#!/bin/sh
# First-boot role password setup for the production Supabase images.
# The values come from the encrypted, mode-0600 db.env file and are never
# printed. Existing databases must use the explicit password-rotation runbook.
set -eu

: "${SUPABASE_AUTH_PASSWORD:?SUPABASE_AUTH_PASSWORD is required}"
: "${POSTGREST_AUTHENTICATOR_PASSWORD:?POSTGREST_AUTHENTICATOR_PASSWORD is required}"

psql \
  --username "${POSTGRES_USER:-postgres}" \
  --dbname "${POSTGRES_DB:-postgres}" \
  --set=auth_password="${SUPABASE_AUTH_PASSWORD}" \
  --set=rest_password="${POSTGREST_AUTHENTICATOR_PASSWORD}" \
  --set=ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE format('ALTER ROLE supabase_auth_admin PASSWORD %L', :'auth_password');
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE format('ALTER ROLE authenticator PASSWORD %L', :'rest_password');
  END IF;
END
$$;
SQL
