import nodemailer from "nodemailer";
import { db, nowIso, one } from "./db.js";
import { decryptSecret, encryptSecret } from "./security.js";

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  recipients: string[];
}

interface SettingRow {
  value: string;
  encrypted: number;
}

export function getSetting(key: string): string | null {
  const row = one<SettingRow>(db.prepare("SELECT value, encrypted FROM settings WHERE key = ?"), key);
  if (!row) return null;
  return row.encrypted ? decryptSecret(row.value) : row.value;
}

export function setSetting(key: string, value: string, encrypted = false): void {
  db.prepare(`
    INSERT INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at
  `).run(key, encrypted ? encryptSecret(value) : value, Number(encrypted), nowIso());
}

export function getSmtpSettings(): SmtpSettings | null {
  const raw = getSetting("smtp");
  if (raw) {
    try { return JSON.parse(raw) as SmtpSettings; } catch { return null; }
  }

  if (!process.env.SMTP_HOST) return null;
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    username: process.env.SMTP_USERNAME ?? "",
    password: process.env.SMTP_PASSWORD ?? "",
    from: process.env.SMTP_FROM ?? "",
    recipients: (process.env.ALERT_RECIPIENTS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  };
}

export async function sendMail(subject: string, text: string): Promise<void> {
  const smtp = getSmtpSettings();
  if (!smtp || !smtp.host || !smtp.from || smtp.recipients.length === 0) return;
  await sendMailTo(subject, text, smtp.recipients);
}

export async function sendMailTo(subject: string, text: string, recipients: string[]): Promise<void> {
  const smtp = getSmtpSettings();
  if (!smtp || !smtp.host || !smtp.from) throw new Error("SMTP provider is not configured");
  if (recipients.length === 0) throw new Error("At least one recipient is required");
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  await transporter.sendMail({
    from: smtp.from,
    to: recipients.join(", "),
    subject,
    text,
  });
}
