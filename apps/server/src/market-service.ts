import { randomUUID } from "node:crypto";
import { db, many, nowIso, one } from "./db.js";
import {
  isAvailableOffer,
  marketSourceAdapters,
  type NormalizedMarketOffer,
  type NormalizedMarketSnapshot,
} from "./market-adapters.js";
import { emitNotification, ensureMarketNotificationSubscription } from "./notification-service.js";

export const PRICEAI_SOURCE_ID = "builtin:priceai-public-feed";
const SOURCE_INTERVAL_SECONDS = 300;
const SOURCE_LEASE_SECONDS = 90;

interface MarketSourceRow {
  id: string;
  name: string;
  adapter_key: string;
  enabled: number;
  poll_interval_seconds: number;
  next_poll_at: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_snapshot_id: string | null;
  last_published_at: string | null;
  status: "pending" | "healthy" | "stale" | "error";
  stale: number;
  partial: number;
  last_error: string | null;
  lease_until: string | null;
  lease_token: string | null;
  updated_at: string;
}

interface CurrentOfferRow {
  external_offer_id: string;
  source_name: string;
  source_store_name: string | null;
  title: string;
  price_minor: number;
  currency: string;
  status: string;
  stock_count: number | null;
  url: string;
  expires_at: string | null;
}

interface WatchRow {
  id: string;
  user_id: string;
  product_id: string;
  target_price_minor: number;
  currency: string;
  state: "waiting" | "met" | "unknown";
  notification_attempt: number;
  name: string;
}

export interface TargetOfferCandidate {
  priceMinor: number;
  currency: string;
  status: string;
  expiresAt: string | null;
}

export function findTargetOffer<T extends TargetOfferCandidate>(
  offers: T[],
  targetPriceMinor: number,
  currency: string,
  now = Date.now(),
): T | null {
  return offers
    .filter((offer) => offer.currency === currency
      && offer.priceMinor <= targetPriceMinor
      && isAvailableOffer({ status: offer.status, expiresAt: offer.expiresAt }, now))
    .sort((left, right) => left.priceMinor - right.priceMinor)[0] ?? null;
}

export function initializeMarketMonitoring(): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO market_sources (
      id, name, adapter_key, enabled, poll_interval_seconds, next_poll_at,
      status, stale, partial, created_at, updated_at
    ) VALUES (?, 'PriceAI 公共价格雷达', 'priceai-public-feed', 1, ?, ?, 'pending', 0, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, adapter_key=excluded.adapter_key,
      poll_interval_seconds=excluded.poll_interval_seconds, partial=1, updated_at=excluded.updated_at
  `).run(PRICEAI_SOURCE_ID, SOURCE_INTERVAL_SECONDS, now, now, now);
}

export function publicMarketSource(row?: MarketSourceRow) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    adapterKey: row.adapter_key,
    enabled: Boolean(row.enabled),
    status: row.status,
    stale: Boolean(row.stale),
    partial: Boolean(row.partial),
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastSnapshotId: row.last_snapshot_id,
    lastPublishedAt: row.last_published_at,
    lastError: row.last_error,
    nextPollAt: row.next_poll_at,
  };
}

export function getMarketSource(): MarketSourceRow | undefined {
  return one<MarketSourceRow>(db.prepare("SELECT * FROM market_sources WHERE id=?"), PRICEAI_SOURCE_ID);
}

function claimSource(force: boolean): MarketSourceRow | undefined {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + SOURCE_LEASE_SECONDS * 1000).toISOString();
  const leaseToken = randomUUID();
  const result = db.prepare(`
    UPDATE market_sources SET lease_until=?, lease_token=?, last_attempt_at=?, updated_at=?
    WHERE id=? AND enabled=1 AND (lease_until IS NULL OR lease_until < ?)
      AND (?=1 OR next_poll_at <= ?)
  `).run(leaseUntil, leaseToken, now, now, PRICEAI_SOURCE_ID, now, Number(force), now);
  return result.changes ? getMarketSource() : undefined;
}

function releaseSource(source: MarketSourceRow, changes: {
  status: "healthy" | "stale" | "error";
  stale: boolean;
  lastSuccessAt?: string;
  lastSnapshotId?: string | null;
  lastPublishedAt?: string | null;
  lastError?: string | null;
}): boolean {
  const now = nowIso();
  const nextPollAt = new Date(Date.now() + source.poll_interval_seconds * 1000).toISOString();
  const result = db.prepare(`
    UPDATE market_sources SET status=?, stale=?, last_success_at=COALESCE(?, last_success_at),
      last_snapshot_id=COALESCE(?, last_snapshot_id), last_published_at=COALESCE(?, last_published_at),
      last_error=?, next_poll_at=?, lease_until=NULL, lease_token=NULL, updated_at=?
    WHERE id=? AND lease_token=?
  `).run(
    changes.status,
    Number(changes.stale),
    changes.lastSuccessAt ?? null,
    changes.lastSnapshotId ?? null,
    changes.lastPublishedAt ?? null,
    changes.lastError ?? null,
    nextPollAt,
    now,
    source.id,
    source.lease_token,
  );
  return Boolean(result.changes);
}

function assertSourceLease(source: MarketSourceRow): void {
  if (!source.lease_token || !one(db.prepare(
    "SELECT 1 FROM market_sources WHERE id=? AND lease_token=?",
  ), source.id, source.lease_token)) throw new Error("Market source lease was lost");
}

function upsertSnapshot(source: MarketSourceRow, snapshot: NormalizedMarketSnapshot): number {
  const now = nowIso();
  let offerCount = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    assertSourceLease(source);
    db.prepare("UPDATE market_source_products SET active=0 WHERE source_id=?").run(source.id);
    db.prepare("UPDATE market_offers SET active=0, updated_at=? WHERE source_id=?").run(now, source.id);
    for (const product of snapshot.products) {
      const canonicalKey = `ai-market:${product.slug}`;
      const existing = one<{ id: string }>(db.prepare("SELECT id FROM market_products WHERE canonical_key=?"), canonicalKey);
      const productId = existing?.id ?? randomUUID();
      db.prepare(`
        INSERT INTO market_products (
          id, canonical_key, name, platform, product_type, spec, summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_key) DO UPDATE SET name=excluded.name, platform=excluded.platform,
          product_type=excluded.product_type, spec=excluded.spec, summary=excluded.summary, updated_at=excluded.updated_at
      `).run(
        productId, canonicalKey, product.name, product.platform, product.productType,
        product.spec, product.summary, now, now,
      );
      const actualProductId = existing?.id ?? productId;
      db.prepare(`
        INSERT INTO market_source_products (
          source_id, product_id, external_id, external_slug, offer_count, in_stock_count,
          lowest_price_minor, currency, latest_seen_at, snapshot_generated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CNY', ?, ?, ?)
        ON CONFLICT(source_id, external_id) DO UPDATE SET product_id=excluded.product_id,
          external_slug=excluded.external_slug, offer_count=excluded.offer_count,
          in_stock_count=excluded.in_stock_count, lowest_price_minor=excluded.lowest_price_minor,
          currency=excluded.currency, latest_seen_at=excluded.latest_seen_at,
          snapshot_generated_at=excluded.snapshot_generated_at, active=1, updated_at=excluded.updated_at
      `).run(
        source.id, actualProductId, product.externalId, product.slug, product.offerCount,
        product.inStockCount, product.lowestPriceMinor, product.latestSeenAt,
        product.snapshotGeneratedAt, now,
      );

      for (const offer of product.offers) {
        offerCount += 1;
        db.prepare(`
          INSERT INTO market_offers (
            source_id, product_id, external_offer_id, source_id_external, source_name,
            source_store_name, title, price_minor, currency, status, stock_count,
            min_order_quantity, url, captured_at, last_seen_at, verified_at, expires_at,
            effective_status, freshness_status, active, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(source_id, product_id, external_offer_id) DO UPDATE SET
            source_id_external=excluded.source_id_external, source_name=excluded.source_name,
            source_store_name=excluded.source_store_name, title=excluded.title,
            price_minor=excluded.price_minor, currency=excluded.currency, status=excluded.status,
            stock_count=excluded.stock_count, min_order_quantity=excluded.min_order_quantity,
            url=excluded.url, captured_at=excluded.captured_at, last_seen_at=excluded.last_seen_at,
            verified_at=excluded.verified_at, expires_at=excluded.expires_at,
            effective_status=excluded.effective_status, freshness_status=excluded.freshness_status,
            active=1, updated_at=excluded.updated_at
        `).run(
          source.id, actualProductId, offer.externalId, offer.sourceExternalId, offer.sourceName,
          offer.sourceStoreName, offer.title, offer.priceMinor, offer.currency, offer.status,
          offer.stockCount === null ? null : Math.trunc(offer.stockCount),
          offer.minOrderQuantity === null ? null : Math.trunc(offer.minOrderQuantity),
          offer.url, offer.capturedAt, offer.lastSeenAt, offer.verifiedAt, offer.expiresAt,
          offer.effectiveStatus, offer.freshnessStatus, now,
        );
      }
      db.prepare(`
        INSERT OR IGNORE INTO market_observations (
          source_id, product_id, snapshot_id, observed_at, published_at, lowest_price_minor,
          visible_median_price_minor, in_stock_count, offer_count, stale, partial
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        source.id, actualProductId, snapshot.snapshotId, snapshot.publishedAt, snapshot.publishedAt,
        product.lowestPriceMinor, product.visibleMedianPriceMinor, product.inStockCount,
        product.offerCount, Number(snapshot.stale), Number(snapshot.partial),
      );
    }
    db.exec("COMMIT");
    return offerCount;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function evaluateWatches(
  snapshot: Pick<NormalizedMarketSnapshot, "snapshotId" | "stale">,
  productId?: string,
  userId?: string,
  leaseSource?: MarketSourceRow,
): void {
  if (snapshot.stale) return;
  if (leaseSource) assertSourceLease(leaseSource);
  const watches = many<WatchRow>(db.prepare(`
    SELECT w.*, p.name FROM market_watch_rules w
    JOIN market_products p ON p.id=w.product_id
    JOIN users u ON u.id=w.user_id
    WHERE w.enabled=1 AND u.disabled=0 AND u.deleted_at IS NULL
      AND (? IS NULL OR w.product_id=?) AND (? IS NULL OR w.user_id=?)
  `), productId ?? null, productId ?? null, userId ?? null, userId ?? null);
  const now = nowIso();
  for (const watch of watches) {
    if (leaseSource) assertSourceLease(leaseSource);
    const offers = many<CurrentOfferRow>(db.prepare(`
      SELECT external_offer_id, source_name, source_store_name, title, price_minor,
        currency, status, stock_count, url, expires_at
      FROM market_offers
      WHERE product_id=? AND active=1
      ORDER BY price_minor
    `), watch.product_id);
    const matched = findTargetOffer(offers.map((offer) => ({
      ...offer,
      priceMinor: offer.price_minor,
      expiresAt: offer.expires_at,
    })), watch.target_price_minor, watch.currency);
    if (!matched) {
      if (watch.state !== "waiting" || watch.notification_attempt !== 0) {
        db.prepare("UPDATE market_watch_rules SET state='waiting', notification_attempt=0, updated_at=? WHERE id=?").run(now, watch.id);
      }
      continue;
    }
    if (watch.state === "met") continue;
    try {
      const storeName = matched.source_store_name ?? matched.source_name;
      ensureMarketNotificationSubscription(watch.user_id);
      const notification = emitNotification({
        projectKey: "market-intelligence",
        eventKey: "price.target_met",
        targetUserId: watch.user_id,
        priority: 4,
        idempotencyKey: `watch:${watch.id}:snapshot:${snapshot.snapshotId}:attempt:${watch.notification_attempt}`,
        deliveryFence: leaseSource ? () => Boolean(one(db.prepare(
          "SELECT 1 FROM market_sources WHERE id=? AND lease_token=?",
        ), leaseSource.id, leaseSource.lease_token)) : undefined,
        data: {
          productName: watch.name.slice(0, 200),
          price: (matched.price_minor / 100).toFixed(2),
          currency: matched.currency,
          storeName: storeName.slice(0, 200),
          offerTitle: matched.title.slice(0, 500),
          offerUrl: matched.url,
          stock: matched.stock_count,
          snapshotId: snapshot.snapshotId,
        },
      });
      const hasDelivery = notification.deliveries > 0 || Boolean(one(db.prepare(`
        SELECT 1 FROM notification_deliveries
        WHERE event_id=? AND user_id=? AND status IN ('pending', 'processing', 'delivered') LIMIT 1
      `), notification.eventId, watch.user_id));
      if (!hasDelivery) {
        db.prepare("UPDATE market_watch_rules SET notification_attempt=notification_attempt+1, updated_at=? WHERE id=?")
          .run(now, watch.id);
        continue;
      }
      db.prepare("UPDATE market_watch_rules SET state='met', last_triggered_at=?, updated_at=? WHERE id=?")
        .run(now, now, watch.id);
    } catch { /* Keep the rule waiting so a later snapshot can retry. */ }
  }
}

export function evaluateCurrentMarketWatches(productId?: string, userId?: string): void {
  const source = getMarketSource();
  if (!source?.last_snapshot_id || source.stale || source.status !== "healthy") return;
  evaluateWatches({ snapshotId: source.last_snapshot_id, stale: false }, productId, userId);
}

let activePoll: Promise<void> | null = null;

async function pollClaimedSource(source: MarketSourceRow): Promise<void> {
  const runId = randomUUID();
  const startedAt = nowIso();
  db.prepare("INSERT INTO market_poll_runs (id, source_id, started_at, status) VALUES (?, ?, ?, 'running')")
    .run(runId, source.id, startedAt);
  try {
    const adapter = marketSourceAdapters[source.adapter_key];
    if (!adapter) throw new Error(`Unknown market adapter: ${source.adapter_key}`);
    const result = await adapter.fetchSnapshot(source.last_snapshot_id);
    if (!result.snapshot) {
      evaluateWatches({ snapshotId: result.snapshotId, stale: Boolean(source.stale) }, undefined, undefined, source);
      if (!releaseSource(source, {
        status: source.stale ? "stale" : "healthy",
        stale: Boolean(source.stale),
        lastSuccessAt: nowIso(),
        lastSnapshotId: result.snapshotId,
        lastError: null,
      })) throw new Error("Market source lease was lost before completion");
      db.prepare(`
        UPDATE market_poll_runs SET finished_at=?, status='skipped', snapshot_id=? WHERE id=?
      `).run(nowIso(), result.snapshotId, runId);
      return;
    }
    const offerCount = upsertSnapshot(source, result.snapshot);
    evaluateWatches(result.snapshot, undefined, undefined, source);
    if (!releaseSource(source, {
      status: result.snapshot.stale ? "stale" : "healthy",
      stale: result.snapshot.stale,
      lastSuccessAt: nowIso(),
      lastSnapshotId: result.snapshot.snapshotId,
      lastPublishedAt: result.snapshot.publishedAt,
      lastError: null,
    })) throw new Error("Market source lease was lost before completion");
    db.prepare(`
      UPDATE market_poll_runs SET finished_at=?, status='completed', snapshot_id=?,
        product_count=?, offer_count=? WHERE id=?
    `).run(nowIso(), result.snapshot.snapshotId, result.snapshot.products.length, offerCount, runId);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    releaseSource(source, { status: "error", stale: Boolean(source.stale), lastError: message });
    db.prepare("UPDATE market_poll_runs SET finished_at=?, status='failed', error=? WHERE id=?")
      .run(nowIso(), message, runId);
    throw error;
  }
}

async function runMarketPoll(force: boolean): Promise<void> {
  if (activePoll) return activePoll;
  const source = claimSource(force);
  if (!source) return;
  activePoll = pollClaimedSource(source).finally(() => { activePoll = null; });
  return activePoll;
}

export function marketWorkerTick(): Promise<void> {
  if (process.env.NODE_ENV === "test" && process.env.MARKET_POLLING_ENABLED !== "true") return Promise.resolve();
  return runMarketPoll(false);
}

export async function forceMarketSync(): Promise<ReturnType<typeof publicMarketSource>> {
  if (activePoll) await activePoll;
  await runMarketPoll(true);
  return publicMarketSource(getMarketSource());
}
