# SysFNOS

SysFNOS is a self-hosted operations console for infrastructure, public endpoints, FRP links, and OpenAI-compatible upstreams. It is designed for a NAS-hosted control plane with lightweight agents on Linux and Windows nodes.

The project is currently in active `0.1.x` development. Database migrations are automatic, but production deployments should still be backed up before upgrading.

## Features

- Admin and viewer roles with closed registration.
- Admin-created users and direct password resets, including the root administrator.
- Linux, Windows, NAS, laptop, and on-demand VM inventory.
- CPU, memory, disk, network, uptime, and selected service metrics.
- HTTP endpoint status, response code, TTFB, duration, and TLS validation.
- Real OpenAI-compatible SSE probes with TTFT and response validation.
- Optional balance collection using a configurable JSON field path.
- Distributed probes assigned from the UI to selected agents.
- Alert and recovery history with SMTP notifications.
- Prometheus metrics with per-location labels and 90-day retention.
- Grafana dashboards behind the same SysFNOS login session.
- Docker Compose deployment with no database, Prometheus, or Grafana port exposed publicly.

## Architecture

```text
Browser
  -> HTTPS edge / FRP
  -> gateway:3200
     -> SysFNOS app:3000
     -> Grafana:3000 (auth_request SSO)

Linux / Windows agents
  -> HTTPS /api/agent/report
  -> HTTPS /api/agent/tasks
  -> execute assigned probes
  -> HTTPS /api/agent/result

Prometheus
  -> private bearer-authenticated /metrics
  -> Grafana datasource
```

The central SysFNOS instance always executes each enabled probe. Agents provide additional geographic and network perspectives. Probe API keys are encrypted at rest on the control plane, sent only to assigned authenticated agents over HTTPS, held in memory, and never written into agent configuration.

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
  -RemoteDirectory "/vol1/docker/sysfnos"
```

The deployment exposes only `127.0.0.1:3200` on the NAS. Point a local reverse proxy or FRP client at that port. See [docs/deployment.md](docs/deployment.md).

## Agent

Build the agent with a local Go toolchain:

```bash
cd agent
go build -o sysfnos-agent .
```

Or use Docker:

```powershell
./scripts/build-agent.ps1 -TargetOS windows -TargetArch amd64
./scripts/build-agent.ps1 -TargetOS linux -TargetArch amd64
```

Create a node in the SysFNOS UI and run the generated installation command as Administrator/root:

The UI downloads build artifacts from the deployment's `/downloads/` path and installs the agent as a boot service. A node token rotation immediately invalidates the existing installation, so run the newly generated command after rotating.

```powershell
sysfnos-agent.exe install `
  --server https://sys.example.com `
  --token ONE_TIME_NODE_TOKEN `
  --services frpc,OpenCode
```

```bash
sudo ./sysfnos-agent install \
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
- Self-registration is disabled.
- Application logs redact authorization headers, cookies, passwords, and API keys.
- Grafana and Prometheus are reachable only on the internal Docker network.
- The metrics endpoint requires a separate bearer token.

Never commit `.env`, files under `deploy/secrets/`, runtime databases, or generated agents. Read [SECURITY.md](SECURITY.md) before exposing a deployment publicly.

## License

SysFNOS source code is licensed under the [Apache License 2.0](LICENSE). Bundled and referenced third-party components retain their own licenses, including Grafana, Prometheus, Nginx, React, and their dependencies.
