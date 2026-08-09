import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const [url, keyFile, ntfyUrl] = process.argv.slice(2);
if (!url || !keyFile || !ntfyUrl) throw new Error("Usage: node scripts/test-provisioner.mjs URL KEY_FILE NTFY_URL");
const key = (await readFile(keyFile, "utf8")).trim();
const suffix = randomBytes(10).toString("hex");
const username = `omni_u_${suffix}`;
const topic = `omni-user-${randomBytes(16).toString("hex")}`;

async function provision(operation, input) {
  const body = JSON.stringify({ operation, ...input });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(18).toString("base64url");
  const signature = createHmac("sha256", key).update(`${timestamp}\n${nonce}\n${body}`).digest("hex");
  const response = await fetch(`${url.replace(/\/$/, "")}/v1/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Omni-Timestamp": timestamp,
      "X-Omni-Nonce": nonce,
      "X-Omni-Signature": signature,
    },
    body,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

let created = false;
try {
  const result = await provision("provision", {
    username,
    topic,
    password: randomBytes(32).toString("base64url"),
    deviceName: "automated-test",
    expires: "8760h",
  });
  if (!result.token || !result.expiresAt) throw new Error("Provisioner did not return token metadata");
  created = true;
  const anonymousRead = await fetch(`${ntfyUrl.replace(/\/$/, "")}/${topic}/json?poll=1`);
  if (![401, 403].includes(anonymousRead.status)) throw new Error(`anonymous topic read returned HTTP ${anonymousRead.status}`);
  const anonymousPublish = await fetch(ntfyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, message: "anonymous ACL test" }),
  });
  if (![401, 403].includes(anonymousPublish.status)) throw new Error(`anonymous topic publish returned HTTP ${anonymousPublish.status}`);
  const authenticatedRead = await fetch(`${ntfyUrl.replace(/\/$/, "")}/${topic}/json?poll=1`, {
    headers: { Authorization: `Bearer ${result.token}` },
  });
  if (!authenticatedRead.ok) throw new Error(`authenticated topic read returned HTTP ${authenticatedRead.status}`);
  await provision("disable-account", { username });
  created = false;
  console.log("provisioner-e2e-ok");
} finally {
  if (created) {
    await provision("disable-account", { username }).catch(() => undefined);
  }
}
