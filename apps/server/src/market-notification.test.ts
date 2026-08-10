import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("market events create default subscriptions and target only the watch owner", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omnideck-market-notification-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  const { db, nowIso, one } = await import("./db.js");
  const { emitNotification, ensureMarketNotificationSubscription, initializeNotificationCenter } = await import("./notification-service.js");
  const root = one<{ id: string; password_hash: string }>(db.prepare("SELECT id, password_hash FROM users WHERE username='root'"))!;
  const now = nowIso();
  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
    VALUES ('market-viewer', 'market-viewer', 'Market Viewer', ?, 'viewer', ?, ?)
  `).run(root.password_hash, now, now);
  db.prepare(`
    INSERT INTO notification_projects (id, module_key, project_key, name, description, created_at, updated_at)
    VALUES ('builtin:market-intelligence', 'market-intelligence', 'market-intelligence', 'Market', '', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO settings (key, value, encrypted, updated_at)
    VALUES ('notification.builtin_members_migrated', '1', 0, ?)
  `).run(now);
  initializeNotificationCenter();
  db.prepare(`
    INSERT INTO notification_subscriptions (
      id, user_id, min_priority, channels_json, cooldown_mode, cooldown_seconds,
      repeat_count, created_at, updated_at
    ) VALUES ('priority-five-only', ?, 5, '["in_app"]', 'once', 1800, 1, ?, ?)
  `).run(root.id, now, now);
  ensureMarketNotificationSubscription(root.id);
  ensureMarketNotificationSubscription("market-viewer");

  const emitted = emitNotification({
    projectKey: "market-intelligence",
    eventKey: "price.target_met",
    targetUserId: root.id,
    idempotencyKey: "market-target-test-1",
    data: {
      productName: "ChatGPT Go",
      price: "36.00",
      currency: "CNY",
      storeName: "Example Store",
      offerTitle: "ChatGPT Go monthly",
      offerUrl: "https://example.com/offer",
      stock: 2,
      snapshotId: "snapshot-test-1",
    },
  });
  assert.equal(emitted.deliveries, 1);
  assert.equal(one<{ count: number }>(db.prepare("SELECT COUNT(*) AS count FROM notification_subscriptions WHERE user_id=?"), root.id)?.count, 2);
  assert.equal(one<{ user_id: string }>(db.prepare("SELECT user_id FROM notification_deliveries WHERE event_id=?"), emitted.eventId)?.user_id, root.id);
  assert.equal(one<{ count: number }>(db.prepare("SELECT COUNT(*) AS count FROM notification_project_members WHERE user_id='market-viewer' AND project_id='builtin:market-intelligence'"))?.count, 1);

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
