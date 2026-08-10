# Market Intelligence

OmniDeck's market module separates source collection, product identity, price history, procurement rules, and notification delivery. The initial implementation monitors five to ten user-selected products while retaining a complete 90-day observation window for every product present in the PriceAI public snapshot.

## PriceAI source

- Discovery: `https://priceai.cc/.well-known/price-radar.json`
- Pointer: `https://data.priceai.cc/latest.json`
- Schema: `https://priceai.cc/price-radar-v1.schema.json`
- Poll interval: five minutes
- Authentication: none

The adapter checks the small pointer first and downloads the immutable snapshot only when `snapshot_id` changes. Snapshot URLs must use HTTPS, the exact `data.priceai.cc` host, and the `/v1/snapshots/*.json` path. Requests have a timeout and a 5 MiB response limit.

PriceAI labels this public feed as partial coverage. It publishes aggregate counts and current Top offers, not all merchant offers. OmniDeck therefore labels Top-offer median and trend statistics as visible-market metrics and never presents them as full-market medians.

## Adapter boundary

`MarketSourceAdapter` returns a `NormalizedMarketSnapshot` containing canonical source product fields, visible offers, stock state, source timestamps, and coverage flags. New adapters must:

- use a documented or explicitly authorized source;
- validate input before persistence;
- keep external IDs separate from canonical OmniDeck IDs;
- preserve original offer title, store name, source URL, currency, and timestamps;
- use integer minor currency units;
- report partial or stale coverage honestly;
- avoid arbitrary user-provided URLs unless SSRF, DNS rebinding, redirect, and response-size controls are implemented.

Adapters are registered explicitly in `marketSourceAdapters`; database configuration cannot load executable adapter code.

## Procurement rules

A rule belongs to one user and one canonical product. It triggers when a fresh visible offer:

- uses the rule currency;
- has raw status `in_stock` or `low_stock`;
- has not expired; and
- is at or below the target price.

The state machine sends only on a `waiting` or `unknown` to `met` transition. A later fresh snapshot above the target resets the rule to `waiting`. Notifications are targeted to the rule owner and use that user's existing notification subscription; OmniDeck creates an in-app market subscription when none exists.

## Internal API

- `GET /api/market/dashboard?days=1|7|30|90`
- `GET /api/market/products/{id}/history?days=1|7|30|90`
- `POST /api/market/watches`
- `PATCH /api/market/watches/{id}`
- `DELETE /api/market/watches/{id}`
- `POST /api/market/sync` (admin only)

The first release limits each user to ten active procurement rules. Future merchant-specific rules can be added without changing the adapter contract or notification providers.
