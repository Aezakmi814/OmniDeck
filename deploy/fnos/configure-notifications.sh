#!/bin/sh
set -eu

target=${1:-/vol1/docker/omnideck}
staging_dir=${2:?Provide a private staging directory}
ntfy_base_url=${3:?Provide the public ntfy base URL}
provisioner_url=${4:?Provide the internal Provisioner URL}
env_file=$target/.env
secrets_dir=$target/deploy/secrets

case "$ntfy_base_url" in https://*) ;; *) echo "The ntfy base URL must use HTTPS" >&2; exit 1 ;; esac
case "$provisioner_url" in http://*|https://*) ;; *) echo "The Provisioner URL must use HTTP or HTTPS" >&2; exit 1 ;; esac

test -d "$target"
test -s "$env_file"
test "$(stat -c '%U:%a' "$staging_dir")" = "${SUDO_USER:-root}:700"
for staged_file in ntfy-publisher-token ntfy-provisioner-key; do
  test -f "$staging_dir/$staged_file"
  test ! -L "$staging_dir/$staged_file"
  test "$(stat -c '%U' "$staging_dir/$staged_file")" = "${SUDO_USER:-root}"
done

mkdir -p "$secrets_dir"
install -m 0600 "$staging_dir/ntfy-publisher-token" "$secrets_dir/ntfy_omnideck_publisher_token.txt"
install -m 0600 "$staging_dir/ntfy-provisioner-key" "$secrets_dir/ntfy_omnideck_provisioner_key.txt"
chown 10001:10001 "$secrets_dir/ntfy_omnideck_publisher_token.txt" "$secrets_dir/ntfy_omnideck_provisioner_key.txt"
chmod 0400 "$secrets_dir/ntfy_omnideck_publisher_token.txt" "$secrets_dir/ntfy_omnideck_provisioner_key.txt"
rm -rf -- "$staging_dir"

awk '
  !/^NTFY_BASE_URL=/ &&
  !/^NTFY_PROVISIONER_URL=/
' "$env_file" > "$env_file.tmp"
{
  printf '\nNTFY_BASE_URL=%s\n' "$ntfy_base_url"
  printf 'NTFY_PROVISIONER_URL=%s\n' "$provisioner_url"
} >> "$env_file.tmp"
mv "$env_file.tmp" "$env_file"
chmod 0600 "$env_file"

echo "Notification transport configured in $target"
