#!/usr/bin/env bash
# Apply ordered migrations only after an immutable recovery/rehearsal gate.
set -Eeuo pipefail

: "${MIGRATION_MODE:?set MIGRATION_MODE=fresh or existing}"
case "$MIGRATION_MODE" in
  fresh|existing) ;;
  *) printf 'Unknown MIGRATION_MODE: %s\n' "$MIGRATION_MODE" >&2; exit 1 ;;
esac
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${MIGRATION_GATE_FILE:?MIGRATION_GATE_FILE is required}"
: "${MIGRATION_TARGET_ID:?MIGRATION_TARGET_ID is required}"
: "${MIGRATION_TARGET_PROJECT:?MIGRATION_TARGET_PROJECT is required}"
: "${MIGRATION_COMPOSE_PROJECT:?MIGRATION_COMPOSE_PROJECT is required}"
: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${MIGRATION_TREE_SHA256:?MIGRATION_TREE_SHA256 is required}"
: "${MIGRATION_DOCKER_CONTEXT:?MIGRATION_DOCKER_CONTEXT is required}"
: "${MIGRATION_RUNTIME_ID_FILE:?MIGRATION_RUNTIME_ID_FILE is required}"
[[ "$MIGRATION_GATE_FILE" == "/run/litt-state/migration-gate.json" ]] || { printf 'Migration gate path is not canonical.\n' >&2; exit 1; }
[[ "$MIGRATION_RUNTIME_ID_FILE" == "/run/litt-state/runtime-identity.json" ]] || { printf 'Migration runtime identity path is not canonical.\n' >&2; exit 1; }
[[ "$POSTGRES_USER" == postgres && "$POSTGRES_DB" == postgres && "$POSTGRES_HOST" == db ]] || { printf 'Migrations require canonical postgres database host/user/name.\n' >&2; exit 1; }
[[ "$MIGRATION_COMPOSE_PROJECT" == "$MIGRATION_TARGET_PROJECT" ]] || { printf 'Migration Compose project and target project differ.\n' >&2; exit 1; }
case "$MIGRATION_TARGET_PROJECT:$MIGRATION_TARGET_ID:$MIGRATION_COMPOSE_PROJECT:$MIGRATION_DOCKER_CONTEXT" in
  litt-production:production-runtime:litt-production:litt-production|litt-rehearsal-disposable:migration-disposable:litt-rehearsal-disposable:litt-rehearsal-disposable) ;;
  *) printf 'Migration runtime target identity is not approved.\n' >&2; exit 1 ;;
esac
if [[ "$MIGRATION_TARGET_PROJECT" == "litt-production" && "$MIGRATION_MODE" == "fresh" ]]; then
  printf 'Fresh schema migration is forbidden against production.\n' >&2
  exit 1
fi
[[ -f "$MIGRATION_RUNTIME_ID_FILE" && ! -L "$MIGRATION_RUNTIME_ID_FILE" && "$(stat -c '%a' "$MIGRATION_RUNTIME_ID_FILE")" =~ ^(600|644)$ ]] || { printf 'Migration runtime identity file is missing or unsafe.\n' >&2; exit 1; }
jq -e --arg id "$MIGRATION_TARGET_ID" --arg project "$MIGRATION_TARGET_PROJECT" --arg compose_project "$MIGRATION_COMPOSE_PROJECT" --arg context "$MIGRATION_DOCKER_CONTEXT" --arg host "$POSTGRES_HOST" --arg database "$POSTGRES_DB" --arg release "$RELEASE_SHA" --arg tree "$MIGRATION_TREE_SHA256" \
  '(.target_id == $id) and (.project == $project) and (.compose_project == $compose_project) and (.docker_context == $context) and (.postgres_host == $host) and (.database == $database) and (.release_sha == $release) and (.migration_tree_sha256 == $tree)' "$MIGRATION_RUNTIME_ID_FILE" >/dev/null || { printf 'Migration runtime identity file is not bound to this target/release.\n' >&2; exit 1; }
[[ -f "$MIGRATION_GATE_FILE" && ! -L "$MIGRATION_GATE_FILE" ]] || { printf 'Migration gate receipt is missing.\n' >&2; exit 1; }
actual_tree_sha=$(cd /opt/litt/migrations && find . -type f -name '*.sql' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
[[ "$actual_tree_sha" == "$MIGRATION_TREE_SHA256" ]] || { printf 'Migration tree hash does not match the release gate.\n' >&2; exit 1; }
jq -e --arg id "$MIGRATION_TARGET_ID" --arg project "$MIGRATION_TARGET_PROJECT" --arg compose_project "$MIGRATION_COMPOSE_PROJECT" --arg context "$MIGRATION_DOCKER_CONTEXT" --arg release "$RELEASE_SHA" --arg tree "$MIGRATION_TREE_SHA256" \
  '(.target_id == $id) and (.release_sha == $release) and (.migration_tree_sha256 == $tree) and (.target_project == $project) and (.compose_project == $compose_project) and (.docker_context == $context) and (.approved == true)' "$MIGRATION_GATE_FILE" >/dev/null || { printf 'Migration gate is not bound to this target/project/context/tree.\n' >&2; exit 1; }
if [[ "$MIGRATION_TARGET_PROJECT" == litt-production ]]; then
  : "${MIGRATION_RECOVERY_SUCCESS_FILE:?MIGRATION_RECOVERY_SUCCESS_FILE is required for production migrations}"
  : "${MIGRATION_REHEARSAL_RECEIPT_FILE:?MIGRATION_REHEARSAL_RECEIPT_FILE is required for production migrations}"
  [[ -f "$MIGRATION_RECOVERY_SUCCESS_FILE" && ! -L "$MIGRATION_RECOVERY_SUCCESS_FILE" ]] || { printf 'Production recovery SUCCESS marker is missing.\n' >&2; exit 1; }
  [[ -f "$MIGRATION_REHEARSAL_RECEIPT_FILE" && ! -L "$MIGRATION_REHEARSAL_RECEIPT_FILE" ]] || { printf 'Migration rehearsal receipt is missing.\n' >&2; exit 1; }
  jq -e --arg set_id "$(jq -er '.recovery_set_id' "$MIGRATION_GATE_FILE")" --arg release "$RELEASE_SHA" \
    '(.status == "success") and (.set_id == $set_id) and (.release_sha == $release)' "$MIGRATION_RECOVERY_SUCCESS_FILE" >/dev/null || { printf 'Recovery SUCCESS marker does not match production migration gate.\n' >&2; exit 1; }
  rehearsal_sha=$(sha256sum "$MIGRATION_REHEARSAL_RECEIPT_FILE" | cut -d' ' -f1)
  [[ "$rehearsal_sha" == "$(jq -er '.rehearsal_receipt_sha256' "$MIGRATION_GATE_FILE")" ]] || { printf 'Migration rehearsal receipt hash does not match gate.\n' >&2; exit 1; }
  jq -e --arg release "$RELEASE_SHA" --arg tree "$MIGRATION_TREE_SHA256" '(.status == "success") and (.release_sha == $release) and (.migration_tree_sha256 == $tree)' "$MIGRATION_REHEARSAL_RECEIPT_FILE" >/dev/null || { printf 'Migration rehearsal receipt is not bound to this release/tree.\n' >&2; exit 1; }
else
  [[ "$MIGRATION_TARGET_PROJECT" =~ ^litt-rehearsal-[a-z0-9-]+$ ]] || { printf 'Non-production migration target is not disposable.\n' >&2; exit 1; }
fi

psql_cmd=(psql --host "$POSTGRES_HOST" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1)
if [[ "$MIGRATION_MODE" == "fresh" ]]; then
  "${psql_cmd[@]}" --file /opt/litt/schema.sql
fi
for migration in /opt/litt/migrations/*.sql; do
  [[ -f "$migration" ]] || continue
  "${psql_cmd[@]}" --file "$migration"
done
"${psql_cmd[@]}" <<'SQL'
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
NOTIFY pgrst, 'reload schema';
SQL
printf 'Migrations applied in %s mode.\n' "$MIGRATION_MODE"
