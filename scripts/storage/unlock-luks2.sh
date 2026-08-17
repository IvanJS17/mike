#!/usr/bin/env bash
# Unlock and mount the encrypted production data volume after reboot.
set -Eeuo pipefail

: "${LITT_DATA_DEVICE:?set LITT_DATA_DEVICE to the dedicated block device}"
: "${LITT_CRYPT_MAPPER:?set LITT_CRYPT_MAPPER to the mapper name}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to the encrypted mount point}"

if (( EUID != 0 )); then
  printf 'Run as root through the approved break-glass procedure.\n' >&2
  exit 1
fi
if [[ ! -b "$LITT_DATA_DEVICE" ]]; then
  printf 'Not a block device: %s\n' "$LITT_DATA_DEVICE" >&2
  exit 1
fi
if ! cryptsetup isLuks "$LITT_DATA_DEVICE" >/dev/null 2>&1; then
  printf 'The configured device is not a LUKS volume.\n' >&2
  exit 1
fi

install -d -m 0700 "$LITT_DATA_ROOT"
if ! cryptsetup status "$LITT_CRYPT_MAPPER" >/dev/null 2>&1; then
  printf 'Enter the LUKS2 passphrase for the dedicated data volume.\n'
  cryptsetup luksOpen "$LITT_DATA_DEVICE" "$LITT_CRYPT_MAPPER"
fi

if ! mountpoint -q "$LITT_DATA_ROOT"; then
  mount "/dev/mapper/$LITT_CRYPT_MAPPER" "$LITT_DATA_ROOT"
fi
mounted_source=$(findmnt -n -o SOURCE --target "$LITT_DATA_ROOT")
expected_source="/dev/mapper/$LITT_CRYPT_MAPPER"
if [[ "$mounted_source" != "$expected_source" ]]; then
  printf 'Unexpected mount source %s; expected %s.\n' "$mounted_source" "$expected_source" >&2
  exit 1
fi

install -d -m 0700 \
  "$LITT_DATA_ROOT/postgres" \
  "$LITT_DATA_ROOT/caddy-data" \
  "$LITT_DATA_ROOT/caddy-config" \
  "$LITT_DATA_ROOT/tmp"
chmod 0700 "$LITT_DATA_ROOT"
findmnt --target "$LITT_DATA_ROOT"
printf 'Encrypted data volume is unlocked and mounted.\n'
