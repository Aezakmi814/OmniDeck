import { randomUUID } from "node:crypto";
import { db, nowIso, one } from "./db.js";
import { sendMail } from "./settings.js";

interface AlertRow {
  id: string;
  status: string;
  title: string;
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
    SELECT id, status, title FROM alerts
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
    try {
      await sendMail(`[SysFNOS] ${title}`, `${message}\n\n发生时间：${now}`);
      db.prepare("UPDATE alerts SET notified_at = ? WHERE id = ?").run(nowIso(), id);
    } catch (error) {
      console.error("Failed to send alert email", error);
    }
  }

  if (!failing && openAlert) {
    const now = nowIso();
    db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE id = ?").run(now, openAlert.id);
    try {
      await sendMail(`[SysFNOS] 已恢复：${openAlert.title}`, `服务已恢复。\n\n恢复时间：${now}`);
    } catch (error) {
      console.error("Failed to send recovery email", error);
    }
  }
}
