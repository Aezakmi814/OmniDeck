# Deployment

## Public edge

Only proxy the gateway port:

```nginx
location / {
    proxy_pass http://127.0.0.1:3200;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
}
```

Do not publish application port `3000`, Prometheus `9090`, or Grafana `3000`.

## Notification secrets

When ntfy is enabled, create ignored files `deploy/secrets/ntfy_omnideck_publisher_token.txt` and `deploy/secrets/ntfy_omnideck_provisioner_key.txt`. The opt-in `compose.ntfy.yaml` override mounts them read-only and the app reads them through the corresponding `*_FILE` variables. On hosts that preserve bind-file ownership, keep them owned by container UID/GID `10001` with mode `0400`.

Set these non-secret values in `.env`:

```dotenv
NTFY_BASE_URL=https://notify.example.com
NTFY_PROVISIONER_URL=http://host.docker.internal:6601
```

Start an ntfy-enabled deployment with both files:

```bash
docker compose -f compose.yaml -f compose.ntfy.yaml up -d --build
```

The GCP installer at `deploy/gcp/install-ntfy-provisioner.sh` creates a restricted publisher, HMAC key, systemd service, and STCP server. Before running it, set ntfy `auth-default-access` to `deny-all`, then place the compiled binary and repository unit in root-owned `/var/lib/omnideck-ntfy-install` with directory mode `0700`; the installer rejects permissive anonymous access, symlinks, non-root ownership, and invalid stored publisher tokens. The FNOS visitor installer binds the client side to Docker host gateway `172.17.0.1`; it is not exposed by Compose or the public gateway. Requests still require timestamped, nonce-protected HMAC authentication, and FRP's WSS transport encrypts the cross-host tunnel.

## FRP

Use a TCP proxy from a loopback-only public relay port to NAS loopback port `3200`:

```toml
[[proxies]]
name = "omnideck"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3200
remotePort = 6500
```

On FRPS, set `proxyBindAddr = "127.0.0.1"` so the remote port cannot bypass the HTTPS reverse proxy.

## Backups

For FNOS updates, `scripts/deploy-fnos.ps1` invokes `deploy/fnos/switch-production.sh`: it tags the running image, archives the protected source tree, stops App writes for a volume snapshot, starts the new image, and restores the old source, image, and data automatically on a failed health check. The switch script supports both the base and opt-in ntfy Compose modes.

Stop writes or stop the app container before taking a volume-level SQLite backup:

```bash
docker compose stop app
docker run --rm -v omnideck_app-data:/data -v "$PWD/backups:/backup" alpine \
  tar -czf "/backup/app-data-$(date +%F).tar.gz" -C /data .
docker compose start app
```

Back up Grafana separately if users create dashboards through Grafana. Prometheus data can generally be recreated and does not need to be part of the critical backup set.

## Upgrade

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app prometheus grafana gateway
```

Review release notes and back up `app-data` before crossing minor versions during the `0.x` period.
