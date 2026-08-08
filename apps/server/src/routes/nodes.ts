import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { updateAlertState } from "../alerts.js";
import { audit, db, many, nowIso, one } from "../db.js";
import { parseBody, requireAdmin, requireUser } from "../http.js";
import { decryptSecret, hashToken, randomToken } from "../security.js";
import type { AgentReport, NodeRow } from "../types.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  platform: z.enum(["linux", "windows", "unknown"]).default("unknown"),
  kind: z.enum(["server", "nas", "laptop", "vm"]).default("server"),
  alertOnOffline: z.boolean().default(true),
  offlineAfterSeconds: z.number().int().min(60).max(86400).default(180),
  labels: z.record(z.string(), z.string()).default({}),
});

const updateSchema = createSchema.partial().extend({ enabled: z.boolean().optional() });

const reportSchema = z.object({
  timestamp: z.string(),
  hostname: z.string().max(255),
  platform: z.string().max(80),
  version: z.string().max(40),
  uptimeSeconds: z.number().nonnegative(),
  cpuPercent: z.number().min(0).max(100),
  memoryTotalBytes: z.number().nonnegative(),
  memoryUsedBytes: z.number().nonnegative(),
  load1: z.number().optional(),
  disks: z.array(z.object({
    mount: z.string().max(255),
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
  })).max(128),
  networks: z.array(z.object({
    name: z.string().max(128),
    rxBytes: z.number().nonnegative(),
    txBytes: z.number().nonnegative(),
  })).max(128),
  services: z.array(z.object({
    name: z.string().max(128),
    state: z.string().max(64),
  })).max(256).optional(),
});

const probeResultSchema = z.object({
  type: z.enum(["endpoint", "ai"]),
  monitorId: z.string().uuid(),
  checkedAt: z.string().optional(),
  success: z.boolean(),
  statusCode: z.number().int().min(0).max(599).nullable().default(null),
  ttfbMs: z.number().nonnegative().nullable().default(null),
  totalMs: z.number().nonnegative().nullable().default(null),
  responseValid: z.boolean().default(false),
  balance: z.number().nullable().default(null),
  error: z.string().max(1000).nullable().default(null),
});

function parseLabels(value: string): Record<string, string> {
  try { return JSON.parse(value) as Record<string, string>; } catch { return {}; }
}

function publicNode(row: NodeRow & Record<string, unknown>) {
  const latest = row.sampled_at ? {
    sampledAt: row.sampled_at,
    cpuPercent: row.cpu_percent,
    memoryTotalBytes: row.memory_total_bytes,
    memoryUsedBytes: row.memory_used_bytes,
    uptimeSeconds: row.uptime_seconds,
    disks: JSON.parse(String(row.disks_json ?? "[]")),
    services: JSON.parse(String(row.services_json ?? "[]")),
  } : null;
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  const online = Boolean(row.enabled) && Date.now() - lastSeen < row.offline_after_seconds * 1000;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    kind: row.kind,
    labels: parseLabels(row.labels),
    alertOnOffline: Boolean(row.alert_on_offline),
    offlineAfterSeconds: row.offline_after_seconds,
    enabled: Boolean(row.enabled),
    online,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    agentVersion: row.agent_version,
    latest,
  };
}

const nodeQuery = `
  SELECT n.*,
    s.sampled_at, s.cpu_percent, s.memory_total_bytes, s.memory_used_bytes,
    s.uptime_seconds, s.disks_json, s.services_json
  FROM nodes n
  LEFT JOIN node_samples s ON s.id = (
    SELECT id FROM node_samples WHERE node_id = n.id ORDER BY sampled_at DESC LIMIT 1
  )
`;

function agentNode(request: FastifyRequest): NodeRow | null {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return null;
  return one<NodeRow>(db.prepare("SELECT * FROM nodes WHERE token_hash = ? AND enabled = 1"), hashToken(token)) ?? null;
}

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/nodes", async (request, reply) => {
    if (!requireUser(request, reply)) return;
    return { nodes: many<NodeRow & Record<string, unknown>>(db.prepare(`${nodeQuery} ORDER BY n.name`)).map(publicNode) };
  });

  app.post("/api/nodes", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(createSchema, request.body, reply);
    if (!body) return;
    const id = randomUUID();
    const token = randomToken();
    const now = nowIso();
    try {
      db.prepare(`
        INSERT INTO nodes (
          id, name, platform, kind, labels, token_hash, alert_on_offline,
          offline_after_seconds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, body.name, body.platform, body.kind, JSON.stringify(body.labels), hashToken(token),
        Number(body.alertOnOffline), body.offlineAfterSeconds, now, now,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "node_exists", message: "节点名称已经存在" });
      }
      throw error;
    }
    audit(actor.id, "node.created", "node", id, { name: body.name }, request.ip);
    const row = one<NodeRow & Record<string, unknown>>(db.prepare(`${nodeQuery} WHERE n.id = ?`), id)!;
    return reply.code(201).send({ node: publicNode(row), enrollmentToken: token });
  });

  app.patch<{ Params: { id: string } }>("/api/nodes/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(updateSchema, request.body, reply);
    if (!body) return;
    const row = one<NodeRow>(db.prepare("SELECT * FROM nodes WHERE id = ?"), request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "节点不存在" });
    db.prepare(`
      UPDATE nodes SET name = ?, platform = ?, kind = ?, labels = ?, alert_on_offline = ?,
        offline_after_seconds = ?, enabled = ?, updated_at = ? WHERE id = ?
    `).run(
      body.name ?? row.name,
      body.platform ?? row.platform,
      body.kind ?? row.kind,
      body.labels ? JSON.stringify(body.labels) : row.labels,
      body.alertOnOffline === undefined ? row.alert_on_offline : Number(body.alertOnOffline),
      body.offlineAfterSeconds ?? row.offline_after_seconds,
      body.enabled === undefined ? row.enabled : Number(body.enabled),
      nowIso(), row.id,
    );
    audit(actor.id, "node.updated", "node", row.id, body, request.ip);
    return { node: publicNode(one<NodeRow & Record<string, unknown>>(db.prepare(`${nodeQuery} WHERE n.id = ?`), row.id)!) };
  });

  app.post<{ Params: { id: string } }>("/api/nodes/:id/rotate-token", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const row = one<NodeRow>(db.prepare("SELECT * FROM nodes WHERE id = ?"), request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "节点不存在" });
    const token = randomToken();
    db.prepare("UPDATE nodes SET token_hash = ?, updated_at = ? WHERE id = ?").run(hashToken(token), nowIso(), row.id);
    audit(actor.id, "node.token_rotated", "node", row.id, {}, request.ip);
    return { enrollmentToken: token };
  });

  app.delete<{ Params: { id: string } }>("/api/nodes/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    db.prepare(`
      DELETE FROM alerts WHERE (source_type='node' AND source_id=?)
        OR (source_type IN ('endpoint_node', 'ai_node') AND source_id LIKE ?)
    `).run(request.params.id, `%:${request.params.id}`);
    const result = db.prepare("DELETE FROM nodes WHERE id = ?").run(request.params.id);
    if (!result.changes) return reply.code(404).send({ error: "not_found", message: "节点不存在" });
    audit(actor.id, "node.deleted", "node", request.params.id, {}, request.ip);
    return { ok: true };
  });

  app.post("/api/agent/report", {
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const node = agentNode(request);
    if (!node) return reply.code(401).send({ error: "invalid_token" });
    const report = parseBody(reportSchema, request.body, reply) as AgentReport | undefined;
    if (!report) return;

    const sampledAt = nowIso();
    db.prepare(`
      INSERT INTO node_samples (
        node_id, sampled_at, uptime_seconds, cpu_percent, memory_total_bytes,
        memory_used_bytes, load1, disks_json, networks_json, services_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.id, sampledAt, report.uptimeSeconds, report.cpuPercent,
      report.memoryTotalBytes, report.memoryUsedBytes, report.load1 ?? null,
      JSON.stringify(report.disks), JSON.stringify(report.networks), JSON.stringify(report.services ?? []),
    );
    db.prepare(`
      UPDATE nodes SET platform = ?, last_seen_at = ?, agent_version = ?, updated_at = ? WHERE id = ?
    `).run(report.platform, sampledAt, report.version, sampledAt, node.id);
    return reply.code(202).send({ ok: true, nextReportSeconds: 30 });
  });

  app.get("/api/agent/tasks", async (request, reply) => {
    const node = agentNode(request);
    if (!node) return reply.code(401).send({ error: "invalid_token" });
    const endpoints = many<Record<string, unknown>>(db.prepare(`
      SELECT e.* FROM endpoints e
      JOIN monitor_assignments a ON a.monitor_type='endpoint' AND a.monitor_id=e.id
      WHERE a.node_id=? AND e.enabled=1 ORDER BY e.name
    `), node.id).map((row) => ({
      type: "endpoint",
      monitorId: row.id,
      name: row.name,
      intervalSeconds: row.interval_seconds,
      timeoutSeconds: row.timeout_seconds,
      url: row.url,
      method: row.method,
      expectedStatus: row.expected_status,
      headers: row.headers_encrypted ? JSON.parse(decryptSecret(String(row.headers_encrypted))) : {},
    }));
    const aiTargets = many<Record<string, unknown>>(db.prepare(`
      SELECT t.* FROM ai_targets t
      JOIN monitor_assignments a ON a.monitor_type='ai' AND a.monitor_id=t.id
      WHERE a.node_id=? AND t.enabled=1 ORDER BY t.name
    `), node.id).map((row) => ({
      type: "ai",
      monitorId: row.id,
      name: row.name,
      intervalSeconds: row.interval_seconds,
      timeoutSeconds: row.timeout_seconds,
      baseUrl: row.base_url,
      chatPath: row.chat_path,
      model: row.model,
      apiKey: decryptSecret(String(row.api_key_encrypted)),
      prompt: row.prompt,
    }));
    reply.header("Cache-Control", "no-store");
    return { tasks: [...endpoints, ...aiTargets] };
  });

  app.post("/api/agent/result", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const node = agentNode(request);
    if (!node) return reply.code(401).send({ error: "invalid_token" });
    const result = parseBody(probeResultSchema, request.body, reply);
    if (!result) return;
    const assigned = one<{ count: number }>(db.prepare(`
      SELECT COUNT(*) AS count FROM monitor_assignments
      WHERE monitor_type=? AND monitor_id=? AND node_id=?
    `), result.type, result.monitorId, node.id)?.count ?? 0;
    if (!assigned) return reply.code(403).send({ error: "task_not_assigned" });

    const checkedAt = nowIso();
    if (result.type === "endpoint") {
      const monitor = one<{ name: string; url: string }>(db.prepare("SELECT name, url FROM endpoints WHERE id=?"), result.monitorId);
      if (!monitor) return reply.code(404).send({ error: "monitor_not_found" });
      db.prepare(`
        INSERT INTO endpoint_checks (endpoint_id, node_id, checked_at, success, status_code, ttfb_ms, total_ms, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(result.monitorId, node.id, checkedAt, Number(result.success), result.statusCode, result.ttfbMs, result.totalMs, result.error);
      const recent = many<{ success: number }>(db.prepare(`
        SELECT success FROM endpoint_checks WHERE endpoint_id=? AND node_id=? ORDER BY checked_at DESC LIMIT 2
      `), result.monitorId, node.id);
      await updateAlertState(
        "endpoint_node", `${result.monitorId}:${node.id}`,
        recent.length >= 2 && recent.every((item) => !item.success),
        `${monitor.name} 在 ${node.name} 探测失败`, result.error ?? monitor.url,
      );
    } else {
      const monitor = one<{ name: string; model: string }>(db.prepare("SELECT name, model FROM ai_targets WHERE id=?"), result.monitorId);
      if (!monitor) return reply.code(404).send({ error: "monitor_not_found" });
      db.prepare(`
        INSERT INTO ai_checks (target_id, node_id, checked_at, success, status_code, ttfb_ms, total_ms, response_valid, balance, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.monitorId, node.id, checkedAt, Number(result.success), result.statusCode,
        result.ttfbMs, result.totalMs, Number(result.responseValid), result.balance, result.error,
      );
      const recent = many<{ success: number }>(db.prepare(`
        SELECT success FROM ai_checks WHERE target_id=? AND node_id=? ORDER BY checked_at DESC LIMIT 2
      `), result.monitorId, node.id);
      await updateAlertState(
        "ai_node", `${result.monitorId}:${node.id}`,
        recent.length >= 2 && recent.every((item) => !item.success),
        `${monitor.name} 在 ${node.name} 流式探测失败`, result.error ?? monitor.model,
      );
    }
    return reply.code(202).send({ ok: true });
  });
}
