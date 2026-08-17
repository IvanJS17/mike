#!/usr/bin/env bash
# Destructive one-time initialization of the dedicated data device.
# The passphrase is entered interactively by cryptsetup; it is never accepted
# as a command-line argument or written to a file by this script.
set -Eeuo pipefail

: "${LITT_DATA_DEVICE:?set LITT_DATA_DEVICE to the dedicated block device}"
: "${LITT_CRYPT_MAPPER:?set LITT_CRYPT_MAPPER to the mapper name}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to the encrypted mount point}"
: "${LUKS2_CONFIRM:?set LUKS2_CONFIRM=YES after checking the device identity}"

if [[ "$LUKS2_CONFIRM" != "YES" ]]; then
  printf 'Refusing destructive LUKS2 format: set LUKS2_CONFIRM=YES explicitly.\n' >&2
  exit 2
fi
if (( EUID != 0 )); then
  printf 'Run as root through the approved break-glass procedure.\n' >&2
  exit 1
fi
if [[ "$LITT_DATA_DEVICE" != /dev/* || "$LITT_DATA_DEVICE" == /dev/mapper/* ]]; then
  printf 'LITT_DATA_DEVICE must be a physical /dev path, not a mapper or relative path.\n' >&2
  exit 1
fi
if [[ ! -b "$LITT_DATA_DEVICE" ]]; then
  printf 'Not a block device: %s\n' "$LITT_DATA_DEVICE" >&2
  exit 1
fi
if [[ "$LITT_DATA_ROOT" == "/" ]]; then
  printf 'Refusing to use / as the data mount.\n' >&2
  exit 1
fi

root_source=$(findmnt -n -o SOURCE --target / || true)
if [[ "$root_source" == "$LITT_DATA_DEVICE" ]]; then
  printf 'Refusing to format the device hosting the root filesystem.\n' >&2
  exit 1
fi
if cryptsetup isLuks "$LITT_DATA_DEVICE" >/dev/null 2>&1; then
  printf 'Device is already LUKS; use unlock-luks2.sh instead.\n' >&2
  exit 1
fi

printf 'Formatting %s as LUKS2 and mounting it at %s.\n' "$LITT_DATA_DEVICE" "$LITT_DATA_ROOT"
cryptsetup luksFormat --type luks2 --batch-mode "$LITT_DATA_DEVICE"
cryptsetup luksOpen "$LITT_DATA_DEVICE" "$LITT_CRYPT_MAPPER"

install -d -m 0700 "$LITT_DATA_ROOT"
mkfs.ext4 -F -L litt-data "/dev/mapper/$LITT_CRYPT_MAPPER"
mount "/dev/mapper/$LITT_CRYPT_MAPPER" "$LITT_DATA_ROOT"
install -d -m 0700 \
  "$LITT_DATA_ROOT/postgres" \
  "$LITT_DATA_ROOT/caddy-data" \
  "$LITT_DATA_ROOT/caddy-config" \
  "$LITT_DATA_ROOT/tmp"
chmod 0700 "$LITT_DATA_ROOT"
findmnt --target "$LITT_DATA_ROOT"
printf 'LUKS2 volume initialized. Keep the recovery receipt and passphrase under Socium custody.\n'
