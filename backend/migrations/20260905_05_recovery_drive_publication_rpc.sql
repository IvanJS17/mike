-- Migration date: 2026-09-05
-- Coordinator-owned 5.2 Drive publication persistence RPC boundary.
-- Canonical rows are claimed before any external upload and may only be
-- advanced through the two lifecycle RPCs below.
begin;
set local search_path = public, extensions;

alter table public.ai_review_drive_publications
  add column if not exists attempts integer not null default 0;

do $$
begin
  if exists (
    select 1 from public.ai_review_drive_publications where attempts is null
  ) then
    raise exception 'Drive publication attempts cannot be null';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'ai_review_drive_publications_attempts_check'
       and conrelid = 'public.ai_review_drive_publications'::regclass
  ) then
    alter table public.ai_review_drive_publications
      add constraint ai_review_drive_publications_attempts_check
      check (attempts >= 0);
  end if;
end
$$;

drop trigger if exists ai_review_drive_publications_insert_only_trigger
  on public.ai_review_drive_publications;
drop function if exists public.ai_review_drive_publications_insert_only();

create or replace function public.recovery_drive_publication_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_review_drive_publications is immutable; DELETE is forbidden';
  end if;

  if old.legacy_payload is distinct from '{}'::jsonb
     or new.legacy_payload is distinct from '{}'::jsonb
  then
    raise exception 'historical Drive publication evidence is immutable';
  end if;
  if new.id is distinct from old.id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.export_id is distinct from old.export_id
     or new.review_id is distinct from old.review_id
     or new.execution_id is distinct from old.execution_id
     or new.matter_id is distinct from old.matter_id
     or new.project_id is distinct from old.project_id
     or new.organization_id is distinct from old.organization_id
     or new.authorization_epoch is distinct from old.authorization_epoch
     or new.drive_folder_id is distinct from old.drive_folder_id
     or new.sha256 is distinct from old.sha256
     or new.format_version is distinct from old.format_version
     or new.actor_user_id is distinct from old.actor_user_id
     or new.created_at is distinct from old.created_at
  then
    raise exception 'Drive publication identity is immutable';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'Drive publication revision is stale';
  end if;

  if old.status = 'unknown_outcome'
     and new.status in ('uploaded', 'reconciled', 'failed')
     and new.attempts = old.attempts
  then
    return new;
  end if;
  if old.status = 'failed'
     and old.failure_code = 'drive_upload_failed'
     and new.status = 'unknown_outcome'
     and new.attempts = old.attempts + 1
     and new.attempts <= 3
  then
    return new;
  end if;
  raise exception 'Invalid Drive publication transition';
end
$$;

drop trigger if exists ai_review_drive_publication_guard_trigger
  on public.ai_review_drive_publications;
create trigger ai_review_drive_publication_guard_trigger
  before update or delete on public.ai_review_drive_publications
  for each row execute function public.recovery_drive_publication_guard();

create or replace function public.ai_review_drive_export_is_canonical(
  p_export public.ai_review_exports,
  p_review public.ai_reviews
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select (p_export).id is not null
     and (p_review).id is not null
     and (p_export).review_id = (p_review).id
     and (p_export).review_revision = (p_review).revision
     and (p_export).execution_id = (p_review).execution_id
     and (p_export).organization_id = (p_review).organization_id
     and (p_export).matter_id = (p_review).matter_id
     and (p_export).project_id = (p_review).project_id
     and (p_export).source_document_id = (p_review).document_id
     and (p_export).source_document_version_id = (p_review).document_version_id
     and (p_export).source_document_sha256 = (p_review).document_content_sha256
     and (p_export).evidence_receipt_sha256 = (p_review).evidence_receipt_sha256
     and (p_export).filename = 'Informe de revision humana.docx'
     and (p_export).mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
     and public.ai_valid_idempotency_key((p_export).idempotency_key)
     and public.ai_valid_sha256((p_export).artifact_sha256)
     and (p_export).storage_path = format(
       'orgs/%s/matters/%s/projects/%s/documents/%s/%s.docx',
       (p_export).organization_id,
       (p_export).matter_id,
       (p_export).project_id,
       (p_export).artifact_document_id,
       (p_export).artifact_sha256
     )
     and exists (
       select 1
         from public.document_versions as source_version
         join public.documents as source_document
           on source_document.id = source_version.document_id
        where source_document.project_id = (p_review).project_id
          and source_version.id = (p_export).source_document_version_id
          and source_version.document_id = (p_export).source_document_id
          and source_version.content_sha256 = (p_export).source_document_sha256
          and source_version.deleted_at is null
     )
     and exists (
       select 1
         from public.document_versions as artifact_version
         join public.documents as artifact_document
           on artifact_document.id = artifact_version.document_id
        where artifact_version.id = (p_export).artifact_document_version_id
          and artifact_version.document_id = (p_export).artifact_document_id
          and artifact_document.project_id = (p_review).project_id
          and artifact_version.storage_path = (p_export).storage_path
          and artifact_version.filename = (p_export).filename
          and artifact_version.file_type = (p_export).mime_type
          and artifact_version.size_bytes = (p_export).size_bytes
          and artifact_version.content_sha256 = (p_export).artifact_sha256
          and artifact_version.source = 'ai_review_report'
          and artifact_version.deleted_at is null
     )
     and exists (
       select 1
         from public.ai_executions as execution
         join public.ai_receipts as receipt on receipt.execution_id = execution.id
        where execution.id = (p_review).execution_id
          and execution.status = 'succeeded'
          and execution.author_user_id = (p_review).execution_author_user_id
          and execution.organization_id = (p_review).organization_id
          and execution.matter_id = (p_review).matter_id
          and execution.project_id = (p_review).project_id
          and execution.document_id = (p_review).document_id
          and execution.document_version_id = (p_review).document_version_id
          and execution.document_content_sha256 = (p_review).document_content_sha256
          and receipt.receipt_sha256 = (p_review).evidence_receipt_sha256
     );
$$;

create or replace function public.ai_review_drive_publication_result(
  p_disposition text,
  p_publication public.ai_review_drive_publications,
  p_export public.ai_review_exports
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'disposition', p_disposition,
    'publication_id', (p_publication).id,
    'export_id', (p_publication).export_id,
    'review_id', (p_publication).review_id,
    'execution_id', (p_publication).execution_id,
    'matter_id', (p_publication).matter_id,
    'project_id', (p_publication).project_id,
    'organization_id', (p_publication).organization_id,
    'actor_user_id', (p_publication).actor_user_id,
    'authorization_epoch', (p_publication).authorization_epoch,
    'matter_folder_id', (p_publication).drive_folder_id,
    'approved_artifact_sha256', (p_publication).sha256,
    'idempotency_key', (p_publication).idempotency_key,
    'attempts', (p_publication).attempts,
    'outcome', (p_publication).status,
    'provider_file_id', (p_publication).file_id,
    'revision', (p_publication).revision,
    'review_revision', (p_export).review_revision,
    'artifact_document_id', (p_export).artifact_document_id,
    'artifact_document_version_id', (p_export).artifact_document_version_id,
    'artifact_storage_path', (p_export).storage_path,
    'artifact_size_bytes', (p_export).size_bytes,
    'source_document_id', (p_export).source_document_id,
    'source_document_version_id', (p_export).source_document_version_id,
    'remote_size_bytes', (p_publication).size_bytes,
    'remote_checksum', (p_publication).checksum,
    'failure_code', (p_publication).failure_code,
    'legacy_payload', (p_publication).legacy_payload
  );
$$;

create or replace function public.begin_ai_review_drive_publication(
  p_export_id uuid,
  p_review_revision integer,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.ai_reviews%rowtype;
  v_export public.ai_review_exports%rowtype;
  v_publication public.ai_review_drive_publications%rowtype;
  v_folder text;
begin
  if p_export_id is null or p_review_revision is null or p_review_revision < 1
     or p_actor_user_id is null or p_organization_id is null
     or p_authorization_epoch is null or p_authorization_epoch < 0
  then
    raise exception 'Invalid Drive publication begin request' using errcode = '22023';
  end if;

  select * into v_review
    from public.ai_reviews
   where id = (select review_id from public.ai_review_exports where id = p_export_id)
   for update;
  select * into v_export from public.ai_review_exports where id = p_export_id for update;
  if v_review.id is null
     or v_export.id is null
     or v_review.status is distinct from 'approved'
     or v_review.revision is distinct from p_review_revision
     or v_review.organization_id is distinct from p_organization_id
     or v_review.reviewer_user_id is distinct from p_actor_user_id
     or v_review.reviewer_user_id is not distinct from v_review.execution_author_user_id
  then
    raise exception 'Drive publication authority is invalid' using errcode = '42501';
  end if;

  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_review.matter_id,
    v_review.project_id, p_authorization_epoch, 'review'
  );
  perform document.id from public.documents as document
   where document.id in (v_export.source_document_id, v_export.artifact_document_id)
   order by document.id for share;
  perform version.id from public.document_versions as version
   where version.id in (v_export.source_document_version_id, v_export.artifact_document_version_id)
   order by version.id for share;
  if public.ai_review_drive_export_is_canonical(v_export, v_review) is not true then
    raise exception 'Drive publication authority is invalid' using errcode = '42501';
  end if;
  select matter.drive_folder_id into v_folder
    from public.matters as matter
    join public.workspaces as workspace on workspace.id = matter.workspace_id
   where matter.id = v_review.matter_id
     and workspace.organization_id = p_organization_id
     and matter.project_id = v_review.project_id
   for share of matter, workspace;
  if v_folder is null or btrim(v_folder) = '' then
    raise exception 'Drive publication folder is not configured' using errcode = '42501';
  end if;

  select * into v_publication
    from public.ai_review_drive_publications
   where export_id = p_export_id
   for update;
  if found then
    if v_publication.legacy_payload is distinct from '{}'::jsonb then
      return jsonb_build_object('disposition', 'conflict');
    end if;
    if v_publication.idempotency_key is distinct from v_export.idempotency_key
       or v_publication.review_id is distinct from v_review.id
       or v_publication.execution_id is distinct from v_review.execution_id
       or v_publication.matter_id is distinct from v_review.matter_id
       or v_publication.project_id is distinct from v_review.project_id
       or v_publication.organization_id is distinct from v_review.organization_id
       or v_publication.authorization_epoch is distinct from p_authorization_epoch
       or v_publication.drive_folder_id is distinct from v_folder
       or v_publication.sha256 is distinct from v_export.artifact_sha256
       or v_publication.format_version is distinct from 'approved-docx-v1'
       or v_publication.actor_user_id is distinct from p_actor_user_id
    then
      return public.ai_review_drive_publication_result('conflict', v_publication, v_export);
    end if;

    if v_publication.status = 'unknown_outcome' then
      return public.ai_review_drive_publication_result('unknown', v_publication, v_export);
    end if;
    if v_publication.status in ('uploaded', 'reconciled') then
      return public.ai_review_drive_publication_result('replayed', v_publication, v_export);
    end if;
    if v_publication.status = 'failed'
       and v_publication.failure_code = 'drive_upload_failed'
       and v_publication.attempts < 3
    then
      update public.ai_review_drive_publications
         set status = 'unknown_outcome',
             revision = revision + 1,
             attempts = attempts + 1,
             file_id = null,
             size_bytes = null,
             checksum = null,
             failure_code = null,
             updated_at = now()
       where id = v_publication.id and revision = v_publication.revision;
      select * into v_publication
        from public.ai_review_drive_publications where id = v_publication.id;
      insert into public.audit_events(
        actor_user_id, organization_id, event_type, event_detail,
        project_id, status
      ) values (
        p_actor_user_id, p_organization_id,
        'ai_review_drive_publication.transition',
        jsonb_build_object(
          'publication_id', v_publication.id,
          'export_id', v_publication.export_id,
          'matter_id', v_publication.matter_id,
          'review_id', v_publication.review_id,
          'revision', v_publication.revision,
          'attempts', v_publication.attempts,
          'outcome', v_publication.status
        ),
        v_publication.project_id, v_publication.status
      );
      return public.ai_review_drive_publication_result('claimed', v_publication, v_export);
    end if;
    return public.ai_review_drive_publication_result('conflict', v_publication, v_export);
  end if;

  insert into public.ai_review_drive_publications(
    idempotency_key, revision, attempts, export_id, review_id, execution_id,
    matter_id, project_id, organization_id, authorization_epoch, drive_folder_id,
    sha256, format_version, status, actor_user_id, legacy_payload
  ) values (
    v_export.idempotency_key, 1, 1, v_export.id, v_review.id,
    v_review.execution_id, v_review.matter_id, v_review.project_id,
    v_review.organization_id, p_authorization_epoch, v_folder,
    v_export.artifact_sha256, 'approved-docx-v1', 'unknown_outcome',
    p_actor_user_id, '{}'::jsonb
  ) returning * into v_publication;

  insert into public.audit_events(
    actor_user_id, organization_id, event_type, event_detail,
    project_id, status
  ) values (
    p_actor_user_id, p_organization_id,
    'ai_review_drive_publication.transition',
    jsonb_build_object(
      'publication_id', v_publication.id,
      'export_id', v_publication.export_id,
          'matter_id', v_publication.matter_id,
          'review_id', v_publication.review_id,
      'revision', v_publication.revision,
      'attempts', v_publication.attempts,
      'outcome', v_publication.status
    ),
    v_publication.project_id, v_publication.status
  );
  return public.ai_review_drive_publication_result('claimed', v_publication, v_export);
end
$$;

create or replace function public.record_ai_review_drive_publication_outcome(
  p_publication_id uuid,
  p_expected_revision integer,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_outcome text,
  p_provider_file_id text default null,
  p_remote_size_bytes bigint default null,
  p_remote_checksum text default null,
  p_failure_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_publication public.ai_review_drive_publications%rowtype;
  v_updated public.ai_review_drive_publications%rowtype;
  v_review public.ai_reviews%rowtype;
  v_export public.ai_review_exports%rowtype;
  v_folder text;
begin
  if p_publication_id is null or p_expected_revision is null or p_expected_revision < 1
     or p_actor_user_id is null or p_organization_id is null
     or p_authorization_epoch is null or p_authorization_epoch < 0
     or p_outcome not in ('uploaded', 'reconciled', 'failed')
  then
    raise exception 'Invalid Drive publication outcome request' using errcode = '22023';
  end if;

  select * into v_publication
    from public.ai_review_drive_publications
   where id = p_publication_id;
  if not found then
    raise exception 'Drive publication does not exist' using errcode = '22023';
  end if;
  select * into v_review from public.ai_reviews where id = v_publication.review_id for update;
  select * into v_export from public.ai_review_exports where id = v_publication.export_id for update;
  if v_review.id is null
     or v_export.id is null
     or v_review.status is distinct from 'approved'
     or v_review.organization_id is distinct from p_organization_id
     or v_review.reviewer_user_id is distinct from p_actor_user_id
     or v_review.reviewer_user_id is not distinct from v_review.execution_author_user_id
  then
    raise exception 'Drive publication authority is invalid' using errcode = '42501';
  end if;
  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_review.matter_id,
    v_review.project_id, p_authorization_epoch, 'review'
  );
  perform document.id from public.documents as document
   where document.id in (v_export.source_document_id, v_export.artifact_document_id)
   order by document.id for share;
  perform version.id from public.document_versions as version
   where version.id in (v_export.source_document_version_id, v_export.artifact_document_version_id)
   order by version.id for share;
  if public.ai_review_drive_export_is_canonical(v_export, v_review) is not true then
    raise exception 'Drive publication authority is invalid' using errcode = '42501';
  end if;
  select matter.drive_folder_id into v_folder
    from public.matters as matter
    join public.workspaces as workspace on workspace.id = matter.workspace_id
   where matter.id = v_review.matter_id
     and workspace.organization_id = p_organization_id
     and matter.project_id = v_review.project_id
   for share of matter, workspace;
  if v_folder is null or btrim(v_folder) = '' then
    raise exception 'Drive publication folder is not configured' using errcode = '42501';
  end if;
  select * into v_publication from public.ai_review_drive_publications
   where id = p_publication_id for update;
  if v_publication.legacy_payload is distinct from '{}'::jsonb
     or v_publication.idempotency_key is distinct from v_export.idempotency_key
     or v_publication.review_id is distinct from v_review.id
     or v_publication.execution_id is distinct from v_review.execution_id
     or v_publication.matter_id is distinct from v_review.matter_id
     or v_publication.project_id is distinct from v_review.project_id
     or v_publication.organization_id is distinct from v_review.organization_id
     or v_publication.authorization_epoch is distinct from p_authorization_epoch
     or v_publication.drive_folder_id is distinct from v_folder
     or v_publication.sha256 is distinct from v_export.artifact_sha256
     or v_publication.format_version is distinct from 'approved-docx-v1'
     or v_publication.actor_user_id is distinct from p_actor_user_id
  then
    return public.ai_review_drive_publication_result('conflict', v_publication, v_export);
  end if;

  if v_publication.status in ('uploaded', 'reconciled') then
    if p_outcome = v_publication.status
       and p_provider_file_id is not distinct from v_publication.file_id
       and p_remote_size_bytes is not distinct from v_publication.size_bytes
       and p_remote_checksum is not distinct from v_publication.checksum
       and p_failure_code is null
    then
      return public.ai_review_drive_publication_result('replayed', v_publication, v_export);
    end if;
    return public.ai_review_drive_publication_result('conflict', v_publication, v_export);
  end if;
  if v_publication.status is distinct from 'unknown_outcome'
     or v_publication.revision is distinct from p_expected_revision
  then
    return public.ai_review_drive_publication_result('conflict', v_publication, v_export);
  end if;

  if p_outcome in ('uploaded', 'reconciled') then
    if p_provider_file_id is null or btrim(p_provider_file_id) = ''
       or length(p_provider_file_id) > 1024
       or p_remote_size_bytes is distinct from v_export.size_bytes
       or p_remote_checksum is distinct from v_export.artifact_sha256
       or length(p_remote_checksum) > 1024
       or p_failure_code is not null
    then
      raise exception 'Drive remote metadata is invalid' using errcode = '22023';
    end if;
  elsif p_failure_code is distinct from 'drive_upload_failed'
     or p_provider_file_id is not null
     or p_remote_size_bytes is not null
     or p_remote_checksum is not null
  then
    raise exception 'Drive failure metadata is invalid' using errcode = '22023';
  end if;

  update public.ai_review_drive_publications
     set status = p_outcome,
         revision = revision + 1,
         file_id = p_provider_file_id,
         size_bytes = p_remote_size_bytes,
         checksum = p_remote_checksum,
         failure_code = p_failure_code,
         updated_at = now()
   where id = v_publication.id
     and revision = p_expected_revision
     and status = 'unknown_outcome'
  returning * into v_updated;
  if not found then
    select * into v_updated from public.ai_review_drive_publications
     where id = v_publication.id;
    return public.ai_review_drive_publication_result('conflict', v_updated, v_export);
  end if;

  insert into public.audit_events(
    actor_user_id, organization_id, event_type, event_detail,
    project_id, status
  ) values (
    p_actor_user_id, p_organization_id,
    'ai_review_drive_publication.transition',
    jsonb_build_object(
      'publication_id', v_updated.id,
      'export_id', v_updated.export_id,
          'matter_id', v_updated.matter_id,
          'review_id', v_updated.review_id,
      'revision', v_updated.revision,
      'attempts', v_updated.attempts,
      'outcome', v_updated.status
    ),
    v_updated.project_id, v_updated.status
  );
  return public.ai_review_drive_publication_result('applied', v_updated, v_export);
end
$$;

create or replace function public.read_ai_review_drive_publication(
  p_publication_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_publication public.ai_review_drive_publications%rowtype;
  v_review public.ai_reviews%rowtype;
  v_export public.ai_review_exports%rowtype;
begin
  select * into v_publication
    from public.ai_review_drive_publications where id = p_publication_id;
  if not found then return null; end if;
  if v_publication.legacy_payload is distinct from '{}'::jsonb then
    return jsonb_build_object('disposition', 'conflict');
  end if;
  select * into v_review from public.ai_reviews where id = v_publication.review_id;
  select * into v_export from public.ai_review_exports where id = v_publication.export_id;
  if v_review.id is null
     or v_export.id is null
     or v_review.organization_id is distinct from p_organization_id
     or not public.ai_review_drive_export_is_canonical(v_export, v_review)
  then
    raise exception 'Drive publication is not readable' using errcode = '42501';
  end if;
  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_review.matter_id,
    v_review.project_id, p_authorization_epoch, 'read'
  );
  return public.ai_review_drive_publication_result('read', v_publication, v_export);
end
$$;

revoke all on public.ai_review_drive_publications from anon, authenticated, service_role;
grant select on public.ai_review_drive_publications to service_role;

revoke all on function public.recovery_drive_publication_guard() from public, anon, authenticated, service_role;
revoke all on function public.ai_review_drive_export_is_canonical(public.ai_review_exports, public.ai_reviews) from public, anon, authenticated, service_role;
revoke all on function public.ai_review_drive_publication_result(text, public.ai_review_drive_publications, public.ai_review_exports) from public, anon, authenticated, service_role;
revoke all on function public.begin_ai_review_drive_publication(uuid, integer, uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.record_ai_review_drive_publication_outcome(uuid, integer, uuid, uuid, bigint, text, text, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.read_ai_review_drive_publication(uuid, uuid, uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function public.begin_ai_review_drive_publication(uuid, integer, uuid, uuid, bigint) to service_role;
grant execute on function public.record_ai_review_drive_publication_outcome(uuid, integer, uuid, uuid, bigint, text, text, bigint, text, text) to service_role;
grant execute on function public.read_ai_review_drive_publication(uuid, uuid, uuid, bigint) to service_role;

commit;
