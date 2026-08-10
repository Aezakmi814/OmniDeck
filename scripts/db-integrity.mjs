import { DatabaseSync } from "node:sqlite";

const path = process.argv[2] || "/app/data/omnideck.db";
const db = new DatabaseSync(path, { readOnly: true });
const count = (table, where = "") => db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get().count;
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((row) => row.name));
const result = {
  users: count("users", userColumns.has("deleted_at") ? "WHERE deleted_at IS NULL" : ""),
  nodes: count("nodes"),
  nodeSamples: count("node_samples"),
  alerts: count("alerts"),
  openAlerts: count("alerts", "WHERE status='open'"),
  projects: tables.has("notification_projects") ? count("notification_projects") : 0,
  subscriptions: tables.has("notification_subscriptions") ? count("notification_subscriptions") : 0,
  projectMembers: tables.has("notification_project_members") ? count("notification_project_members") : 0,
  events: tables.has("notification_events") ? count("notification_events") : 0,
  openIncidents: tables.has("notification_incidents") ? count("notification_incidents", "WHERE status='open'") : 0,
  queuedDeliveries: tables.has("notification_deliveries") ? count("notification_deliveries", "WHERE status IN ('pending', 'processing')") : 0,
  pendingProvisionJobs: tables.has("ntfy_provision_jobs") ? count("ntfy_provision_jobs", "WHERE status IN ('pending', 'processing')") : 0,
  marketSources: tables.has("market_sources") ? count("market_sources") : 0,
  marketProducts: tables.has("market_source_products") ? count("market_source_products", "WHERE active=1") : 0,
  marketOffers: tables.has("market_offers") ? count("market_offers", "WHERE active=1") : 0,
  marketObservations: tables.has("market_observations") ? count("market_observations") : 0,
  marketWatches: tables.has("market_watch_rules") ? count("market_watch_rules", "WHERE enabled=1") : 0,
  integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
};
console.log(JSON.stringify(result));
db.close();
