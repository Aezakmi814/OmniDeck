# Architecture

## Components

### Control plane

The Node.js service owns authentication, users, monitor definitions, encrypted secrets, current alerts, and 90 days of detailed samples in SQLite. SQLite uses WAL mode and is stored in the `app-data` Docker volume.

### Web console

The React console provides operational dashboards and Admin/Viewer authorization. Admin-only pages manage users, agents, monitor definitions, SMTP, thresholds, and distributed probe assignments.

### Agents

Agents send host metrics every 30 seconds. They fetch only probe assignments explicitly linked to their node and execute due tasks locally. OpenAI-compatible keys remain in process memory for the duration of a task poll and are not persisted by the agent.

On-demand VMs should be configured with `alertOnOffline=false`. They retain their last-seen time without creating offline incidents.

### Prometheus and Grafana

Prometheus scrapes the app's bearer-authenticated private metrics endpoint. Labels include stable internal IDs, display names, and the probe location. Grafana is not publicly exposed directly. Nginx `auth_request` validates the SysFNOS session and maps application `admin`/`viewer` roles to Grafana `Admin`/`Viewer` organization roles.

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
- Historical metric data contains monitor names, URLs, latency, status, balances, and sanitized error text. Treat backups as sensitive operational data.
