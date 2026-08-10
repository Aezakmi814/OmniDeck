import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, many, nowIso, one } from "../db.js";
import { parseBody, requireAdmin, requireUser } from "../http.js";
import { isAvailableOffer } from "../market-adapters.js";
import { evaluateCurrentMarketWatches, forceMarketSync, getMarketSource, publicMarketSource } from "../market-service.js";
import { ensureMarketNotificationSubscription } from "../notification-service.js";

const daysSchema = z.object({
  days: z.coerce.number().int().refine((value) => [1, 7, 30, 90].includes(value), "请选择 1、7、30 或 90 天").default(30),
});

const watchCreateSchema = z.object({
  productId: z.string().uuid(),
  targetPriceMinor: z.number().int().positive().max(100_000_000),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default("CNY"),
  enabled: z.boolean().default(true),
});

const watchPatchSchema = z.object({
  targetPriceMinor: z.number().int().positive().max(100_000_000).optional(),
  enabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "至少修改一项");

interface ProductViewRow {
  id: string;
  canonical_key: string;
  name: string;
  platform: string;
  product_type: string;
  spec: string | null;
  summary: string | null;
  external_id: string | null;
  external_slug: string | null;
  offer_count: number | null;
  in_stock_count: number | null;
  lowest_price_minor: number | null;
  currency: string | null;
  latest_seen_at: string | null;
  snapshot_generated_at: string | null;
  store_name: string | null;
  offer_title: string | null;
  offer_url: string | null;
  stock_count: number | null;
}

interface WatchViewRow extends ProductViewRow {
  watch_id: string;
  user_id: string;
  target_price_minor: number;
  watch_currency: string;
  enabled: number;
  state: "waiting" | "met" | "unknown";
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OfferRow {
  external_offer_id: string;
  source_id_external: string | null;
  source_name: string;
  source_store_name: string | null;
  title: string;
  price_minor: number;
  currency: string;
  status: string;
  stock_count: number | null;
  min_order_quantity: number | null;
  url: string;
  captured_at: string | null;
  expires_at: string | null;
}

const productSelect = `
  SELECT p.*, sp.external_id, sp.external_slug, sp.offer_count, sp.in_stock_count,
    sp.lowest_price_minor, sp.currency, sp.latest_seen_at, sp.snapshot_generated_at,
    COALESCE(o.source_store_name, o.source_name) AS store_name,
    o.title AS offer_title, o.url AS offer_url, o.stock_count
  FROM market_products p
  LEFT JOIN market_source_products sp ON sp.product_id=p.id AND sp.active=1
  LEFT JOIN market_offers o ON o.rowid=(
    SELECT rowid FROM market_offers
    WHERE product_id=p.id AND active=1 AND status IN ('in_stock', 'low_stock')
      AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch('now'))
    ORDER BY price_minor LIMIT 1
  )
`;

function publicProduct(row: ProductViewRow) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    externalId: row.external_id,
    slug: row.external_slug,
    name: row.name,
    platform: row.platform,
    productType: row.product_type,
    spec: row.spec,
    summary: row.summary,
    offerCount: row.offer_count ?? 0,
    inStockCount: row.in_stock_count ?? 0,
    lowestPriceMinor: row.lowest_price_minor,
    currency: row.currency ?? "CNY",
    latestSeenAt: row.latest_seen_at,
    snapshotGeneratedAt: row.snapshot_generated_at,
    lowestOffer: row.offer_title ? {
      storeName: row.store_name,
      title: row.offer_title,
      url: row.offer_url,
      stockCount: row.stock_count,
    } : null,
  };
}

function publicWatch(row: WatchViewRow) {
  return {
    id: row.watch_id,
    productId: row.id,
    targetPriceMinor: row.target_price_minor,
    currency: row.watch_currency,
    enabled: Boolean(row.enabled),
    state: row.state,
    lastTriggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    product: publicProduct(row),
  };
}

function publicOffer(row: OfferRow) {
  return {
    id: row.external_offer_id,
    sourceId: row.source_id_external,
    sourceName: row.source_name,
    storeName: row.source_store_name ?? row.source_name,
    title: row.title,
    priceMinor: row.price_minor,
    currency: row.currency,
    status: row.status,
    available: isAvailableOffer({ status: row.status, expiresAt: row.expires_at }),
    stockCount: row.stock_count,
    minOrderQuantity: row.min_order_quantity,
    url: row.url,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
  };
}

function watchRows(userId: string): WatchViewRow[] {
  return many<WatchViewRow>(db.prepare(`
    SELECT base.*, w.id AS watch_id, w.user_id, w.target_price_minor,
      w.currency AS watch_currency, w.enabled, w.state, w.last_triggered_at,
      w.created_at, w.updated_at
    FROM (${productSelect}) base
    JOIN market_watch_rules w ON w.product_id=base.id
    WHERE w.user_id=?
    ORDER BY w.enabled DESC, base.name
  `), userId);
}

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/market/dashboard", async (request, reply) => {
    const actor = requireUser(request, reply);
    if (!actor) return;
    const parsed = daysSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "趋势周期无效" });
    const catalog = many<ProductViewRow>(db.prepare(`${productSelect} WHERE sp.product_id IS NOT NULL ORDER BY p.platform, p.name`));
    const watches = watchRows(actor.id);
    const totals = one<{ products: number; in_stock: number }>(db.prepare(`
      SELECT COUNT(*) AS products, COALESCE(SUM(in_stock_count), 0) AS in_stock
      FROM market_source_products WHERE active=1
    `)) ?? { products: 0, in_stock: 0 };
    return {
      source: publicMarketSource(getMarketSource()),
      summary: {
        catalogProducts: totals.products,
        watchedProducts: watches.filter((watch) => watch.enabled).length,
        targetsMet: watches.filter((watch) => watch.enabled && watch.state === "met").length,
        inStockOffers: totals.in_stock,
      },
      watches: watches.map(publicWatch),
      catalog: catalog.map(publicProduct),
      coverage: {
        kind: "partial",
        label: "PriceAI 公共快照",
        detail: "商品统计与当前 Top 报价，不代表全部商户报价",
      },
    };
  });

  app.get<{ Params: { id: string } }>("/api/market/products/:id/history", async (request, reply) => {
    const actor = requireUser(request, reply);
    if (!actor) return;
    const parsed = daysSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "趋势周期无效" });
    const product = one<ProductViewRow>(db.prepare(`${productSelect} WHERE p.id=?`), request.params.id);
    if (!product) return reply.code(404).send({ error: "not_found", message: "商品不存在" });
    const cutoff = new Date(Date.now() - parsed.data.days * 24 * 60 * 60 * 1000).toISOString();
    const points = many<Record<string, unknown>>(db.prepare(`
      SELECT observed_at AS time, lowest_price_minor, visible_median_price_minor,
        in_stock_count, offer_count, stale, partial
      FROM market_observations WHERE product_id=? AND observed_at>=? ORDER BY observed_at
    `), request.params.id, cutoff).map((point) => ({
      time: point.time,
      lowestPriceMinor: point.lowest_price_minor,
      visibleMedianPriceMinor: point.visible_median_price_minor,
      inStockCount: point.in_stock_count,
      offerCount: point.offer_count,
      stale: Boolean(point.stale),
      partial: Boolean(point.partial),
    }));
    const offers = many<OfferRow>(db.prepare(`
      SELECT * FROM market_offers WHERE product_id=? AND active=1
      ORDER BY CASE WHEN status IN ('in_stock', 'low_stock') THEN 0 ELSE 1 END, price_minor
    `), request.params.id);
    const watch = watchRows(actor.id).find((item) => item.id === request.params.id);
    return {
      product: publicProduct(product),
      offers: offers.map(publicOffer),
      points,
      watch: watch ? publicWatch(watch) : null,
      coverage: "partial",
    };
  });

  app.post("/api/market/watches", async (request, reply) => {
    const actor = requireUser(request, reply);
    if (!actor) return;
    const body = parseBody(watchCreateSchema, request.body, reply);
    if (!body) return;
    if (!one<{ id: string }>(db.prepare("SELECT id FROM market_products WHERE id=?"), body.productId)) {
      return reply.code(404).send({ error: "not_found", message: "商品不存在，请先同步市场数据" });
    }
    const id = randomUUID();
    const now = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (body.enabled) {
        const count = one<{ count: number }>(db.prepare("SELECT COUNT(*) AS count FROM market_watch_rules WHERE user_id=? AND enabled=1"), actor.id)?.count ?? 0;
        if (count >= 10) {
          db.exec("ROLLBACK");
          return reply.code(409).send({ error: "watch_limit", message: "第一期最多同时监控 10 个商品" });
        }
      }
      db.prepare(`
        INSERT INTO market_watch_rules (
          id, user_id, product_id, target_price_minor, currency, enabled, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
      `).run(id, actor.id, body.productId, body.targetPriceMinor, body.currency, Number(body.enabled), now, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "watch_exists", message: "这个商品已经在采购清单中" });
      throw error;
    }
    ensureMarketNotificationSubscription(actor.id);
    evaluateCurrentMarketWatches(body.productId, actor.id);
    audit(actor.id, "market_watch.created", "market_watch", id, {
      productId: body.productId, targetPriceMinor: body.targetPriceMinor, currency: body.currency,
    }, request.ip);
    const created = watchRows(actor.id).find((row) => row.watch_id === id)!;
    return reply.code(201).send({ watch: publicWatch(created) });
  });

  app.patch<{ Params: { id: string } }>("/api/market/watches/:id", async (request, reply) => {
    const actor = requireUser(request, reply);
    if (!actor) return;
    const body = parseBody(watchPatchSchema, request.body, reply);
    if (!body) return;
    db.exec("BEGIN IMMEDIATE");
    let watch: { id: string; user_id: string; product_id: string; target_price_minor: number; enabled: number };
    let enabled: number;
    try {
      const current = one<typeof watch>(
        db.prepare("SELECT id, user_id, product_id, target_price_minor, enabled FROM market_watch_rules WHERE id=?"), request.params.id,
      );
      if (!current) {
        db.exec("ROLLBACK");
        return reply.code(404).send({ error: "not_found", message: "采购规则不存在" });
      }
      watch = current;
      if (watch.user_id !== actor.id && actor.role !== "admin") {
        db.exec("ROLLBACK");
        return reply.code(403).send({ error: "forbidden", message: "只能修改自己的采购规则" });
      }
      if (body.enabled && !watch.enabled) {
        const count = one<{ count: number }>(db.prepare("SELECT COUNT(*) AS count FROM market_watch_rules WHERE user_id=? AND enabled=1"), watch.user_id)?.count ?? 0;
        if (count >= 10) {
          db.exec("ROLLBACK");
          return reply.code(409).send({ error: "watch_limit", message: "第一期最多同时监控 10 个商品" });
        }
      }
      const target = body.targetPriceMinor ?? watch.target_price_minor;
      enabled = body.enabled === undefined ? watch.enabled : Number(body.enabled);
      const resetState = body.targetPriceMinor !== undefined && body.targetPriceMinor !== watch.target_price_minor;
      db.prepare(`
        UPDATE market_watch_rules SET target_price_minor=?, enabled=?,
          state=CASE WHEN ?=1 THEN 'waiting' ELSE state END,
          notification_attempt=CASE WHEN ?=1 THEN 0 ELSE notification_attempt END,
          last_triggered_at=CASE WHEN ?=1 THEN NULL ELSE last_triggered_at END, updated_at=? WHERE id=?
      `).run(target, enabled, Number(resetState), Number(resetState), Number(resetState), nowIso(), watch.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (enabled) evaluateCurrentMarketWatches(watch.product_id, watch.user_id);
    audit(actor.id, "market_watch.updated", "market_watch", watch.id, body, request.ip);
    const updated = watchRows(watch.user_id).find((row) => row.watch_id === watch.id)!;
    return { watch: publicWatch(updated) };
  });

  app.delete<{ Params: { id: string } }>("/api/market/watches/:id", async (request, reply) => {
    const actor = requireUser(request, reply);
    if (!actor) return;
    const watch = one<{ id: string; user_id: string }>(db.prepare("SELECT id, user_id FROM market_watch_rules WHERE id=?"), request.params.id);
    if (!watch) return reply.code(404).send({ error: "not_found", message: "采购规则不存在" });
    if (watch.user_id !== actor.id && actor.role !== "admin") return reply.code(403).send({ error: "forbidden", message: "只能删除自己的采购规则" });
    db.prepare("DELETE FROM market_watch_rules WHERE id=?").run(watch.id);
    audit(actor.id, "market_watch.deleted", "market_watch", watch.id, {}, request.ip);
    return { ok: true };
  });

  app.post("/api/market/sync", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    try {
      const source = await forceMarketSync();
      audit(actor.id, "market_source.synced", "market_source", source?.id ?? null, {}, request.ip);
      return { source };
    } catch (error) {
      return reply.code(502).send({
        error: "market_sync_failed",
        message: error instanceof Error ? error.message : "市场数据同步失败",
      });
    }
  });
}
