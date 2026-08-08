import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret, hashPassword, hashToken, verifyPassword } from "./security.js";

test("password hashes verify without storing plaintext", () => {
  const encoded = hashPassword("A sufficiently long password");
  assert.notEqual(encoded, "A sufficiently long password");
  assert.equal(verifyPassword("A sufficiently long password", encoded), true);
  assert.equal(verifyPassword("wrong password", encoded), false);
});

test("encrypted secrets round trip and use randomized nonces", () => {
  const first = encryptSecret("sk-test-secret");
  const second = encryptSecret("sk-test-secret");
  assert.notEqual(first, second);
  assert.equal(decryptSecret(first), "sk-test-secret");
  assert.equal(decryptSecret(second), "sk-test-secret");
});

test("agent tokens are stored as fixed length hashes", () => {
  const digest = hashToken("agent-enrollment-token");
  assert.match(digest, /^[a-f0-9]{64}$/);
});
