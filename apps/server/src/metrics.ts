import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { db, many, one } from "./db.js";
import { constantTimeEqual } from "./security.js";

function label(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (request, reply) => {
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token || !constantTimeEqual(token, config.metricsToken)) {
      return reply.code(401).send("Unauthorized\n");
    }

    const lines: string[] = [];
    lines.push("# HELP sysfnos_node_up Whether the node is reporting within its configured offline threshold.");
    lines.push("# TYPE sysfnos_node_up gauge");
    const nodes = many<Record<string, unknown>>(db.prepare(`
      SELECT n.*, s.cpu_percent, s.memory_total_bytes, s.memory_used_bytes, s.uptime_seconds,
        s.disks_json, s.services_json
      FROM nodes n LEFT JOIN node_samples s ON s.id=(SELECT id FROM node_samples WHERE node_id=n.id ORDER BY sampled_at DESC LIMIT 1)
    `));
    for (const node of nodes) {
      const labels = `node_id="${label(node.id)}",name="${label(node.name)}",platform="${label(node.platform)}",kind="${label(node.kind)}"`;
      const online = Boolean(node.enabled) && node.last_seen_at && Date.now() - Date.parse(String(node.last_seen_at)) < number(node.offline_after_seconds) * 1000;
      lines.push(`sysfnos_node_up{${labels}} ${online ? 1 : 0}`);
      lines.push(`sysfnos_node_cpu_percent{${labels}} ${number(node.cpu_percent)}`);
      lines.push(`sysfnos_node_memory_total_bytes{${labels}} ${number(node.memory_total_bytes)}`);
      lines.push(`sysfnos_node_memory_used_bytes{${labels}} ${number(node.memory_used_bytes)}`);
      lines.push(`sysfnos_node_uptime_seconds{${labels}} ${number(node.uptime_seconds)}`);
      try {
        const disks = JSON.parse(String(node.disks_json ?? "[]")) as Array<Record<string, unknown>>;
        for (const disk of disks) {
          const diskLabels = `${labels},mount="${label(disk.mount)}"`;
          lines.push(`sysfnos_node_disk_total_bytes{${diskLabels}} ${number(disk.totalBytes)}`);
          lines.push(`sysfnos_node_disk_used_bytes{${diskLabels}} ${number(disk.usedBytes)}`);
        }
      } catch { /* Agent payloads are validated before storage. */ }
    }

    lines.push("# HELP sysfnos_endpoint_up Whether the latest endpoint probe succeeded.");
    lines.push("# TYPE sysfnos_endpoint_up gauge");
    const endpoints = many<Record<string, unknown>>(db.prepare(`
      SELECT e.id, e.name, e.url, c.success, c.status_code, c.ttfb_ms, c.total_ms,
        COALESCE(c.node_id, 'core') AS node_id, COALESCE(n.name, 'monitoring-core') AS location
      FROM endpoint_checks c
      JOIN endpoints e ON e.id=c.endpoint_id
      LEFT JOIN nodes n ON n.id=c.node_id
      WHERE e.enabled=1 AND c.id=(
        SELECT id FROM endpoint_checks latest WHERE latest.endpoint_id=c.endpoint_id
          AND COALESCE(latest.node_id, '')=COALESCE(c.node_id, '') ORDER BY checked_at DESC LIMIT 1
      )
    `));
    for (const endpoint of endpoints) {
      const labels = `endpoint_id="${label(endpoint.id)}",name="${label(endpoint.name)}",node_id="${label(endpoint.node_id)}",location="${label(endpoint.location)}"`;
      lines.push(`sysfnos_endpoint_up{${labels}} ${number(endpoint.success)}`);
      lines.push(`sysfnos_endpoint_status_code{${labels}} ${number(endpoint.status_code)}`);
      lines.push(`sysfnos_endpoint_ttfb_seconds{${labels}} ${number(endpoint.ttfb_ms) / 1000}`);
      lines.push(`sysfnos_endpoint_duration_seconds{${labels}} ${number(endpoint.total_ms) / 1000}`);
    }

    lines.push("# HELP sysfnos_ai_up Whether the latest AI streaming probe succeeded.");
    lines.push("# TYPE sysfnos_ai_up gauge");
    const targets = many<Record<string, unknown>>(db.prepare(`
      SELECT t.id, t.name, t.model, c.success, c.status_code, c.ttfb_ms, c.total_ms, c.balance,
        COALESCE(c.node_id, 'core') AS node_id, COALESCE(n.name, 'monitoring-core') AS location
      FROM ai_checks c
      JOIN ai_targets t ON t.id=c.target_id
      LEFT JOIN nodes n ON n.id=c.node_id
      WHERE t.enabled=1 AND c.id=(
        SELECT id FROM ai_checks latest WHERE latest.target_id=c.target_id
          AND COALESCE(latest.node_id, '')=COALESCE(c.node_id, '') ORDER BY checked_at DESC LIMIT 1
      )
    `));
    for (const target of targets) {
      const labels = `target_id="${label(target.id)}",name="${label(target.name)}",model="${label(target.model)}",node_id="${label(target.node_id)}",location="${label(target.location)}"`;
      lines.push(`sysfnos_ai_up{${labels}} ${number(target.success)}`);
      lines.push(`sysfnos_ai_status_code{${labels}} ${number(target.status_code)}`);
      lines.push(`sysfnos_ai_ttft_seconds{${labels}} ${number(target.ttfb_ms) / 1000}`);
      lines.push(`sysfnos_ai_duration_seconds{${labels}} ${number(target.total_ms) / 1000}`);
      if (target.balance !== null) lines.push(`sysfnos_ai_balance{${labels}} ${number(target.balance)}`);
    }

    const openAlerts = one<{ count: number }>(db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status='open'"))?.count ?? 0;
    lines.push("# HELP sysfnos_alerts_open Number of currently open alerts.");
    lines.push("# TYPE sysfnos_alerts_open gauge");
    lines.push(`sysfnos_alerts_open ${openAlerts}`);
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return `${lines.join("\n")}\n`;
  });
}
