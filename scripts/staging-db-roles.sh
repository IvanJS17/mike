#!/usr/bin/env bash
set -euo pipefail

# Supabase's image creates these roles before init scripts run. Match their
# password to POSTGRES_PASSWORD so Auth and PostgREST can use the same local DB.
# `postgres` is not a superuser in this image, and the reserved roles already
# have LOGIN; changing only PASSWORD avoids altering their protected attributes.
psql \
  --set ON_ERROR_STOP=1 \
  --username supabase_admin \
  --dbname "${POSTGRES_DB:-postgres}" \
  --variable db_password="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" <<'SQL'
SELECT format(
  'ALTER ROLE %I PASSWORD %L',
  rolname,
  :'db_password'
)
FROM pg_roles
WHERE rolname IN ('supabase_auth_admin', 'authenticator');
\gexec
SQL
