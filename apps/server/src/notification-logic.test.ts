import assert from "node:assert/strict";
import test from "node:test";
import { findSensitiveField, isQuietTime, nextQuietEnd, normalizeChannels, renderNotificationTemplate, retryDelaySeconds } from "./notification-logic.js";

test("rejects sensitive fields recursively", () => {
  assert.equal(findSensitiveField({ request: { apiKey: "do-not-store" } }), "data.request.apiKey");
  assert.equal(findSensitiveField({ request: { identifier: "safe" } }), null);
});

test("renders nested structured event data", () => {
  assert.equal(renderNotificationTemplate("{{service.name}}: {{status}}", { service: { name: "gateway" }, status: 502 }), "gateway: 502");
});

test("quiet hours support periods crossing midnight", () => {
  const during = new Date("2026-08-09T15:30:00.000Z"); // 23:30 Asia/Shanghai
  assert.equal(isQuietTime(during, "Asia/Shanghai", "22:00", "07:00"), true);
  const end = nextQuietEnd(during, "Asia/Shanghai", "22:00", "07:00");
  assert.equal(end.toISOString(), "2026-08-09T23:00:00.000Z");
  const beforeSkippedHour = new Date("2026-03-08T06:00:00.000Z");
  assert.equal(nextQuietEnd(beforeSkippedHour, "America/New_York", "22:00", "02:30").toISOString(), "2026-03-08T07:00:00.000Z");
});

test("normalizes channels and exposes bounded retry policy", () => {
  assert.deepEqual(normalizeChannels(["ntfy", "in_app", "ntfy", "invalid"]), ["ntfy", "in_app"]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(retryDelaySeconds), [60, 300, 900, 3600, 21600, null]);
});
