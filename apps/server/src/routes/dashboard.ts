import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, many, one } from "../db.js";
import { requireUser } from "../http.js";

interface CountRow { count: number; }

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dashboard", async (request, reply) => {
    if (!requireUser(request, reply)) return;

    const nodeCounts = one<{ total: number; online: number }>(db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN enabled=1 AND last_seen_at IS NOT NULL
          AND (unixepoch('now') - unixepoch(last_seen_at)) < offline_after_seconds THEN 1 ELSE 0 END), 0) AS online
      FROM nodes
    `)) ?? { total: 0, online: 0 };
    const endpointCounts = one<{ total: number; healthy: number }>(db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN c.success=1 THEN 1 ELSE 0 END), 0) AS healthy
      FROM endpoints e
      LEFT JOIN endpoint_checks c ON c.id=(SELECT id FROM endpoint_checks WHERE endpoint_id=e.id ORDER BY checked_at DESC LIMIT 1)
      WHERE e.enabled=1
    `)) ?? { total: 0, healthy: 0 };
    const aiCounts = one<{ total: number; healthy: number; avg_ttft: number | null }>(db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN c.success=1 THEN 1 ELSE 0 END), 0) AS healthy,
        AVG(CASE WHEN c.success=1 THEN c.ttfb_ms END) AS avg_ttft
      FROM ai_targets t
      LEFT JOIN ai_checks c ON c.id=(SELECT id FROM ai_checks WHERE target_id=t.id ORDER BY checked_at DESC LIMIT 1)
      WHERE t.enabled=1
    `)) ?? { total: 0, healthy: 0, avg_ttft: null };
    const openAlerts = one<CountRow>(db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status='open'"))?.count ?? 0;

    const recentChecks = many<Record<string, unknown>>(db.prepare(`
      SELECT 'endpoint' AS type, e.id, e.name, c.checked_at, c.success, c.status_code,
        c.ttfb_ms, c.total_ms, c.error, COALESCE(n.name, '监控核心') AS location
      FROM endpoint_checks c JOIN endpoints e ON e.id=c.endpoint_id LEFT JOIN nodes n ON n.id=c.node_id
      UNION ALL
      SELECT 'ai' AS type, t.id, t.name, c.checked_at, c.success, c.status_code,
        c.ttfb_ms, c.total_ms, c.error, COALESCE(n.name, '监控核心') AS location
      FROM ai_checks c JOIN ai_targets t ON t.id=c.target_id LEFT JOIN nodes n ON n.id=c.node_id
      ORDER BY checked_at DESC LIMIT 12
    `));

    const latency = many<Record<string, unknown>>(db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:%M:00Z', checked_at) AS time,
        ROUND(AVG(ttfb_ms), 1) AS endpoint_ttfb,
        NULL AS ai_ttft
      FROM endpoint_checks
      WHERE checked_at >= datetime('now', '-24 hours') AND ttfb_ms IS NOT NULL
      GROUP BY strftime('%Y-%m-%dT%H:%M:00Z', checked_at)
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:00Z', checked_at) AS time,
        NULL AS endpoint_ttfb,
        ROUND(AVG(ttfb_ms), 1) AS ai_ttft
      FROM ai_checks
      WHERE checked_at >= datetime('now', '-24 hours') AND ttfb_ms IS NOT NULL
      GROUP BY strftime('%Y-%m-%dT%H:%M:00Z', checked_at)
      ORDER BY time
    `));

    const mergedLatency = new Map<string, { time: string; endpointTtfb?: number; aiTtft?: number }>();
    for (const point of latency) {
      const time = String(point.time);
      const current = mergedLatency.get(time) ?? { time };
      if (point.endpoint_ttfb !== null) current.endpointTtfb = Number(point.endpoint_ttfb);
      if (point.ai_ttft !== null) current.aiTtft = Number(point.ai_ttft);
      mergedLatency.set(time, current);
    }

    return {
      summary: {
        nodes: nodeCounts,
        endpoints: endpointCounts,
        aiTargets: aiCounts,
        openAlerts,
      },
      recentChecks,
      latency: [...mergedLatency.values()],
    };
  });

  app.get("/api/alerts", async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const query = z.object({ status: z.enum(["open", "resolved", "all"]).default("all") }).parse(request.query);
    const where = query.status === "all" ? "" : "WHERE status = ?";
    const params = query.status === "all" ? [] : [query.status];
    return { alerts: many<Record<string, unknown>>(db.prepare(`SELECT * FROM alerts ${where} ORDER BY opened_at DESC LIMIT 200`), ...params) };
  });

  app.get<{ Params: { kind: string; id: string } }>("/api/history/:kind/:id", async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const query = z.object({ hours: z.coerce.number().int().min(1).max(2160).default(24) }).parse(request.query);
    const cutoff = new Date(Date.now() - query.hours * 60 * 60 * 1000).toISOString();
    if (request.params.kind === "node") {
      return { points: many<Record<string, unknown>>(db.prepare(`
        SELECT sampled_at AS time, cpu_percent, memory_total_bytes, memory_used_bytes, uptime_seconds
        FROM node_samples WHERE node_id=? AND sampled_at>=? ORDER BY sampled_at
      `), request.params.id, cutoff) };
    }
    if (request.params.kind === "endpoint") {
      return { points: many<Record<string, unknown>>(db.prepare(`
        SELECT checked_at AS time, success, status_code, ttfb_ms, total_ms
        FROM endpoint_checks WHERE endpoint_id=? AND checked_at>=? ORDER BY checked_at
      `), request.params.id, cutoff) };
    }
    if (request.params.kind === "ai") {
      return { points: many<Record<string, unknown>>(db.prepare(`
        SELECT checked_at AS time, success, status_code, ttfb_ms, total_ms, balance
        FROM ai_checks WHERE target_id=? AND checked_at>=? ORDER BY checked_at
      `), request.params.id, cutoff) };
    }
    return reply.code(404).send({ error: "unknown_history_kind" });
  });
}
