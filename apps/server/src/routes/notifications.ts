import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Ajv } from "ajv";
import { z } from "zod";
import { audit, db, many, nowIso, one } from "../db.js";
import { parseBody, requireAdmin, requireUser } from "../http.js";
import { emitNotification } from "../notification-service.js";
import {
  acknowledgeProvisionResult,
  createProvisionJob,
  provisionerStatus,
  queueProvisionJob,
  readProvisionResult,
  resumeProvisionJob,
} from "../notification-provisioning.js";
import { ntfyProviderStatus } from "../notification-providers.js";
import { decryptSecret, hashToken, randomToken } from "../security.js";
import { getSetting, setSetting } from "../settings.js";

const channels = z.array(z.enum(["in_app", "email", "ntfy"])).min(1).max(3);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional();
const subscriptionSchema = z.object({
  projectId: z.string().min(1).nullable().optional(),
  eventTypeId: z.string().min(1).nullable().optional(),
  minPriority: z.number().int().min(1).max(5).default(1),
  deliveryPriority: z.number().int().min(1).max(5).nullable().optional(),
  channels,
  emailAddresses: z.array(z.string().email()).max(20).default([]),
  cooldownMode: z.enum(["once", "interval", "repeat_count", "until_recovery"]).default("once"),
  cooldownSeconds: z.number().int().min(60).max(2_592_000).default(1800),
  repeatCount: z.number().int().min(1).max(100).default(1),
  quietStart: clock,
  quietEnd: clock,
  recoverySummaryMode: z.enum(["merged", "recovery_only", "all"]).default("merged"),
  enabled: z.boolean().default(true),
});
const profileSchema = z.object({
  email: z.string().email().nullable(),
  locale: z.enum(["zh-CN", "en-US"]),
  timezone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
  }, "无效的时区"),
});
const projectSchema = z.object({
  moduleKey: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  projectKey: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
});
const eventTypeSchema = z.object({
  eventKey: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{1,99}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  schema: z.record(z.string(), z.unknown()).default({}),
  titleTemplate: z.string().min(1).max(200),
  bodyTemplate: z.string().min(1).max(4096),
  defaultPriority: z.number().int().min(1).max(5).default(3),
  lifecycle: z.enum(["event", "opened", "recovered"]).default("event"),
  enabled: z.boolean().default(true),
});
const externalEventSchema = z.object({
  eventType: z.string().min(1).max(100),
  data: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(1).max(5).optional(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(4096).optional(),
  dedupeKey: z.string().min(1).max(255).optional(),
  occurredAt: z.iso.datetime().optional(),
});

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function publicSubscription(row: Record<string, unknown>) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    eventTypeId: row.event_type_id,
    eventTypeName: row.event_type_name,
    minPriority: row.min_priority,
    deliveryPriority: row.delivery_priority,
    channels: parseJson(String(row.channels_json), []),
    emailAddresses: parseJson(String(row.email_addresses_json), []),
    cooldownMode: row.cooldown_mode,
    cooldownSeconds: row.cooldown_seconds,
    repeatCount: row.repeat_count,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    recoverySummaryMode: row.recovery_summary_mode,
    enabled: Boolean(row.enabled),
  };
}

function canAccessProject(userId: string, role: string, projectId: string): boolean {
  if (role === "admin") return true;
  return Boolean(one(db.prepare("SELECT 1 FROM notification_project_members WHERE project_id=? AND user_id=?"), projectId, userId));
}

function validateSubscriptionReferences(userId: string, role: string, projectId: string | null | undefined, eventTypeId: string | null | undefined): boolean {
  if (!eventTypeId) return !projectId || (Boolean(one(db.prepare("SELECT id FROM notification_projects WHERE id=?"), projectId)) && canAccessProject(userId, role, projectId));
  const event = one<{ project_id: string }>(db.prepare("SELECT project_id FROM notification_event_types WHERE id=?"), eventTypeId);
  return Boolean(event && (!projectId || event.project_id === projectId) && canAccessProject(userId, role, event.project_id));
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notifications/catalog", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const projects = many<Record<string, unknown>>(db.prepare(`
      SELECT p.* FROM notification_projects p WHERE p.enabled=1
        AND (?='admin' OR EXISTS (SELECT 1 FROM notification_project_members pm WHERE pm.project_id=p.id AND pm.user_id=?))
      ORDER BY p.module_key, p.name
    `), user.role, user.id).map((project) => ({
      id: project.id,
      moduleKey: project.module_key,
      projectKey: project.project_key,
      name: project.name,
      description: project.description,
      eventTypes: many<Record<string, unknown>>(db.prepare(`
        SELECT * FROM notification_event_types WHERE project_id=? AND enabled=1 ORDER BY name
      `), String(project.id)).map((event) => ({
        id: event.id, eventKey: event.event_key, name: event.name, description: event.description,
        defaultPriority: event.default_priority, lifecycle: event.lifecycle,
      })),
    }));
    return { projects };
  });

  app.get("/api/notifications/profile", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return { profile: { email: user.email, locale: user.locale, timezone: user.timezone } };
  });

  app.put("/api/notifications/profile", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const body = parseBody(profileSchema, request.body, reply);
    if (!body) return;
    db.prepare("UPDATE users SET email=?, locale=?, timezone=?, updated_at=? WHERE id=?")
      .run(body.email, body.locale, body.timezone, nowIso(), user.id);
    audit(user.id, "notification.profile_updated", "user", user.id, { locale: body.locale, timezone: body.timezone }, request.ip);
    return { ok: true };
  });

  app.get("/api/notifications/subscriptions", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const rows = many<Record<string, unknown>>(db.prepare(`
      SELECT s.*, p.name AS project_name, et.name AS event_type_name
      FROM notification_subscriptions s
      LEFT JOIN notification_projects p ON p.id=s.project_id
      LEFT JOIN notification_event_types et ON et.id=s.event_type_id
      WHERE s.user_id=? AND s.enabled=1 ORDER BY s.created_at
    `), user.id);
    return { subscriptions: rows.map(publicSubscription) };
  });

  app.post("/api/notifications/subscriptions", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const body = parseBody(subscriptionSchema, request.body, reply);
    if (!body) return;
    if (!validateSubscriptionReferences(user.id, user.role, body.projectId, body.eventTypeId)) {
      return reply.code(400).send({ error: "invalid_subscription_target", message: "项目或事件类型无效" });
    }
    if (body.channels.includes("ntfy") && !one(db.prepare("SELECT user_id FROM ntfy_accounts WHERE user_id=? AND status='active'"), user.id)) {
      return reply.code(400).send({ error: "ntfy_not_enabled", message: "请先启用 ntfy 设备通知" });
    }
    const id = randomUUID();
    const now = nowIso();
    db.prepare(`
      INSERT INTO notification_subscriptions (
        id, user_id, project_id, event_type_id, min_priority, delivery_priority, channels_json,
        email_addresses_json, cooldown_mode, cooldown_seconds, repeat_count, quiet_start, quiet_end,
        recovery_summary_mode, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, body.projectId ?? null, body.eventTypeId ?? null, body.minPriority,
      body.deliveryPriority ?? null, JSON.stringify(body.channels), JSON.stringify(body.emailAddresses),
      body.cooldownMode, body.cooldownSeconds, body.repeatCount, body.quietStart ?? null,
      body.quietEnd ?? null, body.recoverySummaryMode, Number(body.enabled), now, now);
    audit(user.id, "notification.subscription_created", "notification_subscription", id, { channels: body.channels }, request.ip);
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/notifications/subscriptions/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const body = parseBody(subscriptionSchema, request.body, reply);
    if (!body) return;
    const existing = one<{ id: string }>(db.prepare("SELECT id FROM notification_subscriptions WHERE id=? AND user_id=?"), request.params.id, user.id);
    if (!existing) return reply.code(404).send({ error: "not_found", message: "订阅不存在" });
    if (!validateSubscriptionReferences(user.id, user.role, body.projectId, body.eventTypeId)) {
      return reply.code(400).send({ error: "invalid_subscription_target", message: "项目或事件类型无效" });
    }
    db.prepare(`
      UPDATE notification_subscriptions SET project_id=?, event_type_id=?, min_priority=?, delivery_priority=?,
        channels_json=?, email_addresses_json=?, cooldown_mode=?, cooldown_seconds=?, repeat_count=?, quiet_start=?,
        quiet_end=?, recovery_summary_mode=?, enabled=?, updated_at=? WHERE id=?
    `).run(body.projectId ?? null, body.eventTypeId ?? null, body.minPriority, body.deliveryPriority ?? null,
      JSON.stringify(body.channels), JSON.stringify(body.emailAddresses), body.cooldownMode, body.cooldownSeconds,
      body.repeatCount, body.quietStart ?? null, body.quietEnd ?? null, body.recoverySummaryMode,
      Number(body.enabled), nowIso(), existing.id);
    audit(user.id, "notification.subscription_updated", "notification_subscription", existing.id, {}, request.ip);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/notifications/subscriptions/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const result = db.prepare("UPDATE notification_subscriptions SET enabled=0, updated_at=? WHERE id=? AND user_id=? AND enabled=1")
      .run(nowIso(), request.params.id, user.id);
    if (!result.changes) return reply.code(404).send({ error: "not_found", message: "订阅不存在" });
    audit(user.id, "notification.subscription_deleted", "notification_subscription", request.params.id, {}, request.ip);
    return { ok: true };
  });

  app.get("/api/notifications/inbox", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), unread: z.coerce.boolean().default(false) }).parse(request.query);
    const unreadFilter = query.unread ? "AND d.read_at IS NULL" : "";
    const items = many<Record<string, unknown>>(db.prepare(`
      SELECT d.id, d.read_at, d.delivered_at, e.id AS event_id, e.title, e.body, e.priority,
        e.data_json, e.dedupe_key, e.lifecycle, e.occurred_at, p.name AS project_name,
        p.project_key, et.name AS event_type_name, et.event_key
      FROM notification_deliveries d
      JOIN notification_events e ON e.id=d.event_id
      JOIN notification_projects p ON p.id=e.project_id
      JOIN notification_event_types et ON et.id=e.event_type_id
      WHERE d.user_id=? AND d.channel='in_app' AND d.status='delivered' ${unreadFilter}
      ORDER BY e.occurred_at DESC LIMIT ?
    `), user.id, query.limit).map((item) => ({ ...item, data: parseJson(String(item.data_json), {}), data_json: undefined }));
    const unreadCount = one<{ count: number }>(db.prepare(`
      SELECT COUNT(*) AS count FROM notification_deliveries
      WHERE user_id=? AND channel='in_app' AND status='delivered' AND read_at IS NULL
    `), user.id)?.count ?? 0;
    return { items, unreadCount };
  });

  app.post<{ Params: { id: string } }>("/api/notifications/inbox/:id/read", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    db.prepare("UPDATE notification_deliveries SET read_at=?, updated_at=? WHERE id=? AND user_id=? AND channel='in_app' AND status='delivered'")
      .run(nowIso(), nowIso(), request.params.id, user.id);
    return { ok: true };
  });

  app.post("/api/notifications/inbox/read-all", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const now = nowIso();
    db.prepare("UPDATE notification_deliveries SET read_at=?, updated_at=? WHERE user_id=? AND channel='in_app' AND status='delivered' AND read_at IS NULL")
      .run(now, now, user.id);
    return { ok: true };
  });

  registerNtfyRoutes(app);
  registerNotificationAdminRoutes(app);
  registerExternalEventRoute(app);
}

function registerNtfyRoutes(app: FastifyInstance): void {
  app.get("/api/notifications/ntfy", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const account = one<Record<string, unknown>>(db.prepare("SELECT user_id, username, topic, status, provisioned_at, last_error FROM ntfy_accounts WHERE user_id=?"), user.id);
    const devices = many<Record<string, unknown>>(db.prepare(`
      SELECT id, name, token_hint, expires_at, created_at FROM ntfy_device_tokens
      WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at
    `), user.id);
    const job = one<Record<string, unknown>>(db.prepare(`
      SELECT j.id, j.operation, j.status, j.last_error, j.updated_at,
        CASE WHEN j.result_encrypted IS NULL THEN 0 ELSE 1 END AS result_available
      FROM ntfy_provision_jobs j JOIN ntfy_accounts a ON a.user_id=j.user_id
      WHERE j.user_id=? AND j.operation IN ('provision', 'add-device')
        AND j.account_username=a.username AND j.account_generation=a.generation
      ORDER BY j.created_at DESC LIMIT 1
    `), user.id);
    return { account: account ?? null, devices, job: job ?? null, provider: ntfyProviderStatus(), provisioner: provisionerStatus() };
  });

  app.post("/api/notifications/ntfy/enable", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const body = parseBody(z.object({ deviceName: z.string().trim().min(1).max(80).default("Primary device") }), request.body, reply);
    if (!body) return;
    const account = one<{ username: string; topic: string; status: string; generation: number }>(db.prepare(`
      SELECT username, topic, status, generation FROM ntfy_accounts WHERE user_id=?
    `), user.id);
    const latestJob = account ? one<{ id: string; status: string; result_available: number }>(db.prepare(`
      SELECT id, status, CASE WHEN result_encrypted IS NULL THEN 0 ELSE 1 END AS result_available
      FROM ntfy_provision_jobs WHERE user_id=? AND operation='provision'
        AND account_username=? AND account_generation=?
      ORDER BY created_at DESC LIMIT 1
    `), user.id, account.username, account.generation) : undefined;
    if (account?.status === "active") {
      if (latestJob?.status === "completed" && latestJob.result_available) {
        return reply.code(202).send({ jobId: latestJob.id });
      }
      return reply.code(409).send({ error: "already_enabled", message: "ntfy 已启用" });
    }
    if (account && (account.status === "pending" || account.status === "error") && latestJob) {
      if (latestJob.status === "processing" || (latestJob.status === "completed" && latestJob.result_available)) {
        return reply.code(202).send({ jobId: latestJob.id });
      }
      if (latestJob.status === "pending" || latestJob.status === "failed") {
        try {
          await resumeProvisionJob(latestJob.id, user.id);
          audit(user.id, "notification.ntfy_enabled", "ntfy_account", user.id, { topic: account.topic, deviceName: body.deviceName }, request.ip);
          return reply.code(201).send({ jobId: latestJob.id });
        } catch (error) {
          return reply.code(502).send({ error: "provision_failed", message: error instanceof Error ? error.message : String(error), jobId: latestJob.id });
        }
      }
    }
    if (account && (account.status === "pending" || account.status === "error")) {
      try {
        await createProvisionJob(user.id, "disable-account", { username: account.username, accountGeneration: account.generation });
      } catch (error) {
        return reply.code(502).send({ error: "cleanup_failed", message: error instanceof Error ? error.message : String(error), jobId: (error as { jobId?: string }).jobId });
      }
    }
    const username = `omni_u_${randomToken(9).replace(/[-_]/g, "").toLowerCase()}`;
    const topic = `omni-user-${randomToken(16).replace(/[-_]/g, "").toLowerCase()}`;
    const password = randomToken(24);
    const now = nowIso();
    db.prepare(`
      INSERT INTO ntfy_accounts (user_id, username, topic, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, topic=excluded.topic,
        status='pending', generation=ntfy_accounts.generation+1,
        provisioned_at=NULL, last_error=NULL, updated_at=excluded.updated_at
    `).run(user.id, username, topic, now, now);
    const generation = one<{ generation: number }>(db.prepare("SELECT generation FROM ntfy_accounts WHERE user_id=?"), user.id)!.generation;
    try {
      const { jobId } = await createProvisionJob(user.id, "provision", {
        username, topic, password, deviceName: body.deviceName, expires: "8760h", accountGeneration: generation,
      });
      audit(user.id, "notification.ntfy_enabled", "ntfy_account", user.id, { topic, deviceName: body.deviceName }, request.ip);
      return reply.code(201).send({ jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: "provision_failed", message, jobId: (error as { jobId?: string }).jobId });
    }
  });

  app.post("/api/notifications/ntfy/devices", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(80) }), request.body, reply);
    if (!body) return;
    const account = one<{ username: string; generation: number }>(db.prepare("SELECT username, generation FROM ntfy_accounts WHERE user_id=? AND status='active'"), user.id);
    if (!account) return reply.code(400).send({ error: "ntfy_not_enabled", message: "ntfy 尚未启用" });
    const latestJob = one<{ id: string; status: string; result_available: number }>(db.prepare(`
      SELECT id, status, CASE WHEN result_encrypted IS NULL THEN 0 ELSE 1 END AS result_available
      FROM ntfy_provision_jobs WHERE user_id=? AND operation='add-device'
        AND account_username=? AND account_generation=?
      ORDER BY created_at DESC LIMIT 1
    `), user.id, account.username, account.generation);
    if (latestJob?.status === "processing" || (latestJob?.status === "completed" && latestJob.result_available)) {
      return reply.code(202).send({ jobId: latestJob.id });
    }
    if (latestJob?.status === "pending" || latestJob?.status === "failed") {
      try {
        await resumeProvisionJob(latestJob.id, user.id);
        return reply.code(201).send({ jobId: latestJob.id });
      } catch (error) {
        return reply.code(502).send({ error: "provision_failed", message: error instanceof Error ? error.message : String(error), jobId: latestJob.id });
      }
    }
    try {
      const { jobId } = await createProvisionJob(user.id, "add-device", { username: account.username, deviceName: body.name, expires: "8760h", accountGeneration: account.generation });
      audit(user.id, "notification.ntfy_device_created", "ntfy_account", user.id, { name: body.name }, request.ip);
      return reply.code(201).send({ jobId });
    } catch (error) {
      return reply.code(502).send({ error: "provision_failed", message: error instanceof Error ? error.message : String(error), jobId: (error as { jobId?: string }).jobId });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/notifications/ntfy/devices/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const device = one<{ id: string; token_encrypted: string; username: string }>(db.prepare(`
      SELECT d.id, d.token_encrypted, a.username FROM ntfy_device_tokens d
      JOIN ntfy_accounts a ON a.user_id=d.user_id
      WHERE d.id=? AND d.user_id=? AND d.revoked_at IS NULL
    `), request.params.id, user.id);
    if (!device) return reply.code(404).send({ error: "not_found", message: "设备令牌不存在" });
    try {
      await createProvisionJob(user.id, "revoke-device", { username: device.username, token: decryptSecret(device.token_encrypted) });
      audit(user.id, "notification.ntfy_device_revoked", "ntfy_device", device.id, {}, request.ip);
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: "revoke_failed", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/notifications/ntfy", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const account = one<{ username: string }>(db.prepare(`
      SELECT username FROM ntfy_accounts WHERE user_id=? AND status IN ('active', 'error', 'pending')
    `), user.id);
    if (!account) return reply.code(404).send({ error: "not_found", message: "ntfy 尚未启用" });
    const now = nowIso();
    db.exec("BEGIN IMMEDIATE");
    let jobId: string;
    try {
      db.prepare("UPDATE ntfy_accounts SET status='disabled', generation=generation+1, updated_at=? WHERE user_id=?").run(now, user.id);
      db.prepare("UPDATE ntfy_device_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(now, user.id);
      db.prepare(`
        UPDATE ntfy_provision_jobs SET status='failed', lease_until=NULL, last_error='Superseded by account disable', updated_at=?
        WHERE user_id=? AND operation IN ('provision', 'add-device') AND status IN ('pending', 'processing')
      `).run(now, user.id);
      const generation = one<{ generation: number }>(db.prepare("SELECT generation FROM ntfy_accounts WHERE user_id=?"), user.id)!.generation;
      jobId = queueProvisionJob(user.id, "disable-account", { username: account.username, accountGeneration: generation });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit(user.id, "notification.ntfy_disabled", "ntfy_account", user.id, {}, request.ip);
    return reply.code(202).send({ ok: true, jobId });
  });

  app.get<{ Params: { id: string } }>("/api/notifications/ntfy/jobs/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const job = one<{ operation: string; status: string; last_error: string | null }>(db.prepare(`
      SELECT operation, status, last_error FROM ntfy_provision_jobs WHERE id=? AND user_id=?
    `), request.params.id, user.id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    const result = readProvisionResult(request.params.id, user.id);
    return { operation: job.operation, status: job.status, error: job.last_error, result };
  });

  app.post<{ Params: { id: string } }>("/api/notifications/ntfy/jobs/:id/ack", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    if (!acknowledgeProvisionResult(request.params.id, user.id)) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { ok: true };
  });
}

function registerNotificationAdminRoutes(app: FastifyInstance): void {
  app.put("/api/admin/notifications/ntfy-provider", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(z.object({
      baseUrl: z.string().url(),
      publisherToken: z.string().min(16).optional(),
      enabled: z.boolean(),
    }), request.body, reply);
    if (!body) return;
    let current: { publisherToken?: string } = {};
    const stored = getSetting("notification.ntfy");
    if (stored) { try { current = JSON.parse(stored) as { publisherToken?: string }; } catch { current = {}; } }
    setSetting("notification.ntfy", JSON.stringify({
      baseUrl: body.baseUrl.replace(/\/$/, ""),
      publisherToken: body.publisherToken || current.publisherToken,
      enabled: body.enabled,
    }), true);
    audit(actor.id, "notification.ntfy_provider_updated", "settings", "notification.ntfy", { baseUrl: body.baseUrl, enabled: body.enabled }, request.ip);
    return { ok: true };
  });

  app.get("/api/admin/notifications/projects", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const projects = many<Record<string, unknown>>(db.prepare("SELECT * FROM notification_projects ORDER BY module_key, name"));
    return { projects: projects.map((project) => ({
      ...project,
      enabled: Boolean(project.enabled),
      eventTypes: many<Record<string, unknown>>(db.prepare("SELECT * FROM notification_event_types WHERE project_id=? ORDER BY name"), String(project.id))
        .map((event) => ({ ...event, schema: parseJson(String(event.schema_json), {}), schema_json: undefined, enabled: Boolean(event.enabled) })),
      members: many<Record<string, unknown>>(db.prepare(`
        SELECT pm.user_id, pm.permission, u.username, u.display_name FROM notification_project_members pm
        JOIN users u ON u.id=pm.user_id WHERE pm.project_id=? AND u.deleted_at IS NULL ORDER BY u.username
      `), String(project.id)),
      tokens: many<Record<string, unknown>>(db.prepare(`
        SELECT id, name, token_hint, created_at, expires_at, last_used_at FROM notification_project_tokens
        WHERE project_id=? AND revoked_at IS NULL ORDER BY created_at DESC
      `), String(project.id)),
    })) };
  });

  app.post("/api/admin/notifications/projects", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(projectSchema, request.body, reply);
    if (!body) return;
    const id = randomUUID();
    const now = nowIso();
    try {
      db.prepare(`INSERT INTO notification_projects (id, module_key, project_key, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, body.moduleKey, body.projectKey, body.name, body.description, Number(body.enabled), now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "project_exists", message: "项目标识已存在" });
      throw error;
    }
    audit(actor.id, "notification.project_created", "notification_project", id, { projectKey: body.projectKey }, request.ip);
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/admin/notifications/projects/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(projectSchema, request.body, reply);
    if (!body) return;
    const current = one<{ module_key: string; project_key: string }>(db.prepare("SELECT module_key, project_key FROM notification_projects WHERE id=?"), request.params.id);
    if (!current) return reply.code(404).send({ error: "not_found" });
    if (request.params.id.startsWith("builtin:") && (body.moduleKey !== current.module_key || body.projectKey !== current.project_key)) {
      return reply.code(400).send({ error: "builtin_key_immutable", message: "内建项目标识不可修改" });
    }
    const result = db.prepare(`
      UPDATE notification_projects SET module_key=?, project_key=?, name=?, description=?, enabled=?, updated_at=? WHERE id=?
    `).run(body.moduleKey, body.projectKey, body.name, body.description, Number(body.enabled), nowIso(), request.params.id);
    if (!result.changes) return reply.code(404).send({ error: "not_found" });
    audit(actor.id, "notification.project_updated", "notification_project", request.params.id, {}, request.ip);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/notifications/projects/:id/members", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(z.object({ username: z.string().min(1).max(64), permission: z.enum(["read", "manage"]).default("read") }), request.body, reply);
    if (!body) return;
    const user = one<{ id: string }>(db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE AND disabled=0 AND deleted_at IS NULL"), body.username);
    if (!user) return reply.code(404).send({ error: "user_not_found", message: "用户不存在或已禁用" });
    if (!one(db.prepare("SELECT id FROM notification_projects WHERE id=?"), request.params.id)) return reply.code(404).send({ error: "project_not_found" });
    db.prepare(`
      INSERT INTO notification_project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET permission=excluded.permission
    `).run(request.params.id, user.id, body.permission, nowIso());
    audit(actor.id, "notification.project_member_updated", "notification_project", request.params.id, { userId: user.id, permission: body.permission }, request.ip);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/admin/notifications/projects/:id/members/:userId", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const result = db.prepare("DELETE FROM notification_project_members WHERE project_id=? AND user_id=?").run(request.params.id, request.params.userId);
    if (!result.changes) return reply.code(404).send({ error: "not_found" });
    audit(actor.id, "notification.project_member_removed", "notification_project", request.params.id, { userId: request.params.userId }, request.ip);
    return { ok: true };
  });

  app.post<{ Params: { projectId: string } }>("/api/admin/notifications/projects/:projectId/event-types", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(eventTypeSchema, request.body, reply);
    if (!body) return;
    if (!one(db.prepare("SELECT id FROM notification_projects WHERE id=?"), request.params.projectId)) return reply.code(404).send({ error: "not_found" });
    try { new Ajv({ strict: false }).compile(body.schema); } catch (error) {
      return reply.code(400).send({ error: "invalid_schema", message: error instanceof Error ? error.message : String(error) });
    }
    const id = randomUUID();
    const now = nowIso();
    try {
      db.prepare(`
        INSERT INTO notification_event_types (id, project_id, event_key, name, description, schema_json,
          title_template, body_template, default_priority, lifecycle, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.params.projectId, body.eventKey, body.name, body.description, JSON.stringify(body.schema),
        body.titleTemplate, body.bodyTemplate, body.defaultPriority, body.lifecycle, Number(body.enabled), now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "event_type_exists", message: "事件类型已存在" });
      throw error;
    }
    audit(actor.id, "notification.event_type_created", "notification_event_type", id, { eventKey: body.eventKey }, request.ip);
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/admin/notifications/event-types/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(eventTypeSchema, request.body, reply);
    if (!body) return;
    const current = one<{ event_key: string }>(db.prepare("SELECT event_key FROM notification_event_types WHERE id=?"), request.params.id);
    if (!current) return reply.code(404).send({ error: "not_found" });
    if (request.params.id.startsWith("builtin:") && body.eventKey !== current.event_key) {
      return reply.code(400).send({ error: "builtin_key_immutable", message: "内建事件标识不可修改" });
    }
    try { new Ajv({ strict: false }).compile(body.schema); } catch (error) {
      return reply.code(400).send({ error: "invalid_schema", message: error instanceof Error ? error.message : String(error) });
    }
    const result = db.prepare(`
      UPDATE notification_event_types SET event_key=?, name=?, description=?, schema_json=?, title_template=?,
        body_template=?, default_priority=?, lifecycle=?, enabled=?, updated_at=? WHERE id=?
    `).run(body.eventKey, body.name, body.description, JSON.stringify(body.schema), body.titleTemplate,
      body.bodyTemplate, body.defaultPriority, body.lifecycle, Number(body.enabled), nowIso(), request.params.id);
    if (!result.changes) return reply.code(404).send({ error: "not_found" });
    audit(actor.id, "notification.event_type_updated", "notification_event_type", request.params.id, {}, request.ip);
    return { ok: true };
  });

  app.post<{ Params: { projectId: string } }>("/api/admin/notifications/projects/:projectId/tokens", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(100), expiresAt: z.iso.datetime().nullable().optional() }), request.body, reply);
    if (!body) return;
    if (!one(db.prepare("SELECT id FROM notification_projects WHERE id=?"), request.params.projectId)) return reply.code(404).send({ error: "not_found" });
    const token = `omni_proj_${randomToken(32)}`;
    const id = randomUUID();
    db.prepare(`INSERT INTO notification_project_tokens (id, project_id, name, token_hash, token_hint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, request.params.projectId, body.name, hashToken(token), token.slice(-8), nowIso(), body.expiresAt ?? null);
    audit(actor.id, "notification.project_token_created", "notification_project_token", id, { projectId: request.params.projectId }, request.ip);
    return reply.code(201).send({ token: { id, name: body.name, token, hint: token.slice(-8), expiresAt: body.expiresAt ?? null } });
  });

  app.get<{ Params: { projectId: string } }>("/api/admin/notifications/projects/:projectId/tokens", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return { tokens: many<Record<string, unknown>>(db.prepare(`
      SELECT id, name, token_hint, created_at, expires_at, last_used_at, revoked_at
      FROM notification_project_tokens WHERE project_id=? ORDER BY created_at DESC
    `), request.params.projectId) };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/notifications/tokens/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const result = db.prepare("UPDATE notification_project_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(nowIso(), request.params.id);
    if (!result.changes) return reply.code(404).send({ error: "not_found" });
    audit(actor.id, "notification.project_token_revoked", "notification_project_token", request.params.id, {}, request.ip);
    return { ok: true };
  });

  app.get("/api/admin/notifications/deliveries", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const items = many<Record<string, unknown>>(db.prepare(`
      SELECT d.id, d.channel, d.status, d.attempt_count, d.next_attempt_at, d.delivered_at, d.last_error,
        e.title, e.priority, p.name AS project_name, u.username
      FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id
      JOIN notification_projects p ON p.id=e.project_id JOIN users u ON u.id=d.user_id
      ORDER BY d.created_at DESC LIMIT 200
    `));
    const jobs = many<Record<string, unknown>>(db.prepare(`
      SELECT id, user_id, operation, status, attempt_count, next_attempt_at, last_error, created_at, updated_at
      FROM ntfy_provision_jobs ORDER BY created_at DESC LIMIT 100
    `));
    return { items, jobs, provider: ntfyProviderStatus(), provisioner: provisionerStatus() };
  });
}

function registerExternalEventRoute(app: FastifyInstance): void {
  app.post<{ Params: { projectKey: string } }>("/api/v1/projects/:projectKey/events", {
    config: { rateLimit: {
      max: 120,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.ip,
    } },
  }, async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return reply.code(401).send({ error: "unauthorized", message: "缺少项目令牌" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      return reply.code(400).send({ error: "idempotency_required", message: "Idempotency-Key 必须为 8-255 个字符" });
    }
    const token = one<{ id: string; project_id: string; project_key: string }>(db.prepare(`
      SELECT t.id, t.project_id, p.project_key FROM notification_project_tokens t
      JOIN notification_projects p ON p.id=t.project_id
      WHERE t.token_hash=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
        AND p.project_key=? COLLATE NOCASE AND p.enabled=1
    `), hashToken(authorization.slice(7)), nowIso(), request.params.projectKey);
    if (!token) return reply.code(401).send({ error: "invalid_token", message: "项目令牌无效" });
    const body = parseBody(externalEventSchema, request.body, reply);
    if (!body) return;
    try {
      const result = emitNotification({ projectKey: token.project_key, eventKey: body.eventType, data: body.data,
        priority: body.priority, title: body.title, body: body.body, dedupeKey: body.dedupeKey,
        occurredAt: body.occurredAt, idempotencyKey });
      db.prepare("UPDATE notification_project_tokens SET last_used_at=? WHERE id=?").run(nowIso(), token.id);
      return reply.code(result.duplicate ? 200 : 202).send(result);
    } catch (error) {
      return reply.code(400).send({ error: "event_rejected", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
