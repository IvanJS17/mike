-- Migration date: 2026-09-05
-- Restore the preserved relation in place and publish a canonical,
-- read-only historical Drive publication shape.
begin;
set local search_path = public, extensions;

do $$
begin
  if to_regclass('recovery_drive_publication_upgrade_private.ai_review_drive_publications') is not null then
    if to_regclass('public.ai_review_drive_publications') is not null then
      raise exception 'canonical Drive publication relation already exists beside the preserved relation';
    end if;
    alter table recovery_drive_publication_upgrade_private.ai_review_drive_publications
      add column if not exists legacy_payload jsonb;
    update recovery_drive_publication_upgrade_private.ai_review_drive_publications as publication
       set legacy_payload = to_jsonb(publication) - 'legacy_payload'
     where publication.legacy_payload is null;
    alter table recovery_drive_publication_upgrade_private.ai_review_drive_publications
      set schema public;
  end if;
end
$$;

create table if not exists public.ai_review_drive_publications (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  revision integer not null default 1,
  export_id uuid not null,
  review_id uuid not null,
  execution_id uuid not null,
  matter_id uuid not null,
  project_id uuid not null,
  organization_id uuid not null,
  authorization_epoch bigint not null,
  drive_folder_id text not null,
  file_id text,
  sha256 text not null,
  format_version text not null,
  status text not null default 'pending',
  size_bytes bigint,
  checksum text,
  failure_code text,
  actor_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  legacy_payload jsonb not null default '{}'::jsonb
);

-- The old relation has the same row identity and columns, but its constraints
-- encode the retired publication state machine. Remove only constraints and
-- indexes from this one known table; no row cleanup is performed.
do $$
declare
  constraint_row record;
  index_row record;
begin
  for constraint_row in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.ai_review_drive_publications'::regclass
       and con.contype <> 'p'
  loop
    execute format(
      'alter table public.ai_review_drive_publications drop constraint %I',
      constraint_row.conname
    );
  end loop;

  for index_row in
    select i.indexrelid::regclass as index_name
      from pg_index i
     where i.indrelid = 'public.ai_review_drive_publications'::regclass
       and not i.indisprimary
  loop
    execute format('drop index if exists %s', index_row.index_name);
  end loop;
end
$$;

alter table public.ai_review_drive_publications
  add column if not exists idempotency_key text,
  add column if not exists revision integer,
  add column if not exists legacy_payload jsonb;

-- The replay-safe canonical pass may need to normalize defaults again. The
-- trigger is restored below after that migration-only maintenance update.
drop trigger if exists ai_review_drive_publications_insert_only_trigger
  on public.ai_review_drive_publications;

update public.ai_review_drive_publications as publication
   set idempotency_key = coalesce(publication.idempotency_key, 'legacy-drive-publication:' || publication.id::text),
       revision = coalesce(publication.revision, 1),
       legacy_payload = coalesce(
         publication.legacy_payload,
         to_jsonb(publication) - 'legacy_payload'
       ),
       status = case
         when publication.status = 'published' then 'uploaded'
         when publication.status in ('pending', 'failed')
           and publication.legacy_payload->>'status' in ('pending', 'failed')
           then 'unknown_outcome'
         else publication.status
       end;

alter table public.ai_review_drive_publications
  alter column idempotency_key set not null,
  alter column revision set default 1,
  alter column revision set not null,
  alter column authorization_epoch set not null,
  alter column drive_folder_id set not null,
  alter column sha256 set not null,
  alter column format_version set not null,
  alter column status set default 'pending',
  alter column status set not null,
  alter column actor_user_id set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null,
  alter column legacy_payload set default '{}'::jsonb,
  alter column legacy_payload set not null;

alter table public.ai_review_drive_publications
  add constraint ai_review_drive_publications_export_id_fkey
    foreign key (export_id) references public.ai_review_exports(id) on delete restrict,
  add constraint ai_review_drive_publications_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  add constraint ai_review_drive_publications_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  add constraint ai_review_drive_publications_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  add constraint ai_review_drive_publications_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  add constraint ai_review_drive_publications_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  add constraint ai_review_drive_publications_actor_user_id_fkey
    foreign key (actor_user_id) references auth.users(id) on delete restrict,
  add constraint ai_review_drive_publications_export_id_key unique (export_id),
  add constraint ai_review_drive_publications_idempotency_key_key unique (idempotency_key),
  add constraint ai_review_drive_publications_revision_check check (revision >= 1),
  add constraint ai_review_drive_publications_authorization_epoch_check
    check (authorization_epoch >= 0),
  add constraint ai_review_drive_publications_destination_check
    check (btrim(drive_folder_id) <> ''),
  add constraint ai_review_drive_publications_sha256_check
    check (sha256 ~ '^[0-9a-f]{64}$'),
  add constraint ai_review_drive_publications_format_version_check
    check (btrim(format_version) <> ''),
  add constraint ai_review_drive_publications_failure_code_check check (
    failure_code is null or failure_code in (
      'drive_upload_outcome_unknown',
      'drive_upload_failed',
      'drive_file_invalid',
      'authorization_revoked',
      'publication_record_failed',
      'drive_cleanup_failed'
    )
  ),
  add constraint ai_review_drive_publications_state_check check (
    status in (
      'pending',
      'uploaded',
      'unknown_outcome',
      'reconciled',
      'failed'
    )
  ),
  add constraint ai_review_drive_publications_metadata_check check (
    (status = 'pending'
      and file_id is null and size_bytes is null and checksum is null)
    or (status in ('uploaded', 'reconciled')
      and nullif(btrim(file_id), '') is not null
      and size_bytes is not null and size_bytes >= 0
      and nullif(btrim(checksum), '') is not null
      and failure_code is null)
    or (status = 'unknown_outcome'
      and (size_bytes is null or size_bytes >= 0))
    or (status = 'failed' and failure_code is not null
      and file_id is null and size_bytes is null and checksum is null)
  ),
  add constraint ai_review_drive_publications_legacy_payload_check
    check (jsonb_typeof(legacy_payload) = 'object');

create index ai_review_drive_publications_matter_idx
  on public.ai_review_drive_publications(matter_id, created_at desc);
create index ai_review_drive_publications_review_idx
  on public.ai_review_drive_publications(review_id, created_at desc);
create index ai_review_drive_publications_organization_idx
  on public.ai_review_drive_publications(organization_id, created_at desc);

create or replace function public.ai_review_drive_publications_insert_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_review_drive_publications is historical evidence and is insert-only';
end;
$$;

drop trigger if exists ai_review_drive_publications_insert_only_trigger
  on public.ai_review_drive_publications;
create trigger ai_review_drive_publications_insert_only_trigger
  before update or delete on public.ai_review_drive_publications
  for each row execute function public.ai_review_drive_publications_insert_only();

alter table public.ai_review_drive_publications enable row level security;
revoke all on public.ai_review_drive_publications from anon, authenticated, service_role;
grant select on public.ai_review_drive_publications to service_role;

drop policy if exists ai_review_drive_publications_service_select
  on public.ai_review_drive_publications;
create policy ai_review_drive_publications_service_select
  on public.ai_review_drive_publications
  for select to service_role using (true);

revoke all on function public.ai_review_drive_publications_insert_only()
  from public, anon, authenticated, service_role;

drop schema if exists recovery_drive_publication_upgrade_private;

commit;
