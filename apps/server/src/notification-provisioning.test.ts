import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("provisioning jobs authenticate, encrypt and finalize device state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omnideck-provisioning-test-"));
  const key = "k".repeat(40);
  let holdProvision = false;
  let heldProvisionRequests = 0;
  let observedProvision: (() => void) | undefined;
  let releaseProvision: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const timestamp = String(request.headers["x-omni-timestamp"]);
    const nonce = String(request.headers["x-omni-nonce"]);
    const expected = createHmac("sha256", key).update(`${timestamp}\n${nonce}\n${body}`).digest("hex");
    assert.equal(request.headers["x-omni-signature"], expected);
    const input = JSON.parse(body) as { operation: string };
    if (holdProvision && input.operation === "provision" && heldProvisionRequests++ === 0) {
      observedProvision?.();
      await new Promise<void>((resolve) => { releaseProvision = resolve; });
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(input.operation === "provision"
      ? { token: "tk_test_device_token_12345678", expiresAt: "2027-08-09T00:00:00.000Z" }
      : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  process.env.NTFY_PROVISIONER_URL = `http://127.0.0.1:${address.port}`;
  process.env.NTFY_PROVISIONER_KEY = key;
  const { db, nowIso, one } = await import("./db.js");
  const {
    acknowledgeProvisionResult, createProvisionJob, provisionWorkerTick, queueProvisionJob,
    readProvisionResult, resumeProvisionJob,
  } = await import("./notification-provisioning.js");
  const user = one<{ id: string }>(db.prepare("SELECT id FROM users WHERE username='root'"))!;
  db.prepare(`
    INSERT INTO ntfy_accounts (user_id, username, topic, status, created_at, updated_at)
    VALUES (?, 'omni_u_abcdefgh', 'omni-user-abcdefghijklmnop', 'pending', ?, ?)
  `).run(user.id, nowIso(), nowIso());
  const result = await createProvisionJob(user.id, "provision", {
    username: "omni_u_abcdefgh", topic: "omni-user-abcdefghijklmnop",
    password: "generated-password-123456789", deviceName: "Test phone", expires: "8760h",
  });
  assert.equal(result.result.token, "tk_test_device_token_12345678");
  assert.equal(readProvisionResult(result.jobId, user.id)?.token, result.result.token);
  assert.equal(readProvisionResult(result.jobId, user.id)?.token, result.result.token);
  assert.equal(acknowledgeProvisionResult(result.jobId, user.id), true);
  assert.equal(readProvisionResult(result.jobId, user.id), null);
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM ntfy_accounts WHERE user_id=?"), user.id)?.status, "active");

  db.prepare("UPDATE ntfy_accounts SET status='error', generation=4 WHERE user_id=?").run(user.id);
  const retryJobId = queueProvisionJob(user.id, "provision", {
    username: "omni_u_abcdefgh", topic: "omni-user-abcdefghijklmnop",
    password: "generated-password-123456789", deviceName: "Retry phone", expires: "8760h", accountGeneration: 4,
  });
  db.prepare("UPDATE ntfy_provision_jobs SET status='failed' WHERE id=?").run(retryJobId);
  await resumeProvisionJob(retryJobId, user.id);
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM ntfy_accounts WHERE user_id=?"), user.id)?.status, "active");
  const device = one<{ name: string; token_encrypted: string }>(db.prepare("SELECT name, token_encrypted FROM ntfy_device_tokens WHERE user_id=?"), user.id);
  assert.equal(device?.name, "Test phone");
  assert.notEqual(device?.token_encrypted, result.result.token);

  db.prepare("UPDATE ntfy_accounts SET status='pending', generation=1 WHERE user_id=?").run(user.id);
  holdProvision = true;
  const observed = new Promise<void>((resolve) => { observedProvision = resolve; });
  const staleJob = createProvisionJob(user.id, "provision", {
    username: "omni_u_abcdefgh", topic: "omni-user-abcdefghijklmnop",
    password: "generated-password-123456789", deviceName: "Stale phone", expires: "8760h", accountGeneration: 1,
  });
  await observed;
  db.prepare("UPDATE ntfy_accounts SET status='disabled', generation=2 WHERE user_id=?").run(user.id);
  releaseProvision?.();
  await assert.rejects(staleJob, /superseded/);
  assert.equal(one<{ status: string; generation: number }>(db.prepare("SELECT status, generation FROM ntfy_accounts WHERE user_id=?"), user.id)?.status, "disabled");
  assert.equal(one<{ count: number }>(db.prepare("SELECT COUNT(*) AS count FROM ntfy_device_tokens WHERE user_id=?"), user.id)?.count, 1);

  db.prepare("UPDATE ntfy_accounts SET status='pending', generation=3 WHERE user_id=?").run(user.id);
  heldProvisionRequests = 0;
  holdProvision = true;
  const leaseObserved = new Promise<void>((resolve) => { observedProvision = resolve; });
  const staleLeaseJob = createProvisionJob(user.id, "provision", {
    username: "omni_u_abcdefgh", topic: "omni-user-abcdefghijklmnop",
    password: "generated-password-123456789", deviceName: "Lease phone", expires: "8760h", accountGeneration: 3,
  });
  await leaseObserved;
  const leaseJob = one<{ id: string }>(db.prepare("SELECT id FROM ntfy_provision_jobs WHERE status='processing' ORDER BY created_at DESC"))!;
  db.prepare("UPDATE ntfy_provision_jobs SET lease_until='2020-01-01T00:00:00.000Z' WHERE id=?").run(leaseJob.id);
  holdProvision = false;
  await provisionWorkerTick(1);
  releaseProvision?.();
  await assert.rejects(staleLeaseJob, /lease was lost/);
  assert.equal(one<{ status: string; attempt_count: number }>(db.prepare("SELECT status, attempt_count FROM ntfy_provision_jobs WHERE id=?"), leaseJob.id)?.status, "completed");
  assert.equal(one<{ status: string }>(db.prepare("SELECT status FROM ntfy_accounts WHERE user_id=?"), user.id)?.status, "active");

  db.close();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});
