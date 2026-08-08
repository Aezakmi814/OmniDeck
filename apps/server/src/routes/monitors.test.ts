import assert from "node:assert/strict";
import test from "node:test";
import { aiTargetPatchSchema, endpointPatchSchema } from "./monitors.js";

test("endpoint patch does not inject create defaults", () => {
  const result = endpointPatchSchema.parse({ url: "https://example.com/health" });
  assert.deepEqual(result, { url: "https://example.com/health" });
  assert.equal("intervalSeconds" in result, false);
  assert.equal("probeNodeIds" in result, false);
});

test("AI target patch preserves omitted key and assignments", () => {
  const result = aiTargetPatchSchema.parse({ model: "probe-model" });
  assert.deepEqual(result, { model: "probe-model" });
  assert.equal("apiKey" in result, false);
  assert.equal("probeNodeIds" in result, false);
});
