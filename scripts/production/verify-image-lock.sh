#!/usr/bin/env bash
# Fail-closed validation of all default production images before startup.
set -Eeuo pipefail

: "${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the external 0600 interpolation file}"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
compose_file="$root/compose.prod.yml"
[[ "$(realpath -e "$compose_file")" == "$compose_file" ]] || { printf 'Production Compose path is not canonical.\n' >&2; exit 1; }
[[ -f "$COMPOSE_ENV_FILE" && "$(stat -c '%a' "$COMPOSE_ENV_FILE")" == "600" ]] || { printf 'Compose env file must be mode 600.\n' >&2; exit 1; }

config=$(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$compose_file" config --format json)
images=$(jq -r '.services | to_entries[] | select(.value.image != null) | .value.image' <<<"$config")
count=$(sort -u <<<"$images" | wc -l)
[[ "$count" == "6" ]] || { printf 'Expected six immutable production images, got %s.\n' "$count" >&2; exit 1; }
while IFS= read -r image; do
  [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || { printf 'Mutable/unverified image rejected.\n' >&2; exit 1; }
done <<<"$images"
if jq -e '.services | to_entries[] | select(.value.build != null)' <<<"$config" >/dev/null; then
  printf 'Production Compose contains a build directive.\n' >&2
  exit 1
fi
printf 'Six production images are immutable digests.\n'
