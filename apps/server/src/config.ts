import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  APP_URL: z.string().url().default("http://127.0.0.1:3000"),
  DATA_DIR: z.string().default(resolve(process.cwd(), "data")),
  WEB_ROOT: z.string().optional(),
  AGENT_BIN_DIR: z.string().optional(),
  APP_ENCRYPTION_KEY: z.string().optional(),
  ADMIN_INITIAL_USERNAME: z.string().min(1).max(64).default("root"),
  ADMIN_INITIAL_PASSWORD: z.string().min(10).optional(),
  METRICS_TOKEN: z.string().min(24).optional(),
  NTFY_BASE_URL: z.string().url().optional(),
  NTFY_PUBLISHER_TOKEN: z.string().min(16).optional(),
  NTFY_PUBLISHER_TOKEN_FILE: z.string().optional(),
  NTFY_PROVISIONER_URL: z.string().url().optional(),
  NTFY_PROVISIONER_KEY: z.string().min(32).optional(),
  NTFY_PROVISIONER_KEY_FILE: z.string().optional(),
});

const parsed = schema.parse(process.env);

if (isProduction && !parsed.APP_ENCRYPTION_KEY) {
  throw new Error("APP_ENCRYPTION_KEY is required in production");
}

if (isProduction && !parsed.ADMIN_INITIAL_PASSWORD) {
  throw new Error("ADMIN_INITIAL_PASSWORD is required for first-time production setup");
}

if (isProduction && !parsed.METRICS_TOKEN) {
  throw new Error("METRICS_TOKEN is required in production");
}

mkdirSync(parsed.DATA_DIR, { recursive: true });

const encryptionMaterial = parsed.APP_ENCRYPTION_KEY ?? "omnideck-development-key";

export const config = {
  ...parsed,
  isProduction,
  databasePath: resolve(parsed.DATA_DIR, "omnideck.db"),
  webRoot: parsed.WEB_ROOT ?? resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../dist/web"),
  agentBinDir: parsed.AGENT_BIN_DIR ?? resolve(process.cwd(), "agent", "bin"),
  encryptionKey: createHash("sha256").update(encryptionMaterial).digest(),
  initialPassword: parsed.ADMIN_INITIAL_PASSWORD ?? "change-me-now",
  metricsToken: parsed.METRICS_TOKEN ?? "development-metrics-token-only",
  secureCookies: parsed.APP_URL.startsWith("https://"),
};
