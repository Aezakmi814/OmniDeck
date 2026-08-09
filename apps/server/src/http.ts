import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";
import { db, one } from "./db.js";
import { hashToken } from "./security.js";
import type { SessionUser, UserRow } from "./types.js";

export const SESSION_COOKIE = "omnideck_session";

export function parseBody<T>(schema: ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    reply.code(400).send({
      error: "validation_error",
      message: "提交的数据无效",
      fields: result.error.flatten().fieldErrors,
    });
    return undefined;
  }
  return result.data;
}

export function sessionUser(request: FastifyRequest): SessionUser | null {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = one<UserRow>(db.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND u.deleted_at IS NULL
  `), hashToken(token), new Date().toISOString());

  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    email: row.email,
    locale: row.locale,
    timezone: row.timezone,
  };
}

export function requireUser(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = sessionUser(request);
  if (!user) {
    reply.code(401).send({ error: "unauthorized", message: "请先登录" });
    return null;
  }
  return user;
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = requireUser(request, reply);
  if (!user) return null;
  if (user.role !== "admin") {
    reply.code(403).send({ error: "forbidden", message: "需要管理员权限" });
    return null;
  }
  return user;
}
