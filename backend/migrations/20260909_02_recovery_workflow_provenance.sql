-- Migration date: 2026-09-09
-- Preserve per-entry origin and approval provenance in the sole runtime catalog.
-- Historical rows retain NULL provenance until a source-backed catalog sync;
-- do not invent validation or provenance for existing content.
begin;
alter table public.mike_workflows
  add column if not exists source text,
  add column if not exists approval_provenance text;

create or replace function public.replace_mike_workflows(
  p_source_commit text,
  p_workflows jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  reference_item jsonb;
  jurisdiction_values text[];
  workflow_uuid uuid;
  entry_source_commit text;
begin
  if p_source_commit is null or p_source_commit !~ '^[0-9a-f]{40}$' then
    raise exception 'invalid workflow catalog source commit';
  end if;
  if jsonb_typeof(p_workflows) <> 'array' then
    raise exception 'workflow catalog payload must be an array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mike_workflows', 0));
  update public.mike_workflows set active = false where active;

  for item in select value from jsonb_array_elements(p_workflows)
  loop
    -- Owned catalog content can declare a different immutable source from the
    -- imported batch. A malformed explicit declaration never inherits the batch.
    entry_source_commit := case when item ? 'source_commit'
      then item->>'source_commit' else p_source_commit end;
    if entry_source_commit is null or entry_source_commit !~ '^[0-9a-f]{40}$' then
      raise exception 'invalid workflow entry source commit';
    end if;
    jurisdiction_values := null;
    if jsonb_typeof(item->'jurisdictions') = 'array' then
      select array_agg(value)
        into jurisdiction_values
      from jsonb_array_elements_text(item->'jurisdictions');
    end if;

    insert into public.mike_workflows (
      workflow_key, distribution, version, title, description, type,
      prompt_md, columns_config, contributors, language, practice,
      jurisdictions, pack_key, pack_title, pack_description, pack_version,
      default_sort_order, quick_action_name, quick_action_prompt,
      document_upload, word_quick_action, word_quick_action_prompt,
      source_commit, source, approval_provenance, content_hash, active, updated_at
    ) values (
      item->>'workflow_key',
      item->>'distribution',
      nullif(item->>'version', ''),
      item->>'title',
      nullif(item->>'description', ''),
      item->>'type',
      nullif(item->>'prompt_md', ''),
      case when jsonb_typeof(item->'columns_config') = 'array'
        then item->'columns_config' else null end,
      case when jsonb_typeof(item->'contributors') = 'array'
        then item->'contributors' else '[]'::jsonb end,
      nullif(item->>'language', ''),
      nullif(item->>'practice', ''),
      jurisdiction_values,
      nullif(item->>'pack_key', ''),
      nullif(item->>'pack_title', ''),
      nullif(item->>'pack_description', ''),
      nullif(item->>'pack_version', ''),
      nullif(item->>'default_sort_order', '')::integer,
      nullif(item->>'quick_action_name', ''),
      nullif(item->>'quick_action_prompt', ''),
      coalesce((item->>'document_upload')::boolean, false),
      coalesce((item->>'word_quick_action')::boolean, false),
      nullif(item->>'word_quick_action_prompt', ''),
      entry_source_commit,
      item->>'source',
      item->>'approval_provenance',
      item->>'content_hash',
      true,
      now()
    )
    on conflict (workflow_key, content_hash) do update set
      distribution = excluded.distribution,
      version = excluded.version,
      title = excluded.title,
      description = excluded.description,
      type = excluded.type,
      prompt_md = excluded.prompt_md,
      columns_config = excluded.columns_config,
      contributors = excluded.contributors,
      language = excluded.language,
      practice = excluded.practice,
      jurisdictions = excluded.jurisdictions,
      pack_key = excluded.pack_key,
      pack_title = excluded.pack_title,
      pack_description = excluded.pack_description,
      pack_version = excluded.pack_version,
      default_sort_order = excluded.default_sort_order,
      quick_action_name = excluded.quick_action_name,
      quick_action_prompt = excluded.quick_action_prompt,
      document_upload = excluded.document_upload,
      word_quick_action = excluded.word_quick_action,
      word_quick_action_prompt = excluded.word_quick_action_prompt,
      source_commit = excluded.source_commit,
      source = excluded.source,
      approval_provenance = excluded.approval_provenance,
      active = true,
      updated_at = now()
    returning id into workflow_uuid;

    delete from public.mike_workflow_reference_files
    where mike_workflow_id = workflow_uuid;

    if item ? 'reference_files' then
      if jsonb_typeof(item->'reference_files') <> 'array' then
        raise exception 'workflow reference_files must be an array';
      end if;
      for reference_item in
        select value from jsonb_array_elements(item->'reference_files')
      loop
        insert into public.mike_workflow_reference_files (
          mike_workflow_id, filename, file_type, storage_path,
          size_bytes, content_hash
        ) values (
          workflow_uuid,
          reference_item->>'filename',
          reference_item->>'file_type',
          reference_item->>'storage_path',
          nullif(reference_item->>'size_bytes', '')::integer,
          reference_item->>'content_hash'
        );
      end loop;
    end if;
  end loop;
end;
$$;

commit;
