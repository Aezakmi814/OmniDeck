export interface OmniDeckClientOptions {
  baseUrl: string;
  projectKey: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface PublishEventInput<T extends Record<string, unknown> = Record<string, unknown>> {
  eventType: string;
  data?: T;
  priority?: 1 | 2 | 3 | 4 | 5;
  title?: string;
  body?: string;
  dedupeKey?: string;
  occurredAt?: string;
  idempotencyKey?: string;
}

export interface PublishEventResult {
  eventId: string;
  duplicate: boolean;
  deliveries: number;
}

export class OmniDeckError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "OmniDeckError";
  }
}

export class OmniDeckClient {
  private readonly baseUrl: string;
  private readonly projectKey: string;
  private readonly token: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: OmniDeckClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.projectKey = options.projectKey;
    this.token = options.token;
    this.request = options.fetch ?? globalThis.fetch;
    if (!this.baseUrl || !this.projectKey || !this.token) throw new Error("baseUrl, projectKey and token are required");
  }

  async publish<T extends Record<string, unknown>>(input: PublishEventInput<T>): Promise<PublishEventResult> {
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    const response = await this.request(
      `${this.baseUrl}/api/v1/projects/${encodeURIComponent(this.projectKey)}/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          eventType: input.eventType,
          data: input.data ?? {},
          priority: input.priority,
          title: input.title,
          body: input.body,
          dedupeKey: input.dedupeKey,
          occurredAt: input.occurredAt,
        }),
      },
    );
    const payload = await response.json().catch(() => ({})) as PublishEventResult & { error?: string; message?: string };
    if (!response.ok) throw new OmniDeckError(payload.message ?? `OmniDeck returned HTTP ${response.status}`, response.status, payload.error);
    return payload;
  }
}
