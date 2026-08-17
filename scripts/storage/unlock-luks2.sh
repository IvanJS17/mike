#!/usr/bin/env bash
# Unlock and mount the encrypted production data volume after reboot.
set -Eeuo pipefail

: "${LITT_DATA_DEVICE:?set LITT_DATA_DEVICE to the dedicated block device}"
: "${LITT_CRYPT_MAPPER:?set LITT_CRYPT_MAPPER to the mapper name}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to the encrypted mount point}"
if (( EUID != 0 )); then printf 'Run as root through the approved break-glass procedure.\n' >&2; exit 1; fi
[[ -b "$LITT_DATA_DEVICE" ]] || { printf 'Not a block device.\n' >&2; exit 1; }
device_real=$(realpath -e "$LITT_DATA_DEVICE")
root_source=$(findmnt -n -o SOURCE --target /)
root_real=$(realpath -e "$root_source")
root_disk=$(lsblk -ndo PKNAME "$root_real" || true); root_disk=${root_disk:+/dev/$root_disk}
selected_disk=$(lsblk -ndo PKNAME "$device_real" || true); selected_disk=${selected_disk:+/dev/$selected_disk}
[[ "$device_real" != "$root_real" && "$selected_disk" != "$root_disk" ]] || { printf 'Refusing root filesystem device.\n' >&2; exit 1; }
cryptsetup isLuks "$device_real" >/dev/null 2>&1 || { printf 'Configured device is not LUKS.\n' >&2; exit 1; }
install -d -m 0700 "$LITT_DATA_ROOT"
if cryptsetup status "$LITT_CRYPT_MAPPER" >/dev/null 2>&1; then
  mapped=$(cryptsetup status "$LITT_CRYPT_MAPPER" | awk '/device:/ {print $2}')
  [[ -n "$mapped" && "$(realpath -e "$mapped")" == "$device_real" ]] || { printf 'Existing mapper points to another device.\n' >&2; exit 1; }
else
  printf 'Enter the LUKS2 passphrase for the dedicated data volume.\n'
  cryptsetup luksOpen "$device_real" "$LITT_CRYPT_MAPPER"
fi
mountpoint -q "$LITT_DATA_ROOT" || mount "/dev/mapper/$LITT_CRYPT_MAPPER" "$LITT_DATA_ROOT"
mounted_source=$(findmnt -n -o SOURCE --target "$LITT_DATA_ROOT")
[[ "$mounted_source" == "/dev/mapper/$LITT_CRYPT_MAPPER" ]] || { printf 'Unexpected mount source.\n' >&2; exit 1; }
install -d -m 0700 "$LITT_DATA_ROOT/postgres" "$LITT_DATA_ROOT/caddy-data" "$LITT_DATA_ROOT/caddy-config" "$LITT_DATA_ROOT/tmp" "$LITT_DATA_ROOT/secrets" "$LITT_DATA_ROOT/state"
chmod 0700 "$LITT_DATA_ROOT" "$LITT_DATA_ROOT/secrets"
chown root:root "$LITT_DATA_ROOT" "$LITT_DATA_ROOT/secrets"
findmnt --target "$LITT_DATA_ROOT"
printf 'Encrypted data volume is unlocked and mounted.\n'
