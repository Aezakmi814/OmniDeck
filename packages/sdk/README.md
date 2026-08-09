# @omnideck/sdk

Typed event publisher for OmniDeck projects.

```ts
import { OmniDeckClient } from "@omnideck/sdk";

const client = new OmniDeckClient({
  baseUrl: "https://sys.example.com",
  projectKey: "payments",
  token: process.env.OMNIDECK_PROJECT_TOKEN!,
});

await client.publish({
  eventType: "payment.failed",
  idempotencyKey: crypto.randomUUID(),
  dedupeKey: "order-42",
  priority: 4,
  data: { orderId: "42", reason: "gateway timeout" },
});
```
