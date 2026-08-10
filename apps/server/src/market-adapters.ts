import { z } from "zod";

const PRICEAI_POINTER_URL = "https://data.priceai.cc/latest.json";
const PRICEAI_SNAPSHOT_PREFIX = "/v1/snapshots/";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();
const httpUrl = z.string().url().max(2000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Offer URL must use HTTP or HTTPS");

const priceAiOfferSchema = z.object({
  id: z.string().min(1).max(200),
  source_id: nullableString,
  source_name: z.string().min(1).max(300),
  source_store_name: nullableString,
  title: z.string().min(1).max(1000),
  price: z.number().nonnegative().finite(),
  currency: z.string().min(1).max(10),
  status: z.string().min(1).max(50),
  url: httpUrl,
  stock_count: nullableNumber,
  min_order_quantity: nullableNumber,
  captured_at: nullableString,
  last_seen_at: nullableString,
  verified_at: nullableString,
  expires_at: nullableString,
  effective_status: nullableString,
  freshness_status: nullableString,
}).passthrough();

const priceAiProductSchema = z.object({
  id: z.string().min(1).max(200),
  slug: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  platform: z.string().min(1).max(100),
  product_type: z.string().min(1).max(100),
  spec: nullableString,
  summary: nullableString,
  offer_count: z.number().int().nonnegative(),
  in_stock_count: z.number().int().nonnegative(),
  lowest_price: z.number().nonnegative().finite().nullable(),
  lowest_offer: priceAiOfferSchema.nullable(),
  latest_seen_at: nullableString,
  snapshot_generated_at: z.string().min(1),
  total: z.number().int().nonnegative(),
  top_offers: z.array(priceAiOfferSchema).max(100),
  presets: z.array(z.unknown()).default([]),
}).passthrough();

const priceAiSnapshotSchema = z.object({
  schema_version: z.literal("price-radar.v1"),
  snapshot_id: z.string().min(10).max(100),
  generated_at: z.string().min(1),
  published_at: z.string().min(1),
  stale: z.boolean(),
  products: z.array(priceAiProductSchema).max(1000),
}).passthrough();

const pointerSchema = z.object({
  schema_version: z.literal("price-radar.v1"),
  snapshot_id: z.string().min(10).max(100),
  snapshot_url: z.string().url(),
}).passthrough();

type PriceAiOffer = z.infer<typeof priceAiOfferSchema>;
type PriceAiSnapshot = z.infer<typeof priceAiSnapshotSchema>;

export interface NormalizedMarketOffer {
  externalId: string;
  sourceExternalId: string | null;
  sourceName: string;
  sourceStoreName: string | null;
  title: string;
  priceMinor: number;
  currency: string;
  status: string;
  stockCount: number | null;
  minOrderQuantity: number | null;
  url: string;
  capturedAt: string | null;
  lastSeenAt: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  effectiveStatus: string | null;
  freshnessStatus: string | null;
}

export interface NormalizedMarketProduct {
  externalId: string;
  slug: string;
  name: string;
  platform: string;
  productType: string;
  spec: string | null;
  summary: string | null;
  offerCount: number;
  inStockCount: number;
  lowestPriceMinor: number | null;
  latestSeenAt: string | null;
  snapshotGeneratedAt: string;
  visibleMedianPriceMinor: number | null;
  offers: NormalizedMarketOffer[];
}

export interface NormalizedMarketSnapshot {
  snapshotId: string;
  generatedAt: string;
  publishedAt: string;
  stale: boolean;
  partial: boolean;
  products: NormalizedMarketProduct[];
}

export interface MarketSourceAdapter {
  key: string;
  fetchSnapshot(previousSnapshotId?: string | null): Promise<{
    snapshotId: string;
    snapshot: NormalizedMarketSnapshot | null;
  }>;
}

export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Price must be a non-negative number");
  const minor = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(minor)) throw new Error("Price exceeds the supported range");
  return minor;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function isAvailableOffer(offer: Pick<NormalizedMarketOffer, "status" | "expiresAt">, now = Date.now()): boolean {
  if (offer.status !== "in_stock" && offer.status !== "low_stock") return false;
  if (!offer.expiresAt) return true;
  const expiresAt = Date.parse(offer.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function normalizeOffer(offer: PriceAiOffer): NormalizedMarketOffer {
  if (offer.currency.toUpperCase() !== "CNY") throw new Error(`Unsupported PriceAI currency: ${offer.currency}`);
  return {
    externalId: offer.id,
    sourceExternalId: offer.source_id ?? null,
    sourceName: offer.source_name,
    sourceStoreName: offer.source_store_name ?? null,
    title: offer.title,
    priceMinor: toMinorUnits(offer.price),
    currency: offer.currency.toUpperCase(),
    status: offer.status,
    stockCount: offer.stock_count ?? null,
    minOrderQuantity: offer.min_order_quantity ?? null,
    url: offer.url,
    capturedAt: offer.captured_at ?? null,
    lastSeenAt: offer.last_seen_at ?? null,
    verifiedAt: offer.verified_at ?? null,
    expiresAt: offer.expires_at ?? null,
    effectiveStatus: offer.effective_status ?? null,
    freshnessStatus: offer.freshness_status ?? null,
  };
}

export function normalizePriceAiSnapshot(input: unknown, now = Date.now()): NormalizedMarketSnapshot {
  const snapshot: PriceAiSnapshot = priceAiSnapshotSchema.parse(input);
  return {
    snapshotId: snapshot.snapshot_id,
    generatedAt: snapshot.generated_at,
    publishedAt: snapshot.published_at,
    stale: snapshot.stale,
    partial: true,
    products: snapshot.products.map((product) => {
      const offers = new Map<string, NormalizedMarketOffer>();
      for (const offer of product.top_offers) offers.set(offer.id, normalizeOffer(offer));
      if (product.lowest_offer && !offers.has(product.lowest_offer.id)) {
        offers.set(product.lowest_offer.id, normalizeOffer(product.lowest_offer));
      }
      const normalizedOffers = [...offers.values()];
      const availablePrices = normalizedOffers
        .filter((offer) => isAvailableOffer(offer, now))
        .map((offer) => offer.priceMinor);
      return {
        externalId: product.id,
        slug: product.slug,
        name: product.name,
        platform: product.platform,
        productType: product.product_type,
        spec: product.spec ?? null,
        summary: product.summary ?? null,
        offerCount: product.offer_count,
        inStockCount: product.in_stock_count,
        lowestPriceMinor: product.lowest_offer ? toMinorUnits(product.lowest_offer.price) : null,
        latestSeenAt: product.latest_seen_at ?? null,
        snapshotGeneratedAt: product.snapshot_generated_at,
        visibleMedianPriceMinor: median(availablePrices),
        offers: normalizedOffers,
      };
    }),
  };
}

function validateSnapshotUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "data.priceai.cc"
    || !url.pathname.startsWith(PRICEAI_SNAPSHOT_PREFIX) || !url.pathname.endsWith(".json")
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("PriceAI returned an unexpected snapshot URL");
  }
  return url.toString();
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "OmniDeck-PriceRadar/0.2" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`PriceAI request failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("PriceAI response exceeds the size limit");
  if (!response.body) throw new Error("PriceAI returned an empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("PriceAI response exceeds the size limit");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export const priceAiAdapter: MarketSourceAdapter = {
  key: "priceai-public-feed",
  async fetchSnapshot(previousSnapshotId) {
    const pointer = pointerSchema.parse(await fetchJson(PRICEAI_POINTER_URL));
    if (pointer.snapshot_id === previousSnapshotId) return { snapshotId: pointer.snapshot_id, snapshot: null };
    const snapshot = normalizePriceAiSnapshot(await fetchJson(validateSnapshotUrl(pointer.snapshot_url)));
    if (snapshot.snapshotId !== pointer.snapshot_id) throw new Error("PriceAI pointer and snapshot IDs do not match");
    return { snapshotId: pointer.snapshot_id, snapshot };
  },
};

export const marketSourceAdapters: Record<string, MarketSourceAdapter> = {
  [priceAiAdapter.key]: priceAiAdapter,
};
