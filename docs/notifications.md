# Notification Center

OmniDeck v0.3 routes internal alerts and external project events through one durable notification service. Business modules publish registered events; only providers communicate with in-app storage, SMTP, or ntfy.

## Delivery model

- A project belongs to a module and registers event types before publishing.
- Priorities are integers from 1 (lowest) to 5 (emergency).
- Subscriptions match an optional project and event type, then fan out independently to selected channels.
- Project membership is checked when a rule is saved and again when a queued delivery is claimed.
- Priority 5 bypasses quiet hours. Lower priorities wait until the user's quiet period ends.
- Opened and recovered lifecycle events share a `dedupeKey`. `merged` supersedes queued openings before recovery, `all` preserves both, and `recovery_only` suppresses opening deliveries.
- SQLite stores the outbox and 60-second worker leases. Failed providers retry after 1 minute, 5 minutes, 15 minutes, 1 hour, and 6 hours.
- Events and deliveries are retained for 90 days; opening events for unresolved incidents are exempt until recovery.

## External API

Create a project token in the notification administration view. Tokens are returned once and stored as SHA-256 hashes.

```http
POST /api/v1/projects/{projectKey}/events
Authorization: Bearer omni_proj_...
Idempotency-Key: 8-or-more-characters
Content-Type: application/json

{
  "eventType": "payment.failed",
  "priority": 4,
  "dedupeKey": "order-42",
  "data": { "orderId": "42", "reason": "gateway timeout" }
}
```

Event data is limited to 16 KiB and validated against the registered JSON Schema. Titles are limited to 200 characters and bodies to 4 KiB. Keys that appear to contain passwords, tokens, API keys, cookies, authorization headers, or private keys are rejected.

## ntfy isolation

Each enabled user receives a random ntfy username and private random topic. Each device receives its own one-year token. OmniDeck encrypts device tokens with `APP_ENCRYPTION_KEY` and displays a token only when created; the generated account password is never exposed to the user.

The GCP provisioner executes official ntfy `user`, `access`, and `token` commands against the configured auth file. Requests use a timestamp, nonce, and HMAC-SHA256 signature inside an FRP STCP tunnel carried over WSS. Request IDs make token creation reconcilable after uncertain retries. The provisioner does not use direct SQLite writes, Docker sockets, or SSH keys.
