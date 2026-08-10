import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NormalizedMarketSnapshot } from "./market-adapters.js";

function snapshot(snapshotId: string, includeProduct: boolean): NormalizedMarketSnapshot {
  return {
    snapshotId,
    generatedAt: "2026-08-10T00:00:00.000Z",
    publishedAt: "2026-08-10T00:05:00.000Z",
    stale: false,
    partial: true,
    products: includeProduct ? [{
      externalId: "test-product",
      slug: "test-product",
      name: "Test product",
      platform: "ChatGPT",
      productType: "subscription",
      spec: "Monthly",
      summary: null,
      offerCount: 1,
      inStockCount: 1,
      lowestPriceMinor: 3000,
      latestSeenAt: "2026-08-10T00:00:00.000Z",
      snapshotGeneratedAt: "2026-08-10T00:00:00.000Z",
      visibleMedianPriceMinor: 3000,
      offers: [{
        externalId: "offer-1",
        sourceExternalId: "store-1",
        sourceName: "Test source",
        sourceStoreName: "Test store",
        title: "Test offer",
        priceMinor: 3000,
        currency: "CNY",
        status: "in_stock",
        stockCount: 3,
        minOrderQuantity: 1,
        url: "https://example.com/offer",
        capturedAt: "2026-08-10T00:00:00.000Z",
        lastSeenAt: "2026-08-10T00:00:00.000Z",
        verifiedAt: "2026-08-10T00:00:00.000Z",
        expiresAt: "2099-08-11T00:00:00.000Z",
        effectiveStatus: "available",
        freshnessStatus: "fresh",
      }],
    }] : [],
  };
}

test("market polling retires omitted products and fences stale workers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omnideck-market-service-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  const { db, nowIso, one } = await import("./db.js");
  const { marketSourceAdapters } = await import("./market-adapters.js");
  const { initializeNotificationCenter } = await import("./notification-service.js");
  const { evaluateCurrentMarketWatches, forceMarketSync, initializeMarketMonitoring } = await import("./market-service.js");
  initializeNotificationCenter();
  initializeMarketMonitoring();
  const original = marketSourceAdapters["priceai-public-feed"];
  try {
    let nextSnapshot = snapshot("snapshot-0001", true);
    marketSourceAdapters["priceai-public-feed"] = {
      key: "priceai-public-feed",
      async fetchSnapshot() { return { snapshotId: nextSnapshot.snapshotId, snapshot: nextSnapshot }; },
    };
    await forceMarketSync();
    const product = one<{ id: string }>(db.prepare("SELECT id FROM market_products WHERE canonical_key='ai-market:test-product'"))!;
    const root = one<{ id: string }>(db.prepare("SELECT id FROM users WHERE username='root'"))!;
    db.prepare(`
      INSERT INTO market_watch_rules (
        id, user_id, product_id, target_price_minor, currency, enabled, state, created_at, updated_at
      ) VALUES ('watch-retire', ?, ?, 4000, 'CNY', 1, 'met', ?, ?)
    `).run(root.id, product.id, nowIso(), nowIso());

    nextSnapshot = snapshot("snapshot-0002", false);
    await forceMarketSync();
    assert.equal(one<{ count: number }>(db.prepare("SELECT COUNT(*) AS count FROM market_offers WHERE active=1"))?.count, 0);
    assert.equal(one<{ active: number }>(db.prepare("SELECT active FROM market_source_products WHERE product_id=?"), product.id)?.active, 0);
    assert.equal(one<{ state: string }>(db.prepare("SELECT state FROM market_watch_rules WHERE id='watch-retire'"))?.state, "waiting");

    db.prepare(`
      INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
      SELECT 'disabled-market-user', 'disabled-market-user', 'Disabled market user', password_hash,
        'viewer', 1, ?, ? FROM users WHERE id=?
    `).run(nowIso(), nowIso(), root.id);
    db.prepare(`
      INSERT INTO market_watch_rules (
        id, user_id, product_id, target_price_minor, currency, enabled, state, created_at, updated_at
      ) VALUES ('watch-disabled', 'disabled-market-user', ?, 4000, 'CNY', 1, 'waiting', ?, ?)
    `).run(product.id, nowIso(), nowIso());
    nextSnapshot = snapshot("snapshot-0003", true);
    await forceMarketSync();
    assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM market_sources WHERE id='builtin:priceai-public-feed'"))?.status, "healthy");
    assert.equal(one<{ state: string }>(db.prepare("SELECT state FROM market_watch_rules WHERE id='watch-disabled'"))?.state, "waiting");
    db.prepare(`
      UPDATE notification_deliveries SET status='failed'
      WHERE user_id=? AND event_id IN (
        SELECT id FROM notification_events WHERE idempotency_key='watch:watch-retire:snapshot:snapshot-0003:attempt:0'
      )
    `).run(root.id);
    db.prepare("UPDATE market_watch_rules SET state='waiting' WHERE id='watch-retire'").run();
    evaluateCurrentMarketWatches(product.id, root.id);
    assert.equal(one<{ state: string }>(db.prepare("SELECT state FROM market_watch_rules WHERE id='watch-retire'"))?.state, "waiting");
    assert.equal(one<{ notification_attempt: number }>(db.prepare("SELECT notification_attempt FROM market_watch_rules WHERE id='watch-retire'"))?.notification_attempt, 1);
    evaluateCurrentMarketWatches(product.id, root.id);
    assert.equal(one<{ state: string }>(db.prepare("SELECT state FROM market_watch_rules WHERE id='watch-retire'"))?.state, "met");

    let markStarted!: () => void;
    let releaseFetch!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseFetch = resolve; });
    marketSourceAdapters["priceai-public-feed"] = {
      key: "priceai-public-feed",
      async fetchSnapshot() {
        markStarted();
        await blocked;
        const value = snapshot("snapshot-0004", false);
        return { snapshotId: value.snapshotId, snapshot: value };
      },
    };
    const polling = forceMarketSync();
    await started;
    const claimed = one<{ lease_token: string }>(db.prepare("SELECT lease_token FROM market_sources WHERE id='builtin:priceai-public-feed'"))!;
    assert.ok(claimed.lease_token);
    db.prepare(`
      UPDATE market_sources SET lease_token='replacement-lease', lease_until='2099-01-01T00:00:00.000Z'
      WHERE id='builtin:priceai-public-feed'
    `).run();
    releaseFetch();
    await assert.rejects(polling, /lease was lost/);
    const fenced = one<{ lease_token: string; lease_until: string }>(db.prepare("SELECT lease_token, lease_until FROM market_sources WHERE id='builtin:priceai-public-feed'"))!;
    assert.equal(fenced.lease_token, "replacement-lease");
    assert.equal(fenced.lease_until, "2099-01-01T00:00:00.000Z");
  } finally {
    marketSourceAdapters["priceai-public-feed"] = original;
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
