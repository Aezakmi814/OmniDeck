const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)/i;

export function findSensitiveField(value: unknown, path = "data"): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (SENSITIVE_KEY.test(key)) return childPath;
    const found = findSensitiveField(child, childPath);
    if (found) return found;
  }
  return null;
}

function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function renderNotificationTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key: string) => {
    const value = valueAtPath(data, key);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function localTimeParts(date: Date, timezone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function parseClock(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isQuietTime(date: Date, timezone: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  const current = localTimeParts(date, timezone).minutes;
  const startMinutes = parseClock(start);
  const endMinutes = parseClock(end);
  return startMinutes < endMinutes
    ? current >= startMinutes && current < endMinutes
    : current >= startMinutes || current < endMinutes;
}

export function nextQuietEnd(date: Date, timezone: string, start: string, end: string): Date {
  for (let offset = 1; offset <= 36 * 60; offset += 1) {
    const candidate = new Date(date.getTime() + offset * 60_000);
    if (!isQuietTime(candidate, timezone, start, end)) return candidate;
  }
  return new Date(date.getTime() + 24 * 60 * 60_000);
}

export function retryDelaySeconds(attemptCount: number): number | null {
  return [60, 300, 900, 3600, 21600][attemptCount] ?? null;
}

export function normalizeChannels(value: unknown): Array<"in_app" | "email" | "ntfy"> {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is "in_app" | "email" | "ntfy" =>
    item === "in_app" || item === "email" || item === "ntfy"))];
}
