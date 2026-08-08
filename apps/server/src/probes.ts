import { performance } from "node:perf_hooks";
import { updateAlertState } from "./alerts.js";
import { db, many, nowIso, one } from "./db.js";
import { decryptSecret } from "./security.js";
import type { AiTargetRow, EndpointRow, NodeRow } from "./types.js";

interface LastCheck { checked_at: string; success: number; }

const activeChecks = new Set<string>();

function due(lastChecked: string | null | undefined, intervalSeconds: number): boolean {
  return !lastChecked || Date.now() - Date.parse(lastChecked) >= intervalSeconds * 1000;
}

function cleanError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000);
  return String(error).slice(0, 1000);
}

function valueAtPath(value: unknown, path: string | null): number | null {
  if (!path) return null;
  let current: unknown = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  const number = Number(current);
  return Number.isFinite(number) ? number : null;
}

async function runEndpointCheck(endpoint: EndpointRow): Promise<void> {
  const key = `endpoint:${endpoint.id}`;
  if (activeChecks.has(key)) return;
  activeChecks.add(key);
  const checkedAt = nowIso();
  const started = performance.now();
  let statusCode: number | null = null;
  let ttfbMs: number | null = null;
  let totalMs: number | null = null;
  let errorMessage: string | null = null;
  let success = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint.timeout_seconds * 1000);
    const headers = endpoint.headers_encrypted
      ? JSON.parse(decryptSecret(endpoint.headers_encrypted)) as Record<string, string>
      : {};
    try {
      const response = await fetch(endpoint.url, {
        method: endpoint.method,
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
      ttfbMs = performance.now() - started;
      statusCode = response.status;
      if (endpoint.method !== "HEAD") await response.arrayBuffer();
      totalMs = performance.now() - started;
      success = response.status === endpoint.expected_status;
      if (!success) errorMessage = `Expected HTTP ${endpoint.expected_status}, received ${response.status}`;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    totalMs = performance.now() - started;
    errorMessage = cleanError(error);
  } finally {
    db.prepare(`
      INSERT INTO endpoint_checks (endpoint_id, checked_at, success, status_code, ttfb_ms, total_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(endpoint.id, checkedAt, Number(success), statusCode, ttfbMs, totalMs, errorMessage);
    const recent = many<{ success: number }>(db.prepare(`
      SELECT success FROM endpoint_checks WHERE endpoint_id = ? AND node_id IS NULL ORDER BY checked_at DESC LIMIT 2
    `), endpoint.id);
    await updateAlertState(
      "endpoint", endpoint.id, recent.length >= 2 && recent.every((item) => !item.success),
      `${endpoint.name} 不可用`, errorMessage ?? `连续探测失败：${endpoint.url}`,
    );
    activeChecks.delete(key);
  }
}

async function runBalanceCheck(target: AiTargetRow, apiKey: string): Promise<number | null> {
  if (!target.balance_url || !target.balance_path) return null;
  const lastBalance = one<{ checked_at: string }>(db.prepare(`
    SELECT checked_at FROM ai_checks WHERE target_id = ? AND node_id IS NULL AND balance IS NOT NULL ORDER BY checked_at DESC LIMIT 1
  `), target.id);
  if (!due(lastBalance?.checked_at, target.balance_interval_seconds)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), target.timeout_seconds * 1000);
  try {
    const response = await fetch(target.balance_url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return valueAtPath(await response.json(), target.balance_path);
  } finally {
    clearTimeout(timeout);
  }
}

async function runAiCheck(target: AiTargetRow): Promise<void> {
  const key = `ai:${target.id}`;
  if (activeChecks.has(key)) return;
  activeChecks.add(key);
  const checkedAt = nowIso();
  const started = performance.now();
  let statusCode: number | null = null;
  let ttfbMs: number | null = null;
  let totalMs: number | null = null;
  let errorMessage: string | null = null;
  let success = false;
  let responseValid = false;
  let balance: number | null = null;

  try {
    const apiKey = decryptSecret(target.api_key_encrypted);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), target.timeout_seconds * 1000);
    try {
      const response = await fetch(`${target.base_url}${target.chat_path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: target.model,
          messages: [{ role: "user", content: target.prompt }],
          max_tokens: 8,
          temperature: 0,
          stream: true,
        }),
        signal: controller.signal,
      });
      statusCode = response.status;
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
      }
      if (!response.body) throw new Error("Streaming response body is missing");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let payload = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttfbMs === null && value.byteLength > 0) ttfbMs = performance.now() - started;
        payload += decoder.decode(value, { stream: true });
        if (payload.length > 256_000) throw new Error("Streaming probe exceeded response limit");
      }
      payload += decoder.decode();
      totalMs = performance.now() - started;
      responseValid = payload.includes("data:") && (payload.includes("[DONE]") || payload.includes("choices"));
      success = responseValid;
      if (!responseValid) errorMessage = "Response did not contain a valid SSE completion";
      balance = await runBalanceCheck(target, apiKey);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    totalMs = performance.now() - started;
    errorMessage = cleanError(error);
  } finally {
    db.prepare(`
      INSERT INTO ai_checks (
        target_id, checked_at, success, status_code, ttfb_ms, total_ms, response_valid, balance, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(target.id, checkedAt, Number(success), statusCode, ttfbMs, totalMs, Number(responseValid), balance, errorMessage);
    const recent = many<{ success: number }>(db.prepare(`
      SELECT success FROM ai_checks WHERE target_id = ? AND node_id IS NULL ORDER BY checked_at DESC LIMIT 2
    `), target.id);
    await updateAlertState(
      "ai_target", target.id, recent.length >= 2 && recent.every((item) => !item.success),
      `${target.name} 上游异常`, errorMessage ?? `连续流式探测失败：${target.model}`,
    );
    activeChecks.delete(key);
  }
}

async function checkOfflineNodes(): Promise<void> {
  const nodes = many<NodeRow>(db.prepare("SELECT * FROM nodes WHERE enabled = 1 AND alert_on_offline = 1"));
  for (const node of nodes) {
    const offline = !node.last_seen_at || Date.now() - Date.parse(node.last_seen_at) > node.offline_after_seconds * 1000;
    await updateAlertState(
      "node", node.id, offline, `${node.name} 已离线`,
      node.last_seen_at ? `最后上报时间：${node.last_seen_at}` : "节点尚未上报监控数据",
      "warning",
    );
  }
}

export async function schedulerTick(): Promise<void> {
  const endpoints = many<EndpointRow & { last_checked: string | null }>(db.prepare(`
    SELECT e.*, (SELECT checked_at FROM endpoint_checks WHERE endpoint_id=e.id AND node_id IS NULL ORDER BY checked_at DESC LIMIT 1) AS last_checked
    FROM endpoints e WHERE enabled = 1
  `));
  for (const endpoint of endpoints) {
    if (due(endpoint.last_checked, endpoint.interval_seconds)) void runEndpointCheck(endpoint);
  }

  const targets = many<AiTargetRow & { last_checked: string | null }>(db.prepare(`
    SELECT t.*, (SELECT checked_at FROM ai_checks WHERE target_id=t.id AND node_id IS NULL ORDER BY checked_at DESC LIMIT 1) AS last_checked
    FROM ai_targets t WHERE enabled = 1
  `));
  for (const target of targets) {
    if (due(target.last_checked, target.interval_seconds)) void runAiCheck(target);
  }

  await checkOfflineNodes();
}
