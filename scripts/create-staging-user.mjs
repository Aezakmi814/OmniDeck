import { randomUUID } from "node:crypto";
import { db, nowIso } from "/app/apps/server/dist/db.js";
import { hashPassword } from "/app/apps/server/dist/security.js";

const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");
const now = nowIso();
db.prepare(`
  INSERT INTO users (
    id, username, display_name, password_hash, role, disabled, must_change_password,
    email, locale, timezone, created_at, updated_at
  ) VALUES (?, ?, 'Staging Test', ?, 'admin', 0, 0, NULL, 'zh-CN', 'Asia/Shanghai', ?, ?)
  ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role='admin',
    disabled=0, must_change_password=0, updated_at=excluded.updated_at
`).run(randomUUID(), username, hashPassword(password), now, now);
db.close();
