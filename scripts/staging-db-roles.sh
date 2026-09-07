#!/usr/bin/env bash
set -euo pipefail
# Fresh image initialization only; canonical SQL owns application privileges.
psql -X --set ON_ERROR_STOP=1 --username supabase_admin --dbname "${POSTGRES_DB:-postgres}" <<'SQL'
begin;
do $$
declare item record;
begin
  if exists (
    select 1 from pg_depend
    where refclassid = 'pg_namespace'::regclass
      and refobjid = 'public'::regnamespace
      and classid <> 'pg_default_acl'::regclass
  ) or exists (
    select 1 from pg_default_acl d join pg_roles r on r.oid=d.defaclrole
    where d.defaclnamespace='public'::regnamespace
      and (r.rolname not in ('postgres','supabase_admin') or d.defaclobjtype not in ('r','S','f'))
  ) then
    raise exception 'Image initialization refuses nonempty or unexpected public schema';
  end if;
  -- Supabase image grants on future objects would broaden canonical grants.
  -- Revoke per-schema defaults only, never delete data or change global ACLs.
  for item in
    select distinct r.rolname, d.defaclobjtype, a.grantee
    from pg_default_acl d join pg_roles r on r.oid=d.defaclrole
    cross join lateral aclexplode(d.defaclacl) a
    where d.defaclnamespace='public'::regnamespace
  loop
    execute format('alter default privileges for role %I in schema public revoke all on %s from %s',
      item.rolname,
      case item.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' end,
      case when item.grantee=0 then 'public' else quote_ident(pg_get_userbyid(item.grantee)) end);
  end loop;
  if exists (select 1 from pg_default_acl where defaclnamespace='public'::regnamespace) then
    raise exception 'Image public default privileges were not cleared';
  end if;
end $$;
\getenv db_password POSTGRES_PASSWORD
select format('alter role %I password %L', rolname, :'db_password')
from pg_roles where rolname in ('supabase_auth_admin','authenticator')
\gexec
commit;
SQL
