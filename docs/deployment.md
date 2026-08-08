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

## FRP

Use a TCP proxy from a loopback-only public relay port to NAS loopback port `3200`:

```toml
[[proxies]]
name = "sysfnos"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3200
remotePort = 6500
```

On FRPS, set `proxyBindAddr = "127.0.0.1"` so the remote port cannot bypass the HTTPS reverse proxy.

## Backups

Stop writes or stop the app container before taking a volume-level SQLite backup:

```bash
docker compose stop app
docker run --rm -v sysfnos_app-data:/data -v "$PWD/backups:/backup" alpine \
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
