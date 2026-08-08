import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { config } from "./config.js";
import { hashPassword } from "./security.js";

export const db = new DatabaseSync(config.databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    disabled INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    platform TEXT NOT NULL DEFAULT 'unknown',
    kind TEXT NOT NULL DEFAULT 'server',
    labels TEXT NOT NULL DEFAULT '{}',
    token_hash TEXT NOT NULL UNIQUE,
    alert_on_offline INTEGER NOT NULL DEFAULT 1,
    offline_after_seconds INTEGER NOT NULL DEFAULT 180,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT,
    agent_version TEXT
  );

  CREATE TABLE IF NOT EXISTS node_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    sampled_at TEXT NOT NULL,
    uptime_seconds REAL NOT NULL,
    cpu_percent REAL NOT NULL,
    memory_total_bytes INTEGER NOT NULL,
    memory_used_bytes INTEGER NOT NULL,
    load1 REAL,
    disks_json TEXT NOT NULL,
    networks_json TEXT NOT NULL,
    services_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_node_samples_node_time ON node_samples(node_id, sampled_at DESC);

  CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    url TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    expected_status INTEGER NOT NULL DEFAULT 200,
    timeout_seconds INTEGER NOT NULL DEFAULT 15,
    interval_seconds INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    verify_tls INTEGER NOT NULL DEFAULT 1,
    headers_encrypted TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS endpoint_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    status_code INTEGER,
    ttfb_ms REAL,
    total_ms REAL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_endpoint_checks_target_time ON endpoint_checks(endpoint_id, checked_at DESC);

  CREATE TABLE IF NOT EXISTS ai_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    base_url TEXT NOT NULL,
    chat_path TEXT NOT NULL DEFAULT '/v1/chat/completions',
    model TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT 'Reply with OK only.',
    interval_seconds INTEGER NOT NULL DEFAULT 300,
    timeout_seconds INTEGER NOT NULL DEFAULT 60,
    enabled INTEGER NOT NULL DEFAULT 1,
    balance_url TEXT,
    balance_path TEXT,
    balance_interval_seconds INTEGER NOT NULL DEFAULT 1800,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES ai_targets(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    status_code INTEGER,
    ttfb_ms REAL,
    total_ms REAL,
    response_valid INTEGER NOT NULL DEFAULT 0,
    balance REAL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_checks_target_time ON ai_checks(target_id, checked_at DESC);

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TEXT NOT NULL,
    resolved_at TEXT,
    notified_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_status_opened ON alerts(status, opened_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    ip_address TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

  CREATE TABLE IF NOT EXISTS monitor_assignments (
    monitor_type TEXT NOT NULL CHECK (monitor_type IN ('endpoint', 'ai')),
    monitor_id TEXT NOT NULL,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (monitor_type, monitor_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_monitor_assignments_node ON monitor_assignments(node_id, monitor_type);
`);

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("endpoint_checks", "node_id", "TEXT REFERENCES nodes(id) ON DELETE SET NULL");
ensureColumn("ai_checks", "node_id", "TEXT REFERENCES nodes(id) ON DELETE SET NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_endpoint_checks_location ON endpoint_checks(endpoint_id, node_id, checked_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_ai_checks_location ON ai_checks(target_id, node_id, checked_at DESC)");

const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
if (userCount.count === 0) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'admin', 1, ?, ?)
  `).run(
    randomUUID(),
    config.ADMIN_INITIAL_USERNAME,
    config.ADMIN_INITIAL_USERNAME,
    hashPassword(config.initialPassword),
    now,
    now,
  );
}

type SqlParameter = null | number | bigint | string | Uint8Array;

export function one<T>(statement: StatementSync, ...params: SqlParameter[]): T | undefined {
  return statement.get(...params) as T | undefined;
}

export function many<T>(statement: StatementSync, ...params: SqlParameter[]): T[] {
  return statement.all(...params) as T[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function audit(
  userId: string | null,
  action: string,
  subjectType: string,
  subjectId: string | null,
  details: Record<string, unknown> = {},
  ipAddress: string | null = null,
): void {
  db.prepare(`
    INSERT INTO audit_log (user_id, action, subject_type, subject_id, details, created_at, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, action, subjectType, subjectId, JSON.stringify(details), nowIso(), ipAddress);
}

export function cleanupExpiredData(): void {
  const sessionCutoff = nowIso();
  const metricCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(sessionCutoff);
  db.prepare("DELETE FROM node_samples WHERE sampled_at < ?").run(metricCutoff);
  db.prepare("DELETE FROM endpoint_checks WHERE checked_at < ?").run(metricCutoff);
  db.prepare("DELETE FROM ai_checks WHERE checked_at < ?").run(metricCutoff);
}
