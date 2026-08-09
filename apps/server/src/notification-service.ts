import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import { db, many, nowIso, one } from "./db.js";
import { findSensitiveField, isQuietTime, nextQuietEnd, normalizeChannels, renderNotificationTemplate, retryDelaySeconds } from "./notification-logic.js";
import { activeNtfyTopic, notificationProviders } from "./notification-providers.js";
import { hashToken } from "./security.js";
import { getSetting, getSmtpSettings, setSetting } from "./settings.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const MAX_DATA_BYTES = 16 * 1024;

interface ProjectRow { id: string; project_key: string; enabled: number }
interface EventTypeRow {
  id: string;
  project_id: string;
  project_key: string;
  event_key: string;
  schema_json: string;
  title_template: string;
  body_template: string;
  default_priority: number;
  lifecycle: "event" | "opened" | "recovered";
  enabled: number;
}
interface SubscriptionRow {
  id: string;
  user_id: string;
  min_priority: number;
  delivery_priority: number | null;
  channels_json: string;
  email_addresses_json: string;
  cooldown_mode: "once" | "interval" | "repeat_count" | "until_recovery";
  cooldown_seconds: number;
  repeat_count: number;
  quiet_start: string | null;
  quiet_end: string | null;
  recovery_summary_mode: "merged" | "recovery_only" | "all";
  email: string | null;
  timezone: string;
}
interface DeliveryRow {
  id: string;
  event_id: string;
  subscription_id: string;
  user_id: string;
  channel: "in_app" | "email" | "ntfy";
  attempt_count: number;
  repeat_index: number;
  title: string;
  body: string;
  priority: number;
  dedupe_key: string | null;
  lifecycle: "event" | "opened" | "recovered";
  project_id: string;
  email: string | null;
  email_addresses_json: string;
  cooldown_mode: "once" | "interval" | "repeat_count" | "until_recovery";
  cooldown_seconds: number;
  repeat_count: number;
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
  lease_until: string;
  occurred_at: string;
}

function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

const builtinProjects = [
  { key: "system", module: "system", name: "系统", description: "OmniDeck 平台与安全事件" },
  { key: "infrastructure", module: "infrastructure", name: "基础设施", description: "服务器、NAS 与代理节点事件" },
  { key: "public-endpoints", module: "public-endpoints", name: "公网入口", description: "HTTP 入口与证书检查事件" },
  { key: "ai-upstreams", module: "ai-upstreams", name: "AI 上游", description: "模型上游可用性与余额事件" },
] as const;

const eventSchema = JSON.stringify({
  type: "object",
  properties: {
    sourceType: { type: "string", maxLength: 80 },
    sourceId: { type: "string", maxLength: 200 },
    sourceName: { type: "string", maxLength: 200 },
    message: { type: "string", maxLength: 4000 },
  },
  additionalProperties: true,
});

export function initializeNotificationCenter(): void {
  const now = nowIso();
  for (const project of builtinProjects) {
    const projectId = `builtin:${project.key}`;
    db.prepare(`
      INSERT INTO notification_projects (id, module_key, project_key, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key) DO UPDATE SET module_key=excluded.module_key, name=excluded.name,
        description=excluded.description, updated_at=excluded.updated_at
    `).run(projectId, project.module, project.key, project.name, project.description, now, now);
    const actual = one<ProjectRow>(db.prepare("SELECT * FROM notification_projects WHERE project_key = ?"), project.key)!;
    for (const lifecycle of ["opened", "recovered"] as const) {
      const eventKey = `alert.${lifecycle}`;
      db.prepare(`
        INSERT INTO notification_event_types (
          id, project_id, event_key, name, description, schema_json, title_template, body_template,
          default_priority, lifecycle, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, event_key) DO UPDATE SET name=excluded.name, description=excluded.description,
          schema_json=excluded.schema_json, title_template=excluded.title_template,
          body_template=excluded.body_template, lifecycle=excluded.lifecycle, updated_at=excluded.updated_at
      `).run(
        `builtin:${project.key}:${eventKey}`,
        actual.id,
        eventKey,
        lifecycle === "opened" ? "告警触发" : "告警恢复",
        `${project.name}监控告警${lifecycle === "opened" ? "触发" : "恢复"}`,
        eventSchema,
        lifecycle === "opened" ? "{{sourceName}}发生故障" : "{{sourceName}}已恢复",
        "{{message}}",
        lifecycle === "opened" ? 4 : 3,
        lifecycle,
        now,
        now,
      );
    }
  }

  if (getSetting("notification.builtin_members_migrated") !== "1") {
    db.prepare(`
      INSERT OR IGNORE INTO notification_project_members (project_id, user_id, permission, created_at)
      SELECT p.id, u.id, 'read', ? FROM notification_projects p CROSS JOIN users u
      WHERE p.id LIKE 'builtin:%' AND u.deleted_at IS NULL
    `).run(now);
    setSetting("notification.builtin_members_migrated", "1");
  }

  syncSmtpRecipientSubscription();
}

export function syncSmtpRecipientSubscription(): void {
  const smtp = getSmtpSettings();
  let subscriptionId = getSetting("notification.smtp_subscription_id");
  if (!subscriptionId && getSetting("notification.smtp_recipients_migrated") === "1") {
    const candidates = many<{ id: string }>(db.prepare(`
      SELECT s.id FROM notification_subscriptions s
      JOIN users u ON u.id=s.user_id
      JOIN settings marker ON marker.key='notification.smtp_recipients_migrated'
      WHERE u.role='admin' AND s.project_id IS NULL AND s.event_type_id IS NULL
        AND s.channels_json='["email"]' AND s.cooldown_mode='once' AND s.repeat_count=1
        AND ABS((julianday(s.created_at)-julianday(marker.updated_at))*86400) <= 10
    `));
    if (candidates.length === 1) subscriptionId = candidates[0].id;
  }
  subscriptionId ??= "builtin:smtp-recipients";
  setSetting("notification.smtp_subscription_id", subscriptionId);
  const existing = one<{ id: string; user_id: string }>(db.prepare("SELECT id, user_id FROM notification_subscriptions WHERE id=?"), subscriptionId);
  const storedOwnerId = getSetting("notification.smtp_subscription_user_id");
  const preferredOwnerId = existing?.user_id ?? storedOwnerId;
  let ownerId = preferredOwnerId ? one<{ id: string }>(db.prepare(`
    SELECT id FROM users WHERE id=? AND role='admin' AND disabled=0 AND deleted_at IS NULL
  `), preferredOwnerId)?.id : undefined;
  ownerId ??= one<{ id: string }>(db.prepare(`
    SELECT id FROM users WHERE role='admin' AND disabled=0 AND deleted_at IS NULL ORDER BY created_at LIMIT 1
  `))?.id;
  if (!ownerId) return;
  setSetting("notification.smtp_subscription_user_id", ownerId);
  const now = nowIso();
  if (existing && existing.user_id !== ownerId) {
    db.prepare("UPDATE notification_subscriptions SET user_id=?, updated_at=? WHERE id=?").run(ownerId, now, existing.id);
  }
  if (smtp?.recipients.length) {
    if (existing) {
      db.prepare("UPDATE notification_subscriptions SET email_addresses_json=?, enabled=1, updated_at=? WHERE id=?")
        .run(JSON.stringify(smtp.recipients), now, existing.id);
    } else {
      db.prepare(`
        INSERT INTO notification_subscriptions (
          id, user_id, project_id, event_type_id, min_priority, channels_json,
          email_addresses_json, cooldown_mode, cooldown_seconds, repeat_count, created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, 1, '["email"]', ?, 'once', 1800, 1, ?, ?)
      `).run(subscriptionId, ownerId, JSON.stringify(smtp.recipients), now, now);
    }
  } else if (existing) {
    db.prepare("UPDATE notification_subscriptions SET enabled=0, email_addresses_json='[]', updated_at=? WHERE id=?")
      .run(now, existing.id);
  }
}

export interface EmitNotificationInput {
  projectKey: string;
  eventKey: string;
  data?: Record<string, unknown>;
  priority?: number;
  title?: string;
  body?: string;
  dedupeKey?: string;
  idempotencyKey?: string;
  occurredAt?: string;
}

export interface EmitNotificationResult { eventId: string; duplicate: boolean; deliveries: number }

export function emitNotification(input: EmitNotificationInput): EmitNotificationResult {
  const type = one<EventTypeRow>(db.prepare(`
    SELECT et.*, p.project_key FROM notification_event_types et
    JOIN notification_projects p ON p.id=et.project_id
    WHERE p.project_key=? COLLATE NOCASE AND et.event_key=? COLLATE NOCASE
      AND p.enabled=1 AND et.enabled=1
  `), input.projectKey, input.eventKey);
  if (!type) throw new Error("Unknown or disabled notification event type");

  const data = input.data ?? {};
  const dataJson = stableStringify(data);
  if (Buffer.byteLength(dataJson) > MAX_DATA_BYTES) throw new Error("Event data exceeds 16 KiB");
  const sensitive = findSensitiveField(data);
  if (sensitive) throw new Error(`Sensitive field is not allowed: ${sensitive}`);
  let schema: object;
  try { schema = JSON.parse(type.schema_json) as object; } catch { throw new Error("Registered event schema is invalid"); }
  if (!ajv.validate(schema, data)) throw new Error(`Event data does not match schema: ${ajv.errorsText()}`);

  const priority = input.priority ?? type.default_priority;
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) throw new Error("Priority must be an integer from 1 to 5");
  const title = (input.title ?? renderNotificationTemplate(type.title_template, data)).trim();
  const body = (input.body ?? renderNotificationTemplate(type.body_template, data)).trim();
  if (!title || title.length > 200) throw new Error("Event title must contain 1-200 characters");
  if (!body || Buffer.byteLength(body) > 4096) throw new Error("Event body must contain 1-4096 bytes");
  if (type.lifecycle !== "event" && !input.dedupeKey) throw new Error("Lifecycle events require dedupeKey");
  const normalizedOccurredAt = input.occurredAt ? new Date(input.occurredAt).toISOString() : null;
  if (normalizedOccurredAt && new Date(normalizedOccurredAt).getTime() > Date.now() + 5 * 60_000) {
    throw new Error("occurredAt cannot be more than 5 minutes in the future");
  }
  const idempotencyFingerprint = hashToken(stableStringify({
    eventTypeId: type.id, priority, title, body, data, dedupeKey: input.dedupeKey ?? null,
    lifecycle: type.lifecycle, occurredAt: normalizedOccurredAt,
  }));

  db.exec("BEGIN IMMEDIATE");
  try {
    if (input.idempotencyKey) {
      const existing = one<{
        id: string; event_type_id: string; priority: number; title: string; body: string;
        data_json: string; dedupe_key: string | null; lifecycle: string; occurred_at: string;
        idempotency_fingerprint: string | null;
      }>(db.prepare(
        "SELECT id, event_type_id, priority, title, body, data_json, dedupe_key, lifecycle, occurred_at, idempotency_fingerprint FROM notification_events WHERE project_id=? AND idempotency_key=?",
      ), type.project_id, input.idempotencyKey);
      if (existing) {
        if ((existing.idempotency_fingerprint && existing.idempotency_fingerprint !== idempotencyFingerprint)
          || (!existing.idempotency_fingerprint && (existing.event_type_id !== type.id || existing.priority !== priority || existing.title !== title
          || existing.body !== body || existing.data_json !== dataJson
          || existing.dedupe_key !== (input.dedupeKey ?? null) || existing.lifecycle !== type.lifecycle
          || (normalizedOccurredAt !== null && existing.occurred_at !== normalizedOccurredAt)))) {
          throw new Error("Idempotency-Key was already used for a different event payload");
        }
        db.exec("COMMIT");
        return { eventId: existing.id, duplicate: true, deliveries: 0 };
      }
    }

    const eventId = randomUUID();
    const now = nowIso();
    const occurredAt = normalizedOccurredAt ?? now;
    db.prepare(`
    INSERT INTO notification_events (
      id, project_id, event_type_id, idempotency_key, idempotency_fingerprint, priority, title, body, data_json,
      dedupe_key, lifecycle, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, type.project_id, type.id, input.idempotencyKey ?? null, idempotencyFingerprint, priority, title, body,
      dataJson, input.dedupeKey ?? null, type.lifecycle, occurredAt, now);

    const lifecycleAccepted = updateIncident(type.project_id, eventId, type.lifecycle, input.dedupeKey, occurredAt);
    if (!lifecycleAccepted) {
      db.exec("COMMIT");
      return { eventId, duplicate: false, deliveries: 0 };
    }
    const subscriptions = many<SubscriptionRow>(db.prepare(`
    SELECT s.*, u.email, u.timezone
    FROM notification_subscriptions s
    JOIN users u ON u.id=s.user_id
    WHERE s.enabled=1 AND u.disabled=0 AND u.deleted_at IS NULL
      AND (s.project_id IS NULL OR s.project_id=?)
      AND (s.event_type_id IS NULL OR s.event_type_id=?)
      AND s.min_priority <= ?
      AND (u.role='admin' OR EXISTS (
        SELECT 1 FROM notification_project_members pm WHERE pm.project_id=? AND pm.user_id=u.id
      ))
    `), type.project_id, type.id, priority, type.project_id);

    let deliveries = 0;
    for (const subscription of subscriptions) {
      const channels = normalizeChannels(JSON.parse(subscription.channels_json) as unknown);
      for (const channel of channels) {
        let status = deliveryInitialStatus(subscription, channel, type.project_id, input.dedupeKey, type.lifecycle, now);
        if (type.lifecycle === "opened" && subscription.recovery_summary_mode === "recovery_only") status = "suppressed";
        const effectivePriority = subscription.delivery_priority ?? priority;
        let nextAttemptAt = now;
        if (effectivePriority < 5 && subscription.quiet_start && subscription.quiet_end
          && isQuietTime(new Date(now), subscription.timezone, subscription.quiet_start, subscription.quiet_end)) {
          nextAttemptAt = nextQuietEnd(new Date(now), subscription.timezone, subscription.quiet_start, subscription.quiet_end).toISOString();
        }
        if (type.lifecycle === "recovered" && input.dedupeKey && subscription.recovery_summary_mode === "merged") {
          supersedePendingIncidentDeliveries(type.project_id, input.dedupeKey, subscription.id, subscription.user_id, channel, now);
        }
        db.prepare(`
          INSERT INTO notification_deliveries (
            id, event_id, subscription_id, user_id, channel, status, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), eventId, subscription.id, subscription.user_id, channel, status, nextAttemptAt, now, now);
        deliveries += 1;
      }
    }
    db.exec("COMMIT");
    return { eventId, duplicate: false, deliveries };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function updateIncident(projectId: string, eventId: string, lifecycle: string, dedupeKey: string | undefined, occurredAt: string): boolean {
  if (!dedupeKey || lifecycle === "event") return true;
  const current = one<{ status: "open" | "resolved"; opened_at: string; last_opened_at: string | null; resolved_at: string | null }>(db.prepare(`
    SELECT status, opened_at, last_opened_at, resolved_at FROM notification_incidents WHERE project_id=? AND dedupe_key=?
  `), projectId, dedupeKey);
  if (lifecycle === "opened") {
    if (current?.status === "open") {
      if (occurredAt < (current.last_opened_at ?? current.opened_at)) return false;
      db.prepare(`
        UPDATE notification_incidents SET opened_event_id=?, last_opened_at=?
        WHERE project_id=? AND dedupe_key=? AND status='open'
      `).run(eventId, occurredAt, projectId, dedupeKey);
      return true;
    }
    if (current?.status === "resolved" && occurredAt <= (current.resolved_at ?? current.opened_at)) return false;
    const result = db.prepare(`
      INSERT INTO notification_incidents (id, project_id, dedupe_key, status, opened_event_id, opened_at, last_opened_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?)
      ON CONFLICT(project_id, dedupe_key) DO UPDATE SET
        opened_event_id=excluded.opened_event_id, opened_at=excluded.opened_at, last_opened_at=excluded.last_opened_at,
        status='open', resolved_event_id=NULL, resolved_at=NULL
      WHERE notification_incidents.status='resolved'
        AND excluded.opened_at > COALESCE(notification_incidents.resolved_at, notification_incidents.opened_at)
    `).run(randomUUID(), projectId, dedupeKey, eventId, occurredAt, occurredAt);
    return Boolean(result.changes);
  } else {
    if (current?.status === "resolved") {
      if (occurredAt > (current.resolved_at ?? current.opened_at)) {
        db.prepare(`
          UPDATE notification_incidents SET resolved_event_id=?, resolved_at=?
          WHERE project_id=? AND dedupe_key=? AND status='resolved'
        `).run(eventId, occurredAt, projectId, dedupeKey);
      }
      return false;
    }
    if (current?.status === "open" && occurredAt < (current.last_opened_at ?? current.opened_at)) return false;
    const result = db.prepare(`
      INSERT INTO notification_incidents (
        id, project_id, dedupe_key, status, opened_event_id, resolved_event_id, opened_at, last_opened_at, resolved_at
      ) VALUES (?, ?, ?, 'resolved', ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, dedupe_key) DO UPDATE SET
        status='resolved', resolved_event_id=excluded.resolved_event_id, resolved_at=excluded.resolved_at
      WHERE excluded.resolved_at >= COALESCE(notification_incidents.last_opened_at, notification_incidents.opened_at)
        AND (notification_incidents.resolved_at IS NULL OR excluded.resolved_at > notification_incidents.resolved_at)
    `).run(randomUUID(), projectId, dedupeKey, eventId, eventId, occurredAt, occurredAt, occurredAt);
    return Boolean(result.changes);
  }
}

function deliveryInitialStatus(
  subscription: SubscriptionRow,
  channel: string,
  projectId: string,
  dedupeKey: string | undefined,
  lifecycle: string,
  now: string,
): "pending" | "suppressed" {
  if (lifecycle === "recovered" || !dedupeKey) return "pending";
  const incidentScoped = subscription.cooldown_mode === "once"
    || subscription.cooldown_mode === "repeat_count"
    || subscription.cooldown_mode === "until_recovery";
  let cutoff = new Date(new Date(now).getTime() - subscription.cooldown_seconds * 1000).toISOString();
  let timeExpression = "COALESCE(d.delivered_at, d.created_at)";
  if (incidentScoped) {
    cutoff = one<{ opened_at: string }>(db.prepare(`
      SELECT opened_at FROM notification_incidents WHERE project_id=? AND dedupe_key=? AND status='open'
    `), projectId, dedupeKey)?.opened_at ?? cutoff;
    timeExpression = "e.occurred_at";
  }
  const recent = one<{ id: string }>(db.prepare(`
    SELECT d.id FROM notification_deliveries d
    JOIN notification_events e ON e.id=d.event_id
    WHERE d.subscription_id=? AND d.channel=?
      AND d.status IN ('pending', 'processing', 'delivered', 'failed')
      AND e.project_id=? AND e.dedupe_key=? AND ${timeExpression}>=?
    LIMIT 1
  `), subscription.id, channel, projectId, dedupeKey, cutoff);
  return recent ? "suppressed" : "pending";
}

function supersedePendingIncidentDeliveries(
  projectId: string,
  dedupeKey: string,
  subscriptionId: string,
  userId: string,
  channel: string,
  now: string,
): void {
  db.prepare(`
    UPDATE notification_deliveries SET status='superseded', lease_until=NULL, updated_at=?
    WHERE subscription_id=? AND user_id=? AND channel=? AND status='pending'
      AND event_id IN (
        SELECT id FROM notification_events
        WHERE project_id=? AND dedupe_key=? AND lifecycle='opened'
      )
  `).run(now, subscriptionId, userId, channel, projectId, dedupeKey);
}

export function notificationWorkerTick(limit = 20): Promise<void> {
  return processDeliveries(limit);
}

async function processDeliveries(limit: number): Promise<void> {
  supersedeResolvedIncidentDeliveries();
  supersedeUnauthorizedDeliveries();
  for (let count = 0; count < limit; count += 1) {
    const delivery = claimDelivery();
    if (!delivery) return;
    const provider = notificationProviders[delivery.channel];
    if (!provider) {
      failDelivery(delivery, new Error(`Unknown provider ${delivery.channel}`));
      continue;
    }
    let addresses: string[] = [];
    try { addresses = JSON.parse(delivery.email_addresses_json) as string[]; } catch { addresses = []; }
    if (addresses.length === 0 && delivery.email) addresses = [delivery.email];
    try {
      await provider.deliver({
        userId: delivery.user_id,
        title: delivery.title,
        body: delivery.body,
        priority: delivery.priority,
        topic: activeNtfyTopic(delivery.user_id),
        emailAddresses: addresses,
        dedupeKey: delivery.dedupe_key,
      });
    } catch (error) {
      failDelivery(delivery, error);
      continue;
    }
    if (delivery.lifecycle === "opened" && delivery.dedupe_key && !one(db.prepare(`
      SELECT id FROM notification_incidents
      WHERE project_id=? AND dedupe_key=? AND status='open' AND opened_at<=?
    `), delivery.project_id, delivery.dedupe_key, delivery.occurred_at)) {
      db.prepare(`
        UPDATE notification_deliveries SET status='superseded', lease_until=NULL, updated_at=?
        WHERE id=? AND status='processing' AND lease_until=?
      `).run(nowIso(), delivery.id, delivery.lease_until);
      continue;
    }
    const deliveredAt = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      const completed = db.prepare(`
        UPDATE notification_deliveries SET status='delivered', delivered_at=?, lease_until=NULL,
          last_error=NULL, updated_at=? WHERE id=? AND status='processing' AND lease_until=?
      `).run(deliveredAt, deliveredAt, delivery.id, delivery.lease_until);
      if (!completed.changes) throw new Error("Delivery state changed before completion");
      scheduleRepeat(delivery, deliveredAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      const message = `Provider succeeded but completion persistence failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
      db.prepare(`
        UPDATE notification_deliveries SET status='failed', lease_until=NULL, last_error=?, updated_at=?
        WHERE id=? AND status='processing' AND lease_until=?
      `).run(message, nowIso(), delivery.id, delivery.lease_until);
    }
  }
}

function supersedeResolvedIncidentDeliveries(): void {
  const now = nowIso();
  db.prepare(`
    UPDATE notification_deliveries SET status='superseded', lease_until=NULL, updated_at=?
    WHERE (status='pending' OR (status='processing' AND lease_until<?))
      AND EXISTS (
        SELECT 1 FROM notification_events e
        JOIN notification_subscriptions s ON s.id=notification_deliveries.subscription_id
        WHERE e.id=notification_deliveries.event_id AND e.lifecycle='opened'
          AND s.recovery_summary_mode!='all'
           AND NOT EXISTS (
             SELECT 1 FROM notification_incidents i
             WHERE i.project_id=e.project_id AND i.dedupe_key=e.dedupe_key AND i.status='open'
               AND e.occurred_at>=i.opened_at
           )
      )
  `).run(now, now);
}

function supersedeUnauthorizedDeliveries(): void {
  const now = nowIso();
  db.prepare(`
    UPDATE notification_deliveries SET status='superseded', lease_until=NULL, updated_at=?
    WHERE (status='pending' OR (status='processing' AND lease_until<?)) AND (
      NOT EXISTS (SELECT 1 FROM users u WHERE u.id=notification_deliveries.user_id AND u.disabled=0 AND u.deleted_at IS NULL)
      OR NOT EXISTS (
        SELECT 1 FROM notification_events e JOIN notification_projects p ON p.id=e.project_id
        WHERE e.id=notification_deliveries.event_id AND p.enabled=1
      )
      OR NOT EXISTS (SELECT 1 FROM notification_subscriptions s WHERE s.id=notification_deliveries.subscription_id AND s.enabled=1)
      OR EXISTS (
        SELECT 1 FROM notification_events e JOIN users u ON u.id=notification_deliveries.user_id
        WHERE e.id=notification_deliveries.event_id AND u.role!='admin' AND NOT EXISTS (
          SELECT 1 FROM notification_project_members pm WHERE pm.project_id=e.project_id AND pm.user_id=u.id
        )
      )
    )
  `).run(now, now);
}

function claimDelivery(): DeliveryRow | undefined {
  const now = nowIso();
  const candidate = one<{ id: string }>(db.prepare(`
    SELECT d.id FROM notification_deliveries d
    JOIN notification_events e ON e.id=d.event_id
    JOIN notification_projects p ON p.id=e.project_id AND p.enabled=1
    JOIN users u ON u.id=d.user_id AND u.disabled=0 AND u.deleted_at IS NULL
    JOIN notification_subscriptions s ON s.id=d.subscription_id AND s.enabled=1
    WHERE d.status IN ('pending', 'processing') AND d.next_attempt_at<=?
      AND (u.role='admin' OR EXISTS (
        SELECT 1 FROM notification_project_members pm WHERE pm.project_id=e.project_id AND pm.user_id=u.id
      ))
      AND (e.lifecycle!='opened' OR s.recovery_summary_mode='all' OR EXISTS (
        SELECT 1 FROM notification_incidents i
        WHERE i.project_id=e.project_id AND i.dedupe_key=e.dedupe_key AND i.status='open'
          AND e.occurred_at>=i.opened_at
      ))
      AND (d.lease_until IS NULL OR d.lease_until<?)
    ORDER BY d.next_attempt_at, d.created_at LIMIT 1
  `), now, now);
  if (!candidate) return undefined;
  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  const changed = db.prepare(`
    UPDATE notification_deliveries SET status='processing', attempt_count=attempt_count+1,
      lease_until=?, updated_at=? WHERE id=? AND status IN ('pending', 'processing')
      AND (lease_until IS NULL OR lease_until<?)
  `).run(leaseUntil, now, candidate.id, now);
  if (Number(changed.changes) !== 1) return undefined;
  return one<DeliveryRow>(db.prepare(`
    SELECT d.*, e.title, e.body, COALESCE(s.delivery_priority, e.priority) AS priority,
      e.dedupe_key, e.lifecycle, e.project_id, e.occurred_at,
      u.email, u.timezone, s.email_addresses_json, s.cooldown_mode, s.cooldown_seconds, s.repeat_count,
      s.quiet_start, s.quiet_end
    FROM notification_deliveries d
    JOIN notification_events e ON e.id=d.event_id
    JOIN users u ON u.id=d.user_id
    JOIN notification_subscriptions s ON s.id=d.subscription_id
    WHERE d.id=?
  `), candidate.id);
}

function failDelivery(delivery: DeliveryRow, error: unknown): void {
  const now = nowIso();
  if (delivery.lifecycle === "opened" && delivery.dedupe_key && !one(db.prepare(`
    SELECT id FROM notification_incidents WHERE project_id=? AND dedupe_key=? AND status='open' AND opened_at<=?
  `), delivery.project_id, delivery.dedupe_key, delivery.occurred_at)) {
    db.prepare(`
      UPDATE notification_deliveries SET status='superseded', lease_until=NULL, updated_at=?
      WHERE id=? AND status='processing' AND lease_until=?
    `).run(now, delivery.id, delivery.lease_until);
    return;
  }
  const delay = retryDelaySeconds(delivery.attempt_count - 1);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  if (delay === null) {
    db.prepare(`
      UPDATE notification_deliveries SET status='failed', lease_until=NULL, last_error=?, updated_at=?
      WHERE id=? AND status='processing' AND lease_until=?
    `).run(message, now, delivery.id, delivery.lease_until);
  } else {
    db.prepare(`
      UPDATE notification_deliveries SET status='pending', lease_until=NULL, last_error=?, next_attempt_at=?, updated_at=?
      WHERE id=? AND status='processing' AND lease_until=?
    `).run(message, new Date(Date.now() + delay * 1000).toISOString(), now, delivery.id, delivery.lease_until);
  }
}

function scheduleRepeat(delivery: DeliveryRow, deliveredAt: string): void {
  if (delivery.channel === "in_app" || delivery.lifecycle !== "opened" || !delivery.dedupe_key) return;
  const nextIndex = delivery.repeat_index + 1;
  const boundedRepeat = delivery.cooldown_mode === "repeat_count" && nextIndex < delivery.repeat_count;
  const untilRecovery = delivery.cooldown_mode === "until_recovery";
  if (!boundedRepeat && !untilRecovery) return;
  const incident = one<{ id: string }>(db.prepare(`
    SELECT id FROM notification_incidents WHERE project_id=? AND dedupe_key=? AND status='open'
  `), delivery.project_id, delivery.dedupe_key);
  if (!incident) return;
  let next = new Date(new Date(deliveredAt).getTime() + delivery.cooldown_seconds * 1000);
  if (delivery.priority < 5 && delivery.quiet_start && delivery.quiet_end
    && isQuietTime(next, delivery.timezone, delivery.quiet_start, delivery.quiet_end)) {
    next = nextQuietEnd(next, delivery.timezone, delivery.quiet_start, delivery.quiet_end);
  }
  db.prepare(`
    INSERT OR IGNORE INTO notification_deliveries (
      id, event_id, subscription_id, user_id, channel, status, attempt_count, repeat_index,
      next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
  `).run(randomUUID(), delivery.event_id, delivery.subscription_id, delivery.user_id,
    delivery.channel, nextIndex, next.toISOString(), deliveredAt, deliveredAt);
}

export function projectForAlertSource(sourceType: string): string {
  if (sourceType === "node") return "infrastructure";
  if (sourceType === "endpoint" || sourceType === "endpoint_node") return "public-endpoints";
  if (sourceType === "ai" || sourceType === "ai_target" || sourceType === "ai_node") return "ai-upstreams";
  return "system";
}
