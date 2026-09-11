-- Migration date: 2026-09-04
-- E2a: converge the deployed LiTT AI evidence/review persistence shape with
-- the recovered evidence-v1 and approved-redline-v1 contracts.

begin;
set local search_path = public, extensions;

-- Drive publication belongs to Slice G. Retire only an empty legacy evidence
-- relation; preserve the coordinator-owned matter folder field for that slice.
do $$
begin
  if to_regclass('public.ai_review_drive_publications') is not null then
    if exists (select 1 from public.ai_review_drive_publications limit 1) then
      raise exception 'Non-empty legacy AI Drive publications require the Slice G migration';
    end if;
    drop table public.ai_review_drive_publications;
  end if;
end
$$;

drop function if exists public.ai_review_drive_publication_guard();

-- Remove the superseded Beta guards before renaming their referenced columns.
do $$
declare
  trigger_row record;
begin
  for trigger_row in
    select trigger.oid, trigger.tgname, relation.oid::regclass as relation
      from pg_trigger as trigger
      join pg_class as relation on relation.oid = trigger.tgrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname in (
         'ai_document_version_pages',
         'ai_executions',
         'ai_output_versions',
         'ai_receipts',
         'ai_reviews',
         'ai_review_items',
         'ai_review_decisions',
         'ai_review_exports',
         'ai_redline_bundles'
       )
       and not trigger.tgisinternal
  loop
    execute format(
      'drop trigger if exists %I on %s',
      trigger_row.tgname,
      trigger_row.relation
    );
  end loop;
end
$$;

drop function if exists public.ai_document_version_pages_integrity();
drop function if exists public.ai_execution_scope_integrity();
drop function if exists public.ai_execution_update_guard();
drop function if exists public.ai_append_only_guard();
drop function if exists public.ai_review_scope_guard();
drop function if exists public.ai_review_update_guard();
drop function if exists public.ai_review_item_update_guard();
drop function if exists public.ai_review_decision_insert_guard();
drop function if exists public.ai_review_decisions_insert_only();
drop function if exists public.ai_review_write_authorization_guard();
drop function if exists public.ai_review_export_scope_guard();
drop function if exists public.ai_review_exports_insert_only();
drop function if exists public.ai_redline_bundle_scope_guard();
drop function if exists public.ai_redline_bundles_insert_only();
drop function if exists public.apply_ai_review_item_decision(
  uuid, uuid, uuid, uuid, bigint, text, text, text
);
drop function if exists public.complete_ai_review(
  uuid, uuid, uuid, bigint, text, text
);
drop function if exists public.assert_ai_redline_bundle_access(
  uuid, uuid, uuid, bigint, text
);

-- Rebuild non-primary constraints and indexes from one canonical target set.
-- Primary keys and row identities remain in place.
do $$
declare
  constraint_row record;
  index_row record;
begin
  for constraint_row in
    select con.conrelid::regclass as relation, con.conname
      from pg_constraint as con
      join pg_class as relation on relation.oid = con.conrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname in (
         'ai_document_version_pages',
         'ai_executions',
         'ai_output_versions',
         'ai_receipts',
         'ai_reviews',
         'ai_review_items',
         'ai_review_decisions',
         'ai_review_exports',
         'ai_redline_bundles'
       )
       and con.contype <> 'p'
  loop
    execute format(
      'alter table %s drop constraint %I',
      constraint_row.relation,
      constraint_row.conname
    );
  end loop;

  for index_row in
    select index_class.oid::regclass as index_name
      from pg_index as idx
      join pg_class as relation on relation.oid = idx.indrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      join pg_class as index_class on index_class.oid = idx.indexrelid
     where namespace.nspname = 'public'
       and relation.relname in (
         'ai_document_version_pages',
         'ai_executions',
         'ai_output_versions',
         'ai_receipts',
         'ai_reviews',
         'ai_review_items',
         'ai_review_decisions',
         'ai_review_exports',
         'ai_redline_bundles'
       )
       and not idx.indisprimary
  loop
    execute format('drop index if exists %s', index_row.index_name);
  end loop;
end
$$;

-- Executions: preserve old identifiers by renaming, and tag rows whose newer
-- workflow provenance cannot be reconstructed without inventing authority.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_executions'
       and column_name = 'user_id'
  ) then
    alter table public.ai_executions rename column user_id to author_user_id;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_executions'
       and column_name = 'workflow_id'
  ) then
    alter table public.ai_executions rename column workflow_id to workflow_key;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_executions'
       and column_name = 'playbook_sha256'
  ) then
    alter table public.ai_executions
      rename column playbook_sha256 to workflow_content_hash;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_executions'
       and column_name = 'input_sha256' and data_type = 'text'
  ) then
    alter table public.ai_executions
      alter column input_sha256 type text[] using array[input_sha256];
    alter table public.ai_executions rename column input_sha256 to input_hashes;
  end if;
end
$$;

alter table public.ai_executions
  add column if not exists idempotency_key text,
  add column if not exists evidence_version text,
  add column if not exists organization_id uuid,
  add column if not exists workflow_source_commit text,
  add column if not exists workflow_distribution text,
  add column if not exists workflow_type text,
  add column if not exists workflow_source text,
  add column if not exists workflow_approval_provenance text,
  add column if not exists output_hashes text[],
  add column if not exists citation_hashes text[];

update public.ai_executions as execution
   set organization_id = workspace.organization_id
  from public.matters as matter
  join public.workspaces as workspace on workspace.id = matter.workspace_id
 where execution.matter_id = matter.id
   and execution.organization_id is null;

update public.ai_executions as execution
   set idempotency_key = coalesce(
         execution.idempotency_key,
         'legacy-beta-0.1:' || execution.id::text
       ),
       evidence_version = coalesce(execution.evidence_version, 'legacy-beta-0.1'),
       output_hashes = coalesce(
         execution.output_hashes,
         array(
           select output.output_sha256
             from public.ai_output_versions as output
            where output.execution_id = execution.id
            order by output.id
         )
       ),
       citation_hashes = coalesce(
         execution.citation_hashes,
         array(
           select citation ->> 'quote_sha256'
             from public.ai_output_versions as output
             cross join lateral jsonb_array_elements(
               coalesce(output.citation_refs, '[]'::jsonb)
             ) as citation
            where output.execution_id = execution.id
              and citation ->> 'quote_sha256' is not null
            order by citation ->> 'citation_id'
         )
       );

alter table public.ai_executions
  alter column idempotency_key set not null,
  alter column evidence_version set default 'evidence-v1',
  alter column evidence_version set not null,
  alter column author_user_id set not null,
  alter column project_id set not null,
  alter column workflow_key set not null,
  alter column workflow_version set not null,
  alter column workflow_content_hash set not null,
  alter column output_hashes set not null,
  alter column citation_hashes set not null,
  alter column document_id set not null,
  alter column document_version_id set not null,
  alter column document_content_sha256 set not null,
  alter column input_hashes set not null,
  alter column route_provider set not null,
  alter column route_model set not null,
  alter column credential_ref set not null,
  alter column status set default 'pending',
  alter column status set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

-- Receipts: serialize the historical jsonb object into the only current
-- canonical-text column before removing the duplicate physical representation.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_receipts'
       and column_name = 'canonical_json' and data_type = 'jsonb'
  ) then
    alter table public.ai_receipts rename column canonical_json to legacy_payload;
    alter table public.ai_receipts add column canonical_json text;
    update public.ai_receipts set canonical_json = legacy_payload::text;
    alter table public.ai_receipts drop column legacy_payload;
  end if;
end
$$;

alter table public.ai_receipts
  add column if not exists idempotency_key text;

update public.ai_receipts as receipt
   set receipt_version = case
         when receipt.receipt_version = 'evidence-v1' then 'evidence-v1'
         else 'legacy-beta-0.1'
       end,
       idempotency_key = coalesce(
         receipt.idempotency_key,
         execution.idempotency_key,
         'legacy-beta-0.1:' || receipt.id::text
       )
  from public.ai_executions as execution
 where execution.id = receipt.execution_id;

alter table public.ai_receipts
  alter column idempotency_key set not null,
  alter column receipt_version set default 'evidence-v1',
  alter column receipt_version set not null,
  alter column canonical_json set not null,
  alter column receipt_sha256 set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

-- Reviews inherit all scope and evidence bindings from their immutable execution.
alter table public.ai_reviews
  add column if not exists idempotency_key text,
  add column if not exists revision integer,
  add column if not exists execution_author_user_id uuid,
  add column if not exists organization_id uuid,
  add column if not exists document_id uuid,
  add column if not exists document_version_id uuid,
  add column if not exists document_content_sha256 text,
  add column if not exists evidence_receipt_sha256 text;

update public.ai_reviews as review
   set status = case when review.status = 'in_progress' then 'pending' else review.status end,
       idempotency_key = coalesce(
         review.idempotency_key,
         'legacy-beta-0.1:' || review.id::text
       ),
       revision = coalesce(review.revision, 1),
       execution_author_user_id = coalesce(
         review.execution_author_user_id,
         execution.author_user_id
       ),
       organization_id = coalesce(review.organization_id, execution.organization_id),
       matter_id = coalesce(review.matter_id, execution.matter_id),
       project_id = coalesce(review.project_id, execution.project_id),
       document_id = coalesce(review.document_id, execution.document_id),
       document_version_id = coalesce(
         review.document_version_id,
         execution.document_version_id
       ),
       document_content_sha256 = coalesce(
         review.document_content_sha256,
         execution.document_content_sha256
       ),
       evidence_receipt_sha256 = coalesce(
         review.evidence_receipt_sha256,
         receipt.receipt_sha256
       )
  from public.ai_executions as execution
  join public.ai_receipts as receipt on receipt.execution_id = execution.id
 where execution.id = review.execution_id;

alter table public.ai_reviews
  alter column idempotency_key set not null,
  alter column revision set default 1,
  alter column revision set not null,
  alter column execution_author_user_id set not null,
  alter column reviewer_user_id set not null,
  alter column organization_id set not null,
  alter column matter_id set not null,
  alter column project_id set not null,
  alter column document_id set not null,
  alter column document_version_id set not null,
  alter column document_content_sha256 set not null,
  alter column evidence_receipt_sha256 set not null,
  alter column status set default 'pending',
  alter column status set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

alter table public.ai_review_items add column if not exists item_id text;
update public.ai_review_items
   set item_id = review_id::text || ':' || item_key
 where item_id is null;
alter table public.ai_review_items
  alter column review_id set not null,
  alter column item_id set not null,
  alter column item_key set not null,
  alter column original_text set not null,
  alter column finding_text set not null,
  alter column citation_refs set default '[]'::jsonb,
  alter column citation_refs set not null,
  alter column status set default 'pending',
  alter column status set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

-- Existing rows become revisions 2..N because revision 1 denotes review creation.
alter table public.ai_review_decisions
  add column if not exists operation text,
  add column if not exists revision integer,
  add column if not exists idempotency_key text;

with ordered as (
  select decision.id,
         row_number() over (
           partition by decision.review_id
           order by decision.created_at, decision.id
         )::integer + 1 as reconstructed_revision
    from public.ai_review_decisions as decision
)
update public.ai_review_decisions as decision
   set operation = coalesce(
         decision.operation,
         case when decision.review_item_id is null then 'complete' else 'decide' end
       ),
       revision = coalesce(decision.revision, ordered.reconstructed_revision),
       idempotency_key = coalesce(
         decision.idempotency_key,
         'legacy-beta-0.1:' || decision.id::text
       )
  from ordered
 where ordered.id = decision.id;

update public.ai_reviews as review
   set revision = greatest(
         review.revision,
         coalesce((
           select max(decision.revision)
             from public.ai_review_decisions as decision
            where decision.review_id = review.id
         ), 1)
       );

alter table public.ai_review_decisions
  alter column review_id set not null,
  alter column actor_user_id set not null,
  alter column operation set not null,
  alter column revision set not null,
  alter column idempotency_key set not null,
  alter column decision set not null,
  alter column before_state set not null,
  alter column after_state set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

-- Approved DOCX exports retain the same row identity. Legacy actor and report
-- revision are redundant only when they equal the review authority/revision;
-- fail closed otherwise before removing those duplicate columns.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_review_exports'
       and column_name = 'document_id'
  ) then
    alter table public.ai_review_exports rename column document_id to artifact_document_id;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_review_exports'
       and column_name = 'document_version_id'
  ) then
    alter table public.ai_review_exports
      rename column document_version_id to artifact_document_version_id;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_review_exports'
       and column_name = 'report_version'
  ) then
    alter table public.ai_review_exports rename column report_version to legacy_report_revision;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_review_exports'
       and column_name = 'content_sha256'
  ) then
    alter table public.ai_review_exports rename column content_sha256 to artifact_sha256;
  end if;
end
$$;

alter table public.ai_review_exports
  add column if not exists idempotency_key text,
  add column if not exists review_revision integer,
  add column if not exists organization_id uuid,
  add column if not exists source_document_id uuid,
  add column if not exists source_document_sha256 text,
  add column if not exists evidence_receipt_sha256 text,
  add column if not exists mime_type text;

update public.ai_review_exports as export
   set idempotency_key = coalesce(
         export.idempotency_key,
         'legacy-beta-0.1:' || export.id::text
       ),
       review_revision = coalesce(export.review_revision, review.revision),
       organization_id = coalesce(export.organization_id, review.organization_id),
       matter_id = coalesce(export.matter_id, review.matter_id),
       project_id = coalesce(export.project_id, review.project_id),
       source_document_id = coalesce(
         export.source_document_id,
         source_version.document_id
       ),
       source_document_sha256 = coalesce(
         export.source_document_sha256,
         review.document_content_sha256
       ),
       evidence_receipt_sha256 = coalesce(
         export.evidence_receipt_sha256,
         review.evidence_receipt_sha256
       ),
       mime_type = coalesce(
         export.mime_type,
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       )
  from public.ai_reviews as review,
       public.document_versions as source_version
 where review.id = export.review_id
   and source_version.id = export.source_document_version_id;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_review_exports'
       and column_name = 'legacy_report_revision'
  ) then
    if exists (
      select 1
        from public.ai_review_exports
       where legacy_report_revision <> 1
       limit 1
    ) then
      raise exception 'Unknown legacy report format revision requires an explicit migration';
    end if;
    alter table public.ai_review_exports drop column legacy_report_revision;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_review_exports'
       and column_name = 'actor_user_id'
  ) then
    if exists (
      select 1
        from public.ai_review_exports as export
        join public.ai_reviews as review on review.id = export.review_id
       where export.actor_user_id is distinct from review.reviewer_user_id
       limit 1
    ) then
      raise exception 'Legacy export actor differs from assigned reviewer';
    end if;
    alter table public.ai_review_exports drop column actor_user_id;
  end if;
end
$$;

alter table public.ai_review_exports
  alter column idempotency_key set not null,
  alter column review_id set not null,
  alter column review_revision set not null,
  alter column execution_id set not null,
  alter column organization_id set not null,
  alter column matter_id set not null,
  alter column project_id set not null,
  alter column source_document_id set not null,
  alter column source_document_version_id set not null,
  alter column artifact_document_id set not null,
  alter column artifact_document_version_id set not null,
  alter column source_document_sha256 set not null,
  alter column evidence_receipt_sha256 set not null,
  alter column filename set not null,
  alter column mime_type set not null,
  alter column artifact_sha256 set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

-- Redline rows retain canonical text and actions. Legacy receipt IDs and parsed
-- payloads are verified against the current columns before their duplicate
-- physical representation is removed.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'source_document_version_id'
  ) then
    alter table public.ai_redline_bundles
      rename column source_document_version_id to document_version_id;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'receipt_id'
  ) then
    alter table public.ai_redline_bundles rename column receipt_id to legacy_receipt_id;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'receipt_sha256'
  ) then
    alter table public.ai_redline_bundles
      rename column receipt_sha256 to evidence_receipt_sha256;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'canonical_json' and data_type = 'jsonb'
  ) then
    alter table public.ai_redline_bundles rename column canonical_json to legacy_payload;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'canonical_json_text'
  ) then
    alter table public.ai_redline_bundles
      rename column canonical_json_text to canonical_json;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'actions_count'
  ) then
    alter table public.ai_redline_bundles
      rename column actions_count to legacy_action_count;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'actor_user_id'
  ) then
    alter table public.ai_redline_bundles rename column actor_user_id to reviewer_user_id;
  end if;
end
$$;

alter table public.ai_redline_bundles
  add column if not exists idempotency_key text,
  add column if not exists review_revision integer,
  add column if not exists organization_id uuid,
  add column if not exists document_id uuid,
  add column if not exists evidence_receipt_version text,
  add column if not exists actions jsonb;

update public.ai_redline_bundles as bundle
   set bundle_version = case
         when bundle.bundle_version = 'approved-redline-v1'
           then 'approved-redline-v1'
         else 'legacy-beta-0.1'
       end,
       idempotency_key = coalesce(
         bundle.idempotency_key,
         'legacy-beta-0.1:' || bundle.id::text
       ),
       review_revision = coalesce(bundle.review_revision, review.revision),
       organization_id = coalesce(bundle.organization_id, review.organization_id),
       matter_id = coalesce(bundle.matter_id, review.matter_id),
       project_id = coalesce(bundle.project_id, review.project_id),
       document_id = coalesce(bundle.document_id, version.document_id),
       evidence_receipt_version = coalesce(
         bundle.evidence_receipt_version,
         receipt.receipt_version
       )
  from public.ai_reviews as review,
       public.document_versions as version,
       public.ai_receipts as receipt
 where review.id = bundle.review_id
   and version.id = bundle.document_version_id
   and receipt.execution_id = review.execution_id;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'legacy_payload'
  ) then
    update public.ai_redline_bundles
       set actions = coalesce(actions, legacy_payload -> 'actions');
    if exists (
      select 1
        from public.ai_redline_bundles
       where jsonb_typeof(actions) is distinct from 'array'
       limit 1
    ) then
      raise exception 'Legacy redline actions are not representable';
    end if;
    alter table public.ai_redline_bundles drop column legacy_payload;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'legacy_action_count'
  ) then
    if exists (
      select 1
        from public.ai_redline_bundles
       where legacy_action_count is distinct from jsonb_array_length(actions)
       limit 1
    ) then
      raise exception 'Legacy redline action count does not match its payload';
    end if;
    alter table public.ai_redline_bundles drop column legacy_action_count;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_redline_bundles'
       and column_name = 'legacy_receipt_id'
  ) then
    if exists (
      select 1
        from public.ai_redline_bundles as bundle
        left join public.ai_receipts as receipt on receipt.id = bundle.legacy_receipt_id
       where receipt.id is null
          or receipt.execution_id is distinct from bundle.execution_id
          or receipt.receipt_sha256 is distinct from bundle.evidence_receipt_sha256
       limit 1
    ) then
      raise exception 'Legacy redline receipt binding is invalid';
    end if;
    alter table public.ai_redline_bundles drop column legacy_receipt_id;
  end if;
end
$$;

alter table public.ai_redline_bundles
  alter column idempotency_key set not null,
  alter column bundle_version set default 'approved-redline-v1',
  alter column bundle_version set not null,
  alter column revision set default 1,
  alter column revision set not null,
  alter column review_id set not null,
  alter column review_revision set not null,
  alter column execution_id set not null,
  alter column organization_id set not null,
  alter column matter_id set not null,
  alter column project_id set not null,
  alter column document_id set not null,
  alter column document_version_id set not null,
  alter column source_document_sha256 set not null,
  alter column evidence_receipt_version set not null,
  alter column evidence_receipt_sha256 set not null,
  alter column reviewer_user_id set not null,
  alter column actions set not null,
  alter column canonical_json set not null,
  alter column bundle_sha256 set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

alter table public.document_versions
  drop constraint if exists document_versions_source_check;
alter table public.document_versions
  add constraint document_versions_source_check check (
    source in (
      'upload',
      'user_upload',
      'assistant_edit',
      'user_accept',
      'user_reject',
      'generated',
      'ai_review_report'
    )
  );

-- Canonical restrictive reference graph and semantic constraints.
alter table public.ai_document_version_pages
  add constraint ai_document_version_pages_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete restrict,
  add constraint ai_document_version_pages_document_version_id_fkey
    foreign key (document_version_id) references public.document_versions(id) on delete restrict,
  add constraint ai_document_version_pages_page_check check (page >= 1),
  add constraint ai_document_version_pages_content_integrity_check check (
    content_sha256 ~ '^[0-9a-f]{64}$'
    and content_sha256 = encode(digest(content, 'sha256'), 'hex')
  ),
  add constraint ai_document_version_pages_version_page_key
    unique (document_version_id, page);

alter table public.ai_executions
  add constraint ai_executions_idempotency_key_key unique (idempotency_key),
  add constraint ai_executions_author_user_id_fkey
    foreign key (author_user_id) references auth.users(id) on delete restrict,
  add constraint ai_executions_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  add constraint ai_executions_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  add constraint ai_executions_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  add constraint ai_executions_chat_id_fkey
    foreign key (chat_id) references public.chats(id) on delete restrict,
  add constraint ai_executions_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete restrict,
  add constraint ai_executions_document_version_id_fkey
    foreign key (document_version_id) references public.document_versions(id) on delete restrict,
  add constraint ai_executions_evidence_version_check check (
    evidence_version in ('legacy-beta-0.1', 'evidence-v1')
  ),
  add constraint ai_executions_workflow_content_hash_check check (
    workflow_content_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_executions_document_content_hash_check check (
    document_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_executions_input_hashes_check check (
    cardinality(input_hashes) >= 1 and array_position(input_hashes, null) is null
  ),
  add constraint ai_executions_output_hashes_check check (
    array_position(output_hashes, null) is null
  ),
  add constraint ai_executions_citation_hashes_check check (
    array_position(citation_hashes, null) is null
  ),
  add constraint ai_executions_status_check check (
    status in ('pending', 'running', 'succeeded', 'failed')
  ),
  add constraint ai_executions_current_shape_check check (
    evidence_version = 'legacy-beta-0.1'
    or (
      organization_id is not null
      and matter_id is not null
      and workflow_source_commit ~ '^[0-9a-f]{40}$'
      and workflow_distribution in ('default', 'addon')
      and workflow_type in ('assistant', 'tabular')
      and btrim(workflow_source) <> ''
      and btrim(workflow_approval_provenance) <> ''
      and btrim(route_provider) <> ''
      and btrim(route_model) <> ''
      and btrim(credential_ref) <> ''
    )
  );

alter table public.ai_output_versions
  add constraint ai_output_versions_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  add constraint ai_output_versions_execution_id_key unique (execution_id),
  add constraint ai_output_versions_format_check check (output_format = 'markdown'),
  add constraint ai_output_versions_hash_check check (
    output_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_output_versions_citations_check check (
    jsonb_typeof(citation_refs) = 'array'
  );

alter table public.ai_receipts
  add constraint ai_receipts_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  add constraint ai_receipts_execution_id_key unique (execution_id),
  add constraint ai_receipts_idempotency_key_key unique (idempotency_key),
  add constraint ai_receipts_version_check check (
    receipt_version in ('legacy-beta-0.1', 'evidence-v1')
  ),
  add constraint ai_receipts_hash_check check (
    receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_receipts_current_integrity_check check (
    receipt_version = 'legacy-beta-0.1'
    or receipt_sha256 = encode(digest(canonical_json, 'sha256'), 'hex')
  );

alter table public.ai_reviews
  add constraint ai_reviews_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  add constraint ai_reviews_execution_author_user_id_fkey
    foreign key (execution_author_user_id) references auth.users(id) on delete restrict,
  add constraint ai_reviews_reviewer_user_id_fkey
    foreign key (reviewer_user_id) references auth.users(id) on delete restrict,
  add constraint ai_reviews_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  add constraint ai_reviews_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  add constraint ai_reviews_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  add constraint ai_reviews_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete restrict,
  add constraint ai_reviews_document_version_id_fkey
    foreign key (document_version_id) references public.document_versions(id) on delete restrict,
  add constraint ai_reviews_execution_id_key unique (execution_id),
  add constraint ai_reviews_idempotency_key_key unique (idempotency_key),
  add constraint ai_reviews_revision_check check (revision >= 1),
  add constraint ai_reviews_status_check check (
    status in ('pending', 'approved', 'changes_requested')
  ),
  add constraint ai_reviews_document_hash_check check (
    document_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_reviews_receipt_hash_check check (
    evidence_receipt_sha256 ~ '^[0-9a-f]{64}$'
  );

alter table public.ai_review_items
  add constraint ai_review_items_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  add constraint ai_review_items_review_item_key unique (review_id, item_id),
  add constraint ai_review_items_review_key_key unique (review_id, item_key),
  add constraint ai_review_items_id_check check (btrim(item_id) <> ''),
  add constraint ai_review_items_citations_check check (
    jsonb_typeof(citation_refs) = 'array'
  ),
  add constraint ai_review_items_status_check check (
    status in ('pending', 'accepted', 'rejected', 'edited')
  ),
  add constraint ai_review_items_comment_check check (
    comment is null or char_length(comment) <= 2000
  );

alter table public.ai_review_decisions
  add constraint ai_review_decisions_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  add constraint ai_review_decisions_review_item_id_fkey
    foreign key (review_item_id) references public.ai_review_items(id) on delete restrict,
  add constraint ai_review_decisions_actor_user_id_fkey
    foreign key (actor_user_id) references auth.users(id) on delete restrict,
  add constraint ai_review_decisions_review_idempotency_key
    unique (review_id, idempotency_key),
  add constraint ai_review_decisions_operation_check check (
    operation in ('create', 'decide', 'complete')
  ),
  add constraint ai_review_decisions_revision_check check (revision >= 1),
  add constraint ai_review_decisions_value_check check (
    decision in (
      'pending', 'accepted', 'rejected', 'edited', 'approved', 'changes_requested'
    )
  ),
  add constraint ai_review_decisions_scope_check check (
    (operation = 'create' and review_item_id is null and decision = 'pending' and revision = 1)
    or (operation = 'decide' and review_item_id is not null
      and decision in ('accepted', 'rejected', 'edited'))
    or (operation = 'complete' and review_item_id is null
      and decision in ('approved', 'changes_requested'))
  ),
  add constraint ai_review_decisions_state_check check (
    jsonb_typeof(before_state) = 'object' and jsonb_typeof(after_state) = 'object'
  ),
  add constraint ai_review_decisions_comment_check check (
    comment is null or char_length(comment) <= 2000
  );

alter table public.ai_review_exports
  add constraint ai_review_exports_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  add constraint ai_review_exports_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  add constraint ai_review_exports_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  add constraint ai_review_exports_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  add constraint ai_review_exports_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  add constraint ai_review_exports_source_document_id_fkey
    foreign key (source_document_id) references public.documents(id) on delete restrict,
  add constraint ai_review_exports_source_document_version_id_fkey
    foreign key (source_document_version_id) references public.document_versions(id) on delete restrict,
  add constraint ai_review_exports_artifact_document_id_fkey
    foreign key (artifact_document_id) references public.documents(id) on delete restrict,
  add constraint ai_review_exports_artifact_document_version_id_fkey
    foreign key (artifact_document_version_id) references public.document_versions(id) on delete restrict,
  add constraint ai_review_exports_review_revision_key
    unique (review_id, review_revision),
  add constraint ai_review_exports_artifact_version_key
    unique (artifact_document_version_id),
  add constraint ai_review_exports_idempotency_key_key unique (idempotency_key),
  add constraint ai_review_exports_review_revision_check check (review_revision >= 1),
  add constraint ai_review_exports_filename_check check (
    filename = 'Informe de revision humana.docx'
  ),
  add constraint ai_review_exports_mime_check check (
    mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ),
  add constraint ai_review_exports_source_hash_check check (
    source_document_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_review_exports_receipt_hash_check check (
    evidence_receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_review_exports_artifact_hash_check check (
    artifact_sha256 ~ '^[0-9a-f]{64}$'
  );

alter table public.ai_redline_bundles
  add constraint ai_redline_bundles_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  add constraint ai_redline_bundles_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  add constraint ai_redline_bundles_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  add constraint ai_redline_bundles_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  add constraint ai_redline_bundles_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  add constraint ai_redline_bundles_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete restrict,
  add constraint ai_redline_bundles_document_version_id_fkey
    foreign key (document_version_id) references public.document_versions(id) on delete restrict,
  add constraint ai_redline_bundles_reviewer_user_id_fkey
    foreign key (reviewer_user_id) references auth.users(id) on delete restrict,
  add constraint ai_redline_bundles_review_revision_key
    unique (review_id, review_revision, revision),
  add constraint ai_redline_bundles_idempotency_key_key unique (idempotency_key),
  add constraint ai_redline_bundles_version_check check (
    bundle_version in ('legacy-beta-0.1', 'approved-redline-v1')
  ),
  add constraint ai_redline_bundles_revision_check check (revision >= 1),
  add constraint ai_redline_bundles_review_revision_check check (review_revision >= 1),
  add constraint ai_redline_bundles_source_hash_check check (
    source_document_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_redline_bundles_receipt_version_check check (
    evidence_receipt_version in ('legacy-beta-0.1', 'evidence-v1')
  ),
  add constraint ai_redline_bundles_receipt_hash_check check (
    evidence_receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_redline_bundles_actions_check check (
    jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) >= 1
  ),
  add constraint ai_redline_bundles_canonical_json_check check (
    btrim(canonical_json) <> ''
  ),
  add constraint ai_redline_bundles_hash_check check (
    bundle_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint ai_redline_bundles_current_integrity_check check (
    bundle_version = 'legacy-beta-0.1'
    or (
      evidence_receipt_version = 'evidence-v1'
      and bundle_sha256 = encode(digest(canonical_json, 'sha256'), 'hex')
    )
  );

create index ai_executions_author_created_idx
  on public.ai_executions(author_user_id, created_at desc);
create index ai_executions_project_created_idx
  on public.ai_executions(project_id, created_at desc);
create index ai_executions_document_version_idx
  on public.ai_executions(document_version_id);
create index ai_reviews_matter_created_idx
  on public.ai_reviews(matter_id, created_at desc);
create index ai_reviews_reviewer_created_idx
  on public.ai_reviews(reviewer_user_id, created_at desc);
create index ai_review_items_review_created_idx
  on public.ai_review_items(review_id, created_at);
create index ai_review_decisions_review_created_idx
  on public.ai_review_decisions(review_id, created_at);
create index ai_review_decisions_item_created_idx
  on public.ai_review_decisions(review_item_id, created_at);
create index ai_review_exports_matter_created_idx
  on public.ai_review_exports(matter_id, created_at desc);
create index ai_redline_bundles_matter_created_idx
  on public.ai_redline_bundles(matter_id, created_at desc);

alter table public.ai_document_version_pages enable row level security;
alter table public.ai_executions enable row level security;
alter table public.ai_output_versions enable row level security;
alter table public.ai_receipts enable row level security;
alter table public.ai_reviews enable row level security;
alter table public.ai_review_items enable row level security;
alter table public.ai_review_decisions enable row level security;
alter table public.ai_review_exports enable row level security;
alter table public.ai_redline_bundles enable row level security;

-- ---------------------------------------------------------------------------
-- E2a database write boundary: fixed-scope helpers, integrity guards and RPCs
-- ---------------------------------------------------------------------------
create or replace function public.ai_jsonb_exact_keys(
  p_value jsonb,
  p_keys text[]
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_typeof(p_value) = 'object'
     and coalesce(
       (select array_agg(key order by key) from jsonb_object_keys(p_value) as key),
       array[]::text[]
     ) = (
       select array_agg(key order by key) from unnest(p_keys) as key
     )
$$;

create or replace function public.ai_valid_sha256(p_value text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_value ~ '^[0-9a-f]{64}$'
$$;

create or replace function public.ai_valid_idempotency_key(p_value text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_value ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
$$;

create or replace function public.ai_review_citation_valid(
  p_citation jsonb,
  p_document_id uuid,
  p_document_version_id uuid,
  p_bound_citations jsonb
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select public.ai_jsonb_exact_keys(
           p_citation,
           array['citation_id','document_id','document_version_id','page','span','quote_sha256','finding_text','verified']
         )
     and jsonb_typeof(p_citation->'citation_id') = 'string'
     and jsonb_typeof(p_citation->'document_id') = 'string'
     and jsonb_typeof(p_citation->'document_version_id') = 'string'
     and jsonb_typeof(p_citation->'quote_sha256') = 'string'
     and jsonb_typeof(p_citation->'finding_text') = 'string'
     and btrim(p_citation->>'citation_id') = p_citation->>'citation_id'
     and btrim(p_citation->>'citation_id') <> ''
     and (p_citation->>'document_id')::uuid is not distinct from p_document_id
     and (p_citation->>'document_version_id')::uuid is not distinct from p_document_version_id
     and jsonb_typeof(p_citation->'page') = 'number'
     and (p_citation->>'page')::numeric = trunc((p_citation->>'page')::numeric)
     and (p_citation->>'page')::integer >= 1
     and public.ai_jsonb_exact_keys(p_citation->'span', array['start_char','end_char'])
     and jsonb_typeof(p_citation->'span'->'start_char') = 'number'
     and jsonb_typeof(p_citation->'span'->'end_char') = 'number'
     and (p_citation->'span'->>'start_char')::numeric = trunc((p_citation->'span'->>'start_char')::numeric)
     and (p_citation->'span'->>'end_char')::numeric = trunc((p_citation->'span'->>'end_char')::numeric)
     and (p_citation->'span'->>'start_char')::integer >= 0
     and (p_citation->'span'->>'end_char')::integer > (p_citation->'span'->>'start_char')::integer
     and public.ai_valid_sha256(p_citation->>'quote_sha256')
     and btrim(p_citation->>'finding_text') = p_citation->>'finding_text'
     and btrim(p_citation->>'finding_text') <> ''
     and char_length(p_citation->>'finding_text') <= 100000
     and p_citation->'verified' = 'true'::jsonb
     and exists (
       select 1 from jsonb_array_elements(p_bound_citations) as bound(value)
       where bound.value = p_citation
     )
$$;

create or replace function public.ai_review_item_valid(
  p_item jsonb,
  p_document_id uuid,
  p_document_version_id uuid,
  p_bound_citations jsonb
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select public.ai_jsonb_exact_keys(
           p_item,
           array['item_id','item_key','original_text','finding_text','status','comment','citation']
         )
     and jsonb_typeof(p_item->'item_id') = 'string'
     and jsonb_typeof(p_item->'item_key') = 'string'
     and btrim(p_item->>'item_id') = p_item->>'item_id'
     and btrim(p_item->>'item_id') <> ''
     and btrim(p_item->>'item_key') = p_item->>'item_key'
     and btrim(p_item->>'item_key') <> ''
     and jsonb_typeof(p_item->'original_text') = 'string'
     and btrim(p_item->>'original_text') <> ''
     and char_length(p_item->>'original_text') <= 100000
     and jsonb_typeof(p_item->'finding_text') = 'string'
     and btrim(p_item->>'finding_text') <> ''
     and char_length(p_item->>'finding_text') <= 100000
     and jsonb_typeof(p_item->'status') = 'string'
     and p_item->>'status' in ('pending','accepted','rejected','edited')
     and (
       p_item->'comment' = 'null'::jsonb
       or (
         jsonb_typeof(p_item->'comment') = 'string'
         and btrim(p_item->>'comment') = p_item->>'comment'
         and btrim(p_item->>'comment') <> ''
         and char_length(p_item->>'comment') <= 2000
       )
     )
     and (p_item->>'status' = 'edited' or p_item->>'finding_text' = p_item->>'original_text')
     and (
       p_item->'citation' = 'null'::jsonb
       or public.ai_review_citation_valid(
            p_item->'citation', p_document_id, p_document_version_id, p_bound_citations
          )
     )
$$;

create or replace function public.ai_review_valid(
  p_review jsonb,
  p_document_id uuid,
  p_document_version_id uuid,
  p_bound_citations jsonb,
  p_status text default null
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select public.ai_jsonb_exact_keys(
           p_review,
           array['review_id','revision','execution_id','execution_author_user_id','reviewer_user_id','organization_id','matter_id','project_id','document_id','document_version_id','document_content_sha256','evidence_receipt_sha256','status','items']
         )
     and jsonb_typeof(p_review->'review_id') = 'string'
     and jsonb_typeof(p_review->'execution_id') = 'string'
     and jsonb_typeof(p_review->'execution_author_user_id') = 'string'
     and jsonb_typeof(p_review->'reviewer_user_id') = 'string'
     and jsonb_typeof(p_review->'organization_id') = 'string'
     and jsonb_typeof(p_review->'matter_id') = 'string'
     and jsonb_typeof(p_review->'project_id') = 'string'
     and jsonb_typeof(p_review->'document_id') = 'string'
     and jsonb_typeof(p_review->'document_version_id') = 'string'
     and jsonb_typeof(p_review->'document_content_sha256') = 'string'
     and jsonb_typeof(p_review->'evidence_receipt_sha256') = 'string'
     and jsonb_typeof(p_review->'status') = 'string'
     and btrim(p_review->>'review_id') = p_review->>'review_id'
     and btrim(p_review->>'review_id') <> ''
     and jsonb_typeof(p_review->'revision') = 'number'
     and (p_review->>'revision')::numeric = trunc((p_review->>'revision')::numeric)
     and (p_review->>'revision')::integer >= 1
     and btrim(p_review->>'execution_id') = p_review->>'execution_id'
     and btrim(p_review->>'execution_id') <> ''
     and btrim(p_review->>'execution_author_user_id') = p_review->>'execution_author_user_id'
     and btrim(p_review->>'execution_author_user_id') <> ''
     and btrim(p_review->>'reviewer_user_id') = p_review->>'reviewer_user_id'
     and btrim(p_review->>'reviewer_user_id') <> ''
     and btrim(p_review->>'organization_id') = p_review->>'organization_id'
     and btrim(p_review->>'organization_id') <> ''
     and btrim(p_review->>'matter_id') = p_review->>'matter_id'
     and btrim(p_review->>'matter_id') <> ''
     and btrim(p_review->>'project_id') = p_review->>'project_id'
     and btrim(p_review->>'project_id') <> ''
     and btrim(p_review->>'document_id') = p_review->>'document_id'
     and (p_review->>'document_id')::uuid is not distinct from p_document_id
     and btrim(p_review->>'document_version_id') = p_review->>'document_version_id'
     and (p_review->>'document_version_id')::uuid is not distinct from p_document_version_id
     and public.ai_valid_sha256(p_review->>'document_content_sha256')
     and public.ai_valid_sha256(p_review->>'evidence_receipt_sha256')
     and p_review->>'status' in ('pending','approved','changes_requested')
     and (p_status is null or p_review->>'status' = p_status)
     and jsonb_typeof(p_review->'items') = 'array'
     and jsonb_array_length(p_review->'items') between 1 and 10000
     and not exists (
       select 1
         from jsonb_array_elements(p_review->'items') as item(value)
        where not public.ai_review_item_valid(
          item.value, p_document_id, p_document_version_id, p_bound_citations
        )
     )
     and not exists (
       select 1
         from jsonb_array_elements(p_review->'items') with ordinality as left_item(value, ordinal)
         join jsonb_array_elements(p_review->'items') with ordinality as right_item(value, ordinal)
           on left_item.ordinal < right_item.ordinal
          and left_item.value->>'item_id' = right_item.value->>'item_id'
     )
$$;

create or replace function public.ai_review_matches_execution_evidence(
  p_review jsonb,
  p_bound_citations jsonb,
  p_output_text text
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when jsonb_array_length(p_bound_citations) = 0 then
      jsonb_array_length(p_review->'items') = 1
      and (p_review->'items'->0)->'citation' = 'null'::jsonb
      and (p_review->'items'->0)->>'item_key' = 'finding-1'
      and (p_review->'items'->0)->>'original_text' = p_output_text
    else
      jsonb_array_length(p_review->'items') = jsonb_array_length(p_bound_citations)
      and not exists (
        select 1
          from jsonb_array_elements(p_review->'items') as item(value)
         where item.value->'citation' is null
            or item.value->'citation' = 'null'::jsonb
            or not exists (
              select 1
                from jsonb_array_elements(p_bound_citations) as bound(value)
               where bound.value = item.value->'citation'
            )
            or item.value->>'item_key' is distinct from item.value->'citation'->>'citation_id'
            or item.value->>'original_text' is distinct from item.value->'citation'->>'finding_text'
      )
      and not exists (
        select 1
          from jsonb_array_elements(p_bound_citations) as bound(value)
         where not exists (
           select 1
             from jsonb_array_elements(p_review->'items') as item(value)
            where item.value->'citation'->>'citation_id' = bound.value->>'citation_id'
         )
      )
      and not exists (
        select 1
          from jsonb_array_elements(p_review->'items') with ordinality as left_item(value, ordinal)
          join jsonb_array_elements(p_review->'items') with ordinality as right_item(value, ordinal)
            on left_item.ordinal < right_item.ordinal
           and left_item.value->'citation'->>'citation_id' = right_item.value->'citation'->>'citation_id'
      )
      and not exists (
        select 1
          from jsonb_array_elements(p_bound_citations) with ordinality as left_bound(value, ordinal)
          join jsonb_array_elements(p_bound_citations) with ordinality as right_bound(value, ordinal)
            on left_bound.ordinal < right_bound.ordinal
           and left_bound.value->>'citation_id' = right_bound.value->>'citation_id'
      )
  end
$$;

create or replace function public.ai_assert_active_matter_access(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_matter_id uuid,
  p_project_id uuid,
  p_authorization_epoch bigint,
  p_intent text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_epoch bigint;
  v_organization_id uuid;
  v_project_id uuid;
begin
  if p_intent not in ('write', 'review', 'read') then
    raise exception 'AI access intent is invalid' using errcode = '42501';
  end if;

  select organization.authorization_epoch
    into v_current_epoch
    from public.organizations as organization
   where organization.id = p_organization_id
   for update;
  if not found or v_current_epoch is distinct from p_authorization_epoch then
    raise exception 'AI authorization epoch is stale' using errcode = '42501';
  end if;

  select workspace.organization_id, matter.project_id
    into v_organization_id, v_project_id
    from public.matters as matter
    join public.workspaces as workspace on workspace.id = matter.workspace_id
   where matter.id = p_matter_id;
  if not found
     or v_organization_id is distinct from p_organization_id
     or v_project_id is distinct from p_project_id
  then
    raise exception 'AI matter scope is invalid' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.organization_memberships as membership
     where membership.organization_id = p_organization_id
       and membership.user_id = p_actor_user_id
       and membership.status = 'active'
  ) then
    raise exception 'AI organization membership is inactive' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.matter_memberships as membership
     where membership.matter_id = p_matter_id
       and membership.user_id = p_actor_user_id
       and membership.status = 'active'
       and (
         (p_intent in ('write', 'review') and membership.role in ('matter_owner', 'editor'))
         or (p_intent = 'read' and membership.role in (
           'matter_owner', 'editor', 'viewer', 'technical_operator'
         ))
       )
  ) then
    raise exception 'AI matter membership is inactive or insufficient' using errcode = '42501';
  end if;
end
$$;

create or replace function public.ai_append_only_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception '% is insert-only', tg_table_name using errcode = '55000';
end
$$;

create or replace function public.ai_document_version_page_scope_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_document_id uuid;
begin
  select version.document_id
    into v_document_id
    from public.document_versions as version
   where version.id = new.document_version_id
     and version.deleted_at is null;
  if not found or v_document_id is distinct from new.document_id then
    raise exception 'AI page document-version scope is invalid';
  end if;
  return new;
end
$$;

create or replace function public.ai_execution_scope_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_document_id uuid;
  v_document_hash text;
  v_document_project_id uuid;
  v_matter_project_id uuid;
  v_organization_id uuid;
begin
  select version.document_id, version.content_sha256, document.project_id
    into v_document_id, v_document_hash, v_document_project_id
    from public.document_versions as version
    join public.documents as document on document.id = version.document_id
   where version.id = new.document_version_id
     and version.deleted_at is null;
  if not found
     or v_document_id is distinct from new.document_id
     or v_document_hash is distinct from new.document_content_sha256
     or v_document_project_id is distinct from new.project_id
  then
    raise exception 'AI execution document scope is invalid';
  end if;

  if new.evidence_version = 'evidence-v1' then
    select matter.project_id, workspace.organization_id
      into v_matter_project_id, v_organization_id
      from public.matters as matter
      join public.workspaces as workspace on workspace.id = matter.workspace_id
     where matter.id = new.matter_id;
    if not found
       or v_matter_project_id is distinct from new.project_id
       or v_organization_id is distinct from new.organization_id
    then
      raise exception 'AI execution tenancy scope is invalid';
    end if;
  end if;
  return new;
end
$$;

create or replace function public.ai_execution_update_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('succeeded', 'failed') then
    raise exception 'Terminal AI execution is immutable';
  end if;
  if new.idempotency_key is distinct from old.idempotency_key
     or new.evidence_version is distinct from old.evidence_version
     or new.author_user_id is distinct from old.author_user_id
     or new.organization_id is distinct from old.organization_id
     or new.matter_id is distinct from old.matter_id
     or new.project_id is distinct from old.project_id
     or new.chat_id is distinct from old.chat_id
     or new.workflow_key is distinct from old.workflow_key
     or new.workflow_version is distinct from old.workflow_version
     or new.workflow_content_hash is distinct from old.workflow_content_hash
     or new.workflow_source_commit is distinct from old.workflow_source_commit
     or new.workflow_distribution is distinct from old.workflow_distribution
     or new.workflow_type is distinct from old.workflow_type
     or new.workflow_source is distinct from old.workflow_source
     or new.workflow_approval_provenance is distinct from old.workflow_approval_provenance
     or new.output_hashes is distinct from old.output_hashes
     or new.citation_hashes is distinct from old.citation_hashes
     or new.document_id is distinct from old.document_id
     or new.document_version_id is distinct from old.document_version_id
     or new.document_content_sha256 is distinct from old.document_content_sha256
     or new.input_hashes is distinct from old.input_hashes
     or new.route_provider is distinct from old.route_provider
     or new.route_model is distinct from old.route_model
     or new.credential_ref is distinct from old.credential_ref
     or new.created_at is distinct from old.created_at
  then
    raise exception 'AI execution identity is immutable';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'pending' and new.status in ('running', 'failed'))
    or (old.status = 'running' and new.status in ('succeeded', 'failed'))
  ) then
    raise exception 'Invalid AI execution status transition';
  end if;
  return new;
end
$$;

create or replace function public.ai_review_scope_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_execution public.ai_executions%rowtype;
  v_receipt_sha256 text;
begin
  select * into v_execution
    from public.ai_executions
   where id = new.execution_id;
  select receipt.receipt_sha256 into v_receipt_sha256
    from public.ai_receipts as receipt
   where receipt.execution_id = new.execution_id;
  if v_execution.id is null
     or v_execution.status is distinct from 'succeeded'
     or v_execution.author_user_id is distinct from new.execution_author_user_id
     or v_execution.organization_id is distinct from new.organization_id
     or v_execution.matter_id is distinct from new.matter_id
     or v_execution.project_id is distinct from new.project_id
     or v_execution.document_id is distinct from new.document_id
     or v_execution.document_version_id is distinct from new.document_version_id
     or v_execution.document_content_sha256 is distinct from new.document_content_sha256
     or v_receipt_sha256 is distinct from new.evidence_receipt_sha256
     or new.reviewer_user_id is not distinct from new.execution_author_user_id
  then
    raise exception 'AI review execution scope is invalid';
  end if;
  if tg_op = 'UPDATE' and (
    new.execution_id is distinct from old.execution_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.execution_author_user_id is distinct from old.execution_author_user_id
    or new.reviewer_user_id is distinct from old.reviewer_user_id
    or new.organization_id is distinct from old.organization_id
    or new.matter_id is distinct from old.matter_id
    or new.project_id is distinct from old.project_id
    or new.document_id is distinct from old.document_id
    or new.document_version_id is distinct from old.document_version_id
    or new.document_content_sha256 is distinct from old.document_content_sha256
    or new.evidence_receipt_sha256 is distinct from old.evidence_receipt_sha256
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'AI review identity is immutable';
  end if;
  return new;
end
$$;

create or replace function public.ai_review_update_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('approved', 'changes_requested') then
    raise exception 'Completed AI review is immutable';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'AI review revision is stale';
  end if;
  if new.status not in ('pending', 'approved', 'changes_requested') then
    raise exception 'Invalid AI review status transition';
  end if;
  if new.status = 'approved' and exists (
    select 1 from public.ai_review_items as item
     where item.review_id = old.id and item.status = 'pending'
  ) then
    raise exception 'AI review cannot be approved with pending items';
  end if;
  return new;
end
$$;

create or replace function public.ai_review_item_update_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_review_status text;
begin
  select review.status into v_review_status
    from public.ai_reviews as review where review.id = old.review_id;
  if v_review_status is distinct from 'pending' then
    raise exception 'Completed AI review items are immutable';
  end if;
  if new.review_id is distinct from old.review_id
     or new.item_id is distinct from old.item_id
     or new.item_key is distinct from old.item_key
     or new.original_text is distinct from old.original_text
     or new.citation_refs is distinct from old.citation_refs
     or new.created_at is distinct from old.created_at
  then
    raise exception 'AI review item source is immutable';
  end if;
  return new;
end
$$;

create or replace function public.ai_review_decision_insert_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_review public.ai_reviews%rowtype;
begin
  select * into v_review from public.ai_reviews where id = new.review_id;
  if v_review.id is null
     or new.actor_user_id is distinct from v_review.reviewer_user_id
     or new.revision is distinct from v_review.revision
  then
    raise exception 'AI review decision authority or revision is invalid';
  end if;
  if new.review_item_id is not null and not exists (
    select 1 from public.ai_review_items as item
     where item.id = new.review_item_id and item.review_id = new.review_id
  ) then
    raise exception 'AI review decision item scope is invalid';
  end if;
  return new;
end
$$;

create or replace function public.ai_review_export_scope_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_review public.ai_reviews%rowtype;
  v_source_document_id uuid;
  v_artifact_document_id uuid;
  v_artifact_sha256 text;
begin
  select * into v_review from public.ai_reviews where id = new.review_id;
  select document_id into v_source_document_id
    from public.document_versions
   where id = new.source_document_version_id and deleted_at is null;
  select document_id, content_sha256 into v_artifact_document_id, v_artifact_sha256
    from public.document_versions
   where id = new.artifact_document_version_id
     and deleted_at is null
     and source = 'ai_review_report';
  if v_review.id is null
     or v_review.status is distinct from 'approved'
     or v_review.revision is distinct from new.review_revision
     or v_review.execution_id is distinct from new.execution_id
     or v_review.organization_id is distinct from new.organization_id
     or v_review.matter_id is distinct from new.matter_id
     or v_review.project_id is distinct from new.project_id
     or v_review.document_id is distinct from new.source_document_id
     or v_review.document_version_id is distinct from new.source_document_version_id
     or v_review.document_content_sha256 is distinct from new.source_document_sha256
     or v_review.evidence_receipt_sha256 is distinct from new.evidence_receipt_sha256
     or v_source_document_id is distinct from new.source_document_id
     or v_artifact_document_id is distinct from new.artifact_document_id
     or v_artifact_sha256 is distinct from new.artifact_sha256
  then
    raise exception 'AI review export scope is invalid';
  end if;
  return new;
end
$$;

create or replace function public.ai_redline_bundle_scope_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_review public.ai_reviews%rowtype;
  v_receipt_version text;
  v_receipt_sha256 text;
begin
  select * into v_review from public.ai_reviews where id = new.review_id;
  select receipt_version, receipt_sha256
    into v_receipt_version, v_receipt_sha256
    from public.ai_receipts where execution_id = new.execution_id;
  if v_review.id is null
     or v_review.status is distinct from 'approved'
     or v_review.revision is distinct from new.review_revision
     or v_review.execution_id is distinct from new.execution_id
     or v_review.organization_id is distinct from new.organization_id
     or v_review.matter_id is distinct from new.matter_id
     or v_review.project_id is distinct from new.project_id
     or v_review.document_id is distinct from new.document_id
     or v_review.document_version_id is distinct from new.document_version_id
     or v_review.document_content_sha256 is distinct from new.source_document_sha256
     or v_review.evidence_receipt_sha256 is distinct from new.evidence_receipt_sha256
     or v_review.reviewer_user_id is distinct from new.reviewer_user_id
     or v_receipt_version is distinct from new.evidence_receipt_version
     or v_receipt_sha256 is distinct from new.evidence_receipt_sha256
  then
    raise exception 'AI redline bundle scope is invalid';
  end if;
  return new;
end
$$;

create or replace function public.append_ai_evidence_batch(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_batch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_execution_id uuid;
  v_provenance jsonb;
  v_scope jsonb;
  v_route jsonb;
  v_workflow jsonb;
  v_output jsonb;
  v_receipt jsonb;
  v_receipt_body jsonb;
  v_expected_receipt jsonb;
  v_page_hashes jsonb;
  v_citation_hashes jsonb;
  v_organization_id uuid;
  v_matter_id uuid;
  v_project_id uuid;
  v_document_id uuid;
  v_document_version_id uuid;
  v_document_hash text;
  v_document_project_id uuid;
  v_output_hash text;
  v_receipt_hash text;
  v_page jsonb;
  v_citation jsonb;
  v_existing record;
  v_existing_page record;
  v_citations_count integer;
begin
  if not public.ai_jsonb_exact_keys(
    p_batch,
    array['idempotency_key','execution','pages','output','citations','receipt']
  ) then
    raise exception 'Invalid AI evidence batch';
  end if;
  if not public.ai_jsonb_exact_keys(
    p_batch->'execution', array['execution_id','provenance']
  ) then
    raise exception 'Invalid AI execution envelope';
  end if;

  v_key := p_batch->>'idempotency_key';
  v_execution_id := (p_batch#>>'{execution,execution_id}')::uuid;
  v_provenance := p_batch#>'{execution,provenance}';
  v_scope := v_provenance->'tenant_scope';
  v_route := v_provenance->'route';
  v_workflow := v_provenance->'workflow';
  v_output := p_batch->'output';
  v_receipt := p_batch->'receipt';

  if not public.ai_valid_idempotency_key(v_key)
     or not public.ai_jsonb_exact_keys(
       v_provenance,
       array['tenant_scope','input_hashes','output_hashes','citation_hashes','route','workflow','status']
     )
     or not public.ai_jsonb_exact_keys(v_route, array['provider','model','credential_ref'])
     or not public.ai_jsonb_exact_keys(
       v_workflow,
       array['workflow_key','version','content_hash','source_commit','distribution','type','source','approval_provenance']
     )
     or not public.ai_jsonb_exact_keys(v_output, array['execution_id','output_text','output_sha256'])
     or not public.ai_jsonb_exact_keys(v_receipt, array['receipt_version','canonical_json','receipt_sha256'])
     or jsonb_typeof(p_batch->'pages') <> 'array'
     or jsonb_array_length(p_batch->'pages') < 1
     or jsonb_typeof(p_batch->'citations') <> 'array'
     or v_provenance->>'status' <> 'completed'
  then
    raise exception 'Invalid AI evidence contract';
  end if;

  if not public.ai_jsonb_exact_keys(
    v_scope, array['organization_id','matter_id','project_id','document_version_id']
  ) and not public.ai_jsonb_exact_keys(
    v_scope, array['organization_id','matter_id','project_id','chat_id','document_version_id']
  ) then
    raise exception 'Invalid AI evidence tenant scope';
  end if;

  v_organization_id := (v_scope->>'organization_id')::uuid;
  v_matter_id := (v_scope->>'matter_id')::uuid;
  v_project_id := (v_scope->>'project_id')::uuid;
  v_document_version_id := (v_scope->>'document_version_id')::uuid;
  v_document_id := ((p_batch->'pages')->0->>'document_id')::uuid;
  v_output_hash := v_output->>'output_sha256';
  v_receipt_hash := v_receipt->>'receipt_sha256';

  if v_organization_id is distinct from p_organization_id
     or (v_output->>'execution_id')::uuid is distinct from v_execution_id
     or not public.ai_valid_sha256(v_output_hash)
     or encode(digest(v_output->>'output_text', 'sha256'), 'hex') is distinct from v_output_hash
     or not public.ai_valid_sha256(v_workflow->>'content_hash')
     or (v_workflow->>'source_commit') !~ '^[0-9a-f]{40}$'
     or v_workflow->>'distribution' not in ('default', 'addon')
     or v_workflow->>'type' not in ('assistant', 'tabular')
     or jsonb_typeof(v_provenance->'input_hashes') <> 'array'
     or jsonb_typeof(v_provenance->'output_hashes') <> 'array'
     or jsonb_typeof(v_provenance->'citation_hashes') <> 'array'
     or v_provenance->'output_hashes' <> jsonb_build_array(v_output_hash)
  then
    raise exception 'Invalid AI evidence hashes or provenance';
  end if;

  select version.document_id, version.content_sha256, document.project_id
    into v_document_id, v_document_hash, v_document_project_id
    from public.document_versions as version
    join public.documents as document on document.id = version.document_id
   where version.id = v_document_version_id
     and version.deleted_at is null;
  if not found
     or v_document_id is distinct from ((p_batch->'pages')->0->>'document_id')::uuid
     or v_document_project_id is distinct from v_project_id
     or not (v_provenance->'input_hashes' @> jsonb_build_array(v_document_hash))
  then
    raise exception 'AI evidence document scope is invalid';
  end if;

  perform public.ai_assert_active_matter_access(
    p_actor_user_id,
    p_organization_id,
    v_matter_id,
    v_project_id,
    p_authorization_epoch,
    'write'
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'document_id', page->>'document_id',
        'document_version_id', page->>'document_version_id',
        'page', (page->>'page')::integer,
        'text_sha256', page->>'text_sha256'
      ) order by (page->>'page')::integer
    ),
    '[]'::jsonb
  ) into v_page_hashes
  from jsonb_array_elements(p_batch->'pages') as page;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'citation_id', citation->>'citation_id',
        'document_id', citation->>'document_id',
        'document_version_id', citation->>'document_version_id',
        'page', (citation->>'page')::integer,
        'span', citation->'span',
        'quote_sha256', citation->>'quote_sha256',
        'finding_sha256', encode(digest(citation->>'finding_text', 'sha256'), 'hex')
      ) order by citation->>'citation_id'
    ),
    '[]'::jsonb
  ) into v_citation_hashes
  from jsonb_array_elements(p_batch->'citations') as citation;

  if coalesce(
       (select array_agg(value order by value)
          from jsonb_array_elements_text(v_provenance->'citation_hashes') as value),
       array[]::text[]
     ) is distinct from coalesce(
       (select array_agg(value order by value)
          from jsonb_array_elements_text(
            (select coalesce(jsonb_agg(item->>'quote_sha256'), '[]'::jsonb)
               from jsonb_array_elements(p_batch->'citations') as item)
          ) as value),
       array[]::text[]
     )
  then
    raise exception 'AI citation hashes do not match provenance';
  end if;

  v_receipt_body := (v_receipt->>'canonical_json')::jsonb;
  v_expected_receipt := jsonb_build_object(
    'receipt_version', 'evidence-v1',
    'idempotency_key', v_key,
    'execution_id', v_execution_id::text,
    'tenant_scope', v_scope,
    'route', v_route,
    'workflow', v_workflow,
    'status', 'completed',
    'input_hashes', v_provenance->'input_hashes',
    'page_hashes', v_page_hashes,
    'output_hash', v_output_hash,
    'citation_hashes', v_citation_hashes
  );
  if v_receipt->>'receipt_version' <> 'evidence-v1'
     or not public.ai_valid_sha256(v_receipt_hash)
     or encode(digest(v_receipt->>'canonical_json', 'sha256'), 'hex') is distinct from v_receipt_hash
     or v_receipt_body is distinct from v_expected_receipt
  then
    raise exception 'AI evidence receipt integrity failed';
  end if;

  select execution.id as execution_id,
         receipt.receipt_sha256,
         receipt.canonical_json
    into v_existing
    from public.ai_executions as execution
    join public.ai_receipts as receipt on receipt.execution_id = execution.id
   where execution.idempotency_key = v_key or receipt.idempotency_key = v_key
   limit 1;
  if found then
    if v_existing.execution_id is distinct from v_execution_id
       or v_existing.receipt_sha256 is distinct from v_receipt_hash
       or v_existing.canonical_json is distinct from v_receipt->>'canonical_json'
    then
      raise exception 'AI evidence idempotency conflict';
    end if;
    select jsonb_array_length(output.citation_refs) into v_citations_count
      from public.ai_output_versions as output
     where output.execution_id = v_execution_id;
    return jsonb_build_object(
      'disposition', 'replayed',
      'idempotency_key', v_key,
      'execution_id', v_execution_id,
      'receipt_sha256', v_receipt_hash,
      'counts', jsonb_build_object(
        'pages', jsonb_array_length(p_batch->'pages'),
        'outputs', 1,
        'citations', v_citations_count
      )
    );
  end if;

  insert into public.ai_executions (
    id, idempotency_key, evidence_version, author_user_id,
    organization_id, matter_id, project_id, chat_id,
    workflow_key, workflow_version, workflow_content_hash,
    workflow_source_commit, workflow_distribution, workflow_type,
    workflow_source, workflow_approval_provenance,
    output_hashes, citation_hashes,
    document_id, document_version_id, document_content_sha256,
    input_hashes, route_provider, route_model, credential_ref,
    status, started_at, finished_at
  ) values (
    v_execution_id, v_key, 'evidence-v1', p_actor_user_id,
    v_organization_id, v_matter_id, v_project_id,
    nullif(v_scope->>'chat_id', '')::uuid,
    v_workflow->>'workflow_key', v_workflow->>'version', v_workflow->>'content_hash',
    v_workflow->>'source_commit', v_workflow->>'distribution', v_workflow->>'type',
    v_workflow->>'source', v_workflow->>'approval_provenance',
    array(select jsonb_array_elements_text(v_provenance->'output_hashes')),
    array(select jsonb_array_elements_text(v_provenance->'citation_hashes')),
    v_document_id, v_document_version_id, v_document_hash,
    array(select jsonb_array_elements_text(v_provenance->'input_hashes')),
    v_route->>'provider', v_route->>'model', v_route->>'credential_ref',
    'succeeded', now(), now()
  );

  for v_page in select value from jsonb_array_elements(p_batch->'pages')
  loop
    if not public.ai_jsonb_exact_keys(
      v_page, array['document_id','document_version_id','page','text','text_sha256']
    )
       or (v_page->>'document_id')::uuid is distinct from v_document_id
       or (v_page->>'document_version_id')::uuid is distinct from v_document_version_id
       or (v_page->>'page')::integer < 1
       or not public.ai_valid_sha256(v_page->>'text_sha256')
       or encode(digest(v_page->>'text', 'sha256'), 'hex') is distinct from v_page->>'text_sha256'
    then
      raise exception 'AI evidence page integrity failed';
    end if;
    select page.document_id, page.content, page.content_sha256
      into v_existing_page
      from public.ai_document_version_pages as page
     where page.document_version_id = v_document_version_id
       and page.page = (v_page->>'page')::integer;
    if found then
      if v_existing_page.document_id is distinct from v_document_id
         or v_existing_page.content is distinct from v_page->>'text'
         or v_existing_page.content_sha256 is distinct from v_page->>'text_sha256'
      then
        raise exception 'AI evidence page replay conflict';
      end if;
    else
      insert into public.ai_document_version_pages (
        document_id, document_version_id, page, content, content_sha256
      ) values (
        v_document_id,
        v_document_version_id,
        (v_page->>'page')::integer,
        v_page->>'text',
        v_page->>'text_sha256'
      );
    end if;
  end loop;

  for v_citation in select value from jsonb_array_elements(p_batch->'citations')
  loop
    if not public.ai_jsonb_exact_keys(
      v_citation,
      array['citation_id','document_id','document_version_id','page','span','quote_sha256','finding_text','verified']
    )
       or v_citation->>'verified' <> 'true'
       or (v_citation->>'document_id')::uuid is distinct from v_document_id
       or (v_citation->>'document_version_id')::uuid is distinct from v_document_version_id
       or not public.ai_valid_sha256(v_citation->>'quote_sha256')
    then
      raise exception 'AI citation integrity failed';
    end if;
  end loop;

  insert into public.ai_output_versions (
    execution_id, output_format, output_text, output_sha256, citation_refs
  ) values (
    v_execution_id, 'markdown', v_output->>'output_text', v_output_hash,
    p_batch->'citations'
  );
  insert into public.ai_receipts (
    execution_id, idempotency_key, receipt_version, canonical_json, receipt_sha256
  ) values (
    v_execution_id, v_key, 'evidence-v1', v_receipt->>'canonical_json', v_receipt_hash
  );

  return jsonb_build_object(
    'disposition', 'applied',
    'idempotency_key', v_key,
    'execution_id', v_execution_id,
    'receipt_sha256', v_receipt_hash,
    'counts', jsonb_build_object(
      'pages', jsonb_array_length(p_batch->'pages'),
      'outputs', 1,
      'citations', jsonb_array_length(p_batch->'citations')
    )
  );
end
$$;

create or replace function public.create_ai_review(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_mutation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_review jsonb;
  v_review_id uuid;
  v_execution public.ai_executions%rowtype;
  v_receipt_sha256 text;
  v_bound_citations jsonb;
  v_output_text text;
  v_item jsonb;
  v_item_citations jsonb;
  v_existing record;
begin
  if not public.ai_jsonb_exact_keys(p_mutation, array['idempotency_key','review']) then
    raise exception 'Invalid AI review creation mutation';
  end if;
  v_key := p_mutation->>'idempotency_key';
  v_review := p_mutation->'review';
  v_review_id := (v_review->>'review_id')::uuid;
  if not public.ai_valid_idempotency_key(v_key)
     or not public.ai_jsonb_exact_keys(
       v_review,
       array['review_id','revision','execution_id','execution_author_user_id','reviewer_user_id','organization_id','matter_id','project_id','document_id','document_version_id','document_content_sha256','evidence_receipt_sha256','status','items']
     )
     or (v_review->>'revision')::integer <> 1
     or v_review->>'status' <> 'pending'
     or (v_review->>'reviewer_user_id')::uuid is distinct from p_actor_user_id
     or (v_review->>'organization_id')::uuid is distinct from p_organization_id
     or jsonb_typeof(v_review->'items') <> 'array'
     or jsonb_array_length(v_review->'items') < 1
  then
    raise exception 'Invalid AI review creation contract';
  end if;

  select * into v_execution
    from public.ai_executions
   where id = (v_review->>'execution_id')::uuid;
  select receipt_sha256 into v_receipt_sha256
    from public.ai_receipts
   where execution_id = (v_review->>'execution_id')::uuid;
  select citation_refs, output_text into v_bound_citations, v_output_text
    from public.ai_output_versions
   where execution_id = (v_review->>'execution_id')::uuid;
  if v_execution.id is null
     or v_execution.status is distinct from 'succeeded'
     or v_execution.author_user_id::text is distinct from v_review->>'execution_author_user_id'
     or v_execution.author_user_id is not distinct from p_actor_user_id
     or v_execution.organization_id::text is distinct from v_review->>'organization_id'
     or v_execution.matter_id::text is distinct from v_review->>'matter_id'
     or v_execution.project_id::text is distinct from v_review->>'project_id'
     or v_execution.document_id::text is distinct from v_review->>'document_id'
     or v_execution.document_version_id::text is distinct from v_review->>'document_version_id'
     or v_execution.document_content_sha256 is distinct from v_review->>'document_content_sha256'
     or v_receipt_sha256 is distinct from v_review->>'evidence_receipt_sha256'
     or v_bound_citations is null
  then
    raise exception 'AI review creation scope is invalid';
  end if;

  if not public.ai_review_valid(
    v_review, v_execution.document_id, v_execution.document_version_id,
    v_bound_citations, 'pending'
  )
  or not public.ai_review_matches_execution_evidence(
    v_review, v_bound_citations, v_output_text
  ) then
    raise exception 'AI review creation scope is invalid';
  end if;

  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_execution.matter_id,
    v_execution.project_id, p_authorization_epoch, 'review'
  );

  select review.id, decision.after_state
    into v_existing
    from public.ai_reviews as review
    join public.ai_review_decisions as decision
      on decision.review_id = review.id and decision.operation = 'create'
   where review.idempotency_key = v_key
      or decision.idempotency_key = v_key
   limit 1;
  if found then
    if v_existing.id is distinct from v_review_id
       or v_existing.after_state is distinct from v_review
    then
      raise exception 'AI review creation idempotency conflict';
    end if;
    return jsonb_build_object(
      'disposition','replayed','operation','create','review_id',v_review_id,
      'item_id',null,'revision',1,'idempotency_key',v_key
    );
  end if;

  insert into public.ai_reviews (
    id, execution_id, idempotency_key, revision,
    execution_author_user_id, reviewer_user_id,
    organization_id, matter_id, project_id,
    document_id, document_version_id, document_content_sha256,
    evidence_receipt_sha256, status
  ) values (
    v_review_id, v_execution.id, v_key, 1,
    v_execution.author_user_id, p_actor_user_id,
    v_execution.organization_id, v_execution.matter_id, v_execution.project_id,
    v_execution.document_id, v_execution.document_version_id,
    v_execution.document_content_sha256, v_receipt_sha256, 'pending'
  );

  for v_item in select value from jsonb_array_elements(v_review->'items')
  loop
    if not public.ai_jsonb_exact_keys(
      v_item,
      array['item_id','item_key','original_text','finding_text','status','comment','citation']
    )
       or nullif(btrim(v_item->>'item_id'), '') is null
       or nullif(btrim(v_item->>'item_key'), '') is null
       or v_item->>'status' <> 'pending'
       or v_item->>'finding_text' is distinct from v_item->>'original_text'
    then
      raise exception 'Invalid AI review item';
    end if;
    v_item_citations := case
      when v_item->'citation' is null or v_item->'citation' = 'null'::jsonb
        then '[]'::jsonb
      else jsonb_build_array(v_item->'citation')
    end;
    insert into public.ai_review_items (
      review_id, item_id, item_key, original_text, finding_text,
      citation_refs, status, comment
    ) values (
      v_review_id, v_item->>'item_id', v_item->>'item_key',
      v_item->>'original_text', v_item->>'finding_text',
      v_item_citations, 'pending', null
    );
  end loop;

  insert into public.ai_review_decisions (
    review_id, review_item_id, actor_user_id, operation, revision,
    idempotency_key, decision, before_state, after_state, comment
  ) values (
    v_review_id, null, p_actor_user_id, 'create', 1,
    v_key, 'pending', '{}'::jsonb, v_review, null
  );

  return jsonb_build_object(
    'disposition','applied','operation','create','review_id',v_review_id,
    'item_id',null,'revision',1,'idempotency_key',v_key
  );
end
$$;

create or replace function public.apply_ai_review_item_decision(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_mutation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_review jsonb;
  v_item jsonb;
  v_transition jsonb;
  v_review_row public.ai_reviews%rowtype;
  v_item_row public.ai_review_items%rowtype;
  v_review_id uuid;
  v_revision integer;
  v_item_db_id uuid;
  v_existing public.ai_review_decisions%rowtype;
  v_bound_citations jsonb;
  v_locked_review jsonb;
  v_locked_item jsonb;
  v_expected_review jsonb;
begin
  if not public.ai_jsonb_exact_keys(
    p_mutation, array['idempotency_key','review','item','transition']
  ) then
    raise exception 'Invalid AI review decision mutation';
  end if;
  v_key := p_mutation->>'idempotency_key';
  v_review := p_mutation->'review';
  v_item := p_mutation->'item';
  v_transition := p_mutation->'transition';
  v_review_id := (v_review->>'review_id')::uuid;
  v_revision := (v_review->>'revision')::integer;
  if not public.ai_valid_idempotency_key(v_key)
     or not public.ai_jsonb_exact_keys(v_review, array['review_id','revision','execution_id','execution_author_user_id','reviewer_user_id','organization_id','matter_id','project_id','document_id','document_version_id','document_content_sha256','evidence_receipt_sha256','status','items'])
     or not public.ai_jsonb_exact_keys(v_transition, array['decision','before','after'])
     or jsonb_typeof(v_transition->'decision') <> 'string'
     or jsonb_typeof(v_item) <> 'object'
     or v_transition->'after' is distinct from v_item
     or v_transition->>'decision' is distinct from v_item->>'status'
     or v_item->>'status' not in ('accepted','rejected','edited')
     or (v_review->>'reviewer_user_id')::uuid is distinct from p_actor_user_id
     or (v_review->>'organization_id')::uuid is distinct from p_organization_id
     or v_review->>'status' <> 'pending'
  then
    raise exception 'Invalid AI review decision contract';
  end if;

  select * into v_review_row
    from public.ai_reviews where id = v_review_id for update;
  if v_review_row.id is null
     or v_review_row.reviewer_user_id is distinct from p_actor_user_id
     or v_review_row.organization_id is distinct from p_organization_id
  then
    raise exception 'AI review decision scope is invalid';
  end if;

  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_review_row.matter_id,
    v_review_row.project_id, p_authorization_epoch, 'review'
  );

  select output.citation_refs into v_bound_citations
    from public.ai_output_versions as output
   where output.execution_id = v_review_row.execution_id;
  select * into v_existing
    from public.ai_review_decisions
   where review_id = v_review_id and idempotency_key = v_key;
  if found then
    select * into v_item_row
      from public.ai_review_items
     where review_id = v_review_id and item_id = v_item->>'item_id';
    v_item_db_id := v_item_row.id;
    select jsonb_build_object(
      'review_id', review.id::text, 'revision', review.revision,
      'execution_id', review.execution_id::text,
      'execution_author_user_id', review.execution_author_user_id::text,
      'reviewer_user_id', review.reviewer_user_id::text,
      'organization_id', review.organization_id::text,
      'matter_id', review.matter_id::text, 'project_id', review.project_id::text,
      'document_id', review.document_id::text,
      'document_version_id', review.document_version_id::text,
      'document_content_sha256', review.document_content_sha256,
      'evidence_receipt_sha256', review.evidence_receipt_sha256,
      'status', v_review->>'status',
      'items', (select jsonb_agg(case when item.id = v_item_db_id
        then v_transition->'after' else jsonb_build_object(
          'item_id', item.item_id, 'item_key', item.item_key,
          'original_text', item.original_text, 'finding_text', item.finding_text,
          'status', item.status, 'comment', item.comment,
          'citation', case when jsonb_array_length(item.citation_refs) = 0
            then 'null'::jsonb else item.citation_refs->0 end
        ) end order by item.created_at, item.id)
        from public.ai_review_items item where item.review_id = review.id)
    ) into v_locked_review
      from public.ai_reviews review where review.id = v_review_id;
    v_expected_review := (v_locked_review - 'revision') || jsonb_build_object(
      'revision', v_revision);
    if v_existing.operation <> 'decide'
       or v_existing.review_item_id is distinct from v_item_db_id
       or v_existing.revision is distinct from v_revision
       or v_existing.decision is distinct from v_transition->>'decision'
       or v_existing.before_state is distinct from v_transition->'before'
       or v_existing.after_state is distinct from v_transition->'after'
       or v_item_db_id is null
       or v_review->>'review_id' is distinct from v_locked_review->>'review_id'
       or v_review->>'execution_id' is distinct from v_locked_review->>'execution_id'
       or v_review->>'execution_author_user_id' is distinct from v_locked_review->>'execution_author_user_id'
       or v_review->>'reviewer_user_id' is distinct from v_locked_review->>'reviewer_user_id'
       or v_review->>'organization_id' is distinct from v_locked_review->>'organization_id'
       or v_review->>'matter_id' is distinct from v_locked_review->>'matter_id'
       or v_review->>'project_id' is distinct from v_locked_review->>'project_id'
       or v_review->>'document_id' is distinct from v_locked_review->>'document_id'
       or v_review->>'document_version_id' is distinct from v_locked_review->>'document_version_id'
       or v_review->>'document_content_sha256' is distinct from v_locked_review->>'document_content_sha256'
       or v_review->>'evidence_receipt_sha256' is distinct from v_locked_review->>'evidence_receipt_sha256'
       or v_review is distinct from v_expected_review
    then
      raise exception 'AI review decision idempotency conflict';
    end if;
    return jsonb_build_object(
      'disposition','replayed','operation','decide','review_id',v_review_id,
      'item_id',v_item->>'item_id','revision',v_revision,'idempotency_key',v_key
    );
  end if;

  if v_review->>'status' <> 'pending'
     or v_bound_citations is null
     or not public.ai_review_valid(
       v_review, v_review_row.document_id, v_review_row.document_version_id,
       v_bound_citations, 'pending'
     )
     or not public.ai_review_item_valid(
       v_item, v_review_row.document_id, v_review_row.document_version_id,
       v_bound_citations
     )
     or not public.ai_review_item_valid(
       v_transition->'before', v_review_row.document_id,
       v_review_row.document_version_id, v_bound_citations
     )
     or not public.ai_review_item_valid(
       v_transition->'after', v_review_row.document_id,
       v_review_row.document_version_id, v_bound_citations
     )
  then
    raise exception 'Invalid AI review decision projection';
  end if;

  if v_review_row.status is distinct from 'pending' then
    raise exception 'AI review decision scope is invalid';
  end if;
  if v_revision <> v_review_row.revision + 1 then
    raise exception 'AI review decision revision is stale';
  end if;
  select * into v_item_row
    from public.ai_review_items
   where review_id = v_review_id and item_id = v_item->>'item_id'
   for update;
  v_item_db_id := v_item_row.id;
  if v_item_db_id is null
     or v_item_row.status is distinct from v_transition#>>'{before,status}'
     or v_item_row.finding_text is distinct from v_transition#>>'{before,finding_text}'
     or coalesce(v_item_row.comment, '') is distinct from coalesce(v_transition#>>'{before,comment}', '')
  then
    raise exception 'AI review decision before-state is stale';
  end if;

  v_locked_item := jsonb_build_object(
    'item_id', v_item_row.item_id, 'item_key', v_item_row.item_key,
    'original_text', v_item_row.original_text, 'finding_text', v_item_row.finding_text,
    'status', v_item_row.status, 'comment', v_item_row.comment,
    'citation', case when jsonb_array_length(v_item_row.citation_refs) = 0
      then 'null'::jsonb else v_item_row.citation_refs->0 end
  );
  if v_transition->'before' is distinct from v_locked_item
     or v_item->>'item_key' is distinct from v_item_row.item_key
     or v_item->>'original_text' is distinct from v_item_row.original_text
  then
    raise exception 'AI review decision item projection is stale';
  end if;

  select jsonb_build_object(
    'review_id', review.id::text, 'revision', review.revision,
    'execution_id', review.execution_id::text,
    'execution_author_user_id', review.execution_author_user_id::text,
    'reviewer_user_id', review.reviewer_user_id::text,
    'organization_id', review.organization_id::text,
    'matter_id', review.matter_id::text, 'project_id', review.project_id::text,
    'document_id', review.document_id::text,
    'document_version_id', review.document_version_id::text,
    'document_content_sha256', review.document_content_sha256,
    'evidence_receipt_sha256', review.evidence_receipt_sha256,
    'status', review.status,
    'items', (select jsonb_agg(jsonb_build_object(
      'item_id', item.item_id, 'item_key', item.item_key,
      'original_text', item.original_text, 'finding_text', item.finding_text,
      'status', item.status, 'comment', item.comment,
      'citation', case when jsonb_array_length(item.citation_refs) = 0
        then 'null'::jsonb else item.citation_refs->0 end
    ) order by item.created_at, item.id) from public.ai_review_items item
      where item.review_id = review.id)
  ) into v_locked_review from public.ai_reviews review where review.id = v_review_id;
  v_expected_review := (v_locked_review - 'revision' - 'items') || jsonb_build_object(
    'revision', v_revision,
    'items', (select jsonb_agg(case when item.item_id = v_item->>'item_id'
      then v_item else jsonb_build_object(
        'item_id', item.item_id, 'item_key', item.item_key,
        'original_text', item.original_text, 'finding_text', item.finding_text,
        'status', item.status, 'comment', item.comment,
        'citation', case when jsonb_array_length(item.citation_refs) = 0
          then 'null'::jsonb else item.citation_refs->0 end
      ) end order by item.created_at, item.id) from public.ai_review_items item
      where item.review_id = v_review_id)
  );
  if v_review is distinct from v_expected_review then
    raise exception 'AI review decision review projection is stale';
  end if;

  update public.ai_review_items
     set status = v_item->>'status',
         finding_text = v_item->>'finding_text',
         comment = nullif(v_item->>'comment', ''),
         citation_refs = case when v_item->'citation' = 'null'::jsonb
           then '[]'::jsonb else jsonb_build_array(v_item->'citation') end,
         updated_at = now()
   where id = v_item_db_id;
  update public.ai_reviews
     set revision = v_revision
   where id = v_review_id;
  insert into public.ai_review_decisions (
    review_id, review_item_id, actor_user_id, operation, revision,
    idempotency_key, decision, before_state, after_state, comment
  ) values (
    v_review_id, v_item_db_id, p_actor_user_id, 'decide', v_revision,
    v_key, v_item->>'status', v_transition->'before', v_transition->'after',
    nullif(v_item->>'comment', '')
  );

  return jsonb_build_object(
    'disposition','applied','operation','decide','review_id',v_review_id,
    'item_id',v_item->>'item_id','revision',v_revision,'idempotency_key',v_key
  );
end
$$;

create or replace function public.complete_ai_review(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_mutation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_review jsonb;
  v_review_id uuid;
  v_revision integer;
  v_status text;
  v_review_row public.ai_reviews%rowtype;
  v_existing public.ai_review_decisions%rowtype;
  v_bound_citations jsonb;
  v_expected_review jsonb;
begin
  if not public.ai_jsonb_exact_keys(p_mutation, array['idempotency_key','review']) then
    raise exception 'Invalid AI review completion mutation';
  end if;
  v_key := p_mutation->>'idempotency_key';
  v_review := p_mutation->'review';
  v_review_id := (v_review->>'review_id')::uuid;
  v_revision := (v_review->>'revision')::integer;
  v_status := v_review->>'status';
  if not public.ai_valid_idempotency_key(v_key)
     or v_status not in ('approved','changes_requested')
     or (v_review->>'reviewer_user_id')::uuid is distinct from p_actor_user_id
     or (v_review->>'organization_id')::uuid is distinct from p_organization_id
  then
    raise exception 'Invalid AI review completion contract';
  end if;

  select * into v_review_row
    from public.ai_reviews where id = v_review_id for update;
  if v_review_row.id is null
     or v_review_row.reviewer_user_id is distinct from p_actor_user_id
     or v_review_row.organization_id is distinct from p_organization_id
  then
    raise exception 'AI review completion scope is invalid';
  end if;

  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_review_row.matter_id,
    v_review_row.project_id, p_authorization_epoch, 'review'
  );

  select output.citation_refs into v_bound_citations
    from public.ai_output_versions output
   where output.execution_id = v_review_row.execution_id;
  if v_bound_citations is null
     or not public.ai_review_valid(
       v_review, v_review_row.document_id, v_review_row.document_version_id,
       v_bound_citations, v_status
     )
  then
    raise exception 'Invalid AI review completion projection';
  end if;

  select * into v_existing
    from public.ai_review_decisions
   where review_id = v_review_id and idempotency_key = v_key;
  if found then
    if v_existing.operation <> 'complete'
       or v_existing.revision is distinct from v_revision
       or v_existing.after_state is distinct from v_review
    then
      raise exception 'AI review completion idempotency conflict';
    end if;
    return jsonb_build_object(
      'disposition','replayed','operation','complete','review_id',v_review_id,
      'item_id',null,'revision',v_revision,'idempotency_key',v_key
    );
  end if;

  if v_review_row.status is distinct from 'pending' then
    raise exception 'AI review completion scope is invalid';
  end if;
  if v_revision <> v_review_row.revision + 1 then
    raise exception 'AI review completion revision is stale';
  end if;
  select jsonb_build_object(
    'review_id', review.id::text, 'revision', v_revision,
    'execution_id', review.execution_id::text,
    'execution_author_user_id', review.execution_author_user_id::text,
    'reviewer_user_id', review.reviewer_user_id::text,
    'organization_id', review.organization_id::text,
    'matter_id', review.matter_id::text, 'project_id', review.project_id::text,
    'document_id', review.document_id::text,
    'document_version_id', review.document_version_id::text,
    'document_content_sha256', review.document_content_sha256,
    'evidence_receipt_sha256', review.evidence_receipt_sha256,
    'status', v_status,
    'items', (select jsonb_agg(jsonb_build_object(
      'item_id', item.item_id, 'item_key', item.item_key,
      'original_text', item.original_text, 'finding_text', item.finding_text,
      'status', item.status, 'comment', item.comment,
      'citation', case when jsonb_array_length(item.citation_refs) = 0
        then 'null'::jsonb else item.citation_refs->0 end
    ) order by item.created_at, item.id) from public.ai_review_items item
      where item.review_id = review.id)
  ) into v_expected_review from public.ai_reviews review where review.id = v_review_id;
  if v_review is distinct from v_expected_review then
    raise exception 'AI review completion projection is stale';
  end if;
  if v_status = 'approved' and (
    exists (
      select 1 from public.ai_review_items
       where review_id = v_review_id and status = 'pending'
    )
    or exists (
      select 1
        from public.ai_review_items as item
        cross join lateral jsonb_array_elements(item.citation_refs) as citation
       where item.review_id = v_review_id
         and coalesce(citation->>'verified','false') <> 'true'
    )
  ) then
    raise exception 'AI review approval has unresolved or unverified items';
  end if;

  update public.ai_reviews
     set revision = v_revision,
         status = v_status,
         completed_at = now()
   where id = v_review_id;
  insert into public.ai_review_decisions (
    review_id, review_item_id, actor_user_id, operation, revision,
    idempotency_key, decision, before_state, after_state, comment
  ) values (
    v_review_id, null, p_actor_user_id, 'complete', v_revision,
    v_key, v_status,
    jsonb_build_object('status','pending','revision',v_review_row.revision),
    v_review, null
  );

  return jsonb_build_object(
    'disposition','applied','operation','complete','review_id',v_review_id,
    'item_id',null,'revision',v_revision,'idempotency_key',v_key
  );
end
$$;

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
    array['idempotency_key','review_id','review_revision','execution_id','organization_id','matter_id','project_id','document_id','document_version_id','source_document_sha256','evidence_receipt_sha256','filename','mime_type','artifact_sha256','artifact_document_id','artifact_document_version_id']
  )
     or not public.ai_valid_idempotency_key(p_artifact->>'idempotency_key')
     or not public.ai_valid_sha256(p_artifact->>'source_document_sha256')
     or not public.ai_valid_sha256(p_artifact->>'evidence_receipt_sha256')
     or not public.ai_valid_sha256(p_artifact->>'artifact_sha256')
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

  if p_artifact->>'filename' is distinct from 'Informe de revision humana.docx'
     or p_artifact->>'mime_type' is distinct from 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  then
    raise exception 'Invalid AI review export contract';
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
    id, document_id, content_sha256, source, created_at
  ) values (
    v_artifact_version_id, v_artifact_document_id,
    p_artifact->>'artifact_sha256', 'ai_review_report', now()
  ) on conflict (id) do nothing;
  if not exists (
    select 1 from public.document_versions
     where id = v_artifact_version_id
       and document_id = v_artifact_document_id
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
    filename, mime_type, artifact_sha256
  ) values (
    p_artifact->>'idempotency_key', v_review.id, v_review.revision,
    v_review.execution_id, v_review.organization_id, v_review.matter_id,
    v_review.project_id, v_review.document_id, v_review.document_version_id,
    v_artifact_document_id, v_artifact_version_id,
    v_review.document_content_sha256, v_review.evidence_receipt_sha256,
    p_artifact->>'filename', p_artifact->>'mime_type',
    p_artifact->>'artifact_sha256'
  );

  return jsonb_build_object(
    'disposition','applied','review_id',v_review.id,
    'review_revision',v_review.revision,'execution_id',v_review.execution_id,
    'artifact_sha256',p_artifact->>'artifact_sha256',
    'idempotency_key',p_artifact->>'idempotency_key'
  );
end
$$;

create or replace function public.append_ai_redline_bundle(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_bundle jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.ai_reviews%rowtype;
  v_existing public.ai_redline_bundles%rowtype;
  v_action jsonb;
  v_canonical_actions jsonb;
  v_expected_canonical jsonb;
begin
  if not public.ai_jsonb_exact_keys(
    p_bundle,
    array['idempotency_key','bundle_version','revision','review_id','review_revision','execution_id','organization_id','matter_id','project_id','document_id','document_version_id','source_document_sha256','evidence_receipt_version','evidence_receipt_sha256','reviewer_user_id','actions','canonical_json','bundle_sha256']
  )
     or not public.ai_valid_idempotency_key(p_bundle->>'idempotency_key')
     or p_bundle->>'bundle_version' <> 'approved-redline-v1'
     or p_bundle->>'evidence_receipt_version' <> 'evidence-v1'
     or not public.ai_valid_sha256(p_bundle->>'bundle_sha256')
     or encode(digest(p_bundle->>'canonical_json','sha256'),'hex')
          is distinct from p_bundle->>'bundle_sha256'
     or jsonb_typeof(p_bundle->'actions') <> 'array'
     or jsonb_array_length(p_bundle->'actions') < 1
  then
    raise exception 'Invalid AI redline bundle contract';
  end if;

  select * into v_review
    from public.ai_reviews where id = (p_bundle->>'review_id')::uuid;
  if v_review.id is null
     or v_review.status is distinct from 'approved'
     or v_review.reviewer_user_id is distinct from p_actor_user_id
     or v_review.reviewer_user_id::text is distinct from p_bundle->>'reviewer_user_id'
     or v_review.organization_id is distinct from p_organization_id
     or v_review.organization_id::text is distinct from p_bundle->>'organization_id'
     or v_review.revision is distinct from (p_bundle->>'review_revision')::integer
     or v_review.execution_id::text is distinct from p_bundle->>'execution_id'
     or v_review.matter_id::text is distinct from p_bundle->>'matter_id'
     or v_review.project_id::text is distinct from p_bundle->>'project_id'
     or v_review.document_id::text is distinct from p_bundle->>'document_id'
     or v_review.document_version_id::text is distinct from p_bundle->>'document_version_id'
     or v_review.document_content_sha256 is distinct from p_bundle->>'source_document_sha256'
     or v_review.evidence_receipt_sha256 is distinct from p_bundle->>'evidence_receipt_sha256'
  then
    raise exception 'AI redline bundle scope is invalid';
  end if;
  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_review.matter_id,
    v_review.project_id, p_authorization_epoch, 'review'
  );

  select coalesce(jsonb_agg(value - 'replacement_text' order by value->>'action_id'),'[]'::jsonb)
    into v_canonical_actions
    from jsonb_array_elements(p_bundle->'actions');
  v_expected_canonical := (p_bundle
    - 'idempotency_key' - 'canonical_json' - 'bundle_sha256' - 'actions')
    || jsonb_build_object('actions',v_canonical_actions);
  if (p_bundle->>'canonical_json')::jsonb is distinct from v_expected_canonical then
    raise exception 'AI redline bundle canonical JSON is invalid';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_bundle->'actions') as action
     group by action->>'action_id' having count(*) > 1
  ) then
    raise exception 'AI redline bundle has duplicate actions';
  end if;

  for v_action in select value from jsonb_array_elements(p_bundle->'actions')
  loop
    if not public.ai_jsonb_exact_keys(
      v_action,
      array['action_id','review_item_id','citation_id','document_id','document_version_id','page','start','end','page_content_sha256','before_text_sha256','replacement_text','replacement_text_sha256']
    )
       or (v_action->>'document_id')::uuid is distinct from v_review.document_id
       or (v_action->>'document_version_id')::uuid is distinct from v_review.document_version_id
       or (v_action->>'start')::integer < 0
       or (v_action->>'end')::integer <= (v_action->>'start')::integer
       or not public.ai_valid_sha256(v_action->>'page_content_sha256')
       or not public.ai_valid_sha256(v_action->>'before_text_sha256')
       or not public.ai_valid_sha256(v_action->>'replacement_text_sha256')
       or encode(digest(v_action->>'replacement_text','sha256'),'hex')
            is distinct from v_action->>'replacement_text_sha256'
       or not exists (
         select 1
           from public.ai_review_items as item
           cross join lateral jsonb_array_elements(item.citation_refs) as citation
          where item.review_id = v_review.id
            and item.item_id = v_action->>'review_item_id'
            and item.status in ('accepted','edited')
            and citation->>'citation_id' = v_action->>'citation_id'
            and citation->>'verified' = 'true'
            and citation->>'document_id' = v_action->>'document_id'
            and citation->>'document_version_id' = v_action->>'document_version_id'
            and (citation->>'page')::integer = (v_action->>'page')::integer
            and citation#>>'{span,start_char}' = v_action->>'start'
            and citation#>>'{span,end_char}' = v_action->>'end'
            and citation->>'quote_sha256' = v_action->>'before_text_sha256'
       )
       or not exists (
         select 1 from public.ai_document_version_pages as page
          where page.document_id = v_review.document_id
            and page.document_version_id = v_review.document_version_id
            and page.page = (v_action->>'page')::integer
            and page.content_sha256 = v_action->>'page_content_sha256'
       )
    then
      raise exception 'AI redline action is invalid';
    end if;
  end loop;

  select * into v_existing
    from public.ai_redline_bundles
   where idempotency_key = p_bundle->>'idempotency_key';
  if found then
    if v_existing.review_id is distinct from v_review.id
       or v_existing.review_revision is distinct from v_review.revision
       or v_existing.bundle_sha256 is distinct from p_bundle->>'bundle_sha256'
       or v_existing.canonical_json is distinct from p_bundle->>'canonical_json'
    then
      raise exception 'AI redline bundle idempotency conflict';
    end if;
    return jsonb_build_object(
      'disposition','replayed','review_id',v_review.id,
      'review_revision',v_review.revision,'execution_id',v_review.execution_id,
      'bundle_sha256',v_existing.bundle_sha256,
      'action_count',jsonb_array_length(v_existing.actions),
      'idempotency_key',v_existing.idempotency_key
    );
  end if;

  insert into public.ai_redline_bundles (
    idempotency_key, bundle_version, revision, review_id, review_revision,
    execution_id, organization_id, matter_id, project_id,
    document_id, document_version_id, source_document_sha256,
    evidence_receipt_version, evidence_receipt_sha256,
    reviewer_user_id, actions, canonical_json, bundle_sha256
  ) values (
    p_bundle->>'idempotency_key', 'approved-redline-v1',
    (p_bundle->>'revision')::integer, v_review.id, v_review.revision,
    v_review.execution_id, v_review.organization_id, v_review.matter_id,
    v_review.project_id, v_review.document_id, v_review.document_version_id,
    v_review.document_content_sha256, 'evidence-v1',
    v_review.evidence_receipt_sha256, v_review.reviewer_user_id,
    p_bundle->'actions', p_bundle->>'canonical_json', p_bundle->>'bundle_sha256'
  );

  return jsonb_build_object(
    'disposition','applied','review_id',v_review.id,
    'review_revision',v_review.revision,'execution_id',v_review.execution_id,
    'bundle_sha256',p_bundle->>'bundle_sha256',
    'action_count',jsonb_array_length(p_bundle->'actions'),
    'idempotency_key',p_bundle->>'idempotency_key'
  );
end
$$;

create or replace function public.assert_ai_redline_bundle_access(
  p_bundle_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_intent text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bundle public.ai_redline_bundles%rowtype;
begin
  select * into v_bundle
    from public.ai_redline_bundles where id = p_bundle_id;
  if v_bundle.id is null
     or v_bundle.organization_id is distinct from p_organization_id
     or p_intent not in ('read','review')
     or (p_intent = 'review' and v_bundle.reviewer_user_id is distinct from p_actor_user_id)
  then
    raise exception 'AI redline bundle is not accessible' using errcode = '42501';
  end if;
  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, v_bundle.matter_id,
    v_bundle.project_id, p_authorization_epoch, p_intent
  );
  return true;
end
$$;

-- Recreate deterministic integrity and append-only triggers.
drop trigger if exists ai_document_version_page_scope_guard_trigger
  on public.ai_document_version_pages;
create trigger ai_document_version_page_scope_guard_trigger
  before insert or update on public.ai_document_version_pages
  for each row execute function public.ai_document_version_page_scope_guard();
drop trigger if exists ai_document_version_pages_insert_only_trigger
  on public.ai_document_version_pages;
create trigger ai_document_version_pages_insert_only_trigger
  before update or delete on public.ai_document_version_pages
  for each row execute function public.ai_append_only_guard();

drop trigger if exists ai_execution_scope_guard_trigger on public.ai_executions;
create trigger ai_execution_scope_guard_trigger
  before insert or update on public.ai_executions
  for each row execute function public.ai_execution_scope_guard();
drop trigger if exists ai_execution_update_guard_trigger on public.ai_executions;
create trigger ai_execution_update_guard_trigger
  before update on public.ai_executions
  for each row execute function public.ai_execution_update_guard();

drop trigger if exists ai_output_versions_insert_only_trigger
  on public.ai_output_versions;
create trigger ai_output_versions_insert_only_trigger
  before update or delete on public.ai_output_versions
  for each row execute function public.ai_append_only_guard();
drop trigger if exists ai_receipts_insert_only_trigger on public.ai_receipts;
create trigger ai_receipts_insert_only_trigger
  before update or delete on public.ai_receipts
  for each row execute function public.ai_append_only_guard();

drop trigger if exists ai_review_scope_guard_trigger on public.ai_reviews;
create trigger ai_review_scope_guard_trigger
  before insert or update on public.ai_reviews
  for each row execute function public.ai_review_scope_guard();
drop trigger if exists ai_review_update_guard_trigger on public.ai_reviews;
create trigger ai_review_update_guard_trigger
  before update on public.ai_reviews
  for each row execute function public.ai_review_update_guard();
drop trigger if exists ai_review_item_update_guard_trigger on public.ai_review_items;
create trigger ai_review_item_update_guard_trigger
  before update on public.ai_review_items
  for each row execute function public.ai_review_item_update_guard();
drop trigger if exists ai_review_decision_insert_guard_trigger
  on public.ai_review_decisions;
create trigger ai_review_decision_insert_guard_trigger
  before insert on public.ai_review_decisions
  for each row execute function public.ai_review_decision_insert_guard();
drop trigger if exists ai_review_decisions_insert_only_trigger
  on public.ai_review_decisions;
create trigger ai_review_decisions_insert_only_trigger
  before update or delete on public.ai_review_decisions
  for each row execute function public.ai_append_only_guard();

drop trigger if exists ai_review_export_scope_guard_trigger
  on public.ai_review_exports;
create trigger ai_review_export_scope_guard_trigger
  before insert on public.ai_review_exports
  for each row execute function public.ai_review_export_scope_guard();
drop trigger if exists ai_review_exports_insert_only_trigger
  on public.ai_review_exports;
create trigger ai_review_exports_insert_only_trigger
  before update or delete on public.ai_review_exports
  for each row execute function public.ai_append_only_guard();

drop trigger if exists ai_redline_bundle_scope_guard_trigger
  on public.ai_redline_bundles;
create trigger ai_redline_bundle_scope_guard_trigger
  before insert on public.ai_redline_bundles
  for each row execute function public.ai_redline_bundle_scope_guard();
drop trigger if exists ai_redline_bundles_insert_only_trigger
  on public.ai_redline_bundles;
create trigger ai_redline_bundles_insert_only_trigger
  before update or delete on public.ai_redline_bundles
  for each row execute function public.ai_append_only_guard();

-- No browser or backend role receives direct AI DML. service_role reads through
-- explicit RLS policies and writes only through the locked RPC boundary.
revoke all on public.ai_document_version_pages from anon, authenticated, service_role;
revoke all on public.ai_executions from anon, authenticated, service_role;
revoke all on public.ai_output_versions from anon, authenticated, service_role;
revoke all on public.ai_receipts from anon, authenticated, service_role;
revoke all on public.ai_reviews from anon, authenticated, service_role;
revoke all on public.ai_review_items from anon, authenticated, service_role;
revoke all on public.ai_review_decisions from anon, authenticated, service_role;
revoke all on public.ai_review_exports from anon, authenticated, service_role;
revoke all on public.ai_redline_bundles from anon, authenticated, service_role;
grant select on public.ai_document_version_pages to service_role;
grant select on public.ai_executions to service_role;
grant select on public.ai_output_versions to service_role;
grant select on public.ai_receipts to service_role;
grant select on public.ai_reviews to service_role;
grant select on public.ai_review_items to service_role;
grant select on public.ai_review_decisions to service_role;
grant select on public.ai_review_exports to service_role;
grant select on public.ai_redline_bundles to service_role;

drop policy if exists ai_document_version_pages_service_select on public.ai_document_version_pages;
create policy ai_document_version_pages_service_select on public.ai_document_version_pages
  for select to service_role using (true);
drop policy if exists ai_executions_service_select on public.ai_executions;
create policy ai_executions_service_select on public.ai_executions
  for select to service_role using (true);
drop policy if exists ai_output_versions_service_select on public.ai_output_versions;
create policy ai_output_versions_service_select on public.ai_output_versions
  for select to service_role using (true);
drop policy if exists ai_receipts_service_select on public.ai_receipts;
create policy ai_receipts_service_select on public.ai_receipts
  for select to service_role using (true);
drop policy if exists ai_reviews_service_select on public.ai_reviews;
create policy ai_reviews_service_select on public.ai_reviews
  for select to service_role using (true);
drop policy if exists ai_review_items_service_select on public.ai_review_items;
create policy ai_review_items_service_select on public.ai_review_items
  for select to service_role using (true);
drop policy if exists ai_review_decisions_service_select on public.ai_review_decisions;
create policy ai_review_decisions_service_select on public.ai_review_decisions
  for select to service_role using (true);
drop policy if exists ai_review_exports_service_select on public.ai_review_exports;
create policy ai_review_exports_service_select on public.ai_review_exports
  for select to service_role using (true);
drop policy if exists ai_redline_bundles_service_select on public.ai_redline_bundles;
create policy ai_redline_bundles_service_select on public.ai_redline_bundles
  for select to service_role using (true);

revoke all on function public.ai_jsonb_exact_keys(jsonb, text[])
  from public, anon, authenticated, service_role;
revoke all on function public.ai_valid_sha256(text)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_valid_idempotency_key(text)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_citation_valid(jsonb, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_item_valid(jsonb, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_valid(jsonb, uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_matches_execution_evidence(jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_assert_active_matter_access(uuid, uuid, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_append_only_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_document_version_page_scope_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_execution_scope_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_execution_update_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_scope_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_update_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_item_update_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_decision_insert_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_review_export_scope_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_redline_bundle_scope_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.append_ai_evidence_batch(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.append_ai_evidence_batch(uuid, uuid, bigint, jsonb)
  to service_role;
revoke all on function public.create_ai_review(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_ai_review(uuid, uuid, bigint, jsonb)
  to service_role;
revoke all on function public.apply_ai_review_item_decision(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_ai_review_item_decision(uuid, uuid, bigint, jsonb)
  to service_role;
revoke all on function public.complete_ai_review(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_ai_review(uuid, uuid, bigint, jsonb)
  to service_role;
revoke all on function public.append_ai_review_export(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.append_ai_review_export(uuid, uuid, bigint, jsonb)
  to service_role;
revoke all on function public.append_ai_redline_bundle(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.append_ai_redline_bundle(uuid, uuid, bigint, jsonb)
  to service_role;
revoke all on function public.assert_ai_redline_bundle_access(uuid, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.assert_ai_redline_bundle_access(uuid, uuid, uuid, bigint, text)
  to service_role;

commit;
