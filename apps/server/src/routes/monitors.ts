import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, many, nowIso, one } from "../db.js";
import { parseBody, requireAdmin, requireUser } from "../http.js";
import { encryptSecret } from "../security.js";
import type { AiTargetRow, EndpointRow } from "../types.js";

const endpointSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().url(),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  timeoutSeconds: z.number().int().min(2).max(120).default(15),
  intervalSeconds: z.number().int().min(10).max(86400).default(30),
  enabled: z.boolean().default(true),
  verifyTls: z.boolean().default(true),
  headers: z.record(z.string(), z.string()).default({}),
  probeNodeIds: z.array(z.string().uuid()).max(50).default([]),
});

export const endpointPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().url().optional(),
  method: z.enum(["GET", "HEAD"]).optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  timeoutSeconds: z.number().int().min(2).max(120).optional(),
  intervalSeconds: z.number().int().min(10).max(86400).optional(),
  enabled: z.boolean().optional(),
  verifyTls: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  probeNodeIds: z.array(z.string().uuid()).max(50).optional(),
});

const aiTargetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(),
  chatPath: z.string().trim().startsWith("/").default("/v1/chat/completions"),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(2048).optional(),
  prompt: z.string().min(1).max(1000).default("Reply with OK only."),
  intervalSeconds: z.number().int().min(60).max(86400).default(300),
  timeoutSeconds: z.number().int().min(5).max(300).default(60),
  enabled: z.boolean().default(true),
  balanceUrl: z.union([z.string().url(), z.literal("")]).optional(),
  balancePath: z.string().max(200).optional(),
  balanceIntervalSeconds: z.number().int().min(300).max(604800).default(1800),
  probeNodeIds: z.array(z.string().uuid()).max(50).default([]),
});

export const aiTargetPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  baseUrl: z.string().url().optional(),
  chatPath: z.string().trim().startsWith("/").optional(),
  model: z.string().trim().min(1).max(200).optional(),
  apiKey: z.string().max(2048).optional(),
  prompt: z.string().min(1).max(1000).optional(),
  intervalSeconds: z.number().int().min(60).max(86400).optional(),
  timeoutSeconds: z.number().int().min(5).max(300).optional(),
  enabled: z.boolean().optional(),
  balanceUrl: z.union([z.string().url(), z.literal("")]).optional(),
  balancePath: z.string().max(200).optional(),
  balanceIntervalSeconds: z.number().int().min(300).max(604800).optional(),
  probeNodeIds: z.array(z.string().uuid()).max(50).optional(),
});

function replaceAssignments(type: "endpoint" | "ai", monitorId: string, nodeIds: string[]): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM monitor_assignments WHERE monitor_type = ? AND monitor_id = ?").run(type, monitorId);
    const insert = db.prepare(`
      INSERT INTO monitor_assignments (monitor_type, monitor_id, node_id, created_at) VALUES (?, ?, ?, ?)
    `);
    for (const nodeId of [...new Set(nodeIds)]) insert.run(type, monitorId, nodeId, nowIso());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseNodeIds(value: unknown): string[] {
  try { return JSON.parse(String(value ?? "[]")) as string[]; } catch { return []; }
}

function publicEndpoint(row: EndpointRow & Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    expectedStatus: row.expected_status,
    timeoutSeconds: row.timeout_seconds,
    intervalSeconds: row.interval_seconds,
    enabled: Boolean(row.enabled),
    verifyTls: Boolean(row.verify_tls),
    hasHeaders: Boolean(row.headers_encrypted),
    probeNodeIds: parseNodeIds(row.probe_node_ids),
    createdAt: row.created_at,
    latest: row.checked_at ? {
      checkedAt: row.checked_at,
      success: Boolean(row.success),
      statusCode: row.status_code,
      ttfbMs: row.ttfb_ms,
      totalMs: row.total_ms,
      error: row.error,
      location: row.location,
    } : null,
  };
}

function publicAiTarget(row: AiTargetRow & Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    chatPath: row.chat_path,
    model: row.model,
    prompt: row.prompt,
    intervalSeconds: row.interval_seconds,
    timeoutSeconds: row.timeout_seconds,
    enabled: Boolean(row.enabled),
    balanceUrl: row.balance_url,
    balancePath: row.balance_path,
    balanceIntervalSeconds: row.balance_interval_seconds,
    hasApiKey: Boolean(row.api_key_encrypted),
    probeNodeIds: parseNodeIds(row.probe_node_ids),
    createdAt: row.created_at,
    latest: row.checked_at ? {
      checkedAt: row.checked_at,
      success: Boolean(row.success),
      statusCode: row.status_code,
      ttfbMs: row.ttfb_ms,
      totalMs: row.total_ms,
      responseValid: Boolean(row.response_valid),
      balance: row.balance,
      error: row.error,
      location: row.location,
    } : null,
  };
}

const endpointQuery = `
  SELECT e.*, c.checked_at, c.success, c.status_code, c.ttfb_ms, c.total_ms, c.error,
    COALESCE((SELECT json_group_array(node_id) FROM monitor_assignments WHERE monitor_type='endpoint' AND monitor_id=e.id), '[]') AS probe_node_ids
  FROM endpoints e
  LEFT JOIN endpoint_checks c ON c.id = (
    SELECT id FROM endpoint_checks WHERE endpoint_id = e.id ORDER BY checked_at DESC LIMIT 1
  )
`;

const aiQuery = `
  SELECT t.*, c.checked_at, c.success, c.status_code, c.ttfb_ms, c.total_ms,
    c.response_valid, c.balance, c.error,
    COALESCE((SELECT json_group_array(node_id) FROM monitor_assignments WHERE monitor_type='ai' AND monitor_id=t.id), '[]') AS probe_node_ids
  FROM ai_targets t
  LEFT JOIN ai_checks c ON c.id = (
    SELECT id FROM ai_checks WHERE target_id = t.id ORDER BY checked_at DESC LIMIT 1
  )
`;

export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/endpoints", async (request, reply) => {
    if (!requireUser(request, reply)) return;
    return { endpoints: many<EndpointRow & Record<string, unknown>>(db.prepare(`${endpointQuery} ORDER BY e.name`)).map(publicEndpoint) };
  });

  app.post("/api/endpoints", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(endpointSchema, request.body, reply);
    if (!body) return;
    const id = randomUUID();
    const now = nowIso();
    try {
      db.prepare(`
        INSERT INTO endpoints (
          id, name, url, method, expected_status, timeout_seconds, interval_seconds,
          enabled, verify_tls, headers_encrypted, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, body.name, body.url, body.method, body.expectedStatus, body.timeoutSeconds,
        body.intervalSeconds, Number(body.enabled), Number(body.verifyTls),
        Object.keys(body.headers).length ? encryptSecret(JSON.stringify(body.headers)) : null,
        now, now,
      );
      replaceAssignments("endpoint", id, body.probeNodeIds);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "name_exists", message: "名称已经存在" });
      throw error;
    }
    audit(actor.id, "endpoint.created", "endpoint", id, { name: body.name, url: body.url }, request.ip);
    return reply.code(201).send({
      endpoint: publicEndpoint(one<EndpointRow & Record<string, unknown>>(db.prepare(`${endpointQuery} WHERE e.id = ?`), id)!),
    });
  });

  app.patch<{ Params: { id: string } }>("/api/endpoints/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(endpointPatchSchema, request.body, reply);
    if (!body) return;
    const row = one<EndpointRow>(db.prepare("SELECT * FROM endpoints WHERE id = ?"), request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "监控项不存在" });
    db.prepare(`
      UPDATE endpoints SET name=?, url=?, method=?, expected_status=?, timeout_seconds=?, interval_seconds=?,
        enabled=?, verify_tls=?, headers_encrypted=?, updated_at=? WHERE id=?
    `).run(
      body.name ?? row.name, body.url ?? row.url, body.method ?? row.method,
      body.expectedStatus ?? row.expected_status, body.timeoutSeconds ?? row.timeout_seconds,
      body.intervalSeconds ?? row.interval_seconds,
      body.enabled === undefined ? row.enabled : Number(body.enabled),
      body.verifyTls === undefined ? row.verify_tls : Number(body.verifyTls),
      body.headers === undefined ? row.headers_encrypted : (Object.keys(body.headers).length ? encryptSecret(JSON.stringify(body.headers)) : null),
      nowIso(), row.id,
    );
    if (body.probeNodeIds !== undefined) replaceAssignments("endpoint", row.id, body.probeNodeIds);
    audit(actor.id, "endpoint.updated", "endpoint", row.id, { ...body, headers: body.headers ? "[updated]" : undefined }, request.ip);
    return { endpoint: publicEndpoint(one<EndpointRow & Record<string, unknown>>(db.prepare(`${endpointQuery} WHERE e.id = ?`), row.id)!) };
  });

  app.delete<{ Params: { id: string } }>("/api/endpoints/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    db.prepare("DELETE FROM monitor_assignments WHERE monitor_type='endpoint' AND monitor_id=?").run(request.params.id);
    db.prepare(`
      DELETE FROM alerts WHERE (source_type='endpoint' AND source_id=?)
        OR (source_type='endpoint_node' AND source_id LIKE ?)
    `).run(request.params.id, `${request.params.id}:%`);
    const result = db.prepare("DELETE FROM endpoints WHERE id = ?").run(request.params.id);
    if (!result.changes) return reply.code(404).send({ error: "not_found" });
    audit(actor.id, "endpoint.deleted", "endpoint", request.params.id, {}, request.ip);
    return { ok: true };
  });

  app.get("/api/ai-targets", async (request, reply) => {
    if (!requireUser(request, reply)) return;
    return { targets: many<AiTargetRow & Record<string, unknown>>(db.prepare(`${aiQuery} ORDER BY t.name`)).map(publicAiTarget) };
  });

  app.post("/api/ai-targets", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(aiTargetSchema, request.body, reply);
    if (!body) return;
    if (!body.apiKey) return reply.code(400).send({ error: "api_key_required", message: "新建目标时必须填写监控密钥" });
    const id = randomUUID();
    const now = nowIso();
    try {
      db.prepare(`
        INSERT INTO ai_targets (
          id, name, base_url, chat_path, model, api_key_encrypted, prompt, interval_seconds,
          timeout_seconds, enabled, balance_url, balance_path, balance_interval_seconds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, body.name, body.baseUrl.replace(/\/$/, ""), body.chatPath, body.model,
        encryptSecret(body.apiKey), body.prompt, body.intervalSeconds, body.timeoutSeconds,
        Number(body.enabled), body.balanceUrl || null, body.balancePath || null,
        body.balanceIntervalSeconds, now, now,
      );
      replaceAssignments("ai", id, body.probeNodeIds);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "name_exists", message: "名称已经存在" });
      throw error;
    }
    audit(actor.id, "ai_target.created", "ai_target", id, { name: body.name, baseUrl: body.baseUrl, model: body.model }, request.ip);
    return reply.code(201).send({
      target: publicAiTarget(one<AiTargetRow & Record<string, unknown>>(db.prepare(`${aiQuery} WHERE t.id = ?`), id)!),
    });
  });

  app.patch<{ Params: { id: string } }>("/api/ai-targets/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(aiTargetPatchSchema, request.body, reply);
    if (!body) return;
    const row = one<AiTargetRow>(db.prepare("SELECT * FROM ai_targets WHERE id = ?"), request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "上游目标不存在" });
    db.prepare(`
      UPDATE ai_targets SET name=?, base_url=?, chat_path=?, model=?, api_key_encrypted=?, prompt=?,
        interval_seconds=?, timeout_seconds=?, enabled=?, balance_url=?, balance_path=?,
        balance_interval_seconds=?, updated_at=? WHERE id=?
    `).run(
      body.name ?? row.name,
      body.baseUrl ? body.baseUrl.replace(/\/$/, "") : row.base_url,
      body.chatPath ?? row.chat_path,
      body.model ?? row.model,
      body.apiKey ? encryptSecret(body.apiKey) : row.api_key_encrypted,
      body.prompt ?? row.prompt,
      body.intervalSeconds ?? row.interval_seconds,
      body.timeoutSeconds ?? row.timeout_seconds,
      body.enabled === undefined ? row.enabled : Number(body.enabled),
      body.balanceUrl === undefined ? row.balance_url : body.balanceUrl || null,
      body.balancePath === undefined ? row.balance_path : body.balancePath || null,
      body.balanceIntervalSeconds ?? row.balance_interval_seconds,
      nowIso(), row.id,
    );
    if (body.probeNodeIds !== undefined) replaceAssignments("ai", row.id, body.probeNodeIds);
    audit(actor.id, "ai_target.updated", "ai_target", row.id, { ...body, apiKey: body.apiKey ? "[updated]" : undefined }, request.ip);
    return { target: publicAiTarget(one<AiTargetRow & Record<string, unknown>>(db.prepare(`${aiQuery} WHERE t.id = ?`), row.id)!) };
  });

  app.delete<{ Params: { id: string } }>("/api/ai-targets/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    db.prepare("DELETE FROM monitor_assignments WHERE monitor_type='ai' AND monitor_id=?").run(request.params.id);
    db.prepare(`
      DELETE FROM alerts WHERE (source_type='ai_target' AND source_id=?)
        OR (source_type='ai_node' AND source_id LIKE ?)
    `).run(request.params.id, `${request.params.id}:%`);
    const result = db.prepare("DELETE FROM ai_targets WHERE id = ?").run(request.params.id);
    if (!result.changes) return reply.code(404).send({ error: "not_found" });
    audit(actor.id, "ai_target.deleted", "ai_target", request.params.id, {}, request.ip);
    return { ok: true };
  });
}
