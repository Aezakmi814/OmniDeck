import assert from "node:assert/strict";
import test from "node:test";
import { isAvailableOffer, median, normalizePriceAiSnapshot, toMinorUnits } from "./market-adapters.js";

function offer(id: string, price: number, status = "in_stock", expiresAt: string | null = "2026-08-11T00:00:00.000Z") {
  return {
    id,
    source_id: `source-${id}`,
    source_name: `Source ${id}`,
    source_store_name: `Store ${id}`,
    title: `Offer ${id}`,
    price,
    currency: "CNY",
    status,
    url: `https://example.com/${id}`,
    stock_count: status === "out_of_stock" ? 0 : 3,
    min_order_quantity: 1,
    captured_at: "2026-08-10T00:00:00.000Z",
    last_seen_at: "2026-08-10T00:00:00.000Z",
    verified_at: "2026-08-10T00:00:00.000Z",
    expires_at: expiresAt,
    effective_status: "available",
    freshness_status: "fresh",
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatgpt-go",
    slug: "chatgpt-go",
    name: "ChatGPT Go",
    platform: "ChatGPT",
    product_type: "subscription",
    spec: "Go",
    summary: "Monthly subscription",
    offer_count: 3,
    in_stock_count: 2,
    lowest_price: 10,
    lowest_offer: offer("a", 10),
    latest_seen_at: "2026-08-10T00:00:00.000Z",
    snapshot_generated_at: "2026-08-10T00:00:00.000Z",
    total: 3,
    top_offers: [offer("a", 10), offer("b", 20), offer("c", 5, "out_of_stock")],
    presets: [],
    ...overrides,
  };
}

function snapshot(products: unknown[]) {
  return {
    schema_version: "price-radar.v1",
    snapshot_id: "20260810000000-test",
    generated_at: "2026-08-10T00:00:00.000Z",
    published_at: "2026-08-10T00:05:00.000Z",
    stale: false,
    products,
  };
}

test("normalizes PriceAI money, visible offers and median", () => {
  const normalized = normalizePriceAiSnapshot(snapshot([product()]), Date.parse("2026-08-10T12:00:00.000Z"));
  const item = normalized.products[0];
  assert.equal(item.lowestPriceMinor, 1000);
  assert.equal(item.visibleMedianPriceMinor, 1500);
  assert.equal(item.offers.length, 3);
  assert.equal(item.offers[0].sourceStoreName, "Store a");
  assert.equal(toMinorUnits(36.95), 3695);
  assert.throws(() => toMinorUnits(1e308), /supported range/);
  assert.equal(median([300, 100, 200, 400]), 250);
});

test("distinguishes no available offer from a legitimate zero price", () => {
  const normalized = normalizePriceAiSnapshot(snapshot([
    product({ id: "none", slug: "none", lowest_price: 0, lowest_offer: null, top_offers: [offer("none", 10, "out_of_stock")] }),
    product({ id: "free", slug: "free", lowest_price: 0, lowest_offer: offer("free", 0), top_offers: [offer("free", 0)] }),
  ]), Date.parse("2026-08-10T12:00:00.000Z"));
  assert.equal(normalized.products[0].lowestPriceMinor, null);
  assert.equal(normalized.products[1].lowestPriceMinor, 0);
});

test("availability uses raw stock status and expiry", () => {
  assert.equal(isAvailableOffer({ status: "in_stock", expiresAt: "2026-08-11T00:00:00.000Z" }, Date.parse("2026-08-10T00:00:00.000Z")), true);
  assert.equal(isAvailableOffer({ status: "low_stock", expiresAt: null }), true);
  assert.equal(isAvailableOffer({ status: "out_of_stock", expiresAt: null }), false);
  assert.equal(isAvailableOffer({ status: "in_stock", expiresAt: "2026-08-09T00:00:00.000Z" }, Date.parse("2026-08-10T00:00:00.000Z")), false);
});

test("rejects incompatible PriceAI schema versions", () => {
  assert.throws(() => normalizePriceAiSnapshot({ ...snapshot([product()]), schema_version: "price-radar.v2" }), /Invalid input/);
  assert.throws(() => normalizePriceAiSnapshot(snapshot([
    product({ top_offers: [{ ...offer("bad-url", 10), url: "javascript:alert(1)" }] }),
  ])), /Offer URL must use HTTP or HTTPS/);
});
