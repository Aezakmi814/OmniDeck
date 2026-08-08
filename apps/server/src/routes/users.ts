import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, many, nowIso, one } from "../db.js";
import { parseBody, requireAdmin } from "../http.js";
import { hashPassword } from "../security.js";
import type { UserRow } from "../types.js";

const createSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{2,64}$/),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(10).max(512),
  role: z.enum(["admin", "viewer"]),
});

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["admin", "viewer"]).optional(),
  disabled: z.boolean().optional(),
});

const resetSchema = z.object({ password: z.string().min(10).max(512) });

function publicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    disabled: Boolean(row.disabled),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return {
      users: many<UserRow>(db.prepare("SELECT * FROM users ORDER BY role, username")).map(publicUser),
    };
  });

  app.post("/api/users", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(createSchema, request.body, reply);
    if (!body) return;

    const id = randomUUID();
    const now = nowIso();
    try {
      db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, role, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, body.username, body.displayName, hashPassword(body.password), body.role, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "username_exists", message: "用户名已经存在" });
      }
      throw error;
    }
    audit(actor.id, "user.created", "user", id, { username: body.username, role: body.role }, request.ip);
    const row = one<UserRow>(db.prepare("SELECT * FROM users WHERE id = ?"), id);
    return reply.code(201).send({ user: publicUser(row!) });
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(updateSchema, request.body, reply);
    if (!body) return;
    const target = one<UserRow>(db.prepare("SELECT * FROM users WHERE id = ?"), request.params.id);
    if (!target) return reply.code(404).send({ error: "not_found", message: "用户不存在" });

    if (target.username.toLowerCase() === "root" && (body.role === "viewer" || body.disabled)) {
      return reply.code(400).send({ error: "root_protected", message: "不能禁用 root 或降低其权限" });
    }
    if (target.id === actor.id && body.disabled) {
      return reply.code(400).send({ error: "self_disable", message: "不能禁用当前账号" });
    }

    const now = nowIso();
    db.prepare(`
      UPDATE users SET display_name = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?
    `).run(
      body.displayName ?? target.display_name,
      body.role ?? target.role,
      body.disabled === undefined ? target.disabled : Number(body.disabled),
      now,
      target.id,
    );
    if (body.disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    audit(actor.id, "user.updated", "user", target.id, body, request.ip);
    return { user: publicUser(one<UserRow>(db.prepare("SELECT * FROM users WHERE id = ?"), target.id)!) };
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/reset-password", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const body = parseBody(resetSchema, request.body, reply);
    if (!body) return;
    const target = one<UserRow>(db.prepare("SELECT * FROM users WHERE id = ?"), request.params.id);
    if (!target) return reply.code(404).send({ error: "not_found", message: "用户不存在" });

    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?
    `).run(hashPassword(body.password), nowIso(), target.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    audit(actor.id, "user.password_reset", "user", target.id, {}, request.ip);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply);
    if (!actor) return;
    const target = one<UserRow>(db.prepare("SELECT * FROM users WHERE id = ?"), request.params.id);
    if (!target) return reply.code(404).send({ error: "not_found", message: "用户不存在" });
    if (target.id === actor.id || target.username.toLowerCase() === "root") {
      return reply.code(400).send({ error: "protected_user", message: "不能删除当前账号或 root" });
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
    audit(actor.id, "user.deleted", "user", target.id, { username: target.username }, request.ip);
    return { ok: true };
  });
}
