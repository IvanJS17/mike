#!/usr/bin/env bash
# Stop only the production Compose project, unmount LUKS2, and close the mapper.
# This intentionally never runs `down -v` and refuses the local Compose file.
set -Eeuo pipefail

: "${LITT_DATA_DEVICE:?set LITT_DATA_DEVICE to the dedicated block device}"
: "${LITT_CRYPT_MAPPER:?set LITT_CRYPT_MAPPER to the mapper name}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to the encrypted mount point}"
: "${LUKS2_CONFIRM:?set LUKS2_CONFIRM=YES after confirming the maintenance window}"

if [[ "$LUKS2_CONFIRM" != "YES" ]]; then
  printf 'Refusing to close the encrypted volume without LUKS2_CONFIRM=YES.\n' >&2
  exit 2
fi
if (( EUID != 0 )); then
  printf 'Run as root through the approved break-glass procedure.\n' >&2
  exit 1
fi
compose_file=${COMPOSE_FILE:-compose.prod.yml}
case "$compose_file" in
  *docker-compose.yml|*docker-compose.yaml)
    printf 'Refusing to operate on the local demo Compose file.\n' >&2
    exit 1
    ;;
esac

if mountpoint -q "$LITT_DATA_ROOT"; then
  docker compose -f "$compose_file" stop
  sync
  umount "$LITT_DATA_ROOT"
fi

if cryptsetup status "$LITT_CRYPT_MAPPER" >/dev/null 2>&1; then
  cryptsetup luksClose "$LITT_CRYPT_MAPPER"
fi
printf 'Production containers stopped and the LUKS2 mapper is closed.\n'
