#!/usr/bin/env bash
# Apply the repository's ordered migrations from the production DB image.
# MIGRATION_MODE=fresh loads schema.sql before the dated migrations; existing
# runs only the dated migrations. The caller must create a recovery set first.
set -Eeuo pipefail

: "${MIGRATION_MODE:?set MIGRATION_MODE=fresh or existing}"
case "$MIGRATION_MODE" in
  fresh|existing) ;;
  *) printf 'Unknown MIGRATION_MODE: %s\n' "$MIGRATION_MODE" >&2; exit 1 ;;
esac
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

psql_cmd=(psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1)
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
