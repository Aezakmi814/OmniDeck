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
    notified_at TEXT,
    recovery_notified_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_status_opened ON alerts(status, opened_at DESC);

  CREATE TABLE IF NOT EXISTS market_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
    next_poll_at TEXT NOT NULL,
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_snapshot_id TEXT,
    last_published_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'healthy', 'stale', 'error')),
    stale INTEGER NOT NULL DEFAULT 0,
    partial INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    lease_until TEXT,
    lease_token TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_market_sources_queue ON market_sources(enabled, next_poll_at, lease_until);

  CREATE TABLE IF NOT EXISTS market_products (
    id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    product_type TEXT NOT NULL,
    spec TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS market_source_products (
    source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    external_slug TEXT NOT NULL,
    offer_count INTEGER NOT NULL DEFAULT 0,
    in_stock_count INTEGER NOT NULL DEFAULT 0,
    lowest_price_minor INTEGER,
    currency TEXT NOT NULL DEFAULT 'CNY',
    latest_seen_at TEXT,
    snapshot_generated_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_id, external_id),
    UNIQUE (source_id, product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_market_source_products_product ON market_source_products(product_id, source_id);

  CREATE TABLE IF NOT EXISTS market_offers (
    source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    external_offer_id TEXT NOT NULL,
    source_id_external TEXT,
    source_name TEXT NOT NULL,
    source_store_name TEXT,
    title TEXT NOT NULL,
    price_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    stock_count INTEGER,
    min_order_quantity INTEGER,
    url TEXT NOT NULL,
    captured_at TEXT,
    last_seen_at TEXT,
    verified_at TEXT,
    expires_at TEXT,
    effective_status TEXT,
    freshness_status TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_id, product_id, external_offer_id)
  );
  CREATE INDEX IF NOT EXISTS idx_market_offers_current ON market_offers(product_id, active, price_minor);
  CREATE INDEX IF NOT EXISTS idx_market_offers_source_store ON market_offers(source_id, source_id_external, active);

  CREATE TABLE IF NOT EXISTS market_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    published_at TEXT,
    lowest_price_minor INTEGER,
    visible_median_price_minor INTEGER,
    in_stock_count INTEGER NOT NULL DEFAULT 0,
    offer_count INTEGER NOT NULL DEFAULT 0,
    stale INTEGER NOT NULL DEFAULT 0,
    partial INTEGER NOT NULL DEFAULT 1,
    UNIQUE (source_id, product_id, snapshot_id)
  );
  CREATE INDEX IF NOT EXISTS idx_market_observations_product_time ON market_observations(product_id, observed_at);

  CREATE TABLE IF NOT EXISTS market_watch_rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    target_price_minor INTEGER NOT NULL CHECK (target_price_minor > 0),
    currency TEXT NOT NULL DEFAULT 'CNY',
    enabled INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'met', 'unknown')),
    notification_attempt INTEGER NOT NULL DEFAULT 0,
    last_triggered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_market_watch_rules_user ON market_watch_rules(user_id, enabled, state);

  CREATE TABLE IF NOT EXISTS market_poll_runs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
    snapshot_id TEXT,
    http_status INTEGER,
    product_count INTEGER NOT NULL DEFAULT 0,
    offer_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_market_poll_runs_source_time ON market_poll_runs(source_id, started_at DESC);

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

  CREATE TABLE IF NOT EXISTS notification_projects (
    id TEXT PRIMARY KEY,
    module_key TEXT NOT NULL,
    project_key TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_event_types (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES notification_projects(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    schema_json TEXT NOT NULL DEFAULT '{}',
    title_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    default_priority INTEGER NOT NULL DEFAULT 3 CHECK (default_priority BETWEEN 1 AND 5),
    lifecycle TEXT NOT NULL DEFAULT 'event' CHECK (lifecycle IN ('event', 'opened', 'recovered')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, event_key)
  );

  CREATE TABLE IF NOT EXISTS notification_project_members (
    project_id TEXT NOT NULL REFERENCES notification_projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'manage')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_notification_project_members_user ON notification_project_members(user_id, project_id);

  CREATE TABLE IF NOT EXISTS notification_project_tokens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES notification_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notification_tokens_project ON notification_project_tokens(project_id, revoked_at);

  CREATE TABLE IF NOT EXISTS notification_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES notification_projects(id) ON DELETE CASCADE,
    event_type_id TEXT REFERENCES notification_event_types(id) ON DELETE CASCADE,
    min_priority INTEGER NOT NULL DEFAULT 1 CHECK (min_priority BETWEEN 1 AND 5),
    delivery_priority INTEGER CHECK (delivery_priority BETWEEN 1 AND 5),
    channels_json TEXT NOT NULL DEFAULT '["in_app"]',
    email_addresses_json TEXT NOT NULL DEFAULT '[]',
    cooldown_mode TEXT NOT NULL DEFAULT 'once' CHECK (cooldown_mode IN ('once', 'interval', 'repeat_count', 'until_recovery')),
    cooldown_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (cooldown_seconds BETWEEN 60 AND 2592000),
    repeat_count INTEGER NOT NULL DEFAULT 1 CHECK (repeat_count BETWEEN 1 AND 100),
    quiet_start TEXT,
    quiet_end TEXT,
    recovery_summary_mode TEXT NOT NULL DEFAULT 'merged' CHECK (recovery_summary_mode IN ('merged', 'recovery_only', 'all')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_match ON notification_subscriptions(project_id, event_type_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_user ON notification_subscriptions(user_id, enabled);

  CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES notification_projects(id) ON DELETE CASCADE,
    event_type_id TEXT NOT NULL REFERENCES notification_event_types(id) ON DELETE CASCADE,
    idempotency_key TEXT,
    idempotency_fingerprint TEXT,
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    dedupe_key TEXT,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('event', 'opened', 'recovered')),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_notification_events_created ON notification_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notification_events_dedupe ON notification_events(project_id, event_type_id, dedupe_key, created_at DESC);

  CREATE TABLE IF NOT EXISTS notification_incidents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES notification_projects(id) ON DELETE CASCADE,
    dedupe_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    opened_event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    resolved_event_id TEXT REFERENCES notification_events(id) ON DELETE SET NULL,
    opened_at TEXT NOT NULL,
    last_opened_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(project_id, dedupe_key)
  );

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES notification_subscriptions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email', 'ntfy')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'suppressed', 'superseded')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    repeat_index INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    lease_until TEXT,
    delivered_at TEXT,
    read_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(event_id, subscription_id, channel, repeat_index)
  );
  CREATE INDEX IF NOT EXISTS idx_notification_delivery_queue ON notification_deliveries(status, next_attempt_at, lease_until);
  CREATE INDEX IF NOT EXISTS idx_notification_delivery_inbox ON notification_deliveries(user_id, channel, created_at DESC);

  CREATE TABLE IF NOT EXISTS ntfy_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled', 'error')),
    provisioned_at TEXT,
    last_error TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ntfy_device_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_encrypted TEXT NOT NULL,
    token_hint TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ntfy_tokens_user ON ntfy_device_tokens(user_id, revoked_at);

  CREATE TABLE IF NOT EXISTS ntfy_provision_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    operation TEXT NOT NULL,
    request_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    lease_until TEXT,
    account_username TEXT,
    account_generation INTEGER,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ntfy_jobs_queue ON ntfy_provision_jobs(status, next_attempt_at, lease_until);
`);

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("endpoint_checks", "node_id", "TEXT REFERENCES nodes(id) ON DELETE SET NULL");
ensureColumn("ai_checks", "node_id", "TEXT REFERENCES nodes(id) ON DELETE SET NULL");
ensureColumn("users", "email", "TEXT");
ensureColumn("users", "locale", "TEXT NOT NULL DEFAULT 'zh-CN'");
ensureColumn("users", "timezone", "TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
ensureColumn("users", "deleted_at", "TEXT");
ensureColumn("alerts", "recovery_notified_at", "TEXT");
ensureColumn("notification_events", "idempotency_fingerprint", "TEXT");
ensureColumn("notification_incidents", "last_opened_at", "TEXT");
db.prepare("UPDATE notification_incidents SET last_opened_at=opened_at WHERE last_opened_at IS NULL").run();
ensureColumn("ntfy_accounts", "generation", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("ntfy_provision_jobs", "account_username", "TEXT");
ensureColumn("ntfy_provision_jobs", "account_generation", "INTEGER");
ensureColumn("market_sources", "lease_token", "TEXT");
ensureColumn("market_source_products", "active", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("market_watch_rules", "notification_attempt", "INTEGER NOT NULL DEFAULT 0");
const recoveryMigration = db.prepare("SELECT value FROM settings WHERE key='notification.alert_recovery_migrated'").get() as { value: string } | undefined;
if (!recoveryMigration) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE alerts SET recovery_notified_at=COALESCE(notified_at, resolved_at)
    WHERE status='resolved' AND recovery_notified_at IS NULL
  `).run();
  db.prepare("INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('notification.alert_recovery_migrated', '1', 0, ?)").run(now);
}
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
  const credentialCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(sessionCutoff);
  db.prepare("DELETE FROM node_samples WHERE sampled_at < ?").run(metricCutoff);
  db.prepare("DELETE FROM endpoint_checks WHERE checked_at < ?").run(metricCutoff);
  db.prepare("DELETE FROM ai_checks WHERE checked_at < ?").run(metricCutoff);
  db.prepare("DELETE FROM market_observations WHERE observed_at < ?").run(metricCutoff);
  db.prepare("DELETE FROM market_poll_runs WHERE started_at < ?").run(metricCutoff);
  db.prepare("DELETE FROM notification_deliveries WHERE created_at < ?").run(metricCutoff);
  db.prepare(`
    UPDATE ntfy_provision_jobs SET result_encrypted=NULL, request_json=''
    WHERE status='completed' AND result_encrypted IS NOT NULL AND updated_at < ?
  `).run(credentialCutoff);
  db.prepare(`
    DELETE FROM notification_events WHERE created_at < ? AND id NOT IN (
      SELECT opened_event_id FROM notification_incidents WHERE status='open'
    )
  `).run(metricCutoff);
  db.prepare("DELETE FROM ntfy_provision_jobs WHERE created_at < ? AND status IN ('completed', 'failed')").run(metricCutoff);
}

ensureColumn("ntfy_provision_jobs", "result_encrypted", "TEXT");
