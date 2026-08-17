#!/usr/bin/env bash
# Stop only the canonical production Compose project and close LUKS2.
set -Eeuo pipefail
: "${LITT_DATA_DEVICE:?set LITT_DATA_DEVICE}"
: "${LITT_CRYPT_MAPPER:?set LITT_CRYPT_MAPPER}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT}"
: "${LITT_SECRETS_ROOT:?set LITT_SECRETS_ROOT}"
: "${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to encrypted secrets/compose.env}"
: "${LUKS2_CONFIRM:?set LUKS2_CONFIRM=YES}"
[[ "$LUKS2_CONFIRM" == YES ]] || { printf 'Explicit LUKS2_CONFIRM=YES is required.\n' >&2; exit 2; }
(( EUID == 0 )) || { printf 'Run as root.\n' >&2; exit 1; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
expected="$root/compose.prod.yml"
[[ -z "${COMPOSE_FILE:-}" || "$(realpath -e "${COMPOSE_FILE}")" == "$expected" ]] || { printf 'Non-canonical Compose path.\n' >&2; exit 1; }
[[ "$(realpath -e "$COMPOSE_ENV_FILE")" == "$LITT_SECRETS_ROOT/compose.env" ]] || { printf 'Non-canonical Compose env path.\n' >&2; exit 1; }
if mountpoint -q "$LITT_DATA_ROOT"; then
  docker compose --env-file "$COMPOSE_ENV_FILE" -f "$expected" -p litt-production stop
  sync
  umount "$LITT_DATA_ROOT"
fi
if cryptsetup status "$LITT_CRYPT_MAPPER" >/dev/null 2>&1; then
  mapped=$(cryptsetup status "$LITT_CRYPT_MAPPER" | awk '/device:/ {print $2}')
  [[ -n "$mapped" && "$(realpath -e "$mapped")" == "$(realpath -e "$LITT_DATA_DEVICE")" ]] || { printf 'Mapper/device mismatch.\n' >&2; exit 1; }
  cryptsetup luksClose "$LITT_CRYPT_MAPPER"
fi
printf 'Production containers stopped and LUKS2 mapper closed.\n'
