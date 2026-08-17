#!/usr/bin/env bash
# Rehearse fresh + idempotent migrations in a disposable Compose project.
set -Eeuo pipefail
umask 077

: "${COMPOSE_FILE:?set COMPOSE_FILE to compose.prod.yml}"
: "${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the disposable mode-600 env file}"
: "${MIGRATION_REHEARSAL_PROJECT:?set MIGRATION_REHEARSAL_PROJECT to litt-rehearsal-*}"
: "${MIGRATION_REHEARSAL_ROOT:?set MIGRATION_REHEARSAL_ROOT to /srv/litt-rehearsal}"
: "${MIGRATION_DOCKER_CONTEXT:?set MIGRATION_DOCKER_CONTEXT to litt-rehearsal-disposable}"
: "${MIGRATION_TARGET_ID:?set MIGRATION_TARGET_ID to migration-disposable}"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
expected="$root/compose.prod.yml"
target_manifest="$root/infra/production/disposable-targets.json"
jq -e --arg id "$MIGRATION_TARGET_ID" --arg root "/srv/litt-rehearsal" --arg context "$MIGRATION_DOCKER_CONTEXT" \
  '(.migration.target_id == $id) and (.migration.root == $root) and (.migration.docker_context == $context)' "$target_manifest" >/dev/null || { printf 'Migration target is not the versioned disposable target.\n' >&2; exit 1; }
[[ "$(realpath -e "$COMPOSE_FILE")" == "$expected" ]] || { printf 'Non-canonical migration Compose path.\n' >&2; exit 1; }
[[ "$MIGRATION_REHEARSAL_PROJECT" =~ ^litt-rehearsal-[a-z0-9-]{1,40}$ ]] || { printf 'Non-disposable migration project.\n' >&2; exit 1; }
[[ "$MIGRATION_DOCKER_CONTEXT" =~ ^litt-rehearsal-[a-z0-9-]+$ && "$(docker context show)" == "$MIGRATION_DOCKER_CONTEXT" ]] || { printf 'Migration Docker context is not disposable.\n' >&2; exit 1; }
mkdir -p "$MIGRATION_REHEARSAL_ROOT"
rehearsal_root=$(realpath -e "$MIGRATION_REHEARSAL_ROOT")
[[ "$rehearsal_root" == "/srv/litt-rehearsal" && ! -L "$MIGRATION_REHEARSAL_ROOT" ]] || { printf 'Migration rehearsal root is not canonical.\n' >&2; exit 1; }
[[ "$rehearsal_root" != /srv/litt-data* && "$rehearsal_root" != /srv/mike-governed-local-demo* ]] || { printf 'Migration rehearsal root collides with a live/local root.\n' >&2; exit 1; }
[[ "$(realpath -e "$COMPOSE_ENV_FILE")" == "$rehearsal_root/compose.env" && ! -L "$COMPOSE_ENV_FILE" && "$(stat -c '%a' "$COMPOSE_ENV_FILE")" == "600" ]] || { printf 'Migration env must be canonical regular mode 600.\n' >&2; exit 1; }

migration_tree_sha256=$(cd "$root/backend/migrations" && find . -type f -name '*.sql' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
release_sha=$(git -C "$root" rev-parse HEAD)
[[ -z "$(git -C "$root" status --porcelain --untracked-files=all)" ]] || { printf 'Migration source checkout is not clean.\n' >&2; exit 1; }
export LITT_DATA_ROOT="$rehearsal_root/data"
export LITT_SECRETS_ROOT="$rehearsal_root/secrets"
mkdir -p "$LITT_DATA_ROOT/state" "$LITT_SECRETS_ROOT"
export MIGRATION_TARGET_PROJECT="$MIGRATION_REHEARSAL_PROJECT"
export RELEASE_SHA="$release_sha"
export MIGRATION_TREE_SHA256="$migration_tree_sha256"
MIGRATION_RECEIPT="$rehearsal_root/state/migration-rehearsal.json"
export MIGRATION_RECEIPT
jq -n --arg project "$MIGRATION_REHEARSAL_PROJECT" --arg release "$RELEASE_SHA" --arg tree "$MIGRATION_TREE_SHA256" \
  '{approved:true,status:"rehearsal-approved",target_project:$project,release_sha:$release,migration_tree_sha256:$tree}' \
  >"$LITT_DATA_ROOT/state/migration-gate.json"
chmod 0600 "$LITT_DATA_ROOT/state/migration-gate.json"

docker_prefix=(docker --context "$MIGRATION_DOCKER_CONTEXT")
compose=("${docker_prefix[@]}" compose --env-file "$COMPOSE_ENV_FILE" -f "$expected" -p "$MIGRATION_REHEARSAL_PROJECT")
config=$("${compose[@]}" config --format json)
[[ -z "$("${docker_prefix[@]}" ps -aq --filter "label=com.docker.compose.project=$MIGRATION_REHEARSAL_PROJECT")" ]] || { printf 'Migration rehearsal project already exists.\n' >&2; exit 1; }
while IFS= read -r source; do
  [[ ! -L "$source" ]] || { printf 'Migration bind source is a symlink.\n' >&2; exit 1; }
  source_real=$(realpath -e "$source")
  case "$source_real" in "$rehearsal_root"/*|"$root"/*) ;; *) printf 'Migration source outside disposable/repository roots.\n' >&2; exit 1 ;; esac
done < <(jq -r '.services[].volumes[]?.source // empty' <<<"$config")
started=0
cleanup() {
  local status=$?
  if (( started == 1 )); then
    "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || status=1
    [[ -z "$("${docker_prefix[@]}" ps -aq --filter "label=com.docker.compose.project=$MIGRATION_REHEARSAL_PROJECT")" ]] || status=1
  fi
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT
started=1
"${compose[@]}" up -d db auth rest
"${compose[@]}" --profile ops run --rm -e MIGRATION_MODE=fresh migrations
"${compose[@]}" --profile ops run --rm -e MIGRATION_MODE=existing migrations
migration_version=$(find "$root/backend/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort | awk 'END {print}')
jq -n \
  --arg project "$MIGRATION_REHEARSAL_PROJECT" --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg release "$RELEASE_SHA" --arg tree "$MIGRATION_TREE_SHA256" --arg version "$migration_version" \
  --arg backend_image "$(jq -r '.services.backend.image // "unknown"' <<<"$config")" \
  --arg frontend_image "$(jq -r '.services.frontend.image // "unknown"' <<<"$config")" \
  '{approved:true,status:"success",target_project:$project,completed_at:$completed_at,release_sha:$release,migration_tree_sha256:$tree,migration_version:$version,backend_image:$backend_image,frontend_image:$frontend_image,rollback:"previous immutable image plus recovery restore"}' \
  >"$MIGRATION_RECEIPT"
chmod 0600 "$MIGRATION_RECEIPT"
printf 'Migration rehearsal passed in %s.\n' "$MIGRATION_REHEARSAL_PROJECT"
