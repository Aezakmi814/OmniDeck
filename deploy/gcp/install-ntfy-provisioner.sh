#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root" >&2
  exit 1
fi

NTFY_DIR=/opt/ntfy
DATA_DIR=$NTFY_DIR/data
CONFIG=$NTFY_DIR/server.yml
SERVICE_USER=omnideck-provisioner
SECRETS_DIR=/etc/omnideck-ntfy-provisioner
PROVISIONER=/usr/local/bin/omnideck-ntfy-provisioner
NTFY_BIN=/usr/local/bin/ntfy
FRPC_CONFIG=/etc/frp/frpc.toml
STAGING_DIR=/var/lib/omnideck-ntfy-install

test "$(stat -c '%U:%G:%a' "$STAGING_DIR")" = "root:root:700"
for staged_file in omnideck-ntfy-provisioner omnideck-ntfy-provisioner.service; do
  test -f "$STAGING_DIR/$staged_file"
  test ! -L "$STAGING_DIR/$staged_file"
  test "$(stat -c '%U:%G' "$STAGING_DIR/$staged_file")" = "root:root"
done
test -s "$DATA_DIR/auth.db"
test -s "$CONFIG"
test -s "$FRPC_CONFIG"
grep -Eq '^[[:space:]]*auth-default-access:[[:space:]]*"?deny-all"?[[:space:]]*$' "$CONFIG" || {
  echo "ntfy auth-default-access must be deny-all" >&2
  exit 1
}

stamp=$(date +%Y%m%d-%H%M%S)
backup="$NTFY_DIR/backups/$stamp"
mkdir -p "$backup"
cp -a "$DATA_DIR/auth.db" "$CONFIG" "$FRPC_CONFIG" "$backup/"
chmod 700 "$backup"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -m 0755 "$STAGING_DIR/omnideck-ntfy-provisioner" "$PROVISIONER"
docker cp ntfy:/usr/bin/ntfy "$STAGING_DIR/ntfy-host"
install -m 0755 "$STAGING_DIR/ntfy-host" "$NTFY_BIN"
rm -f "$STAGING_DIR/ntfy-host"
"$NTFY_BIN" --version >/dev/null

ntfy_user() {
  "$NTFY_BIN" user --config "$CONFIG" --auth-file "$DATA_DIR/auth.db" "$@"
}

ntfy_access() {
  "$NTFY_BIN" access --config "$CONFIG" --auth-file "$DATA_DIR/auth.db" "$@"
}

ntfy_token() {
  "$NTFY_BIN" token --config "$CONFIG" --auth-file "$DATA_DIR/auth.db" "$@"
}

mkdir -p "$SECRETS_DIR"
if [ ! -s "$SECRETS_DIR/key" ]; then
  openssl rand -hex 32 > "$SECRETS_DIR/key"
fi
if [ ! -s "$SECRETS_DIR/stcp-key" ]; then
  openssl rand -hex 32 > "$SECRETS_DIR/stcp-key"
fi
chown root:"$SERVICE_USER" "$SECRETS_DIR" "$SECRETS_DIR/key" "$SECRETS_DIR/stcp-key"
chmod 0750 "$SECRETS_DIR"
chmod 0640 "$SECRETS_DIR/key" "$SECRETS_DIR/stcp-key"

if ! ntfy_user list | grep -q '^user omnideck-publisher '; then
  publisher_password=$(openssl rand -base64 48)
  export NTFY_PASSWORD="$publisher_password"
  ntfy_user add omnideck-publisher >/dev/null
  unset NTFY_PASSWORD
  unset publisher_password
fi
ntfy_access omnideck-publisher 'omni-user-*' write-only >/dev/null

publisher_token_file="$SECRETS_DIR/publisher-token"
if [ ! -s "$publisher_token_file" ]; then
  token_output=$(ntfy_token add --expires=8760h omnideck-publisher)
  publisher_token=$(printf '%s' "$token_output" | grep -o 'tk_[A-Za-z0-9_-]*' | head -n 1)
  unset token_output
  if [ -z "$publisher_token" ]; then
    echo "Unable to parse publisher token" >&2
    exit 1
  fi
  printf '%s' "$publisher_token" > "$publisher_token_file"
  unset publisher_token
fi
publisher_token=$(cat "$publisher_token_file")
token_line=$(ntfy_token list omnideck-publisher | grep -F -- "$publisher_token" || true)
unset publisher_token
if [ -z "$token_line" ] || printf '%s' "$token_line" | grep -Eqi 'expired|revoked'; then
  unset token_line
  echo "The stored publisher token is missing, expired, or revoked; rotate it and update FNOS before reinstalling" >&2
  exit 1
fi
unset token_line
chown root:"$SERVICE_USER" "$publisher_token_file"
chmod 0640 "$publisher_token_file"

chown root:"$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/auth.db"
chmod 0770 "$DATA_DIR"
chmod 0660 "$DATA_DIR/auth.db"

if ! grep -q '^name = "gcp-omnideck-provisioner"$' "$FRPC_CONFIG"; then
  {
    printf '\n[[proxies]]\n'
    printf 'name = "gcp-omnideck-provisioner"\n'
    printf 'type = "stcp"\n'
    printf 'secretKey = "%s"\n' "$(cat "$SECRETS_DIR/stcp-key")"
    printf 'localIP = "127.0.0.1"\n'
    printf 'localPort = 2671\n'
  } >> "$FRPC_CONFIG"
fi

install -m 0644 "$STAGING_DIR/omnideck-ntfy-provisioner.service" /etc/systemd/system/omnideck-ntfy-provisioner.service
systemctl daemon-reload
systemctl enable --now omnideck-ntfy-provisioner.service
systemctl restart frpc.service

curl --fail --silent --show-error http://127.0.0.1:2671/health >/dev/null
systemctl is-active --quiet omnideck-ntfy-provisioner.service
systemctl is-active --quiet frpc.service
echo "Provisioner installed; backup: $backup"
