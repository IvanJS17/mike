#!/usr/bin/env bash
# Rehearse fresh + idempotent production migrations in a disposable Compose
# project. It refuses the local demo file and writes a sanitized receipt.
set -Eeuo pipefail
umask 077

: "${COMPOSE_FILE:?set COMPOSE_FILE to compose.prod.yml}"
: "${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the disposable mode-600 env file}"
: "${MIGRATION_REHEARSAL_PROJECT:?set MIGRATION_REHEARSAL_PROJECT to a litt-rehearsal-* project}"
: "${MIGRATION_RECEIPT:?set MIGRATION_RECEIPT to an evidence path on the disposable host}"

[[ "$MIGRATION_REHEARSAL_PROJECT" == litt-rehearsal-* ]] || {
  printf 'Refusing a non-disposable migration project.\n' >&2
  exit 1
}
[[ "$(basename "$COMPOSE_FILE")" == "compose.prod.yml" ]] || {
  printf 'Refusing a non-production topology for migration rehearsal.\n' >&2
  exit 1
}
[[ -f "$COMPOSE_ENV_FILE" && "$(stat -c '%a' "$COMPOSE_ENV_FILE")" == "600" ]] || {
  printf 'Migration env file must be mode 600.\n' >&2
  exit 1
}
mkdir -p "$(dirname "$MIGRATION_RECEIPT")"
compose=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" -p "$MIGRATION_REHEARSAL_PROJECT")
"${compose[@]}" up -d db auth rest
"${compose[@]}" --profile ops run --rm -e MIGRATION_MODE=fresh migrations
"${compose[@]}" --profile ops run --rm -e MIGRATION_MODE=existing migrations
schema_version=$("${compose[@]}" exec -T db psql -At -U postgres -d postgres -c \
  "select coalesce(max(version), 'none') from schema_migrations" 2>/dev/null | tr -d '[:space:]' || printf 'none')
compose_config=$("${compose[@]}" config --format json)
jq -n \
  --arg project "$MIGRATION_REHEARSAL_PROJECT" \
  --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg schema_version "$schema_version" \
  --arg backend_image "$(jq -r '.services.backend.image // "unknown"' <<<"$compose_config")" \
  --arg frontend_image "$(jq -r '.services.frontend.image // "unknown"' <<<"$compose_config")" \
  '{status:"success",disposable_project:$project,completed_at:$completed_at,schema_version:$schema_version,backend_image:$backend_image,frontend_image:$frontend_image,rollback:"previous immutable image plus recovery restore"}' \
  >"$MIGRATION_RECEIPT"
chmod 0600 "$MIGRATION_RECEIPT"
printf 'Migration rehearsal passed in %s.\n' "$MIGRATION_REHEARSAL_PROJECT"
