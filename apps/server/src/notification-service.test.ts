import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("persists, deduplicates, delivers and resolves lifecycle events", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omnideck-notification-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  const { db, nowIso, one } = await import("./db.js");
  const { emitNotification, initializeNotificationCenter, notificationWorkerTick, syncSmtpRecipientSubscription } = await import("./notification-service.js");
  const { notificationProviders } = await import("./notification-providers.js");
  const { updateAlertState } = await import("./alerts.js");
  const { setSetting } = await import("./settings.js");
  initializeNotificationCenter();
  const root = one<{ id: string; password_hash: string }>(db.prepare("SELECT id, password_hash FROM users WHERE username='root'"))!;
  const project = one<{ id: string }>(db.prepare("SELECT id FROM notification_projects WHERE project_key='infrastructure'"))!;
  const now = nowIso();
  db.prepare(`
    INSERT INTO notification_subscriptions (
      id, user_id, channels_json, email_addresses_json, cooldown_mode, cooldown_seconds, repeat_count, created_at, updated_at
    ) VALUES ('unrelated-email-rule', ?, '["email"]', '["unrelated@example.com"]', 'once', 1800, 1, ?, ?)
  `).run(root.id, now, now);
  setSetting("smtp", JSON.stringify({ host: "smtp.example.com", port: 587, secure: false, username: "", password: "", from: "alerts@example.com", recipients: ["ops@example.com"] }), true);
  syncSmtpRecipientSubscription();
  assert.equal(one<{ email_addresses_json: string }>(db.prepare("SELECT email_addresses_json FROM notification_subscriptions WHERE id='unrelated-email-rule'"))?.email_addresses_json, '["unrelated@example.com"]');
  assert.ok(one(db.prepare("SELECT 1 FROM notification_subscriptions WHERE id='builtin:smtp-recipients'")));
  setSetting("smtp", JSON.stringify({ host: "smtp.example.com", port: 587, secure: false, username: "", password: "", from: "alerts@example.com", recipients: [] }), true);
  syncSmtpRecipientSubscription();
  db.prepare("DELETE FROM notification_subscriptions WHERE id='unrelated-email-rule'").run();
  db.prepare(`
    INSERT INTO notification_subscriptions (
      id, user_id, project_id, channels_json, cooldown_mode, cooldown_seconds, repeat_count, created_at, updated_at
    ) VALUES ('test-subscription', ?, ?, '["in_app"]', 'once', 1800, 1, ?, ?)
  `).run(root.id, project.id, now, now);
  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
    VALUES ('unassigned-viewer', 'unassigned-viewer', 'Unassigned viewer', ?, 'viewer', ?, ?)
  `).run(root.password_hash, now, now);
  db.prepare(`
    INSERT INTO notification_subscriptions (
      id, user_id, project_id, channels_json, cooldown_mode, cooldown_seconds, repeat_count, created_at, updated_at
    ) VALUES ('unauthorized-subscription', 'unassigned-viewer', ?, '["in_app"]', 'once', 1800, 1, ?, ?)
  `).run(project.id, now, now);

  const opened = emitNotification({
    projectKey: "infrastructure",
    eventKey: "alert.opened",
    idempotencyKey: "event-request-0001",
    dedupeKey: "node:test",
    data: { sourceName: "Test node", message: "offline" },
  });
  assert.equal(opened.deliveries, 1);
  assert.equal(emitNotification({
    projectKey: "infrastructure",
    eventKey: "alert.opened",
    idempotencyKey: "event-request-0001",
    dedupeKey: "node:test",
    data: { sourceName: "Test node", message: "offline" },
  }).duplicate, true);
  assert.equal(emitNotification({
    projectKey: "infrastructure",
    eventKey: "alert.opened",
    idempotencyKey: "event-request-0001",
    dedupeKey: "node:test",
    data: { message: "offline", sourceName: "Test node" },
  }).duplicate, true);
  assert.throws(() => emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-0001",
    dedupeKey: "node:test", data: { sourceName: "Test node", message: "different payload" },
  }), /different event payload/);
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-unicode-order",
    dedupeKey: "node:unicode-order", data: { sourceName: "Unicode node", message: "offline", "\u00e9": "composed", "e\u0301": "decomposed" },
  });
  assert.equal(emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-unicode-order",
    dedupeKey: "node:unicode-order", data: { "e\u0301": "decomposed", "\u00e9": "composed", message: "offline", sourceName: "Unicode node" },
  }).duplicate, true);
  await notificationWorkerTick();
  assert.equal(one<{ count: number }>(db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE status='delivered'"))?.count, 2);
  const openedAt = one<{ opened_at: string }>(db.prepare("SELECT opened_at FROM notification_incidents WHERE dedupe_key='node:test'"))!.opened_at;
  const repeated = emitNotification({
    projectKey: "infrastructure",
    eventKey: "alert.opened",
    idempotencyKey: "event-request-0001-repeat",
    dedupeKey: "node:test",
    data: { sourceName: "Test node", message: "still offline" },
  });
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM notification_deliveries WHERE event_id=?"), repeated.eventId)?.status, "suppressed");
  assert.equal(one<{ opened_at: string }>(db.prepare("SELECT opened_at FROM notification_incidents WHERE dedupe_key='node:test'"))?.opened_at, openedAt);

  db.prepare("INSERT INTO notification_project_members (project_id, user_id, permission, created_at) VALUES (?, 'unassigned-viewer', 'read', ?)")
    .run(project.id, nowIso());
  const permissionEvent = emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-permission",
    dedupeKey: "node:permission", data: { sourceName: "Permission test", message: "offline" },
  });
  db.prepare(`
    UPDATE notification_deliveries SET status='processing', lease_until='2020-01-01T00:00:00.000Z'
    WHERE event_id=? AND user_id='unassigned-viewer'
  `).run(permissionEvent.eventId);
  db.prepare("DELETE FROM notification_project_members WHERE project_id=? AND user_id='unassigned-viewer'").run(project.id);
  initializeNotificationCenter();
  assert.equal(one(db.prepare("SELECT 1 FROM notification_project_members WHERE project_id=? AND user_id='unassigned-viewer'"), project.id), undefined);
  await notificationWorkerTick();
  assert.equal(one<{ status: string }>(db.prepare(`
    SELECT status FROM notification_deliveries WHERE event_id=? AND user_id='unassigned-viewer'
  `), permissionEvent.eventId)?.status, "superseded");

  const recoveryAt = new Date(Date.now() + 10_000).toISOString();
  emitNotification({
    projectKey: "infrastructure",
    eventKey: "alert.recovered",
    idempotencyKey: "event-request-0002",
    dedupeKey: "node:test",
    data: { sourceName: "Test node", message: "online" },
    occurredAt: recoveryAt,
  });
  await notificationWorkerTick();
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM notification_incidents WHERE dedupe_key='node:test'"))?.status, "resolved");
  const staleOpening = emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-stale-open",
    dedupeKey: "node:test", data: { sourceName: "Test node", message: "stale" }, occurredAt: now,
  });
  assert.equal(staleOpening.deliveries, 0);
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM notification_incidents WHERE dedupe_key='node:test'"))?.status, "resolved");
  const recoveryWithoutOpening = emitNotification({
    projectKey: "infrastructure", eventKey: "alert.recovered", idempotencyKey: "event-request-recovery-first",
    dedupeKey: "node:reordered", data: { sourceName: "Reordered node", message: "online" }, occurredAt: recoveryAt,
  });
  assert.equal(recoveryWithoutOpening.deliveries, 1);
  assert.throws(() => emitNotification({
    projectKey: "infrastructure", eventKey: "alert.recovered", idempotencyKey: "event-request-recovery-first",
    dedupeKey: "node:reordered", data: { sourceName: "Reordered node", message: "online" },
    occurredAt: new Date(Date.now() + 20_000).toISOString(),
  }), /different event payload/);
  assert.equal(emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-open-second",
    dedupeKey: "node:reordered", data: { sourceName: "Reordered node", message: "stale" }, occurredAt: now,
  }).deliveries, 0);
  const orderedOpenAt = new Date(Date.now() + 40_000).toISOString();
  const newestOpenAt = new Date(Date.now() + 60_000).toISOString();
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-ordered-open-1",
    dedupeKey: "node:ordered-watermark", data: { sourceName: "Ordered node", message: "offline" }, occurredAt: orderedOpenAt,
  });
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-ordered-open-2",
    dedupeKey: "node:ordered-watermark", data: { sourceName: "Ordered node", message: "still offline" }, occurredAt: newestOpenAt,
  });
  assert.equal(emitNotification({
    projectKey: "infrastructure", eventKey: "alert.recovered", idempotencyKey: "event-request-ordered-stale-recovery",
    dedupeKey: "node:ordered-watermark", data: { sourceName: "Ordered node", message: "stale recovery" },
    occurredAt: new Date(Date.now() + 50_000).toISOString(),
  }).deliveries, 0);
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM notification_incidents WHERE dedupe_key='node:ordered-watermark'"))?.status, "open");
  assert.ok(emitNotification({
    projectKey: "infrastructure", eventKey: "alert.recovered", idempotencyKey: "event-request-ordered-current-recovery",
    dedupeKey: "node:ordered-watermark", data: { sourceName: "Ordered node", message: "online" },
    occurredAt: new Date(Date.now() + 70_000).toISOString(),
  }).deliveries > 0);
  const laterRecoveryAt = new Date(Date.now() + 30_000).toISOString();
  assert.equal(emitNotification({
    projectKey: "infrastructure", eventKey: "alert.recovered", idempotencyKey: "event-request-recovery-later",
    dedupeKey: "node:reordered", data: { sourceName: "Reordered node", message: "online again" }, occurredAt: laterRecoveryAt,
  }).deliveries, 0);
  assert.equal(emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-open-between",
    dedupeKey: "node:reordered", data: { sourceName: "Reordered node", message: "older than recovery" },
    occurredAt: new Date(Date.now() + 20_000).toISOString(),
  }).deliveries, 0);
  db.prepare("UPDATE notification_subscriptions SET cooldown_mode='repeat_count', repeat_count=3 WHERE id='test-subscription'").run();
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-repeat-chain-1",
    dedupeKey: "node:repeat-chain", data: { sourceName: "Repeat node", message: "offline" },
  });
  const overlapping = emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-repeat-chain-2",
    dedupeKey: "node:repeat-chain", data: { sourceName: "Repeat node", message: "still offline" },
  });
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM notification_deliveries WHERE event_id=?"), overlapping.eventId)?.status, "suppressed");
  await notificationWorkerTick();
  const oldGenerationEvent = emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-old-generation",
    dedupeKey: "node:generation", data: { sourceName: "Generation node", message: "first outage" },
    occurredAt: new Date(Date.now() + 120_000).toISOString(),
  });
  db.prepare("UPDATE notification_deliveries SET status='processing', lease_until='2020-01-01T00:00:00.000Z' WHERE event_id=?")
    .run(oldGenerationEvent.eventId);
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.recovered", idempotencyKey: "event-request-old-generation-recovery",
    dedupeKey: "node:generation", data: { sourceName: "Generation node", message: "online" },
    occurredAt: new Date(Date.now() + 150_000).toISOString(),
  });
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-new-generation",
    dedupeKey: "node:generation", data: { sourceName: "Generation node", message: "second outage" },
    occurredAt: new Date(Date.now() + 180_000).toISOString(),
  });
  await notificationWorkerTick();
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM notification_deliveries WHERE event_id=?"), oldGenerationEvent.eventId)?.status, "superseded");
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-delayed-generation-old",
    dedupeKey: "node:delayed-generation", data: { sourceName: "Delayed node", message: "first outage" },
    occurredAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  });
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.recovered", idempotencyKey: "event-request-delayed-generation-recovery",
    dedupeKey: "node:delayed-generation", data: { sourceName: "Delayed node", message: "online" },
    occurredAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
  });
  const delayedReopen = emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-delayed-generation-new",
    dedupeKey: "node:delayed-generation", data: { sourceName: "Delayed node", message: "second outage" },
    occurredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  });
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM notification_deliveries WHERE event_id=?"), delayedReopen.eventId)?.status, "pending");
  await notificationWorkerTick();
  for (const [id, recoveryMode] of [["merged-policy", "merged"], ["all-policy", "all"]] as const) {
    db.prepare(`
      INSERT INTO notification_subscriptions (
        id, user_id, project_id, channels_json, cooldown_mode, cooldown_seconds,
        repeat_count, recovery_summary_mode, created_at, updated_at
      ) VALUES (?, ?, ?, '["in_app"]', 'interval', 1800, 1, ?, ?, ?)
    `).run(id, root.id, project.id, recoveryMode, nowIso(), nowIso());
  }
  const policyOpening = emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-policy-open",
    dedupeKey: "node:policy", data: { sourceName: "Policy node", message: "offline" },
  });
  emitNotification({
    projectKey: "infrastructure", eventKey: "alert.recovered", idempotencyKey: "event-request-policy-recovery",
    dedupeKey: "node:policy", data: { sourceName: "Policy node", message: "online" },
    occurredAt: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.equal(one<{ status: string }>(db.prepare(`
    SELECT status FROM notification_deliveries WHERE event_id=? AND subscription_id='merged-policy'
  `), policyOpening.eventId)?.status, "superseded");
  assert.equal(one<{ status: string }>(db.prepare(`
    SELECT status FROM notification_deliveries WHERE event_id=? AND subscription_id='all-policy'
  `), policyOpening.eventId)?.status, "pending");
  db.prepare("DELETE FROM notification_subscriptions WHERE id IN ('merged-policy', 'all-policy')").run();
  await notificationWorkerTick();
  const originalInAppProvider = notificationProviders.in_app;
  let releaseFirstDelivery: (() => void) | undefined;
  let observeFirstDelivery: (() => void) | undefined;
  let deliveryCalls = 0;
  notificationProviders.in_app = {
    channel: "in_app",
    async deliver() {
      deliveryCalls += 1;
      if (deliveryCalls === 1) {
        observeFirstDelivery?.();
        await new Promise<void>((resolve) => { releaseFirstDelivery = resolve; });
      }
    },
  };
  try {
    const observed = new Promise<void>((resolve) => { observeFirstDelivery = resolve; });
    const leasedEvent = emitNotification({
      projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-lease-race",
      dedupeKey: "node:lease-race", data: { sourceName: "Lease node", message: "offline" },
    });
    const staleWorker = notificationWorkerTick(1);
    await observed;
    db.prepare("UPDATE notification_deliveries SET lease_until='2020-01-01T00:00:00.000Z' WHERE event_id=?").run(leasedEvent.eventId);
    await notificationWorkerTick(1);
    releaseFirstDelivery?.();
    await staleWorker;
    const finalDelivery = one<{ status: string; attempt_count: number; last_error: string | null }>(db.prepare(`
      SELECT status, attempt_count, last_error FROM notification_deliveries WHERE event_id=?
    `), leasedEvent.eventId)!;
    assert.equal(finalDelivery.status, "delivered");
    assert.equal(finalDelivery.attempt_count, 2);
    assert.equal(finalDelivery.last_error, null);
  } finally {
    notificationProviders.in_app = originalInAppProvider;
  }
  assert.throws(() => emitNotification({
    projectKey: "infrastructure",
    eventKey: "alert.opened",
    idempotencyKey: "event-request-0003",
    dedupeKey: "node:test-2",
    data: { sourceName: "Unsafe", apiToken: "secret" },
  }), /Sensitive field/);
  assert.throws(() => emitNotification({
    projectKey: "infrastructure", eventKey: "alert.opened", idempotencyKey: "event-request-future",
    dedupeKey: "node:future", data: { sourceName: "Future node", message: "offline" }, occurredAt: "9999-01-01T00:00:00.000Z",
  }), /5 minutes in the future/);
  db.prepare("UPDATE notification_projects SET enabled=0 WHERE id=?").run(project.id);
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await updateAlertState("node", "retry-alert", true, "Retry alert", "offline");
    assert.equal(one<{ notified_at: string | null }>(db.prepare("SELECT notified_at FROM alerts WHERE source_id='retry-alert'"))?.notified_at, null);
    db.prepare("UPDATE notification_projects SET enabled=1 WHERE id=?").run(project.id);
    await updateAlertState("node", "retry-alert", true, "Retry alert", "offline");
    assert.ok(one<{ notified_at: string | null }>(db.prepare("SELECT notified_at FROM alerts WHERE source_id='retry-alert'"))?.notified_at);
    db.prepare("UPDATE notification_projects SET enabled=0 WHERE id=?").run(project.id);
    await updateAlertState("node", "retry-alert", false, "Retry alert", "online");
    assert.equal(one<{ status: string; recovery_notified_at: string | null }>(db.prepare("SELECT status, recovery_notified_at FROM alerts WHERE source_id='retry-alert'"))?.recovery_notified_at, null);
    db.prepare("UPDATE notification_projects SET enabled=1 WHERE id=?").run(project.id);
    await updateAlertState("node", "retry-alert", false, "Retry alert", "online");
    assert.ok(one<{ recovery_notified_at: string | null }>(db.prepare("SELECT recovery_notified_at FROM alerts WHERE source_id='retry-alert'"))?.recovery_notified_at);
  } finally {
    console.error = originalConsoleError;
  }

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
