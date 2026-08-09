const [baseUrl, username, password] = process.argv.slice(2);
if (!baseUrl || !username || !password) throw new Error("Usage: node scripts/test-staging-notifications.mjs URL USERNAME PASSWORD");

let cookie = "";
let ntfyEnabled = false;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${payload.message || payload.error || "unknown error"}`);
  return payload;
}

async function disableNtfy() {
  const result = await request("/api/notifications/ntfy", { method: "DELETE" });
  if (!result.jobId) return;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const job = await request(`/api/notifications/ntfy/jobs/${result.jobId}`);
    if (job.status === "completed") return;
    if (job.status === "failed") throw new Error(job.error || "ntfy disable failed");
  }
  throw new Error("ntfy disable did not complete");
}

async function waitForCredentials(jobId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const job = await request(`/api/notifications/ntfy/jobs/${jobId}`);
    if (job.status === "failed") throw new Error(job.error || "ntfy provisioning failed");
    if (job.status === "completed" && job.result?.token) {
      await request(`/api/notifications/ntfy/jobs/${jobId}/ack`, { method: "POST" });
      return job.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("ntfy credentials were not available");
}

try {
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!loginResponse.ok) throw new Error(`login returned HTTP ${loginResponse.status}`);
  cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0] || "";
  if (!cookie) throw new Error("login did not return a session cookie");

  const currentNtfy = await request("/api/notifications/ntfy");
  if (currentNtfy.account?.status === "active") {
    await disableNtfy();
  }

  const ntfyJob = await request("/api/notifications/ntfy/enable", {
    method: "POST", body: JSON.stringify({ deviceName: "Staging test" }),
  });
  const ntfyCredentials = await waitForCredentials(ntfyJob.jobId);
  const ntfyStatus = await request("/api/notifications/ntfy");
  if (!ntfyCredentials.token || !ntfyStatus.account?.topic) throw new Error("ntfy credentials were not returned");
  ntfyEnabled = true;

  const catalog = await request("/api/notifications/catalog");
  const project = catalog.projects.find((item) => item.projectKey === "system");
  if (!project) throw new Error("system notification project is missing");
  await request("/api/notifications/subscriptions", {
    method: "POST",
    body: JSON.stringify({ projectId: project.id, channels: ["in_app", "ntfy"], minPriority: 1 }),
  });
  const tokenResult = await request(`/api/admin/notifications/projects/${project.id}/tokens`, {
    method: "POST", body: JSON.stringify({ name: "staging validation" }),
  });
  const title = `Staging notification ${Date.now()}`;
  const publishResponse = await fetch(`${baseUrl}/api/v1/projects/system/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenResult.token.token}`,
      "Idempotency-Key": `staging-${Date.now()}`,
    },
    body: JSON.stringify({
      eventType: "alert.opened", dedupeKey: `staging:${Date.now()}`, title,
      body: "Staging end-to-end delivery validation", priority: 4,
      data: { sourceName: "Staging", message: "delivery validation" },
    }),
  });
  if (publishResponse.status !== 202) throw new Error(`event publish returned HTTP ${publishResponse.status}`);

  let delivered = false;
  let matching = [];
  for (let attempt = 0; attempt < 80 && !delivered; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await request("/api/admin/notifications/deliveries");
    matching = result.items.filter((item) => item.title === title);
    delivered = matching.some((item) => item.channel === "in_app" && item.status === "delivered")
      && matching.some((item) => item.channel === "ntfy" && item.status === "delivered");
  }
  if (!delivered) throw new Error(`in-app and ntfy deliveries did not both complete: ${JSON.stringify(matching.map((item) => ({ channel: item.channel, status: item.status, error: item.last_error })))}`);
  const inbox = await request("/api/notifications/inbox?unread=true");
  if (!inbox.items.some((item) => item.title === title)) throw new Error("delivered event is missing from the inbox");

  await disableNtfy();
  ntfyEnabled = false;
  console.log("staging-notification-e2e-ok");
} finally {
  if (ntfyEnabled && cookie) {
    await disableNtfy().catch(() => undefined);
  }
}
