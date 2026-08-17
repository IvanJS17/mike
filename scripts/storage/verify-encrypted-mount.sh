#!/usr/bin/env bash
# Fail-closed guard used immediately before production Compose startup.
set -Eeuo pipefail

: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to the encrypted mount}"
: "${LITT_SECRETS_ROOT:?set LITT_SECRETS_ROOT below the encrypted mount}"
: "${LITT_CRYPT_MAPPER:?set LITT_CRYPT_MAPPER to the mapper name}"
: "${LITT_DATA_DEVICE:?set LITT_DATA_DEVICE to the verified block device}"

if (( EUID != 0 )); then printf 'The encrypted-mount guard must run as root.\n' >&2; exit 1; fi
if [[ "$(realpath -m "$LITT_DATA_ROOT")" != "/srv/litt-data" || -L "$LITT_DATA_ROOT" ]]; then printf 'Refusing non-canonical LITT_DATA_ROOT.\n' >&2; exit 1; fi
if [[ "$(realpath -m "$LITT_SECRETS_ROOT")" != "/srv/litt-data/secrets" || -L "$LITT_SECRETS_ROOT" ]]; then printf 'Refusing non-canonical LITT_SECRETS_ROOT.\n' >&2; exit 1; fi
if [[ ! -d "$LITT_DATA_ROOT" ]]; then printf 'Invalid encrypted data directory.\n' >&2; exit 1; fi
root_device=$(realpath -e "$LITT_DATA_DEVICE")
root_source=$(findmnt -n -o SOURCE --target /)
if ! cryptsetup isLuks "$root_device" >/dev/null 2>&1; then
  printf 'Refusing startup: backing device is not a LUKS volume.\n' >&2
  exit 1
fi
luks_version=$(cryptsetup luksDump "$root_device" | awk -F: '/Version:/ {gsub(/[[:space:]]/, "", $2); print $2; exit}')
[[ "$luks_version" == "2" ]] || { printf 'Refusing startup: volume is not LUKS2.\n' >&2; exit 1; }

root_source_real=$(realpath -e "$root_source")
root_disk=$(lsblk -ndo PKNAME "$root_source_real" || true)
root_disk=${root_disk:+/dev/$root_disk}
selected_disk=$(lsblk -ndo PKNAME "$root_device" || true)
selected_disk=${selected_disk:+/dev/$selected_disk}
[[ "$root_device" != "$root_source_real" && "$selected_disk" != "$root_disk" ]] || {
  printf 'Refusing to use a device belonging to the root filesystem.\n' >&2; exit 1;
}

mounted_source=$(findmnt -n -o SOURCE --target "$LITT_DATA_ROOT" || true)
expected_source="/dev/mapper/$LITT_CRYPT_MAPPER"
[[ "$mounted_source" == "$expected_source" ]] || {
  printf 'Refusing startup: unexpected encrypted mount source.\n' >&2; exit 1;
}
cryptsetup status "$LITT_CRYPT_MAPPER" >/dev/null 2>&1 || {
  printf 'Refusing startup: LUKS mapper is not active.\n' >&2; exit 1;
}
mapped_device=$(cryptsetup status "$LITT_CRYPT_MAPPER" | awk '/device:/ {print $2}')
[[ -n "$mapped_device" && "$(realpath -e "$mapped_device")" == "$root_device" ]] || {
  printf 'Refusing startup: mapper does not point to the configured device.\n' >&2; exit 1;
}
secrets_real=$(realpath -e "$LITT_SECRETS_ROOT")
[[ "$secrets_real" == "$LITT_DATA_ROOT/secrets" && -d "$secrets_real" && ! -L "$LITT_SECRETS_ROOT" ]] || {
  printf 'Refusing startup: secrets are outside the encrypted mount.\n' >&2; exit 1;
}
[[ "$(stat -c '%U:%a' "$secrets_real")" == "root:700" ]] || {
  printf 'Refusing startup: encrypted secrets directory must be root-owned mode 700.\n' >&2; exit 1;
}
for secret_name in compose.env backend.env db.env auth.env rest.env backup.env; do
  secret_path="$secrets_real/$secret_name"
  [[ -f "$secret_path" && ! -L "$secret_path" && "$(stat -c '%U:%a' "$secret_path")" == "root:600" ]] || {
    printf 'Refusing startup: secret file %s must be root-owned mode 600.\n' "$secret_name" >&2; exit 1;
  }
done
for required_dir in postgres caddy-data caddy-config tmp state; do
  [[ -d "$LITT_DATA_ROOT/$required_dir" && ! -L "$LITT_DATA_ROOT/$required_dir" && "$(stat -c '%U:%a' "$LITT_DATA_ROOT/$required_dir")" == "root:700" ]] || {
    printf 'Refusing startup: missing encrypted directory %s.\n' "$required_dir" >&2; exit 1;
  }
done
printf 'Encrypted production mount and secret root verified: %s\n' "$mounted_source"
