#!/usr/bin/env bash
# Destructive one-time initialization of the dedicated data device.
set -Eeuo pipefail
: "${LITT_DATA_DEVICE:?set LITT_DATA_DEVICE}"
: "${LITT_CRYPT_MAPPER:?set LITT_CRYPT_MAPPER}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT}"
: "${LUKS2_CONFIRM:?set LUKS2_CONFIRM=YES}"
[[ "$LUKS2_CONFIRM" == YES ]] || { printf 'Explicit LUKS2_CONFIRM=YES is required.\n' >&2; exit 2; }
(( EUID == 0 )) || { printf 'Run as root.\n' >&2; exit 1; }
[[ -b "$LITT_DATA_DEVICE" && "$LITT_DATA_DEVICE" != /dev/mapper/* ]] || { printf 'Physical block device required.\n' >&2; exit 1; }
device_real=$(realpath -e "$LITT_DATA_DEVICE")
root_source=$(findmnt -n -o SOURCE --target /)
root_real=$(realpath -e "$root_source")
root_disk=$(lsblk -ndo PKNAME "$root_real" || true); root_disk=${root_disk:+/dev/$root_disk}
selected_disk=$(lsblk -ndo PKNAME "$device_real" || true); selected_disk=${selected_disk:+/dev/$selected_disk}
[[ "$device_real" != "$root_real" && "$selected_disk" != "$root_disk" ]] || { printf 'Refusing root filesystem device.\n' >&2; exit 1; }
[[ -z "$(findmnt -rn -S "$device_real" || true)" ]] || { printf 'Device is mounted.\n' >&2; exit 1; }
cryptsetup isLuks "$device_real" >/dev/null 2>&1 && { printf 'Device is already LUKS.\n' >&2; exit 1; }
cryptsetup luksFormat --type luks2 --batch-mode "$device_real"
cryptsetup luksOpen "$device_real" "$LITT_CRYPT_MAPPER"
install -d -m 0700 "$LITT_DATA_ROOT"
mkfs.ext4 -F -L litt-data "/dev/mapper/$LITT_CRYPT_MAPPER"
mount "/dev/mapper/$LITT_CRYPT_MAPPER" "$LITT_DATA_ROOT"
install -d -m 0700 "$LITT_DATA_ROOT/postgres" "$LITT_DATA_ROOT/caddy-data" "$LITT_DATA_ROOT/caddy-config" "$LITT_DATA_ROOT/tmp" "$LITT_DATA_ROOT/secrets" "$LITT_DATA_ROOT/state"
chmod 0700 "$LITT_DATA_ROOT" "$LITT_DATA_ROOT/secrets"
chown root:root "$LITT_DATA_ROOT" "$LITT_DATA_ROOT/secrets"
findmnt --target "$LITT_DATA_ROOT"
printf 'LUKS2 volume initialized under Socium custody.\n'
