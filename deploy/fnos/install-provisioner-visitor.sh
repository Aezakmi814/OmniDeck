#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root" >&2
  exit 1
fi

FRPC_CONFIG=/etc/frp/frpc.toml
STAGING_DIR=${1:?Provide a private staging directory}
STCP_KEY_FILE=$STAGING_DIR/stcp-key
test -s "$FRPC_CONFIG"
test "$(stat -c '%U:%a' "$STAGING_DIR")" = "${SUDO_USER:-root}:700"
test -f "$STCP_KEY_FILE"
test ! -L "$STCP_KEY_FILE"
test "$(stat -c '%U' "$STCP_KEY_FILE")" = "${SUDO_USER:-root}"

stamp=$(date +%Y%m%d-%H%M%S)
backup=/etc/frp/frpc.toml.omnideck-$stamp.bak
cp -a "$FRPC_CONFIG" "$backup"

if ! grep -q '^name = "fnos-omnideck-provisioner"$' "$FRPC_CONFIG"; then
  {
    printf '\n[[visitors]]\n'
    printf 'name = "fnos-omnideck-provisioner"\n'
    printf 'type = "stcp"\n'
    printf 'serverName = "gcp-omnideck-provisioner"\n'
    printf 'secretKey = "%s"\n' "$(cat "$STCP_KEY_FILE")"
    printf 'bindAddr = "172.17.0.1"\n'
    printf 'bindPort = 6601\n'
  } >> "$FRPC_CONFIG"
fi

sed -i '/name = "fnos-omnideck-provisioner"/,/bindPort = 6601/ s/bindAddr = "127.0.0.1"/bindAddr = "172.17.0.1"/' "$FRPC_CONFIG"

rm -rf -- "$STAGING_DIR"
systemctl restart frpc.service
sleep 2
systemctl is-active --quiet frpc.service
curl --fail --silent --show-error http://172.17.0.1:6601/health >/dev/null
echo "Provisioner visitor installed; backup: $backup"
