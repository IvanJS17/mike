-- Migration date: 2026-09-05
-- Preserve the populated legacy Drive relation while the unchanged E2a
-- migration removes its obsolete public relation and guard function.
begin;
set local search_path = public, extensions;

do $$
declare
  relation_owner text;
  relation_kind "char";
begin
  if to_regclass('recovery_drive_publication_upgrade_private.ai_review_drive_publications') is not null then
    raise exception 'legacy Drive publication preflight has an unfinished private relation';
  end if;

  if to_regclass('public.ai_review_drive_publications') is not null then
    select c.relkind, pg_get_userbyid(c.relowner)
      into relation_kind, relation_owner
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'ai_review_drive_publications'
     for update;

    if relation_kind <> 'r' then
      raise exception 'legacy Drive publication relation is not a table';
    end if;
    if relation_owner <> current_user then
      raise exception 'legacy Drive publication table ownership is not controlled by the migration owner';
    end if;

    create schema recovery_drive_publication_upgrade_private;
    revoke all on schema recovery_drive_publication_upgrade_private from public;
    lock table public.ai_review_drive_publications in access exclusive mode;

    -- The old guard names public tables that E2a intentionally rebuilds. Drop
    -- only this known dependency before moving the same relation by OID.
    drop trigger if exists ai_review_drive_publication_guard_trigger
      on public.ai_review_drive_publications;
    alter table public.ai_review_drive_publications
      set schema recovery_drive_publication_upgrade_private;
    drop function if exists public.ai_review_drive_publication_guard();
  end if;
end
$$;

commit;
