import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("authenticated notification API accepts idempotent project events", { timeout: 30_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omnideck-http-test-"));
  const port = 33_000 + Math.floor(Math.random() * 1_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      APP_URL: baseUrl,
      ADMIN_INITIAL_PASSWORD: "integration-password",
    },
    stdio: "ignore",
  });
  try {
    await waitForHealth(`${baseUrl}/api/health`);
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json()) as { version: string };
    assert.equal(health.version, "0.3.0");

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "root", password: "integration-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const sessionHeaders = { Cookie: cookie, "Content-Type": "application/json" };

    const marketProductId = "11111111-1111-4111-8111-111111111111";
    const marketDb = new DatabaseSync(join(dataDir, "omnideck.db"));
    const marketNow = new Date().toISOString();
    marketDb.prepare(`
      INSERT INTO market_products (id, canonical_key, name, platform, product_type, spec, created_at, updated_at)
      VALUES (?, 'ai-market:test-product', 'Test Product', 'ChatGPT', 'subscription', 'Monthly', ?, ?)
    `).run(marketProductId, marketNow, marketNow);
    marketDb.prepare(`
      INSERT INTO market_source_products (
        source_id, product_id, external_id, external_slug, offer_count, in_stock_count,
        lowest_price_minor, currency, latest_seen_at, snapshot_generated_at, updated_at
      ) VALUES ('builtin:priceai-public-feed', ?, 'test-product', 'test-product', 3, 2, 3600, 'CNY', ?, ?, ?)
    `).run(marketProductId, marketNow, marketNow, marketNow);
    marketDb.close();
    const marketDashboard = await apiJson<{ catalog: Array<{ id: string }>; summary: { catalogProducts: number } }>(`${baseUrl}/api/market/dashboard?days=30`, { headers: sessionHeaders });
    assert.equal(marketDashboard.catalog[0]?.id, marketProductId);
    assert.equal(marketDashboard.summary.catalogProducts, 1);
    const watchResponse = await fetch(`${baseUrl}/api/market/watches`, {
      method: "POST", headers: sessionHeaders,
      body: JSON.stringify({ productId: marketProductId, targetPriceMinor: 4000, currency: "CNY" }),
    });
    assert.equal(watchResponse.status, 201);
    const marketHistory = await apiJson<{ product: { id: string }; watch: { targetPriceMinor: number } }>(`${baseUrl}/api/market/products/${marketProductId}/history?days=90`, { headers: sessionHeaders });
    assert.equal(marketHistory.product.id, marketProductId);
    assert.equal(marketHistory.watch.targetPriceMinor, 4000);

    const catalog = await apiJson<{ projects: Array<{ id: string; projectKey: string }> }>(`${baseUrl}/api/notifications/catalog`, { headers: sessionHeaders });
    const infrastructure = catalog.projects.find((project) => project.projectKey === "infrastructure");
    assert.ok(infrastructure);
    const subscriptionResponse = await fetch(`${baseUrl}/api/notifications/subscriptions`, {
      method: "POST", headers: sessionHeaders,
      body: JSON.stringify({ projectId: infrastructure.id, channels: ["in_app"] }),
    });
    assert.equal(subscriptionResponse.status, 201);

    const tokenResponse = await apiJson<{ token: { token: string } }>(`${baseUrl}/api/admin/notifications/projects/${infrastructure.id}/tokens`, {
      method: "POST", headers: sessionHeaders, body: JSON.stringify({ name: "integration test" }),
    });
    const eventBody = JSON.stringify({
      eventType: "alert.opened",
      dedupeKey: "node:integration",
      data: { sourceName: "Integration node", message: "offline" },
    });
    const publishHeaders = {
      Authorization: `Bearer ${tokenResponse.token.token}`,
      "Idempotency-Key": "integration-event-0001",
      "Content-Type": "application/json",
    };
    const first = await fetch(`${baseUrl}/api/v1/projects/infrastructure/events`, { method: "POST", headers: publishHeaders, body: eventBody });
    assert.equal(first.status, 202);
    const replay = await fetch(`${baseUrl}/api/v1/projects/infrastructure/events`, { method: "POST", headers: publishHeaders, body: eventBody });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true);
    for (let requestCount = 2; requestCount < 120; requestCount += 1) {
      const accepted = await fetch(`${baseUrl}/api/v1/projects/infrastructure/events`, { method: "POST", headers: publishHeaders, body: eventBody });
      assert.equal(accepted.status, 200);
    }
    const throttled = await fetch(`${baseUrl}/api/v1/projects/infrastructure/events`, { method: "POST", headers: publishHeaders, body: eventBody });
    assert.equal(throttled.status, 429);

    let inbox: { items: Array<{ title: string }>; unreadCount: number } = { items: [], unreadCount: 0 };
    for (let attempt = 0; attempt < 30 && inbox.items.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      inbox = await apiJson(`${baseUrl}/api/notifications/inbox`, { headers: sessionHeaders });
    }
    assert.equal(inbox.items[0]?.title, "Integration node发生故障");
    assert.equal(inbox.unreadCount, 1);

    const createdUser = await apiJson<{ user: { id: string } }>(`${baseUrl}/api/users`, {
      method: "POST", headers: sessionHeaders,
      body: JSON.stringify({ username: "disable-test", displayName: "Disable test", password: "disable-test-password", role: "viewer" }),
    });
    const directDb = new DatabaseSync(join(dataDir, "omnideck.db"));
    const now = new Date().toISOString();
    directDb.prepare(`
      INSERT INTO ntfy_accounts (user_id, username, topic, status, created_at, updated_at)
      VALUES (?, 'omni_u_disabletest', 'omni-user-disabletest1234', 'active', ?, ?)
    `).run(createdUser.user.id, now, now);
    directDb.close();
    const disableResponse = await fetch(`${baseUrl}/api/users/${createdUser.user.id}`, {
      method: "PATCH", headers: sessionHeaders, body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disableResponse.status, 200);
    const verifyDb = new DatabaseSync(join(dataDir, "omnideck.db"), { readOnly: true });
    assert.equal(verifyDb.prepare("SELECT disabled FROM users WHERE id=?").get(createdUser.user.id)?.disabled, 1);
    assert.equal(verifyDb.prepare("SELECT status FROM ntfy_provision_jobs WHERE user_id=?").get(createdUser.user.id)?.status, "pending");
    verifyDb.close();
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test server did not start");
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
