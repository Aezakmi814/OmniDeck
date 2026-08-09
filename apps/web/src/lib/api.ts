export class ApiError extends Error {
  status: number;
  fields?: Record<string, string[]>;
  data?: Record<string, unknown>;

  constructor(status: number, message: string, fields?: Record<string, string[]>, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.data = data;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const payload = response.status === 204
    ? null
    : await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof payload?.message === "string" ? payload.message : `请求失败（HTTP ${response.status}）`,
      payload?.fields as Record<string, string[]> | undefined,
      payload ?? undefined,
    );
  }
  return payload as T;
}

export function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}
