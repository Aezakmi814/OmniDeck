# Architecture

## Components

### Control plane

The Node.js service owns authentication, users, project membership, monitor definitions, encrypted secrets, current alerts, notification events, and 90 days of detailed samples and deliveries in SQLite. SQLite uses WAL mode and is stored in the `app-data` Docker volume.

### Web console

The React console provides operational dashboards and Admin/Viewer authorization. Admin-only pages manage users, agents, monitor definitions, SMTP, thresholds, and distributed probe assignments.

### Agents

Agents send host metrics every 30 seconds. They fetch only probe assignments explicitly linked to their node and execute due tasks locally. OpenAI-compatible keys remain in process memory for the duration of a task poll and are not persisted by the agent.

On-demand VMs should be configured with `alertOnOffline=false`. They retain their last-seen time without creating offline incidents.

### Prometheus and Grafana

Prometheus scrapes the app's bearer-authenticated private metrics endpoint. Labels include stable internal IDs, display names, and the probe location. Grafana is not publicly exposed directly. Nginx `auth_request` validates the OmniDeck session and maps application `admin`/`viewer` roles to Grafana `Admin`/`Viewer` organization roles.

### Notification core

Modules publish registered project events to `NotificationService`; they never call a transport directly. JSON Schema, size limits, sensitive-key rejection, project permission, idempotency, subscription matching, quiet hours, cooldowns, and incident lifecycle are applied before delivery. A SQLite outbox uses 60-second leases and bounded retry delays.

`InAppProvider`, `EmailProvider`, and `NtfyProvider` fan out independently. The webhook provider name is reserved for a future contract. External integrations use hashed project Bearer tokens and `Idempotency-Key` through the OpenAPI contract or `@omnideck/sdk`.

### ntfy provisioner

The provisioner is a separate Go service next to ntfy. HMAC-authenticated requests arrive through FRP STCP. It executes only validated official `ntfy user`, `ntfy access`, and `ntfy token` commands; it has no Docker socket, SSH key, or direct SQLite implementation. Each OmniDeck user receives a random account/topic and each device receives an independently revocable one-year token.

### Gateway

The gateway is the only published container port and binds to `127.0.0.1:3200`. A host reverse proxy or FRP client connects to it. HTTPS is terminated at the public edge.

## Probe flow

1. Admin creates an endpoint or AI upstream.
2. The central scheduler begins probing it.
3. Admin optionally assigns one or more nodes.
4. Assigned agents fetch tasks with their node bearer token.
5. Each agent enforces its local interval and timeout.
6. Results are accepted only when the monitor is still assigned to that node.
7. Two consecutive failures for the same target and location open an incident.
8. A successful result resolves that location's incident.

## Data boundaries

- Full API keys never appear in list APIs, Prometheus labels, Grafana variables, audit details, or application logs.
- Node enrollment tokens are returned only at creation or rotation.
- Project and ntfy credentials are returned once. Project tokens are hashed; device tokens and provider secrets are encrypted.
- Project membership is checked both when a subscription is created and when a delivery is matched.
- Historical metric data contains monitor names, URLs, latency, status, balances, and sanitized error text. Treat backups as sensitive operational data.
