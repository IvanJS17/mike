#!/bin/sh
# First-boot role password setup. Passwords are written only to a mode-600
# temporary SQL file inside the container and never passed in argv or logged.
set -eu
umask 077
: "${SUPABASE_AUTH_PASSWORD:?SUPABASE_AUTH_PASSWORD is required}"
: "${POSTGREST_AUTHENTICATOR_PASSWORD:?POSTGREST_AUTHENTICATOR_PASSWORD is required}"
tmp_sql=$(mktemp)
trap 'rm -f "$tmp_sql"' EXIT
# PostgreSQL string literals escape a quote by doubling it.
auth_sql=$(printf '%s' "$SUPABASE_AUTH_PASSWORD" | sed "s/'/''/g")
rest_sql=$(printf '%s' "$POSTGREST_AUTHENTICATOR_PASSWORD" | sed "s/'/''/g")
cat >"$tmp_sql" <<SQL
DO \$\$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE format('ALTER ROLE supabase_auth_admin PASSWORD %L', '$auth_sql');
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE format('ALTER ROLE authenticator PASSWORD %L', '$rest_sql');
  END IF;
END
\$\$;
SQL
psql --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-postgres}" --set=ON_ERROR_STOP=1 --file "$tmp_sql"
