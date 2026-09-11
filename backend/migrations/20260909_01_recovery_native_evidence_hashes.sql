-- Migration date: 2026-09-09
-- Use PostgreSQL's native SHA-256 over exact UTF-8 bytes. Supabase installs
-- pgcrypto in extensions; privileged evidence RPCs deliberately search only
-- public. Do not relocate pgcrypto or widen security-definer search paths.
-- Existing hashes/rows and RPC grants are unchanged; replacement CHECKs validate
-- all existing rows. Historical migrations remain immutable.
begin;

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
     or encode(pg_catalog.sha256(pg_catalog.convert_to(v_output->>'output_text', 'UTF8')), 'hex') is distinct from v_output_hash
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
        'finding_sha256', encode(pg_catalog.sha256(pg_catalog.convert_to(citation->>'finding_text', 'UTF8')), 'hex')
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
     or encode(pg_catalog.sha256(pg_catalog.convert_to(v_receipt->>'canonical_json', 'UTF8')), 'hex') is distinct from v_receipt_hash
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
       or encode(pg_catalog.sha256(pg_catalog.convert_to(v_page->>'text', 'UTF8')), 'hex') is distinct from v_page->>'text_sha256'
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
     or encode(pg_catalog.sha256(pg_catalog.convert_to(p_bundle->>'canonical_json', 'UTF8')),'hex')
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
       or encode(pg_catalog.sha256(pg_catalog.convert_to(v_action->>'replacement_text', 'UTF8')),'hex')
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

alter table public.ai_document_version_pages
  drop constraint ai_document_version_pages_content_integrity_check,
  add constraint ai_document_version_pages_content_integrity_check check (
    content_sha256 ~ '^[0-9a-f]{64}$'
    and content_sha256 = encode(pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8')), 'hex')
  );
alter table public.ai_receipts
  drop constraint ai_receipts_current_integrity_check,
  add constraint ai_receipts_current_integrity_check check (
    receipt_version = 'legacy-beta-0.1'
    or receipt_sha256 = encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_json, 'UTF8')), 'hex')
  );
alter table public.ai_redline_bundles
  drop constraint ai_redline_bundles_current_integrity_check,
  add constraint ai_redline_bundles_current_integrity_check check (
    bundle_version = 'legacy-beta-0.1'
    or (
      evidence_receipt_version = 'evidence-v1'
      and bundle_sha256 = encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_json, 'UTF8')), 'hex')
    )
  );

commit;
