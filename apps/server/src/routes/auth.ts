import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { audit, db, nowIso, one } from "../db.js";
import { requireUser, SESSION_COOKIE, sessionUser, parseBody } from "../http.js";
import { hashPassword, hashToken, randomToken, verifyPassword } from "../security.js";
import type { UserRow } from "../types.js";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(512),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(10).max(512),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", {
    config: { rateLimit: { max: 8, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const body = parseBody(loginSchema, request.body, reply);
    if (!body) return;

    const user = one<UserRow>(
      db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL"),
      body.username,
    );

    if (!user || user.disabled || !verifyPassword(body.password, user.password_hash)) {
      audit(user?.id ?? null, "auth.login_failed", "user", user?.id ?? null, { username: body.username }, request.ip);
      return reply.code(401).send({ error: "invalid_credentials", message: "用户名或密码错误" });
    }

    const token = randomToken();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hashToken(token), user.id, createdAt, expiresAt, request.ip, request.headers["user-agent"] ?? null);
    db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(createdAt, createdAt, user.id);
    audit(user.id, "auth.login", "user", user.id, {}, request.ip);

    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      expires: new Date(expiresAt),
    });

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        mustChangePassword: Boolean(user.must_change_password),
        email: user.email,
        locale: user.locale,
        timezone: user.timezone,
      },
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return { user };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const body = parseBody(passwordSchema, request.body, reply);
    if (!body) return;

    const row = one<UserRow>(db.prepare("SELECT * FROM users WHERE id = ?"), user.id);
    if (!row || !verifyPassword(body.currentPassword, row.password_hash)) {
      return reply.code(400).send({ error: "invalid_password", message: "当前密码不正确" });
    }

    const now = nowIso();
    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?
    `).run(hashPassword(body.newPassword), now, user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(
      user.id,
      hashToken(request.cookies[SESSION_COOKIE] ?? randomUUID()),
    );
    audit(user.id, "auth.password_changed", "user", user.id, {}, request.ip);
    return { ok: true };
  });

  app.get("/api/auth/proxy-verify", async (request, reply) => {
    const user = sessionUser(request);
    if (!user) return reply.code(401).send();
    reply.header("X-WEBAUTH-USER", user.username);
    reply.header("X-WEBAUTH-NAME", user.displayName);
    reply.header("X-WEBAUTH-ROLE", user.role === "admin" ? "Admin" : "Viewer");
    return reply.code(204).send();
  });
}
