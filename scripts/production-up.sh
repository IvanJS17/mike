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

[[ "$(git -C "$root" rev-parse HEAD)" == "$RELEASE_SHA" ]] || { printf 'Release SHA does not match the checked-out HEAD.\n' >&2; exit 1; }
git -C "$root" cat-file -e "$RELEASE_SHA^{commit}" || { printf 'Release SHA is not a commit in this checkout.\n' >&2; exit 1; }
[[ -z "$(git -C "$root" status --porcelain --untracked-files=all)" ]] || { printf 'Production source checkout is not clean.\n' >&2; exit 1; }
for source_path in backend/schema.sql backend/migrations scripts/migrations/apply-production.sh; do
  git -C "$root" ls-files --error-unmatch "$source_path" >/dev/null || { printf 'Migration source is not tracked: %s\n' "$source_path" >&2; exit 1; }
done

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

compose_config=$(docker compose --env-file "$compose_env_file" -f "$expected_compose" -p litt-production config --format json)
effective_source=$(jq -er '.services.caddy.environment.SOURCE_OFFER_URL' <<<"$compose_config")
jq -e \
  --arg source "$effective_source" \
  --arg backend "$(jq -er '.services.backend.image' <<<"$compose_config")" \
  --arg frontend "$(jq -er '.services.frontend.image' <<<"$compose_config")" \
  --arg caddy "$(jq -er '.services.caddy.image' <<<"$compose_config")" \
  --arg db "$(jq -er '.services.db.image' <<<"$compose_config")" \
  --arg auth "$(jq -er '.services.auth.image' <<<"$compose_config")" \
  --arg rest "$(jq -er '.services.rest.image' <<<"$compose_config")" \
  '(.source_offer == $source) and (.images.backend == $backend) and (.images.frontend == $frontend) and (.images.caddy == $caddy) and (.images.postgres == $db) and (.images.auth == $auth) and (.images.rest == $rest)' \
  "$RELEASE_MANIFEST_PATH" >/dev/null || {
  printf 'Release manifest does not match effective Compose source/images.\n' >&2
  exit 1
}

"$root/scripts/storage/verify-encrypted-mount.sh"
"$root/scripts/production/verify-host-firewall.sh"
"$root/scripts/production/verify-image-lock.sh"
docker compose --env-file "$compose_env_file" -f "$expected_compose" -p litt-production config --quiet
docker compose --env-file "$compose_env_file" -f "$expected_compose" -p litt-production up -d
