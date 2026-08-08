import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db.js";
import { parseBody, requireAdmin } from "../http.js";
import { getSmtpSettings, sendMail, setSetting } from "../settings.js";

const smtpSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().max(255).default(""),
  password: z.string().max(1024).optional(),
  from: z.string().trim().min(3).max(320),
  recipients: z.array(z.string().email()).min(1).max(20),
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/smtp", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const settings = getSmtpSettings();
    return {
      smtp: settings ? {
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        username: settings.username,
        from: settings.from,
        recipients: settings.recipients,
        hasPassword: Boolean(settings.password),
      } : null,
    };
  });

  app.put("/api/settings/smtp", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(smtpSchema, request.body, reply);
    if (!body) return;
    const current = getSmtpSettings();
    setSetting("smtp", JSON.stringify({
      ...body,
      password: body.password || current?.password || "",
    }), true);
    audit(actor.id, "settings.smtp_updated", "settings", "smtp", { host: body.host, recipients: body.recipients }, request.ip);
    return { ok: true };
  });

  app.post("/api/settings/smtp/test", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    try {
      await sendMail("[OmniDeck] 邮件配置测试", `邮件通知已配置成功。\n\n测试时间：${new Date().toISOString()}`);
      audit(actor.id, "settings.smtp_test", "settings", "smtp", {}, request.ip);
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: "smtp_failed", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
