import { randomUUID } from "node:crypto";
import { db, nowIso, one } from "./db.js";
import { emitNotification, projectForAlertSource } from "./notification-service.js";

interface AlertRow {
  id: string;
  status: string;
  title: string;
  message: string;
  severity: string;
  opened_at: string;
  resolved_at: string | null;
  notified_at: string | null;
  recovery_notified_at: string | null;
}

export async function updateAlertState(
  sourceType: string,
  sourceId: string,
  failing: boolean,
  title: string,
  message: string,
  severity = "critical",
): Promise<void> {
  const openAlert = one<AlertRow>(db.prepare(`
    SELECT * FROM alerts
    WHERE source_type = ? AND source_id = ? AND status = 'open'
    ORDER BY opened_at DESC LIMIT 1
  `), sourceType, sourceId);

  if (failing && !openAlert) {
    const id = randomUUID();
    const now = nowIso();
    db.prepare(`
      INSERT INTO alerts (id, source_type, source_id, severity, title, message, status, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(id, sourceType, sourceId, severity, title, message.slice(0, 2000), now);
  }

  const currentOpen = failing
    ? one<AlertRow>(db.prepare("SELECT * FROM alerts WHERE source_type=? AND source_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1"), sourceType, sourceId)
    : openAlert;
  if (failing && currentOpen && !currentOpen.notified_at) {
    try {
      emitNotification({
        projectKey: projectForAlertSource(sourceType), eventKey: "alert.opened",
        priority: currentOpen.severity === "critical" ? 5 : currentOpen.severity === "warning" ? 4 : 3,
        title: currentOpen.title, body: currentOpen.message, dedupeKey: `${sourceType}:${sourceId}:${currentOpen.id}`,
        idempotencyKey: `alert-opened:${currentOpen.id}`,
        data: { sourceType, sourceId, sourceName: currentOpen.title, message: currentOpen.message },
        occurredAt: currentOpen.opened_at,
      });
      db.prepare("UPDATE alerts SET notified_at=? WHERE id=?").run(nowIso(), currentOpen.id);
    } catch (error) { console.error("Failed to enqueue alert notification", error); }
  }

  if (!failing && openAlert) {
    const now = nowIso();
    db.prepare("UPDATE alerts SET status='resolved', resolved_at=? WHERE id=?").run(now, openAlert.id);
  }
  if (!failing) {
    const pendingRecovery = one<AlertRow>(db.prepare(`
      SELECT * FROM alerts WHERE source_type=? AND source_id=? AND status='resolved'
        AND recovery_notified_at IS NULL ORDER BY resolved_at DESC LIMIT 1
    `), sourceType, sourceId);
    if (!pendingRecovery?.resolved_at) return;
    try {
      emitNotification({
        projectKey: projectForAlertSource(sourceType),
        eventKey: "alert.recovered",
        priority: 3,
        title: `已恢复：${pendingRecovery.title}`,
        body: `服务已恢复。\n\n恢复时间：${pendingRecovery.resolved_at}`,
        dedupeKey: `${sourceType}:${sourceId}:${pendingRecovery.id}`,
        idempotencyKey: `alert-recovered:${pendingRecovery.id}`,
        data: { sourceType, sourceId, sourceName: pendingRecovery.title, message: "服务已恢复" },
        occurredAt: pendingRecovery.resolved_at,
      });
      db.prepare("UPDATE alerts SET recovery_notified_at=? WHERE id=?").run(nowIso(), pendingRecovery.id);
    } catch (error) { console.error("Failed to enqueue recovery notification", error); }
  }
}
