#!/usr/bin/env bash
# Start only the production Compose project after the encrypted-mount guard.
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
compose_file=${COMPOSE_FILE:-"$root/compose.prod.yml"}
compose_env_file=${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the external 0600 interpolation file}

case "$compose_file" in
  *docker-compose.yml|*docker-compose.yaml)
    printf 'Refusing to start the local demo Compose file.\n' >&2
    exit 1
    ;;
esac
if [[ ! -f "$compose_env_file" ]]; then
  printf 'Missing external Compose env file: %s\n' "$compose_env_file" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$compose_env_file")" != "600" ]]; then
  printf 'Compose env file must be mode 600: %s\n' "$compose_env_file" >&2
  exit 1
fi

"$root/scripts/storage/verify-encrypted-mount.sh"
docker compose --env-file "$compose_env_file" -f "$compose_file" config --quiet
docker compose --env-file "$compose_env_file" -f "$compose_file" up -d
