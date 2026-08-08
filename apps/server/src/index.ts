import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { config } from "./config.js";
import { cleanupExpiredData } from "./db.js";
import { metricsRoutes } from "./metrics.js";
import { schedulerTick } from "./probes.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { monitorRoutes } from "./routes/monitors.js";
import { nodeRoutes } from "./routes/nodes.js";
import { settingsRoutes } from "./routes/settings.js";
import { userRoutes } from "./routes/users.js";

const app = Fastify({
  logger: {
    level: config.isProduction ? "info" : "debug",
    redact: ["req.headers.authorization", "req.headers.cookie", "body.password", "body.apiKey"],
  },
  trustProxy: true,
  bodyLimit: 1024 * 1024,
});

await app.register(cookie);
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
    },
  },
});
await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });

await authRoutes(app);
await userRoutes(app);
await nodeRoutes(app);
await monitorRoutes(app);
await dashboardRoutes(app);
await settingsRoutes(app);
await metricsRoutes(app);

app.get("/api/health", async () => ({ status: "ok", version: "0.1.0", time: new Date().toISOString() }));

const agentDownloads: Record<string, { file: string; type: string }> = {
  "sysfnos-agent-windows-amd64.exe": {
    file: "sysfnos-agent-windows-amd64.exe",
    type: "application/vnd.microsoft.portable-executable",
  },
  "sysfnos-agent-linux-amd64": {
    file: "sysfnos-agent-linux-amd64",
    type: "application/octet-stream",
  },
};

app.get<{ Params: { filename: string } }>("/downloads/:filename", async (request, reply) => {
  const download = agentDownloads[request.params.filename];
  if (!download) return reply.code(404).send({ error: "download_not_found" });
  const path = join(config.agentBinDir, download.file);
  if (!existsSync(path)) return reply.code(404).send({ error: "agent_build_unavailable" });
  reply.header("Content-Type", download.type);
  reply.header("Content-Length", statSync(path).size);
  reply.header("Content-Disposition", `attachment; filename="${download.file}"`);
  reply.header("Cache-Control", "public, max-age=3600");
  return reply.send(createReadStream(path));
});

if (existsSync(config.webRoot)) {
  await app.register(fastifyStatic, { root: config.webRoot, prefix: "/" });
}

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith("/api/") || request.url === "/metrics") {
    return reply.code(404).send({ error: "not_found" });
  }
  if (existsSync(config.webRoot)) return reply.sendFile("index.html");
  return reply.code(404).send({ error: "web_build_missing" });
});

setInterval(() => void schedulerTick().catch((error) => app.log.error(error)), 10_000).unref();
setInterval(cleanupExpiredData, 6 * 60 * 60 * 1000).unref();
void schedulerTick().catch((error) => app.log.error(error));

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
