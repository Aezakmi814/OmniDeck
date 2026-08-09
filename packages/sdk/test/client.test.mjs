import assert from "node:assert/strict";
import test from "node:test";
import { OmniDeckClient, OmniDeckError } from "../dist/index.js";

test("publishes an event with bearer and idempotency headers", async () => {
  let captured;
  const client = new OmniDeckClient({
    baseUrl: "https://example.test/",
    projectKey: "payments",
    token: "secret-token",
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ eventId: "event-1", duplicate: false, deliveries: 2 }), { status: 202 });
    },
  });
  const result = await client.publish({ eventType: "payment.failed", data: { orderId: "42" }, idempotencyKey: "request-42" });
  assert.equal(result.eventId, "event-1");
  assert.equal(captured.url, "https://example.test/api/v1/projects/payments/events");
  assert.equal(captured.init.headers.Authorization, "Bearer secret-token");
  assert.equal(captured.init.headers["Idempotency-Key"], "request-42");
});

test("throws a typed API error", async () => {
  const client = new OmniDeckClient({
    baseUrl: "https://example.test",
    projectKey: "payments",
    token: "secret-token",
    fetch: async () => new Response(JSON.stringify({ error: "event_rejected", message: "bad event" }), { status: 400 }),
  });
  await assert.rejects(() => client.publish({ eventType: "invalid" }), (error) => {
    assert.ok(error instanceof OmniDeckError);
    assert.equal(error.code, "event_rejected");
    return true;
  });
});
