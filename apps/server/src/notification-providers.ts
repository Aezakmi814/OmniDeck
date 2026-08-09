import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { db, one } from "./db.js";
import { decryptSecret } from "./security.js";
import { getSetting, getSmtpSettings, sendMailTo } from "./settings.js";

export interface DeliveryMessage {
  userId: string;
  title: string;
  body: string;
  priority: number;
  topic?: string;
  emailAddresses: string[];
  dedupeKey: string | null;
}

export interface NotificationProvider {
  readonly channel: "in_app" | "email" | "ntfy";
  deliver(message: DeliveryMessage): Promise<void>;
}

function secretFromFile(path: string | undefined): string {
  if (!path) return "";
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

interface StoredNtfySettings { baseUrl?: string; publisherToken?: string; enabled?: boolean }

function ntfySettings(): { baseUrl: string; publisherToken: string; enabled: boolean } {
  let stored: StoredNtfySettings = {};
  const value = getSetting("notification.ntfy");
  if (value) {
    try { stored = JSON.parse(value) as StoredNtfySettings; } catch { stored = {}; }
  }
  return {
    baseUrl: (stored.baseUrl ?? config.NTFY_BASE_URL ?? "").replace(/\/$/, ""),
    publisherToken: stored.publisherToken ?? config.NTFY_PUBLISHER_TOKEN ?? secretFromFile(config.NTFY_PUBLISHER_TOKEN_FILE),
    enabled: stored.enabled ?? Boolean(config.NTFY_BASE_URL),
  };
}

class InAppProvider implements NotificationProvider {
  readonly channel = "in_app" as const;
  async deliver(): Promise<void> {}
}

class EmailProvider implements NotificationProvider {
  readonly channel = "email" as const;
  async deliver(message: DeliveryMessage): Promise<void> {
    if (!getSmtpSettings()) throw new Error("SMTP provider is not configured");
    if (message.emailAddresses.length === 0) throw new Error("No email address is configured for this subscription");
    await sendMailTo(message.title, message.body, message.emailAddresses);
  }
}

class NtfyProvider implements NotificationProvider {
  readonly channel = "ntfy" as const;
  async deliver(message: DeliveryMessage): Promise<void> {
    const settings = ntfySettings();
    if (!settings.enabled || !settings.baseUrl || !settings.publisherToken) {
      throw new Error("ntfy provider is not configured");
    }
    if (!message.topic) throw new Error("User has no active ntfy topic");
    const response = await fetch(settings.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.publisherToken}`,
      },
      body: JSON.stringify({
        topic: message.topic,
        title: message.title,
        message: message.body,
        priority: Math.max(1, Math.min(5, message.priority)),
        tags: message.priority === 5 ? ["rotating_light"] : ["satellite"],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}`);
  }
}

export const notificationProviders: Record<string, NotificationProvider> = {
  in_app: new InAppProvider(),
  email: new EmailProvider(),
  ntfy: new NtfyProvider(),
};

export function activeNtfyTopic(userId: string): string | undefined {
  return one<{ topic: string }>(db.prepare("SELECT topic FROM ntfy_accounts WHERE user_id = ? AND status = 'active'"), userId)?.topic;
}

export function decryptDeviceToken(value: string): string {
  return decryptSecret(value);
}

export function ntfyProviderStatus(): { configured: boolean; enabled: boolean; baseUrl: string } {
  const settings = ntfySettings();
  return { configured: Boolean(settings.baseUrl && settings.publisherToken), enabled: settings.enabled, baseUrl: settings.baseUrl };
}
