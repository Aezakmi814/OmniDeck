import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { db, nowIso, one } from "./db.js";
import { decryptSecret, encryptSecret, randomToken } from "./security.js";

export type ProvisionOperation = "provision" | "add-device" | "revoke-device" | "disable-account";

export interface ProvisionRequest {
  username: string;
  topic?: string;
  password?: string;
  deviceName?: string;
  token?: string;
  expires?: string;
  requestId?: string;
  accountGeneration?: number;
}

export interface ProvisionResult {
  token?: string;
  expiresAt?: string;
}

interface JobRow {
  id: string;
  user_id: string | null;
  operation: ProvisionOperation;
  request_json: string;
  attempt_count: number;
  status: string;
  lease_until: string;
}

function secretFromFile(path: string | undefined): string {
  if (!path) return "";
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

function provisionerConfig(): { url: string; key: string } {
  return {
    url: (config.NTFY_PROVISIONER_URL ?? "").replace(/\/$/, ""),
    key: config.NTFY_PROVISIONER_KEY ?? secretFromFile(config.NTFY_PROVISIONER_KEY_FILE),
  };
}

async function requestProvisioner(operation: ProvisionOperation, payload: ProvisionRequest): Promise<ProvisionResult> {
  const settings = provisionerConfig();
  if (!settings.url || !settings.key) throw new Error("ntfy provisioner is not configured");
  const body = JSON.stringify({ operation, ...payload });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomToken(18);
  const signature = createHmac("sha256", settings.key)
    .update(`${timestamp}\n${nonce}\n${body}`)
    .digest("hex");
  const response = await fetch(`${settings.url}/v1/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Omni-Timestamp": timestamp,
      "X-Omni-Nonce": nonce,
      "X-Omni-Signature": signature,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as ProvisionResult & { error?: string };
  if (!response.ok) throw new Error(result.error || `ntfy provisioner returned HTTP ${response.status}`);
  return result;
}

export async function createProvisionJob(
  userId: string | null,
  operation: ProvisionOperation,
  payload: ProvisionRequest,
): Promise<{ jobId: string; result: ProvisionResult }> {
  const id = queueProvisionJob(userId, operation, payload);
  try {
    const result = await processJob(id);
    return { jobId: id, result };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { jobId: id });
  }
}

export async function resumeProvisionJob(jobId: string, userId: string): Promise<ProvisionResult> {
  const now = nowIso();
  const job = one<{ operation: ProvisionOperation; account_username: string | null; account_generation: number | null }>(db.prepare(`
    SELECT operation, account_username, account_generation FROM ntfy_provision_jobs
    WHERE id=? AND user_id=? AND status IN ('pending', 'failed')
  `), jobId, userId);
  if (!job) throw new Error("Provisioning job cannot be resumed");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (job.operation === "provision") {
      const account = db.prepare(`
        UPDATE ntfy_accounts SET status='pending', last_error=NULL, updated_at=?
        WHERE user_id=? AND username=? AND generation=? AND status IN ('pending', 'error')
      `).run(now, userId, job.account_username, job.account_generation);
      if (!account.changes) throw new Error("Provisioning job no longer matches the current ntfy account");
    }
    const resumed = db.prepare(`
      UPDATE ntfy_provision_jobs SET status='pending', attempt_count=0, next_attempt_at=?,
        lease_until=NULL, last_error=NULL, updated_at=?
      WHERE id=? AND user_id=? AND status IN ('pending', 'failed')
    `).run(now, now, jobId, userId);
    if (!resumed.changes) throw new Error("Provisioning job cannot be resumed");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return processJob(jobId);
}

export function queueProvisionJob(
  userId: string | null,
  operation: ProvisionOperation,
  payload: ProvisionRequest,
): string {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO ntfy_provision_jobs (
      id, user_id, operation, request_json, status, next_attempt_at,
      account_username, account_generation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(id, userId, operation, encryptSecret(JSON.stringify({ ...payload, requestId: id })), now,
    payload.username, payload.accountGeneration ?? null, now, now);
  return id;
}

async function processJob(id: string): Promise<ProvisionResult> {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  const claimed = db.prepare(`
    UPDATE ntfy_provision_jobs SET status='processing', attempt_count=attempt_count+1,
      lease_until=?, updated_at=? WHERE id=? AND (
        status='pending' OR (status='processing' AND lease_until<?)
      )
  `).run(leaseUntil, now, id, now);
  if (!claimed.changes) throw new Error("Provisioning job is not claimable");
  const job = one<JobRow>(db.prepare("SELECT * FROM ntfy_provision_jobs WHERE id=?"), id);
  if (!job) throw new Error("Provisioning job does not exist");
  try {
    const payload = JSON.parse(decryptSecret(job.request_json)) as ProvisionRequest;
    const result = await requestProvisioner(job.operation, payload);
    if (!one(db.prepare(`
      SELECT id FROM ntfy_provision_jobs WHERE id=? AND status='processing' AND lease_until=?
    `), id, job.lease_until)) {
      throw new Error("Provisioning lease was lost before completion");
    }
    if ((job.operation === "provision" || job.operation === "add-device") && job.user_id) {
      const current = one<{ username: string; status: string; generation: number }>(db.prepare(`
        SELECT username, status, generation FROM ntfy_accounts WHERE user_id=?
      `), job.user_id);
      const expectedStatus = job.operation === "provision" ? "pending" : "active";
      if (!current || current.username !== payload.username || current.status !== expectedStatus
        || current.generation !== (payload.accountGeneration ?? 0)) {
        if (job.operation === "provision") {
          try {
            await requestProvisioner("disable-account", { username: payload.username });
          } catch {
            queueProvisionJob(null, "disable-account", { username: payload.username });
          }
        } else if (result.token) {
          try {
            await requestProvisioner("revoke-device", { username: payload.username, token: result.token });
          } catch {
            queueProvisionJob(null, "revoke-device", { username: payload.username, token: result.token });
          }
        }
        throw Object.assign(new Error("Provisioning job was superseded by a newer account operation"), { stale: true });
      }
    }
    const completedAt = nowIso();
    const returnsCredentials = job.operation === "provision" || job.operation === "add-device";
    db.exec("BEGIN IMMEDIATE");
    try {
      finalizeProvisioning(job, payload, result);
      const completed = db.prepare(`
        UPDATE ntfy_provision_jobs SET status='completed', result_encrypted=?, request_json=?, lease_until=NULL,
          last_error=NULL, updated_at=? WHERE id=? AND status='processing' AND lease_until=?
      `).run(returnsCredentials ? encryptSecret(JSON.stringify(result)) : null, returnsCredentials ? job.request_json : "", completedAt, id, job.lease_until);
      if (!completed.changes) throw new Error("Provisioning job state changed before completion");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return result;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const failedAt = nowIso();
    const stale = Boolean((error as { stale?: boolean }).stale);
    const cleanupOperation = job.operation === "disable-account" || job.operation === "revoke-device";
    const delay = stale ? null : ([60, 300, 900, 3600, 21600][job.attempt_count - 1] ?? (cleanupOperation ? 21600 : null));
    const failed = db.prepare(`
      UPDATE ntfy_provision_jobs SET status=?, next_attempt_at=?, lease_until=NULL,
        last_error=?, updated_at=? WHERE id=? AND status='processing' AND lease_until=?
    `).run(delay === null ? "failed" : "pending", delay === null ? failedAt : new Date(Date.now() + delay * 1000).toISOString(), message, failedAt, id, job.lease_until);
    if (failed.changes && delay === null && !stale && job.operation === "provision" && job.user_id) {
      const payload = JSON.parse(decryptSecret(job.request_json)) as ProvisionRequest;
      db.prepare(`
        UPDATE ntfy_accounts SET status='error', last_error=?, updated_at=?
        WHERE user_id=? AND username=? AND generation=? AND status='pending'
      `).run(message, failedAt, job.user_id, payload.username, payload.accountGeneration ?? 0);
    }
    throw error;
  }
}

function finalizeProvisioning(job: JobRow, payload: ProvisionRequest, result: ProvisionResult): void {
  if (!job.user_id) return;
  const now = nowIso();
  if (job.operation === "provision" || job.operation === "add-device") {
    if (!result.token) throw new Error("Provisioner did not return a device token");
    const expiresAt = result.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();
    const hint = result.token.slice(-8);
    const account = one<{ username: string; status: string; generation: number }>(db.prepare("SELECT username, status, generation FROM ntfy_accounts WHERE user_id=?"), job.user_id);
    const expectedStatus = job.operation === "provision" ? "pending" : "active";
    if (!account || account.username !== payload.username || account.status !== expectedStatus
      || account.generation !== (payload.accountGeneration ?? 0)) {
      throw new Error("Provisioning job no longer matches the current ntfy account");
    }
    const existing = one<{ id: string }>(db.prepare(`
      SELECT id FROM ntfy_device_tokens WHERE user_id=? AND token_hint=? AND revoked_at IS NULL
    `), job.user_id, hint);
    if (!existing) {
      db.prepare(`
        INSERT INTO ntfy_device_tokens (id, user_id, name, token_encrypted, token_hint, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), job.user_id, payload.deviceName ?? "Device", encryptSecret(result.token), hint, expiresAt, now);
    }
    if (job.operation === "provision") {
      db.prepare("UPDATE ntfy_accounts SET status='active', provisioned_at=?, last_error=NULL, updated_at=? WHERE user_id=?")
        .run(now, now, job.user_id);
    }
    return;
  }
  if (job.operation === "revoke-device" && payload.token) {
    const devices = db.prepare(`
      SELECT id, token_encrypted FROM ntfy_device_tokens WHERE user_id=? AND revoked_at IS NULL
    `).all(job.user_id) as Array<{ id: string; token_encrypted: string }>;
    const device = devices.find((item) => decryptSecret(item.token_encrypted) === payload.token);
    if (device) db.prepare("UPDATE ntfy_device_tokens SET revoked_at=? WHERE id=?").run(now, device.id);
    return;
  }
  if (job.operation === "disable-account") {
    db.prepare(`
      UPDATE ntfy_accounts SET status='disabled', updated_at=?
      WHERE user_id=? AND username=? AND generation=?
    `).run(now, job.user_id, payload.username, payload.accountGeneration ?? 0);
    db.prepare(`
      UPDATE ntfy_device_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM ntfy_accounts WHERE user_id=? AND username=? AND generation=?)
    `).run(now, job.user_id, job.user_id, payload.username, payload.accountGeneration ?? 0);
  }
}

export async function provisionWorkerTick(limit = 3): Promise<void> {
  const settings = provisionerConfig();
  if (!settings.url || !settings.key) return;
  for (let count = 0; count < limit; count += 1) {
    const now = nowIso();
    const job = one<{ id: string }>(db.prepare(`
      SELECT id FROM ntfy_provision_jobs
      WHERE status IN ('pending', 'processing') AND next_attempt_at<=?
        AND (lease_until IS NULL OR lease_until<?)
      ORDER BY next_attempt_at LIMIT 1
    `), now, now);
    if (!job) return;
    try { await processJob(job.id); } catch { /* Persisted for the next retry. */ }
  }
}

export function readProvisionResult(jobId: string, userId: string): ProvisionResult | null {
  const row = one<{ result_encrypted: string | null }>(db.prepare(`
    SELECT result_encrypted FROM ntfy_provision_jobs
    WHERE id=? AND user_id=? AND status='completed'
  `), jobId, userId);
  if (!row?.result_encrypted) return null;
  return JSON.parse(decryptSecret(row.result_encrypted)) as ProvisionResult;
}

export function acknowledgeProvisionResult(jobId: string, userId: string): boolean {
  return Boolean(db.prepare(`
    UPDATE ntfy_provision_jobs SET result_encrypted=NULL, request_json='', updated_at=?
    WHERE id=? AND user_id=? AND status='completed' AND result_encrypted IS NOT NULL
  `).run(nowIso(), jobId, userId).changes);
}

export function provisionerStatus(): { configured: boolean; url: string } {
  const value = provisionerConfig();
  return { configured: Boolean(value.url && value.key), url: value.url };
}
