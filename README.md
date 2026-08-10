# OmniDeck

[English](README.md) | [简体中文](README.zh-CN.md)

OmniDeck is a self-hosted control and observability platform for services, infrastructure, data sources, alerts, notifications, and automation. Version `0.3.x` monitors infrastructure, public endpoints, OpenAI-compatible upstreams, and market procurement targets, with lightweight agents on Linux and Windows nodes.

The platform includes shared authentication, project permissions, navigation, durable notification jobs, and a typed event integration contract. Database migrations are automatic, but production deployments should still be backed up before upgrading.

## Features

- Admin and viewer roles with closed registration.
- Admin-created users and direct password resets, including the root administrator.
- Linux, Windows, NAS, laptop, and on-demand VM inventory.
- CPU, memory, disk, network, uptime, and selected service metrics.
- HTTP endpoint status, response code, TTFB, duration, and TLS validation.
- Real OpenAI-compatible SSE probes with TTFT and response validation.
- Optional balance collection using a configurable JSON field path.
- Distributed probes assigned from the UI to selected agents.
- Unified in-app, SMTP, and private per-user ntfy notifications with subscriptions, quiet hours, priorities, cooldowns, retries, and recovery handling.
- Module/project registry, registered JSON Schema event types, hashed project tokens, idempotent external API, and `@omnideck/sdk`.
- Procurement watchlists backed by the PriceAI public feed, target-price notifications, visible Top-offer comparison, and 90-day price/stock trends.
- Prometheus metrics with per-location labels and 90-day retention.
- Grafana dashboards behind the same OmniDeck login session.
- Docker Compose deployment with no database, Prometheus, or Grafana port exposed publicly.

## Architecture

```text
Browser
  -> HTTPS edge / FRP
  -> gateway:3200
     -> OmniDeck app:3000
     -> Grafana:3000 (auth_request SSO)

Linux / Windows agents
  -> HTTPS /api/agent/report
  -> HTTPS /api/agent/tasks
  -> execute assigned probes
  -> HTTPS /api/agent/result

Prometheus
  -> private bearer-authenticated /metrics
  -> Grafana datasource

Projects / modules
  -> @omnideck/sdk / HTTPS event API
  -> durable SQLite outbox
   -> in-app / email / ntfy providers

Market source adapters
  -> normalized products / offers / observations
  -> user procurement rules
  -> targeted notification events
```

The central OmniDeck instance always executes each enabled probe. Agents provide additional geographic and network perspectives. Probe API keys are encrypted at rest on the control plane, sent only to assigned authenticated agents over HTTPS, held in memory, and never written into agent configuration.

Notification architecture, API limits, and ntfy isolation are documented in [docs/notifications.md](docs/notifications.md). Market source boundaries and extension points are documented in [docs/market-intelligence.md](docs/market-intelligence.md). The machine-readable external event contract is [docs/openapi.yaml](docs/openapi.yaml).

## Quick Start

Requirements:

- Docker Engine 24 or newer with Docker Compose v2.
- A Linux host or NAS with at least 2 GiB RAM.
- HTTPS in front of port `3200` for production.

Generate deployment secrets:

```powershell
./scripts/prepare-deploy.ps1 -AppUrl "https://sys.example.com"
```

The command creates ignored `.env` and `deploy/secrets/` files. The one-time root password is saved locally in `deploy/secrets/initial_admin_password.txt` and is never included in deployment archives.

Start the stack:

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:3200` for local testing. Production must use HTTPS because session cookies are marked `Secure` when `APP_URL` uses HTTPS.

## FNOS Deployment

From Windows PowerShell:

```powershell
./scripts/prepare-deploy.ps1 `
  -AppUrl "https://sys.example.com" `
  -NpmRegistry "https://registry.npmjs.org/"

./scripts/deploy-fnos.ps1 `
  -SshHost "fnos" `
  -RemoteDirectory "/vol1/docker/omnideck" `
  -NtfyBaseUrl "https://notify.example.com" `
  -NtfyProvisionerUrl "http://host.docker.internal:6601"
```

The ntfy URL parameters are required only when both ignored ntfy secret files exist; otherwise the base deployment is used. Updates create source and stopped-app data backups, retain the previous image, and automatically restore them if the new app fails its health check. The deployment exposes only `127.0.0.1:3200` on the NAS. Point a local reverse proxy or FRP client at that port. See [docs/deployment.md](docs/deployment.md).

## Agent

Build the agent with a local Go toolchain:

```bash
cd agent
go build -o omnideck-agent .
```

Or use Docker:

```powershell
./scripts/build-agent.ps1 -TargetOS windows -TargetArch amd64
./scripts/build-agent.ps1 -TargetOS linux -TargetArch amd64
```

Create a node in the OmniDeck UI and run the generated installation command as Administrator/root:

The UI downloads build artifacts from the deployment's `/downloads/` path and installs the agent as a boot service. A node token rotation immediately invalidates the existing installation, so run the newly generated command after rotating.

```powershell
omnideck-agent.exe install `
  --server https://sys.example.com `
  --token ONE_TIME_NODE_TOKEN `
  --services frpc,OpenCode
```

```bash
sudo ./omnideck-agent install \
  --server https://sys.example.com \
  --token ONE_TIME_NODE_TOKEN \
  --services frpc,docker
```

Windows uses a boot-time Scheduled Task running as `SYSTEM`. Linux uses a hardened systemd service. Agent tokens can be rotated from the node management page.

## Development

Node.js 24 or newer is required.

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

The web application runs on `127.0.0.1:5173` and proxies `/api` to the server on `127.0.0.1:3000`.

## Security

- Passwords use salted `scrypt` hashes.
- API keys and SMTP credentials use AES-256-GCM at rest.
- Session and agent tokens are stored only as SHA-256 hashes.
- Project API tokens are hashed; ntfy device tokens and provider credentials use AES-256-GCM.
- Per-user ntfy accounts have random private topics, read-only subscriber ACLs, and independent one-year device tokens.
- Self-registration is disabled.
- Application logs redact authorization headers, cookies, passwords, and API keys.
- Grafana and Prometheus are reachable only on the internal Docker network.
- The metrics endpoint requires a separate bearer token.

Never commit `.env`, files under `deploy/secrets/`, runtime databases, or generated agents. Read [SECURITY.md](SECURITY.md) before exposing a deployment publicly.

## License

The source code in this repository is licensed under the [Apache License 2.0](LICENSE). Bundled and referenced third-party components retain their own licenses, including Grafana, Prometheus, Nginx, React, and their dependencies.
