#!/bin/sh
set -eu

target=${1:-/vol1/docker/omnideck}
backup=${2:?Backup directory is required}
rollback_image=${3:?Rollback image tag is required}
mode=${4:-base}

compose() {
  if [ "$mode" = ntfy ]; then
    docker compose -f "$target/compose.yaml" -f "$target/compose.ntfy.yaml" --project-directory "$target" "$@"
  else
    docker compose -f "$target/compose.yaml" --project-directory "$target" "$@"
  fi
}

rollback_compose() {
  if [ -f "$backup/compose-mode-ntfy" ]; then
    docker compose -f "$target/compose.yaml" -f "$target/compose.ntfy.yaml" --project-directory "$target" "$@"
  else
    docker compose -f "$target/compose.yaml" --project-directory "$target" "$@"
  fi
}

test -d "$target"
test -d "$backup"
test -s "$backup/source.tar.gz"
docker image inspect "$rollback_image" >/dev/null

rollback_needed=true
data_backup_complete=false

restore_release() {
  echo "Production switch failed; restoring rollback release" >&2
  set +e
  compose stop app >/dev/null 2>&1
  docker image tag "$rollback_image" omnideck/app:local
  if [ "$data_backup_complete" = true ]; then
    docker run --rm \
      -v omnideck_app-data:/data \
      -v "$backup:/backup:ro" \
      alpine:3.22 sh -c 'rm -rf /data/* /data/.[!.]* /data/..?*; tar -xzf /backup/app-data.tar.gz -C /data'
  fi
  tar -xzf "$backup/source.tar.gz" -C "$target"
  rollback_compose up -d
  attempt=0
  rollback_healthy=false
  while [ "$attempt" -lt 18 ]; do
    attempt=$((attempt + 1))
    if curl --fail --silent http://127.0.0.1:3200/api/health >/dev/null 2>&1; then
      rollback_healthy=true
      break
    fi
    sleep 5
  done
  if [ "$rollback_healthy" != true ]; then
    echo "Rollback was restored but did not become healthy" >&2
  fi
}

finish() {
  code=$?
  trap - EXIT INT TERM
  if [ "$rollback_needed" = true ]; then restore_release; fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose stop app
docker run --rm \
  -v omnideck_app-data:/data:ro \
  -v "$backup:/backup" \
  alpine:3.22 sh -c 'tar -czf /backup/app-data.tar.gz.tmp -C /data . && mv /backup/app-data.tar.gz.tmp /backup/app-data.tar.gz'
data_backup_complete=true

compose up -d app

healthy=false
attempt=0
while [ "$attempt" -lt 18 ]; do
  attempt=$((attempt + 1))
  if curl --fail --silent http://127.0.0.1:3200/api/health >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 5
done

if [ "$healthy" != true ]; then
  echo "v0.2 health check failed" >&2
  exit 1
fi

compose up -d
rollback_needed=false
trap - EXIT INT TERM
echo "Production switched; data backup: $backup/app-data.tar.gz"
