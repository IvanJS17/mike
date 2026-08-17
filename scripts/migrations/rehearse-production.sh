#!/usr/bin/env bash
# Rehearse fresh + idempotent migrations in a disposable Compose project.
set -Eeuo pipefail
umask 077

: "${COMPOSE_FILE:?set COMPOSE_FILE to compose.prod.yml}"
: "${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the disposable mode-600 env file}"
: "${MIGRATION_REHEARSAL_PROJECT:?set MIGRATION_REHEARSAL_PROJECT to litt-rehearsal-*}"
: "${MIGRATION_REHEARSAL_ROOT:?set MIGRATION_REHEARSAL_ROOT to the disposable encrypted root}"
: "${MIGRATION_RECEIPT:?set MIGRATION_RECEIPT inside the rehearsal root}"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
expected="$root/compose.prod.yml"
[[ "$(realpath -e "$COMPOSE_FILE")" == "$expected" ]] || { printf 'Non-canonical migration Compose path.\n' >&2; exit 1; }
[[ "$MIGRATION_REHEARSAL_PROJECT" =~ ^litt-rehearsal-[a-z0-9-]{1,40}$ ]] || { printf 'Non-disposable migration project.\n' >&2; exit 1; }
mkdir -p "$MIGRATION_REHEARSAL_ROOT"
rehearsal_root=$(realpath -e "$MIGRATION_REHEARSAL_ROOT")
[[ "$(realpath -e "$COMPOSE_ENV_FILE")" == "$rehearsal_root/compose.env" ]] || { printf 'Migration env must be inside rehearsal root.\n' >&2; exit 1; }
[[ "$(realpath -e "$MIGRATION_RECEIPT")" == "$rehearsal_root"/* ]] || { printf 'Migration receipt must be inside rehearsal root.\n' >&2; exit 1; }
[[ -f "$COMPOSE_ENV_FILE" && "$(stat -c '%a' "$COMPOSE_ENV_FILE")" == "600" ]] || { printf 'Migration env file must be mode 600.\n' >&2; exit 1; }

compose=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$expected" -p "$MIGRATION_REHEARSAL_PROJECT")
config=$("${compose[@]}" config --format json)
while IFS= read -r source; do
  case "$source" in "$rehearsal_root"/*|"$root"/*) ;; *) printf 'Migration source outside disposable/repository root.\n' >&2; exit 1 ;; esac
done < <(jq -r '.services[].volumes[]?.source // empty' <<<"$config")
started=0
cleanup() { if (( started == 1 )); then "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
mkdir -p "$(dirname "$MIGRATION_RECEIPT")"
"${compose[@]}" up -d db auth rest
started=1
"${compose[@]}" --profile ops run --rm -e MIGRATION_MODE=fresh migrations
"${compose[@]}" --profile ops run --rm -e MIGRATION_MODE=existing migrations
schema_version=$("${compose[@]}" exec -T db psql -At -U postgres -d postgres -c \
  "select coalesce(to_regclass('public.schema_migrations')::text, 'schema_migrations_not_present')" )
jq -n \
  --arg project "$MIGRATION_REHEARSAL_PROJECT" \
  --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg schema_version "$schema_version" \
  --arg backend_image "$(jq -r '.services.backend.image // "unknown"' <<<"$config")" \
  --arg frontend_image "$(jq -r '.services.frontend.image // "unknown"' <<<"$config")" \
  '{status:"success",disposable_project:$project,completed_at:$completed_at,schema_version:$schema_version,backend_image:$backend_image,frontend_image:$frontend_image,rollback:"previous immutable image plus recovery restore"}' \
  >"$MIGRATION_RECEIPT"
chmod 0600 "$MIGRATION_RECEIPT"
printf 'Migration rehearsal passed in %s.\n' "$MIGRATION_REHEARSAL_PROJECT"
