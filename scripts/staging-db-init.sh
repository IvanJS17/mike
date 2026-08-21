#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'staging db-init: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: db-init.sh fresh

Only supported mode is: fresh. Upgrade mode is not supported by this script.
EOF
}

if [[ "${1:-}" != "fresh" || "$#" -ne 1 ]]; then
  usage
  exit 64
fi

SCHEMA_FILE=/staging/schema.sql
psql_args=(
  --no-psqlrc
  --set ON_ERROR_STOP=1
  --username "${PGUSER:?PGUSER is required}"
  --dbname "${PGDATABASE:?PGDATABASE is required}"
)

schema_digest="$(sha256sum "$SCHEMA_FILE")"
schema_sha256="${schema_digest%% *}"
[[ "$schema_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  fail "could not calculate the canonical schema checksum"

until psql "${psql_args[@]}" -tAc "select 1 where to_regclass('auth.users') is not null" | grep -qx 1; do
  echo "waiting for Supabase Auth schema"
  sleep 2
done

marker_exists="$(psql "${psql_args[@]}" -tAc \
  "select to_regclass('public._mike_staging_bootstrap') is not null;")"
read -r marker_exists <<<"$marker_exists"

case "$marker_exists" in
  t)
    database_state="$(psql "${psql_args[@]}" -tAc "
select case
  when count(*) = 1
   and bool_and(
     id is true
     and mode = 'fresh'
     and schema_sha256 = '$schema_sha256'
   )
    then 'initialized'
  else 'ambiguous'
end
  from public._mike_staging_bootstrap;
")"
    read -r database_state <<<"$database_state"
    ;;
  f)
    public_relation_count="$(psql "${psql_args[@]}" -tAc "
select count(*)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f');
")"
    read -r public_relation_count <<<"$public_relation_count"
    if [[ "$public_relation_count" == "0" ]]; then
      database_state=empty
    elif [[ "$public_relation_count" =~ ^[0-9]+$ ]]; then
      database_state=nonempty
    else
      database_state=ambiguous
    fi
    ;;
  *)
    fail "could not determine whether the bootstrap marker exists"
    ;;
esac

case "$database_state" in
  empty)
    echo "database state: empty; loading canonical schema once (fresh)"
    ;;
  initialized)
    echo "database state: initialized with the same canonical schema; skipping fresh bootstrap"
    psql "${psql_args[@]}" <<'SQL'
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
notify pgrst, 'reload schema';
SQL
    exit 0
    ;;
  nonempty)
    fail "database is not empty; fresh mode refuses to run an upgrade or replay historical migrations"
    ;;
  ambiguous)
    fail "database state is ambiguous; refusing to bootstrap without destroying or replaying anything"
    ;;
  *)
    fail "could not classify database state: ${database_state:-<empty>}"
    ;;
esac

psql "${psql_args[@]}" --single-transaction --file "$SCHEMA_FILE"

missing_relations="$(psql "${psql_args[@]}" -tAc "
with required(name) as (
  values
    ('user_profiles'),
    ('documents'),
    ('document_versions'),
    ('workflows'),
    ('tabular_reviews'),
    ('organizations'),
    ('workspaces'),
    ('matters'),
    ('ai_executions'),
    ('ai_reviews'),
    ('ai_review_exports'),
    ('ai_redline_bundles'),
    ('ai_review_drive_publications')
)
select coalesce(string_agg(name, ', ' order by name), '')
  from required
 where to_regclass('public.' || name) is null;
")"
read -r missing_relations <<<"$missing_relations"
[[ -z "$missing_relations" ]] ||
  fail "canonical schema is missing required current tables: $missing_relations"

psql "${psql_args[@]}" \
  --single-transaction \
  --variable schema_sha256="$schema_sha256" <<'SQL'
create table if not exists public._mike_staging_bootstrap (
  id boolean primary key check (id is true),
  mode text not null check (mode = 'fresh'),
  schema_sha256 text not null check (schema_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);

insert into public._mike_staging_bootstrap (id, mode, schema_sha256)
values (true, 'fresh', :'schema_sha256');

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
notify pgrst, 'reload schema';
SQL

echo "staging db-init: fresh bootstrap complete"