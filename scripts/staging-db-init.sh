#!/usr/bin/env bash
# Fresh-only disposable staging bootstrap. Ordered upgrade uses recovery-upgrade.
set -euo pipefail
if [[ $# != 1 || "$1" != fresh ]]; then
  printf '%s\n' 'Usage: staging-db-init.sh fresh' >&2
  exit 64
fi
schema=/staging/schema.sql
[[ -r "$schema" ]] || { printf '%s\n' 'Canonical schema unavailable' >&2; exit 66; }
digest=$(sha256sum "$schema")
digest=${digest%% *}
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || exit 65
# All bootstrap changes, including the receipt, share one connection/transaction.
# Never re-grant application privileges: canonical SQL owns its ACL contract.
PGCONNECT_TIMEOUT=10 timeout --signal=TERM --kill-after=5s 120s \
  psql -X --set ON_ERROR_STOP=1 --set "schema_sha256=$digest" <<'SQL'
begin;
set local lock_timeout = '10s';
set local statement_timeout = '90s';
select pg_advisory_xact_lock(78246103);
select to_regclass('recovery_staging.bootstrap') is not null as initialized \gset
\if :initialized
select count(*) = 1 and coalesce(bool_and(schema_sha256 = :'schema_sha256'), false) as same_source
  from recovery_staging.bootstrap \gset
\if :same_source
-- No mutation to public schema or grants on a replay.
\else
do $$ begin raise exception 'Staging bootstrap source mismatch'; end $$;
\endif
\else
do $$ begin
  if to_regclass('auth.users') is null then
    raise exception 'Supabase Auth schema is required';
  end if;
  if exists (
    -- Namespace dependencies cover relations AND routines/types/operators,
    -- text-search objects, extensions and per-schema default ACLs. Do not
    -- maintain a partial catalog/relkind allowlist for an emptiness gate.
    select 1 from pg_depend
    where refclassid = 'pg_namespace'::regclass
      and refobjid = 'public'::regnamespace
  ) then
    raise exception 'Fresh bootstrap refuses a nonempty public schema';
  end if;
end $$;
\i /staging/schema.sql
create schema recovery_staging;
revoke all on schema recovery_staging from public;
create table recovery_staging.bootstrap (
  singleton boolean primary key check (singleton),
  schema_sha256 text not null check (schema_sha256 ~ '^[0-9a-f]{64}$')
);
revoke all on recovery_staging.bootstrap from public, anon, authenticated, service_role;
insert into recovery_staging.bootstrap values (true, :'schema_sha256');
\endif
notify pgrst, 'reload schema';
commit;
SQL
