#!/usr/bin/env bash
# Fail-closed guard used immediately before production Compose startup.
set -Eeuo pipefail

: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to the encrypted mount point}"
: "${LITT_CRYPT_MAPPER:?set LITT_CRYPT_MAPPER to the mapper name}"

if (( EUID != 0 )); then
  printf 'The encrypted-mount guard must run as root.\n' >&2
  exit 1
fi
if [[ "$LITT_DATA_ROOT" == "/" || "$LITT_DATA_ROOT" != /* ]]; then
  printf 'Invalid LITT_DATA_ROOT.\n' >&2
  exit 1
fi
if [[ ! -d "$LITT_DATA_ROOT" ]]; then
  printf 'Encrypted data directory does not exist: %s\n' "$LITT_DATA_ROOT" >&2
  exit 1
fi

mounted_source=$(findmnt -n -o SOURCE --target "$LITT_DATA_ROOT" || true)
expected_source="/dev/mapper/$LITT_CRYPT_MAPPER"
if [[ "$mounted_source" != "$expected_source" ]]; then
  printf 'Refusing startup: %s is not mounted from %s (actual: %s).\n' \
    "$LITT_DATA_ROOT" "$expected_source" "${mounted_source:-none}" >&2
  exit 1
fi
if ! cryptsetup status "$LITT_CRYPT_MAPPER" >/dev/null 2>&1; then
  printf 'Refusing startup: LUKS mapper %s is not active.\n' "$LITT_CRYPT_MAPPER" >&2
  exit 1
fi

for required_dir in postgres caddy-data caddy-config tmp; do
  if [[ ! -d "$LITT_DATA_ROOT/$required_dir" ]]; then
    printf 'Refusing startup: missing encrypted directory %s.\n' "$required_dir" >&2
    exit 1
  fi
done
printf 'Encrypted production mount verified: %s\n' "$mounted_source"
