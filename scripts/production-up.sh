#!/usr/bin/env bash
# Start only the reviewed production Compose topology after all host guards.
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
expected_compose="$root/compose.prod.yml"
compose_file=${COMPOSE_FILE:-$expected_compose}
compose_env_file=${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the external 0600 interpolation file}
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to the encrypted mount}"
: "${LITT_SECRETS_ROOT:?set LITT_SECRETS_ROOT below the encrypted mount}"
: "${RELEASE_SHA:?set RELEASE_SHA to the reviewed full commit}"
: "${RELEASE_MANIFEST_PATH:?set RELEASE_MANIFEST_PATH to the encrypted release manifest}"

[[ "$(realpath -e "$compose_file")" == "$expected_compose" ]] || {
  printf 'Refusing a non-canonical production Compose path.\n' >&2
  exit 1
}
[[ "$(realpath -e "$compose_env_file")" == "$LITT_SECRETS_ROOT/compose.env" ]] || {
  printf 'Compose env must be the canonical encrypted secrets file.\n' >&2
  exit 1
}
[[ ! -L "$compose_env_file" && -f "$compose_env_file" && "$(stat -c '%a' "$compose_env_file")" == "600" ]] || {
  printf 'Compose env file must exist with mode 600.\n' >&2
  exit 1
}

[[ "$(realpath -e "$RELEASE_MANIFEST_PATH")" == "$LITT_DATA_ROOT/state/release-manifest.json" && ! -L "$RELEASE_MANIFEST_PATH" && "$(stat -c '%a' "$RELEASE_MANIFEST_PATH")" == "600" ]] || {
  printf 'Release manifest must be the canonical encrypted mode-600 file.\n' >&2
  exit 1
}
caddy_sha=$(sha256sum "$root/infra/production/Caddyfile" | cut -d' ' -f1)
jq -e --arg sha "$RELEASE_SHA" --arg caddy "$caddy_sha" '(.release_sha == $sha) and (.source_offer | endswith($sha)) and (.caddy_config_sha256 == $caddy)' "$RELEASE_MANIFEST_PATH" >/dev/null || {
  printf 'Release manifest does not match SHA/source/Caddyfile.\n' >&2
  exit 1
}

"$root/scripts/storage/verify-encrypted-mount.sh"
"$root/scripts/production/verify-host-firewall.sh"
"$root/scripts/production/verify-image-lock.sh"
docker compose --env-file "$compose_env_file" -f "$expected_compose" -p litt-production config --quiet
docker compose --env-file "$compose_env_file" -f "$expected_compose" -p litt-production up -d
