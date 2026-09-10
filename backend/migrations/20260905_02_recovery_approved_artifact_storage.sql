-- Migration date: 2026-09-05
-- Approved DOCX object identity is durable and append-only.
begin;

alter table public.ai_review_exports
  add column if not exists storage_path text,
  add column if not exists size_bytes integer;

alter table public.ai_review_exports
  drop constraint if exists ai_review_exports_storage_metadata_check,
  drop constraint if exists ai_review_exports_size_check,
  drop constraint if exists ai_review_exports_storage_path_check;
alter table public.ai_review_exports
  add constraint ai_review_exports_storage_metadata_check check (
    (storage_path is null and size_bytes is null)
    or (storage_path is not null and size_bytes is not null)
  ),
  add constraint ai_review_exports_size_check check (size_bytes is null or size_bytes > 0),
  add constraint ai_review_exports_storage_path_check check (storage_path is null or storage_path <> '');

create or replace function public.append_ai_review_export(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_artifact jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.ai_reviews%rowtype;
  v_existing public.ai_review_exports%rowtype;
  v_artifact_document_id uuid;
  v_artifact_version_id uuid;
begin
  if not public.ai_jsonb_exact_keys(
    p_artifact,
    array['idempotency_key','review_id','review_revision','execution_id','organization_id','matter_id','project_id','document_id','document_version_id','source_document_sha256','evidence_receipt_sha256','filename','mime_type','artifact_sha256','artifact_document_id','artifact_document_version_id','storage_path','size_bytes']
  )
     or not public.ai_valid_idempotency_key(p_artifact->>'idempotency_key')
     or not public.ai_valid_sha256(p_artifact->>'source_document_sha256')
     or not public.ai_valid_sha256(p_artifact->>'evidence_receipt_sha256')
     or not public.ai_valid_sha256(p_artifact->>'artifact_sha256')
     or p_artifact->>'filename' is distinct from 'Informe de revision humana.docx'
     or p_artifact->>'mime_type' is distinct from 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
     or p_artifact->>'size_bytes' !~ '^[1-9][0-9]*$'
     or (p_artifact->>'size_bytes')::bigint > 2147483647
     or p_artifact->>'storage_path' is distinct from format(
       'orgs/%s/matters/%s/projects/%s/documents/%s/%s.docx',
       (p_artifact->>'organization_id')::uuid,
       (p_artifact->>'matter_id')::uuid,
       (p_artifact->>'project_id')::uuid,
       (p_artifact->>'artifact_document_id')::uuid,
       p_artifact->>'artifact_sha256'
     )
  then
    raise exception 'Invalid AI review export contract';
  end if;

  v_artifact_document_id := (p_artifact->>'artifact_document_id')::uuid;
  v_artifact_version_id := (p_artifact->>'artifact_document_version_id')::uuid;

  select * into v_review
    from public.ai_reviews where id = (p_artifact->>'review_id')::uuid
    for update;
  if v_review.id is null
     or v_review.status is distinct from 'approved'
     or v_review.reviewer_user_id is distinct from p_actor_user_id
     or v_review.organization_id is distinct from p_organization_id
     or v_review.revision is distinct from (p_artifact->>'review_revision')::integer
     or v_review.execution_id is distinct from (p_artifact->>'execution_id')::uuid
     or v_review.matter_id is distinct from (p_artifact->>'matter_id')::uuid
     or v_review.project_id is distinct from (p_artifact->>'project_id')::uuid
     or v_review.document_id is distinct from (p_artifact->>'document_id')::uuid
     or v_review.document_version_id is distinct from (p_artifact->>'document_version_id')::uuid
     or v_review.document_content_sha256 is distinct from p_artifact->>'source_document_sha256'
     or v_review.evidence_receipt_sha256 is distinct from p_artifact->>'evidence_receipt_sha256'
  then
    raise exception 'AI review export scope is invalid';
  end if;
  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_review.matter_id,
    v_review.project_id, p_authorization_epoch, 'review'
  );

  select * into v_existing
    from public.ai_review_exports
   where idempotency_key = p_artifact->>'idempotency_key';
  if found then
    if v_existing.review_id is distinct from v_review.id
       or v_existing.review_id is distinct from (p_artifact->>'review_id')::uuid
       or v_existing.review_revision is distinct from v_review.revision
       or v_existing.review_revision is distinct from (p_artifact->>'review_revision')::integer
       or v_existing.execution_id is distinct from v_review.execution_id
       or v_existing.execution_id is distinct from (p_artifact->>'execution_id')::uuid
       or v_existing.organization_id is distinct from v_review.organization_id
       or v_existing.organization_id is distinct from p_organization_id
       or v_existing.organization_id is distinct from (p_artifact->>'organization_id')::uuid
       or v_existing.matter_id is distinct from v_review.matter_id
       or v_existing.matter_id is distinct from (p_artifact->>'matter_id')::uuid
       or v_existing.project_id is distinct from v_review.project_id
       or v_existing.project_id is distinct from (p_artifact->>'project_id')::uuid
       or v_existing.source_document_id is distinct from v_review.document_id
       or v_existing.source_document_id is distinct from (p_artifact->>'document_id')::uuid
       or v_existing.source_document_version_id is distinct from v_review.document_version_id
       or v_existing.source_document_version_id is distinct from (p_artifact->>'document_version_id')::uuid
       or v_existing.source_document_sha256 is distinct from v_review.document_content_sha256
       or v_existing.source_document_sha256 is distinct from p_artifact->>'source_document_sha256'
       or v_existing.evidence_receipt_sha256 is distinct from v_review.evidence_receipt_sha256
       or v_existing.evidence_receipt_sha256 is distinct from p_artifact->>'evidence_receipt_sha256'
       or v_existing.artifact_document_id is distinct from v_artifact_document_id
       or v_existing.artifact_document_id is distinct from (p_artifact->>'artifact_document_id')::uuid
       or v_existing.artifact_document_version_id is distinct from v_artifact_version_id
       or v_existing.artifact_document_version_id is distinct from (p_artifact->>'artifact_document_version_id')::uuid
       or v_existing.filename is distinct from p_artifact->>'filename'
       or v_existing.mime_type is distinct from p_artifact->>'mime_type'
       or v_existing.artifact_sha256 is distinct from p_artifact->>'artifact_sha256'
       or v_existing.storage_path is distinct from p_artifact->>'storage_path'
       or v_existing.size_bytes is distinct from (p_artifact->>'size_bytes')::integer
       or not exists (
         select 1 from public.document_versions v
         join public.documents d on d.id = v.document_id
         where v.id = v_artifact_version_id
           and v.document_id = v_artifact_document_id
           and d.project_id = v_review.project_id
           and v.storage_path = p_artifact->>'storage_path'
           and v.filename = p_artifact->>'filename'
           and v.file_type = p_artifact->>'mime_type'
           and v.size_bytes = (p_artifact->>'size_bytes')::integer
           and v.content_sha256 = p_artifact->>'artifact_sha256'
           and v.source = 'ai_review_report'
       )
    then
      raise exception 'AI review export idempotency conflict';
    end if;
    return jsonb_build_object(
      'disposition','replayed','review_id',v_review.id,
      'review_revision',v_review.revision,'execution_id',v_review.execution_id,
      'artifact_sha256',v_existing.artifact_sha256,
      'idempotency_key',v_existing.idempotency_key
    );
  end if;

  insert into public.documents(id, project_id, user_id, status)
    values (v_artifact_document_id, v_review.project_id, p_actor_user_id, 'completed')
    on conflict (id) do nothing;
  if not exists (
    select 1 from public.documents
     where id = v_artifact_document_id and project_id = v_review.project_id
  ) then
    raise exception 'AI review export artifact document conflict';
  end if;
  insert into public.document_versions(
    id, document_id, storage_path, filename, file_type, size_bytes,
    content_sha256, source, created_at
  ) values (
    v_artifact_version_id, v_artifact_document_id,
    p_artifact->>'storage_path', p_artifact->>'filename',
    p_artifact->>'mime_type', (p_artifact->>'size_bytes')::integer,
    p_artifact->>'artifact_sha256', 'ai_review_report', now()
  ) on conflict (id) do nothing;
  if not exists (
    select 1 from public.document_versions
       where id = v_artifact_version_id
       and document_id = v_artifact_document_id
       and storage_path = p_artifact->>'storage_path'
       and filename = p_artifact->>'filename'
       and file_type = p_artifact->>'mime_type'
       and size_bytes = (p_artifact->>'size_bytes')::integer
       and content_sha256 = p_artifact->>'artifact_sha256'
       and source = 'ai_review_report'
  ) then
    raise exception 'AI review export artifact version conflict';
  end if;

  insert into public.ai_review_exports (
    idempotency_key, review_id, review_revision, execution_id,
    organization_id, matter_id, project_id,
    source_document_id, source_document_version_id,
    artifact_document_id, artifact_document_version_id,
    source_document_sha256, evidence_receipt_sha256,
    filename, mime_type, artifact_sha256, storage_path, size_bytes
  ) values (
    p_artifact->>'idempotency_key', v_review.id, v_review.revision,
    v_review.execution_id, v_review.organization_id, v_review.matter_id,
    v_review.project_id, v_review.document_id, v_review.document_version_id,
    v_artifact_document_id, v_artifact_version_id,
    v_review.document_content_sha256, v_review.evidence_receipt_sha256,
    p_artifact->>'filename', p_artifact->>'mime_type',
    p_artifact->>'artifact_sha256', p_artifact->>'storage_path',
    (p_artifact->>'size_bytes')::integer
  );

  return jsonb_build_object(
    'disposition','applied','review_id',v_review.id,
    'review_revision',v_review.revision,'execution_id',v_review.execution_id,
    'artifact_sha256',p_artifact->>'artifact_sha256',
    'idempotency_key',p_artifact->>'idempotency_key'
  );
end
$$;

commit;
