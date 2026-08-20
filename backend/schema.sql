-- Mike Supabase schema
-- Use this for a fresh Supabase database. Existing deployments should instead
-- apply the dated incremental migration files in backend/migrations that are
-- newer than the version of Mike they currently have deployed.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text,
  display_name text,
  organisation text,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  title_model text,
  tabular_model text not null default 'gemini-3-flash-preview',
  quote_model text,
  mfa_on_login boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

create unique index if not exists user_profiles_email_lower_unique
  on public.user_profiles (lower(email))
  where email is not null and btrim(email) <> '';

create index if not exists idx_user_profiles_email
  on public.user_profiles(email);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, email)
  values (new.id, lower(new.email))
  on conflict (user_id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
exception when others then
  -- Never block signup if the profile insert fails.
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'gemini', 'openai', 'openrouter', 'deepseek', 'opencode-zen', 'opencode-go')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  version integer not null default 1,
  credential_ref text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider),
  unique(user_id, credential_ref)
);

create or replace function public.assign_user_api_key_credential_ref()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    new.version := 1;
  elsif new.enabled and (
    not old.enabled
    or new.encrypted_key is distinct from old.encrypted_key
    or new.iv is distinct from old.iv
    or new.auth_tag is distinct from old.auth_tag
  ) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;

  new.credential_ref := new.provider || ':v' || new.version::text;
  return new;
end;
$$;

drop trigger if exists assign_user_api_key_credential_ref
  on public.user_api_keys;
create trigger assign_user_api_key_credential_ref
  before insert or update on public.user_api_keys
  for each row
  execute function public.assign_user_api_key_credential_ref();

create index if not exists idx_user_api_keys_user
  on public.user_api_keys(user_id);

alter table public.user_api_keys enable row level security;

create table if not exists public.user_mcp_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  transport text not null default 'streamable_http'
    check (transport in ('streamable_http')),
  server_url text not null,
  auth_type text not null default 'none'
    check (auth_type in ('none', 'bearer', 'oauth')),
  enabled boolean not null default true,
  tool_policy jsonb not null default '{}'::jsonb,
  encrypted_auth_config text,
  auth_config_iv text,
  auth_config_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_connectors_user
  on public.user_mcp_connectors(user_id);

alter table public.user_mcp_connectors enable row level security;

create table if not exists public.user_mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  encrypted_access_token text,
  access_token_iv text,
  access_token_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  token_type text,
  scope text,
  expires_at timestamptz,
  authorization_server text,
  token_endpoint text,
  client_id text,
  encrypted_client_secret text,
  client_secret_iv text,
  client_secret_tag text,
  resource text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id)
);

alter table public.user_mcp_oauth_tokens enable row level security;

create table if not exists public.user_mcp_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  state_hash text not null unique,
  encrypted_state_config text not null,
  state_config_iv text not null,
  state_config_tag text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_oauth_states_expires
  on public.user_mcp_oauth_states(expires_at);

alter table public.user_mcp_oauth_states enable row level security;

create table if not exists public.user_mcp_connector_tools (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_name text not null,
  openai_tool_name text not null,
  title text,
  description text,
  input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  output_schema jsonb,
  annotations jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  requires_confirmation boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id, tool_name),
  unique(openai_tool_name)
);

create index if not exists idx_user_mcp_connector_tools_connector
  on public.user_mcp_connector_tools(connector_id);

alter table public.user_mcp_connector_tools enable row level security;

create table if not exists public.user_mcp_tool_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_id uuid references public.user_mcp_connector_tools(id) on delete set null,
  tool_name text not null,
  openai_tool_name text not null,
  status text not null check (status in ('ok', 'error')),
  error_message text,
  duration_ms integer not null default 0,
  result_size_chars integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_tool_audit_logs_user_created
  on public.user_mcp_tool_audit_logs(user_id, created_at desc);

alter table public.user_mcp_tool_audit_logs enable row level security;

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  cm_number text,
  practice text,
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user
  on public.projects(user_id);

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project
  on public.project_subfolders(project_id);

create table if not exists public.library_folders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  library_kind text not null default 'file',
  name text not null,
  parent_folder_id uuid references public.library_folders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint library_folders_kind_check
    check (library_kind in ('file', 'template'))
);

create index if not exists idx_library_folders_user_kind
  on public.library_folders(user_id, library_kind);

create index if not exists idx_library_folders_parent
  on public.library_folders(parent_folder_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  status text not null default 'pending',
  folder_id uuid references public.project_subfolders(id) on delete set null,
  library_kind text not null default 'file',
  library_folder_id uuid references public.library_folders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_library_kind_check
    check (library_kind in ('file', 'template'))
);

create index if not exists idx_documents_user_project
  on public.documents(user_id, project_id);

create index if not exists idx_documents_project_folder
  on public.documents(project_id, folder_id);

create index if not exists idx_documents_library_kind_folder
  on public.documents(user_id, library_kind, library_folder_id)
  where project_id is null;

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text,
  pdf_storage_path text,
  source text not null default 'upload',
  version_number integer,
  filename text,
  file_type text,
  size_bytes integer,
  page_count integer,
  content_sha256 text,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text,
      'ai_review_report'::text
    ]))
);

create index if not exists document_versions_document_id_idx
  on public.document_versions(document_id, created_at desc);

create index if not exists document_versions_active_document_id_idx
  on public.document_versions(document_id, created_at desc)
  where deleted_at is null;

create index if not exists document_versions_doc_vnum_idx
  on public.document_versions(document_id, version_number);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_versions_doc_version_unique'
      and conrelid = 'public.document_versions'::regclass
  ) then
    alter table public.document_versions
      add constraint document_versions_doc_version_unique
      unique (document_id, version_number);
  end if;
end;
$$;

alter table public.documents
  add column if not exists current_version_id uuid
  references public.document_versions(id) on delete set null;

create table if not exists public.document_download_grants (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  document_id uuid not null references public.documents(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  issued_to_user text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists document_download_grants_expiry_idx
  on public.document_download_grants(expires_at)
  where consumed_at is null;

alter table public.document_download_grants enable row level security;
revoke all on public.document_download_grants from anon, authenticated;
grant select, insert, update on public.document_download_grants to service_role;

create table if not exists public.document_edits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chat_message_id uuid,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  change_id text not null,
  del_w_id text,
  ins_w_id text,
  deleted_text text not null default '',
  inserted_text text not null default '',
  context_before text,
  context_after text,
  status text not null default 'pending'
    check (status = any (array[
      'pending'::text,
      'accepted'::text,
      'rejected'::text
    ])),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists document_edits_document_id_idx
  on public.document_edits(document_id, created_at desc);

create index if not exists document_edits_message_id_idx
  on public.document_edits(chat_message_id);

create index if not exists document_edits_version_id_idx
  on public.document_edits(version_id);

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  title text not null,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  language text default 'English',
  practice text default 'General Transactions',
  jurisdictions text[] default array['General']::text[],
  created_at timestamptz not null default now()
);

create index if not exists idx_workflows_user
  on public.workflows(user_id);

create table if not exists public.hidden_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user
  on public.hidden_workflows(user_id);

create or replace function public.get_workflows_overview(
  p_user_id text,
  p_type text default null
)
returns table (
  id uuid,
  user_id text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean
)
language sql
stable
as $$
  select
    w.id,
    w.user_id::text as user_id,
    w.title,
    w.type,
    w.prompt_md,
    w.columns_config,
    w.language,
    w.practice,
    w.jurisdictions,
    false as is_system,
    w.created_at,
    true as allow_edit,
    true as is_owner
  from public.workflows w
  where w.user_id::text = p_user_id
    and (p_type is null or w.type = p_type)
  order by w.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  title text,
  model_provider text,
  model text,
  credential_ref text,
  constraint chats_model_route_consistent check (
    (model_provider is null and model is null and credential_ref is null)
    or
    (model_provider is not null and model is not null and credential_ref is not null)
  ),
  created_at timestamptz not null default now()
);

create index if not exists idx_chats_user
  on public.chats(user_id);

create index if not exists idx_chats_project
  on public.chats(project_id);

create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  created_at timestamptz
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id,
    c.title,
    c.created_at
  from public.chats c
  where c.user_id = p_user_id
     or exists (
      select 1
      from public.projects p
      where p.id = c.project_id
        and p.user_id = p_user_id
    )
  order by c.created_at desc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end;
$$;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null,
  content jsonb,
  files jsonb,
  workflow jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_chat
  on public.chat_messages(chat_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_edits_chat_message_id_fkey'
      and conrelid = 'public.document_edits'::regclass
  ) then
    alter table public.document_edits
      add constraint document_edits_chat_message_id_fkey
      foreign key (chat_message_id)
      references public.chat_messages(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tabular reviews
-- ---------------------------------------------------------------------------

create table if not exists public.tabular_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  practice text,
  document_grouping text not null default 'document' check (document_grouping in ('document', 'folder')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user
  on public.tabular_reviews(user_id);

create index if not exists idx_tabular_reviews_project
  on public.tabular_reviews(project_id);

create index if not exists tabular_reviews_title_trgm_idx
  on public.tabular_reviews using gin (lower(title) gin_trgm_ops);

create or replace function public.get_projects_overview(
  p_user_id text
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where p.user_id = p_user_id
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.created_at,
    vp.updated_at,
    vp.user_id = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;

create table if not exists public.tabular_review_rows (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  label text not null,
  row_type text not null check (row_type in ('document', 'folder')),
  folder_id uuid references public.project_subfolders(id) on delete set null,
  library_folder_id uuid references public.library_folders(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  sort_index integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_review_rows_review
  on public.tabular_review_rows(review_id, sort_index);

alter table public.tabular_review_rows enable row level security;

create table if not exists public.tabular_review_row_sources (
  row_id uuid not null references public.tabular_review_rows(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  sort_index integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (row_id, document_id)
);

create index if not exists idx_tabular_review_row_sources_document
  on public.tabular_review_row_sources(document_id);

alter table public.tabular_review_row_sources enable row level security;

create table if not exists public.tabular_cells (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  row_id uuid not null references public.tabular_review_rows(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  column_index integer not null,
  content text,
  citations jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_cells_review
  on public.tabular_cells(review_id, document_id, column_index);

create index if not exists idx_tabular_cells_review_row
  on public.tabular_cells(review_id, row_id, column_index);

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_project_id text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  document_count integer
)
language sql
stable
as $$
  with visible_reviews as (
    select tr.*
    from public.tabular_reviews tr
    where (p_project_id is null or tr.project_id::text = p_project_id)
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'in-project' and tr.project_id is not null)
        or (p_scope = 'standalone' and tr.project_id is null)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(tr.title) like
          '%' ||
          replace(
            replace(
              replace(lower(p_search_term), '\', '\\'),
              '%',
              '\%'
            ),
            '_',
            '\_'
          ) ||
          '%'
          escape '\'
      )
      and tr.user_id = p_user_id
  ),
  cell_document_counts as (
    select
      tc.review_id,
      count(distinct tc.document_id)::integer as document_count
    from public.tabular_cells tc
    where tc.review_id in (
      select vr.id
      from visible_reviews vr
      where jsonb_typeof(vr.document_ids) is distinct from 'array'
    )
    group by tc.review_id
  ),
  review_document_counts as (
    select
      vr.id,
      case
        when jsonb_typeof(vr.document_ids) = 'array'
          then (
            select count(distinct doc_id.value)::integer
            from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
          )
        else coalesce(cdc.document_count, 0)
      end as document_count
    from visible_reviews vr
    left join cell_document_counts cdc
      on cdc.review_id = vr.id
  )
  select
    vr.id,
    vr.project_id,
    vr.user_id,
    vr.title,
    vr.columns_config,
    vr.document_ids,
    vr.workflow_id,
    vr.created_at,
    vr.updated_at,
    vr.user_id = p_user_id as is_owner,
    rdc.document_count
  from visible_reviews vr
  join review_document_counts rdc
    on rdc.id = vr.id
  order by
    case
      when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vr.title, ''))
      else null
    end asc,
    case
      when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vr.title, ''))
      else null
    end desc,
    case
      when p_sort_key = 'columns' and p_sort_direction = 'asc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb))
      else null
    end asc,
    case
      when p_sort_key = 'columns' and p_sort_direction = 'desc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb))
      else null
    end desc,
    case
      when p_sort_key = 'documents' and p_sort_direction = 'asc' then rdc.document_count
      else null
    end asc,
    case
      when p_sort_key = 'documents' and p_sort_direction = 'desc' then rdc.document_count
      else null
    end desc,
    case
      when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at
      else null
    end asc,
    case
      when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at
      else null
    end desc,
    vr.created_at desc,
    vr.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_project_id text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  document_count integer
)
language sql
stable
as $$
  select *
  from public.get_tabular_reviews_overview(
    p_user_id,
    p_project_id,
    'all',
    2147483647,
    0,
    null,
    'created',
    'desc'
  );
$$;

create or replace function public.get_tabular_review_ids_overview(
  p_user_id text,
  p_project_id text,
  p_scope text,
  p_search_term text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select tr.id, tr.user_id
  from public.tabular_reviews tr
  where (p_project_id is null or tr.project_id::text = p_project_id)
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'in-project' and tr.project_id is not null)
      or (p_scope = 'standalone' and tr.project_id is null)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(tr.title) like
        '%' ||
        replace(
          replace(
            replace(lower(p_search_term), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) ||
        '%'
        escape '\'
    )
    and tr.user_id = p_user_id
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create table if not exists public.tabular_review_chats (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id text not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tabular_review_chats_review_idx
  on public.tabular_review_chats(review_id, updated_at desc);

create index if not exists tabular_review_chats_user_idx
  on public.tabular_review_chats(user_id);

create table if not exists public.tabular_review_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.tabular_review_chats(id) on delete cascade,
  role text not null,
  content jsonb,
  annotations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tabular_review_chat_messages_chat_idx
  on public.tabular_review_chat_messages(chat_id, created_at);

-- ---------------------------------------------------------------------------
-- Direct client grant hardening
-- ---------------------------------------------------------------------------
--
-- The frontend uses Supabase directly only for authentication. Application
-- data access goes through the backend API with the service role after the
-- backend verifies the user's JWT. Do not grant the browser anon/authenticated
-- roles direct table privileges for backend-owned data.

revoke all on public.user_profiles from anon, authenticated;
revoke all on public.projects from anon, authenticated;
revoke all on public.project_subfolders from anon, authenticated;
revoke all on public.library_folders from anon, authenticated;
revoke all on public.documents from anon, authenticated;
revoke all on public.document_versions from anon, authenticated;
revoke all on public.document_edits from anon, authenticated;
revoke all on public.workflows from anon, authenticated;
revoke all on public.hidden_workflows from anon, authenticated;
revoke all on public.chats from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
revoke all on public.tabular_reviews from anon, authenticated;
revoke all on public.tabular_cells from anon, authenticated;
revoke all on public.tabular_review_rows from anon, authenticated;
revoke all on public.tabular_review_row_sources from anon, authenticated;
revoke all on public.tabular_review_chats from anon, authenticated;
revoke all on public.tabular_review_chat_messages from anon, authenticated;
revoke all on public.user_api_keys from anon, authenticated;
revoke all on public.user_mcp_connectors from anon, authenticated;
revoke all on public.user_mcp_oauth_tokens from anon, authenticated;
revoke all on public.user_mcp_oauth_states from anon, authenticated;
revoke all on public.user_mcp_connector_tools from anon, authenticated;
revoke all on public.user_mcp_tool_audit_logs from anon, authenticated;

-- Tables created by this file are owned by the database bootstrap role. The
-- backend connects as service_role, so grant it only the data privileges that
-- the direct browser roles above intentionally do not have. RLS is still
-- enabled as defense in depth; service_role bypasses it for the backend path.
grant select, insert, update, delete
  on all tables in schema public
  to service_role;
grant usage, select
  on all sequences in schema public
  to service_role;

-- ---------------------------------------------------------------------------
-- Multi-tenant foundations (W1.5): organizations, workspaces, matters + RLS
-- ---------------------------------------------------------------------------
-- W1.5: multi-tenant foundations — organizations, workspaces, matters and
-- memberships with row-level security. The backend validates authorization
-- in application code (service_role path); RLS is enforced defense-in-depth
-- for direct browser roles (anon/authenticated).
--
-- Membership checks run through SECURITY DEFINER helpers to avoid the
-- infinite-recursion Postgres detects when a policy subqueries its own table.

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  authorization_epoch bigint not null default 0
);

alter table public.organizations enable row level security;

create table if not exists public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (
    role in ('org_owner', 'workspace_admin', 'editor', 'viewer', 'technical_operator')
  ),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

alter table public.organization_memberships enable row level security;

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspaces enable row level security;

create table if not exists public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (
    role in ('workspace_admin', 'editor', 'viewer', 'technical_operator')
  ),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.workspace_memberships enable row level security;

-- ---------------------------------------------------------------------------
-- Matters (legal matters / asuntos)
-- ---------------------------------------------------------------------------
create table if not exists public.matters (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  cm_number text,
  practice text,
  status text not null default 'open' check (status in ('open', 'closed', 'archived')),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  drive_folder_id text
);

alter table public.matters enable row level security;

create table if not exists public.matter_memberships (
  matter_id uuid not null references public.matters(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (
    role in ('matter_owner', 'editor', 'viewer', 'technical_operator')
  ),
  created_at timestamptz not null default now(),
  primary key (matter_id, user_id)
);

alter table public.matter_memberships enable row level security;

-- ---------------------------------------------------------------------------
-- RLS helper functions (SECURITY DEFINER, fixed search_path)
-- ---------------------------------------------------------------------------
create or replace function public.organization_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.organization_memberships
  where organization_id = p_org and user_id = auth.uid()
  limit 1;
$$;

create or replace function public.is_organization_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_memberships
    where organization_id = p_org and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_admin(p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces w
    join public.organization_memberships m on m.organization_id = w.organization_id
    where w.id = p_ws
      and m.user_id = auth.uid()
      and m.role in ('org_owner', 'workspace_admin')
  );
$$;

create or replace function public.matter_role(p_matter uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- Matter access requires both an explicit matter assignment and an active
  -- organization membership. This makes organization revocation effective
  -- immediately even if a descendant matter_memberships row remains.
  select mm.role
  from public.matter_memberships mm
  join public.matters m on m.id = mm.matter_id
  join public.workspaces w on w.id = m.workspace_id
  join public.organization_memberships om
    on om.organization_id = w.organization_id
   and om.user_id = auth.uid()
  where mm.matter_id = p_matter
    and mm.user_id = auth.uid()
  limit 1;
$$;

grant execute on function public.organization_role(uuid) to authenticated;
grant execute on function public.is_organization_member(uuid) to authenticated;
grant execute on function public.is_workspace_admin(uuid) to authenticated;
grant execute on function public.matter_role(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
drop policy if exists organizations_select_member on public.organizations;
create policy organizations_select_member
  on public.organizations for select
  using (public.is_organization_member(id));

drop policy if exists organizations_update_owner on public.organizations;
create policy organizations_update_owner
  on public.organizations for update
  using (public.organization_role(id) = 'org_owner');

drop policy if exists org_memberships_select_member on public.organization_memberships;
create policy org_memberships_select_member
  on public.organization_memberships for select
  using (user_id = auth.uid() or public.organization_role(organization_id) = 'org_owner');

drop policy if exists org_memberships_insert_owner on public.organization_memberships;
create policy org_memberships_insert_owner
  on public.organization_memberships for insert
  with check (public.organization_role(organization_id) = 'org_owner');

drop policy if exists org_memberships_delete_owner on public.organization_memberships;
create policy org_memberships_delete_owner
  on public.organization_memberships for delete
  using (public.organization_role(organization_id) = 'org_owner');

drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member
  on public.workspaces for select
  using (public.is_organization_member(organization_id));

drop policy if exists workspaces_update_member on public.workspaces;
create policy workspaces_update_member
  on public.workspaces for update
  using (public.organization_role(organization_id) in ('org_owner', 'workspace_admin'));

drop policy if exists workspace_memberships_select_member on public.workspace_memberships;
create policy workspace_memberships_select_member
  on public.workspace_memberships for select
  using (
    user_id = auth.uid()
    or public.is_workspace_admin(workspace_id)
  );

drop policy if exists workspace_memberships_insert_admin on public.workspace_memberships;
create policy workspace_memberships_insert_admin
  on public.workspace_memberships for insert
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists workspace_memberships_delete_admin on public.workspace_memberships;
create policy workspace_memberships_delete_admin
  on public.workspace_memberships for delete
  using (public.is_workspace_admin(workspace_id));

drop policy if exists matters_select_member on public.matters;
create policy matters_select_member
  on public.matters for select
  using (public.matter_role(id) is not null);

drop policy if exists matters_update_member on public.matters;
create policy matters_update_member
  on public.matters for update
  using (public.matter_role(id) in ('matter_owner', 'editor'));

drop policy if exists matter_memberships_select_member on public.matter_memberships;
create policy matter_memberships_select_member
  on public.matter_memberships for select
  using (public.matter_role(matter_id) is not null);

drop policy if exists matter_memberships_insert_owner on public.matter_memberships;
create policy matter_memberships_insert_owner
  on public.matter_memberships for insert
  with check (
    public.matter_role(matter_id) = 'matter_owner'
    or exists (
      select 1 from public.matters m
      where m.id = matter_memberships.matter_id
        and public.is_workspace_admin(m.workspace_id)
    )
  );

drop policy if exists matter_memberships_delete_owner on public.matter_memberships;
create policy matter_memberships_delete_owner
  on public.matter_memberships for delete
  using (
    public.matter_role(matter_id) = 'matter_owner'
    or exists (
      select 1 from public.matters m
      where m.id = matter_memberships.matter_id
        and public.is_workspace_admin(m.workspace_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Direct client access: browser roles only through RLS policies.
-- ---------------------------------------------------------------------------
revoke all on public.organizations from anon;
revoke all on public.organization_memberships from anon;
revoke all on public.workspaces from anon;
revoke all on public.workspace_memberships from anon;
revoke all on public.matters from anon;
revoke all on public.matter_memberships from anon;

-- authenticated gets table-level access filtered by the policies above;
-- anon gets nothing.
grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_memberships to authenticated;
grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspace_memberships to authenticated;
grant select, insert, update, delete on public.matters to authenticated;
grant select, insert, update, delete on public.matter_memberships to authenticated;

-- ---------------------------------------------------------------------------
-- W1.6 RLS hardening: every public table has row-level security enabled
-- (backend uses service_role which bypasses RLS; browser roles hold no grants).
-- ---------------------------------------------------------------------------
alter table public.user_profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_subfolders enable row level security;
alter table public.library_folders enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_edits enable row level security;
alter table public.workflows enable row level security;
alter table public.hidden_workflows enable row level security;
alter table public.chats enable row level security;
alter table public.chat_messages enable row level security;
alter table public.tabular_reviews enable row level security;
alter table public.tabular_cells enable row level security;
alter table public.tabular_review_chats enable row level security;
alter table public.tabular_review_chat_messages enable row level security;

-- W1.7: monotonic authorization epoch bump (called via RPC on membership
-- revocation; atomic increment).
create or replace function public.bump_authorization_epoch(p_org uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.organizations
  set authorization_epoch = authorization_epoch + 1
  where id = p_org;
$$;

revoke execute on function public.bump_authorization_epoch(uuid) from public, anon, authenticated;
grant execute on function public.bump_authorization_epoch(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- W1.13: insert-only audit trail
-- ---------------------------------------------------------------------------
-- W1.13: insert-only audit trail.
-- audit_events is append-only: UPDATE and DELETE are aborted by trigger for
-- every role (including service_role); rows can only be exported (W1.14) and
-- pruned by a future retention job running with elevated privileges outside
-- the normal path.

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  organization_id uuid references public.organizations(id) on delete set null,
  event_type text not null,
  event_detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_org_created_idx
  on public.audit_events(organization_id, created_at desc);
create index if not exists audit_events_type_idx
  on public.audit_events(event_type);

alter table public.audit_events enable row level security;

-- Insert-only enforcement: abort any UPDATE/DELETE attempt.
create or replace function public.audit_events_insert_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is insert-only; UPDATE/DELETE are forbidden (W1.13)';
end;
$$;

drop trigger if exists audit_events_insert_only_trigger on public.audit_events;
create trigger audit_events_insert_only_trigger
  before update or delete on public.audit_events
  for each row execute function public.audit_events_insert_only();

-- Direct browser roles get nothing; the backend writes via service_role.
revoke all on public.audit_events from anon, authenticated;
grant insert, select on public.audit_events to service_role;

-- ---------------------------------------------------------------------------
-- Beta Jurídica 0.1 / Fase 2: AI executions, outputs, receipts and citations
-- ---------------------------------------------------------------------------
ALTER TABLE public.matters
  ADD COLUMN IF NOT EXISTS project_id uuid
  REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS matters_project_id_idx
  ON public.matters(project_id)
  WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ai_document_version_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  page integer NOT NULL CHECK (page >= 1),
  content text NOT NULL,
  content_sha256 text NOT NULL CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND content_sha256 = encode(digest(content, 'sha256'), 'hex')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_version_id, page)
);
CREATE INDEX IF NOT EXISTS ai_document_version_pages_version_idx
  ON public.ai_document_version_pages(document_version_id, page);

CREATE TABLE IF NOT EXISTS public.ai_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  matter_id uuid REFERENCES public.matters(id) ON DELETE SET NULL,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  chat_id uuid REFERENCES public.chats(id) ON DELETE SET NULL,
  workflow_id text NOT NULL,
  workflow_version text NOT NULL,
  playbook_sha256 text NOT NULL CHECK (playbook_sha256 ~ '^[0-9a-f]{64}$'),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  document_content_sha256 text NOT NULL CHECK (document_content_sha256 ~ '^[0-9a-f]{64}$'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  route_provider text NOT NULL CHECK (
    route_provider IN ('openai', 'claude', 'gemini', 'openrouter', 'deepseek', 'opencode-zen', 'opencode-go')
  ),
  route_model text NOT NULL,
  credential_ref text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  error_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_executions_user_created_idx
  ON public.ai_executions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_executions_document_version_idx
  ON public.ai_executions(document_version_id);
CREATE INDEX IF NOT EXISTS ai_executions_project_idx
  ON public.ai_executions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_output_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  output_format text NOT NULL CHECK (output_format = 'markdown'),
  output_text text NOT NULL,
  output_sha256 text NOT NULL CHECK (output_sha256 ~ '^[0-9a-f]{64}$'),
  citation_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_output_versions_execution_idx
  ON public.ai_output_versions(execution_id);

CREATE TABLE IF NOT EXISTS public.ai_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  receipt_version text NOT NULL DEFAULT 'beta-0.1',
  canonical_json jsonb NOT NULL,
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_receipts_execution_idx
  ON public.ai_receipts(execution_id);

CREATE OR REPLACE FUNCTION public.ai_document_version_pages_integrity()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE version_document_id uuid;
BEGIN
  SELECT document_id INTO version_document_id FROM public.document_versions
   WHERE id = NEW.document_version_id AND deleted_at IS NULL;
  IF version_document_id IS NULL OR version_document_id IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'AI citation page does not belong to document version';
  END IF;
  IF NEW.content_sha256 IS DISTINCT FROM encode(digest(NEW.content, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'AI citation page content hash mismatch';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ai_document_version_pages_integrity_trigger ON public.ai_document_version_pages;
CREATE TRIGGER ai_document_version_pages_integrity_trigger
  BEFORE INSERT OR UPDATE ON public.ai_document_version_pages
  FOR EACH ROW EXECUTE FUNCTION public.ai_document_version_pages_integrity();

CREATE OR REPLACE FUNCTION public.ai_execution_scope_integrity()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE version_document_id uuid; matter_project_id uuid;
BEGIN
  SELECT document_id INTO version_document_id FROM public.document_versions
   WHERE id = NEW.document_version_id AND deleted_at IS NULL;
  IF version_document_id IS NULL OR version_document_id IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'AI execution document version does not belong to document';
  END IF;
  IF NEW.matter_id IS NOT NULL THEN
    SELECT project_id INTO matter_project_id FROM public.matters WHERE id = NEW.matter_id;
    IF matter_project_id IS NULL OR matter_project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'AI execution matter does not belong to project';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ai_execution_scope_integrity_trigger ON public.ai_executions;
CREATE TRIGGER ai_execution_scope_integrity_trigger
  BEFORE INSERT OR UPDATE ON public.ai_executions
  FOR EACH ROW EXECUTE FUNCTION public.ai_execution_scope_integrity();

CREATE OR REPLACE FUNCTION public.ai_execution_update_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'Terminal AI execution is immutable';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.chat_id IS DISTINCT FROM OLD.chat_id
     OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
     OR NEW.workflow_version IS DISTINCT FROM OLD.workflow_version
     OR NEW.playbook_sha256 IS DISTINCT FROM OLD.playbook_sha256
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.document_content_sha256 IS DISTINCT FROM OLD.document_content_sha256
     OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
     OR NEW.route_provider IS DISTINCT FROM OLD.route_provider
     OR NEW.route_model IS DISTINCT FROM OLD.route_model
     OR NEW.credential_ref IS DISTINCT FROM OLD.credential_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'AI execution identity is immutable'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('running', 'failed'))
    OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed'))
  ) THEN RAISE EXCEPTION 'Invalid AI execution status transition'; END IF;
  IF NEW.status = 'succeeded' AND (
    NEW.finished_at IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.ai_output_versions WHERE execution_id = NEW.id)
    OR NOT EXISTS (SELECT 1 FROM public.ai_receipts WHERE execution_id = NEW.id)
  ) THEN RAISE EXCEPTION 'Succeeded AI execution requires output and receipt'; END IF;
  IF NEW.status = 'failed' AND nullif(btrim(NEW.error_class), '') IS NULL THEN
    RAISE EXCEPTION 'Failed AI execution requires error class';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ai_execution_update_guard_trigger ON public.ai_executions;
CREATE TRIGGER ai_execution_update_guard_trigger
  BEFORE UPDATE ON public.ai_executions
  FOR EACH ROW EXECUTE FUNCTION public.ai_execution_update_guard();

CREATE OR REPLACE FUNCTION public.ai_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AI pages, outputs and receipts are insert-only'; END;
$$;
DROP TRIGGER IF EXISTS ai_document_version_pages_insert_only_trigger ON public.ai_document_version_pages;
CREATE TRIGGER ai_document_version_pages_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_document_version_pages
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
DROP TRIGGER IF EXISTS ai_output_versions_insert_only_trigger ON public.ai_output_versions;
CREATE TRIGGER ai_output_versions_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_output_versions
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
DROP TRIGGER IF EXISTS ai_receipts_insert_only_trigger ON public.ai_receipts;
CREATE TRIGGER ai_receipts_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_receipts
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();

ALTER TABLE public.ai_document_version_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_output_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_document_version_pages FROM anon, authenticated;
REVOKE ALL ON public.ai_executions FROM anon, authenticated;
REVOKE ALL ON public.ai_output_versions FROM anon, authenticated;
REVOKE ALL ON public.ai_receipts FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ai_document_version_pages TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_executions TO service_role;
GRANT SELECT, INSERT ON public.ai_output_versions TO service_role;
GRANT SELECT, INSERT ON public.ai_receipts TO service_role;

-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Bloque 3A: human review of finalized AI output.
-- Reviews are assigned to a second matter lawyer. Item projections are mutable
-- only while a review is open; every decision is insert-only with actor and
-- before/after state snapshots.

CREATE TABLE IF NOT EXISTS public.ai_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES public.matters(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'in_progress' CHECK (
    status IN ('in_progress', 'approved', 'changes_requested')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_reviews_matter_idx
  ON public.ai_reviews(matter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_reviews_reviewer_idx
  ON public.ai_reviews(reviewer_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  original_text text NOT NULL,
  finding_text text NOT NULL,
  citation_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citation_refs) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'rejected', 'edited')
  ),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, item_key)
);

CREATE INDEX IF NOT EXISTS ai_review_items_review_idx
  ON public.ai_review_items(review_id, created_at);

CREATE TABLE IF NOT EXISTS public.ai_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  review_item_id uuid REFERENCES public.ai_review_items(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (
    decision IN ('accepted', 'rejected', 'edited', 'approved', 'changes_requested')
  ),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (review_item_id IS NULL AND decision IN ('approved', 'changes_requested'))
    OR (review_item_id IS NOT NULL AND decision IN ('accepted', 'rejected', 'edited'))
  )
);

CREATE INDEX IF NOT EXISTS ai_review_decisions_review_idx
  ON public.ai_review_decisions(review_id, created_at);
CREATE INDEX IF NOT EXISTS ai_review_decisions_item_idx
  ON public.ai_review_decisions(review_item_id, created_at);

CREATE OR REPLACE FUNCTION public.ai_review_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  execution_user_id uuid;
  execution_matter_id uuid;
  execution_project_id uuid;
  execution_status text;
BEGIN
  SELECT user_id, matter_id, project_id, status
    INTO execution_user_id, execution_matter_id, execution_project_id, execution_status
    FROM public.ai_executions
   WHERE id = NEW.execution_id;

  IF execution_user_id IS NULL
     OR execution_status IS DISTINCT FROM 'succeeded'
     OR execution_matter_id IS DISTINCT FROM NEW.matter_id
     OR execution_project_id IS DISTINCT FROM NEW.project_id
  THEN
    RAISE EXCEPTION 'AI review execution scope is invalid or not finalized';
  END IF;

  IF NEW.reviewer_user_id IS NOT DISTINCT FROM execution_user_id THEN
    RAISE EXCEPTION 'AI execution author cannot be its reviewer';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.matters m ON m.id = mm.matter_id
      JOIN public.workspaces w ON w.id = m.workspace_id
      JOIN public.organization_memberships om
        ON om.organization_id = w.organization_id
       AND om.user_id = NEW.reviewer_user_id
     WHERE mm.matter_id = NEW.matter_id
       AND mm.user_id = NEW.reviewer_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI reviewer is not an active matter lawyer';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.execution_id IS DISTINCT FROM OLD.execution_id
    OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'AI review identity is immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_scope_guard_trigger ON public.ai_reviews;
CREATE TRIGGER ai_review_scope_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_reviews
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_scope_guard();

CREATE OR REPLACE FUNCTION public.ai_review_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'Completed AI review is immutable';
  END IF;
  IF NEW.status NOT IN ('approved', 'changes_requested') THEN
    RAISE EXCEPTION 'Invalid AI review status transition';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.ai_executions e
       WHERE e.id = NEW.execution_id
         AND e.status = 'succeeded'
    ) THEN
      RAISE EXCEPTION 'AI review cannot be approved for an unfinished execution';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.ai_review_items i WHERE i.review_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'AI review requires at least one finding';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.ai_review_items i
        CROSS JOIN LATERAL jsonb_array_elements(i.citation_refs) citation
       WHERE i.review_id = NEW.id
         AND COALESCE(citation->>'verified', 'false') <> 'true'
    ) THEN
      RAISE EXCEPTION 'AI review cannot be approved with an unverified citation';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.ai_review_items i
       WHERE i.review_id = NEW.id
         AND i.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'AI review cannot be approved with pending findings';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_update_guard_trigger ON public.ai_reviews;
CREATE TRIGGER ai_review_update_guard_trigger
  BEFORE UPDATE ON public.ai_reviews
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_update_guard();

CREATE OR REPLACE FUNCTION public.ai_review_item_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  review_status text;
BEGIN
  IF NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.item_key IS DISTINCT FROM OLD.item_key
     OR NEW.original_text IS DISTINCT FROM OLD.original_text
     OR NEW.citation_refs IS DISTINCT FROM OLD.citation_refs
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'AI review item source is immutable';
  END IF;
  SELECT status INTO review_status FROM public.ai_reviews WHERE id = OLD.review_id;
  IF review_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'Completed AI review items are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_item_update_guard_trigger ON public.ai_review_items;
CREATE TRIGGER ai_review_item_update_guard_trigger
  BEFORE UPDATE ON public.ai_review_items
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_item_update_guard();

CREATE OR REPLACE FUNCTION public.ai_review_decision_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  review_reviewer uuid;
  review_status text;
  item_review_id uuid;
BEGIN
  SELECT reviewer_user_id, status
    INTO review_reviewer, review_status
    FROM public.ai_reviews
   WHERE id = NEW.review_id;
  IF review_reviewer IS NULL OR NEW.actor_user_id IS DISTINCT FROM review_reviewer THEN
    RAISE EXCEPTION 'AI review decision actor is not the assigned reviewer';
  END IF;

  IF NEW.review_item_id IS NULL THEN
    IF review_status IS DISTINCT FROM NEW.decision THEN
      RAISE EXCEPTION 'AI review completion decision does not match review status';
    END IF;
  ELSE
    SELECT review_id INTO item_review_id
      FROM public.ai_review_items
     WHERE id = NEW.review_item_id;
    IF item_review_id IS DISTINCT FROM NEW.review_id OR review_status IS DISTINCT FROM 'in_progress' THEN
      RAISE EXCEPTION 'AI item decision scope is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_decision_insert_guard_trigger ON public.ai_review_decisions;
CREATE TRIGGER ai_review_decision_insert_guard_trigger
  BEFORE INSERT ON public.ai_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_decision_insert_guard();

CREATE OR REPLACE FUNCTION public.ai_review_decisions_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai_review_decisions is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS ai_review_decisions_insert_only_trigger ON public.ai_review_decisions;
CREATE TRIGGER ai_review_decisions_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_decisions_insert_only();

ALTER TABLE public.ai_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_review_decisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_reviews FROM anon, authenticated;
REVOKE ALL ON public.ai_review_items FROM anon, authenticated;
REVOKE ALL ON public.ai_review_decisions FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.ai_reviews TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_review_items TO service_role;
GRANT SELECT, INSERT ON public.ai_review_decisions TO service_role;

-- Migration date: 2026-08-19
-- Bloque 3A fix 1: make organization revocation and human-review writes
-- linearizable at the organization authorization boundary.

CREATE OR REPLACE FUNCTION public.revoke_organization_membership(
  p_org uuid,
  p_user uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM public.organizations
   WHERE id = p_org
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization does not exist';
  END IF;

  DELETE FROM public.organization_memberships
   WHERE organization_id = p_org
     AND user_id = p_user;

  UPDATE public.organizations
     SET authorization_epoch = authorization_epoch + 1
   WHERE id = p_org;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_organization_membership(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_organization_membership(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ai_review_write_authorization_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_review_id uuid;
  v_actor_id uuid;
  v_matter_id uuid;
  v_reviewer_id uuid;
  v_organization_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'ai_reviews' THEN
    v_review_id := NEW.id;
    v_actor_id := NEW.reviewer_user_id;
    v_matter_id := NEW.matter_id;
    v_reviewer_id := NEW.reviewer_user_id;
  ELSE
    v_review_id := NEW.review_id;
    SELECT r.matter_id, r.reviewer_user_id
      INTO v_matter_id, v_reviewer_id
      FROM public.ai_reviews r
     WHERE r.id = v_review_id
     FOR SHARE;
    IF TG_TABLE_NAME = 'ai_review_decisions' THEN
      v_actor_id := NEW.actor_user_id;
    ELSE
      v_actor_id := v_reviewer_id;
    END IF;
  END IF;

  IF v_review_id IS NULL
     OR v_actor_id IS NULL
     OR v_matter_id IS NULL
     OR v_reviewer_id IS NULL
     OR v_actor_id IS DISTINCT FROM v_reviewer_id
  THEN
    RAISE EXCEPTION 'AI review actor is not authorized for this write'
      USING ERRCODE = '42501';
  END IF;

  SELECT w.organization_id
    INTO v_organization_id
    FROM public.matters m
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = v_matter_id;

  IF v_organization_id IS NULL THEN
    RAISE EXCEPTION 'AI review organization scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.organizations
   WHERE id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review organization does not exist'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_matter_id
       AND mm.user_id = v_actor_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI review actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aaa_ai_review_write_authorization_guard_trigger
  ON public.ai_reviews;
CREATE TRIGGER aaa_ai_review_write_authorization_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_reviews
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_write_authorization_guard();

DROP TRIGGER IF EXISTS aaa_ai_review_item_write_authorization_guard_trigger
  ON public.ai_review_items;
CREATE TRIGGER aaa_ai_review_item_write_authorization_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_review_items
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_write_authorization_guard();

DROP TRIGGER IF EXISTS aaa_ai_review_decision_write_authorization_guard_trigger
  ON public.ai_review_decisions;
CREATE TRIGGER aaa_ai_review_decision_write_authorization_guard_trigger
  BEFORE INSERT ON public.ai_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_write_authorization_guard();

REVOKE ALL ON FUNCTION public.ai_review_write_authorization_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_write_authorization_guard()
  TO service_role;

-- Migration date: 2026-08-19
-- Bloque 3A fix 1B: keep each human-review mutation and its projection
-- inside one transaction while serializing it with organization revocation.

CREATE OR REPLACE FUNCTION public.apply_ai_review_item_decision(
  p_review_id uuid,
  p_item_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_decision text,
  p_finding_text text,
  p_comment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_matter_id uuid;
  v_reviewer_user_id uuid;
  v_review_status text;
  v_organization_id uuid;
  v_current_epoch bigint;
  v_item public.ai_review_items%ROWTYPE;
  v_updated_item public.ai_review_items%ROWTYPE;
  v_decision_row public.ai_review_decisions%ROWTYPE;
  v_before_state jsonb;
  v_after_state jsonb;
  v_finding_text text;
  v_comment text;
BEGIN
  IF p_decision NOT IN ('accepted', 'rejected', 'edited') THEN
    RAISE EXCEPTION 'Invalid AI review item decision';
  END IF;
  IF p_comment IS NOT NULL AND char_length(p_comment) > 2000 THEN
    RAISE EXCEPTION 'AI review comment is too long';
  END IF;
  IF p_decision = 'edited' AND nullif(btrim(p_finding_text), '') IS NULL THEN
    RAISE EXCEPTION 'Edited AI review finding must not be empty';
  END IF;

  -- Resolve the organization before taking its lock. The lock is then held for
  -- the complete RPC, including both the decision insert and item update.
  SELECT r.matter_id, r.reviewer_user_id, r.status, w.organization_id
    INTO v_matter_id, v_reviewer_user_id, v_review_status, v_organization_id
    FROM public.ai_reviews r
    JOIN public.matters m ON m.id = r.matter_id
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE r.id = p_review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review not found';
  END IF;
  IF v_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'AI review organization scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT o.authorization_epoch
    INTO v_current_epoch
    FROM public.organizations o
   WHERE o.id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND OR v_current_epoch IS DISTINCT FROM p_authorization_epoch THEN
    RAISE EXCEPTION 'AI review authorization changed'
      USING ERRCODE = '42501';
  END IF;

  IF v_reviewer_user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'AI review actor is not the assigned reviewer'
      USING ERRCODE = '42501';
  END IF;
  IF v_review_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'AI review is already complete';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_matter_id
       AND mm.user_id = p_actor_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI review actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize concurrent item decisions/completion against this review after
  -- the authorization lock has established the revocation ordering.
  SELECT *
    INTO v_item
    FROM public.ai_review_items i
   WHERE i.id = p_item_id
     AND i.review_id = p_review_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review item not found';
  END IF;

  v_comment := CASE
    WHEN p_comment IS NULL THEN NULL
    ELSE nullif(btrim(p_comment), '')
  END;
  v_finding_text := CASE
    WHEN p_decision = 'edited' THEN btrim(p_finding_text)
    ELSE v_item.finding_text
  END;
  v_before_state := jsonb_build_object(
    'status', v_item.status,
    'finding_text', v_item.finding_text,
    'comment', v_item.comment
  );
  v_after_state := jsonb_build_object(
    'status', p_decision,
    'finding_text', v_finding_text,
    'comment', v_comment
  );

  INSERT INTO public.ai_review_decisions (
    review_id,
    review_item_id,
    actor_user_id,
    decision,
    before_state,
    after_state,
    comment
  ) VALUES (
    p_review_id,
    p_item_id,
    p_actor_user_id,
    p_decision,
    v_before_state,
    v_after_state,
    v_comment
  )
  RETURNING * INTO v_decision_row;

  UPDATE public.ai_review_items
     SET status = p_decision,
         finding_text = v_finding_text,
         comment = v_comment,
         updated_at = now()
   WHERE id = p_item_id
     AND review_id = p_review_id
  RETURNING * INTO v_updated_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review item projection failed';
  END IF;

  RETURN jsonb_build_object(
    'item', to_jsonb(v_updated_item),
    'decision', to_jsonb(v_decision_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_ai_review_item_decision(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_ai_review_item_decision(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_ai_review(
  p_review_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_status text,
  p_comment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_matter_id uuid;
  v_reviewer_user_id uuid;
  v_review_status text;
  v_organization_id uuid;
  v_current_epoch bigint;
  v_review public.ai_reviews%ROWTYPE;
  v_decision_row public.ai_review_decisions%ROWTYPE;
  v_comment text;
BEGIN
  IF p_status NOT IN ('approved', 'changes_requested') THEN
    RAISE EXCEPTION 'Invalid AI review completion status';
  END IF;
  IF p_comment IS NOT NULL AND char_length(p_comment) > 2000 THEN
    RAISE EXCEPTION 'AI review comment is too long';
  END IF;

  SELECT r.matter_id, r.reviewer_user_id, r.status, w.organization_id
    INTO v_matter_id, v_reviewer_user_id, v_review_status, v_organization_id
    FROM public.ai_reviews r
    JOIN public.matters m ON m.id = r.matter_id
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE r.id = p_review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review not found';
  END IF;
  IF v_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'AI review organization scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT o.authorization_epoch
    INTO v_current_epoch
    FROM public.organizations o
   WHERE o.id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND OR v_current_epoch IS DISTINCT FROM p_authorization_epoch THEN
    RAISE EXCEPTION 'AI review authorization changed'
      USING ERRCODE = '42501';
  END IF;

  IF v_reviewer_user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'AI review actor is not the assigned reviewer'
      USING ERRCODE = '42501';
  END IF;
  IF v_review_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'AI review is already complete';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_matter_id
       AND mm.user_id = p_actor_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI review actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  -- The review update and terminal decision are deliberately ordered this way
  -- because the existing decision trigger requires the new terminal status.
  -- Both writes remain in this RPC transaction; any later trigger/constraint
  -- failure rolls the status update back with the decision insert.
  UPDATE public.ai_reviews
     SET status = p_status,
         completed_at = now()
   WHERE id = p_review_id
     AND status = 'in_progress'
  RETURNING * INTO v_review;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review completion failed';
  END IF;

  v_comment := CASE
    WHEN p_comment IS NULL THEN NULL
    ELSE nullif(btrim(p_comment), '')
  END;

  INSERT INTO public.ai_review_decisions (
    review_id,
    review_item_id,
    actor_user_id,
    decision,
    before_state,
    after_state,
    comment
  ) VALUES (
    p_review_id,
    NULL,
    p_actor_user_id,
    p_status,
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object('status', p_status, 'comment', v_comment),
    v_comment
  )
  RETURNING * INTO v_decision_row;

  RETURN jsonb_build_object(
    'review', to_jsonb(v_review),
    'decision', to_jsonb(v_decision_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_ai_review(
  uuid, uuid, uuid, bigint, text, text
) FROM PUBLIC, anon, authenticated;

-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Bloque 3B1: immutable DOCX reports generated only
-- from an approved human review.

CREATE TABLE IF NOT EXISTS public.ai_review_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES public.matters(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  report_version integer NOT NULL DEFAULT 1 CHECK (report_version >= 1),
  filename text NOT NULL CHECK (filename = 'Informe de revision humana.docx'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, source_document_version_id),
  UNIQUE (document_version_id)
);

CREATE INDEX IF NOT EXISTS ai_review_exports_matter_idx
  ON public.ai_review_exports(matter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_review_exports_actor_idx
  ON public.ai_review_exports(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ai_review_export_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_execution_matter_id uuid;
  v_execution_project_id uuid;
  v_execution_document_id uuid;
  v_execution_version_id uuid;
  v_execution_status text;
  v_review_status text;
  v_review_matter_id uuid;
  v_review_project_id uuid;
  v_source_document_id uuid;
  v_report_document_id uuid;
  v_report_content_sha256 text;
  v_organization_id uuid;
BEGIN
  SELECT
    e.matter_id,
    e.project_id,
    e.document_id,
    e.document_version_id,
    e.status,
    r.status,
    r.matter_id,
    r.project_id
    INTO
      v_execution_matter_id,
      v_execution_project_id,
      v_execution_document_id,
      v_execution_version_id,
      v_execution_status,
      v_review_status,
      v_review_matter_id,
      v_review_project_id
    FROM public.ai_reviews r
    JOIN public.ai_executions e ON e.id = r.execution_id
   WHERE r.id = NEW.review_id
     AND e.id = NEW.execution_id;

  IF NOT FOUND
     OR v_execution_status IS DISTINCT FROM 'succeeded'
     OR v_review_status IS DISTINCT FROM 'approved'
     OR v_execution_matter_id IS NULL
     OR v_review_matter_id IS DISTINCT FROM v_execution_matter_id
     OR v_review_project_id IS DISTINCT FROM v_execution_project_id
     OR NEW.matter_id IS DISTINCT FROM v_execution_matter_id
     OR NEW.project_id IS DISTINCT FROM v_execution_project_id
     OR NEW.source_document_version_id IS DISTINCT FROM v_execution_version_id
  THEN
    RAISE EXCEPTION 'AI review export scope is invalid or review is not approved';
  END IF;

  SELECT document_id
    INTO v_source_document_id
    FROM public.document_versions
   WHERE id = NEW.source_document_version_id
     AND deleted_at IS NULL;
  IF v_source_document_id IS NULL
     OR v_source_document_id IS DISTINCT FROM v_execution_document_id
  THEN
    RAISE EXCEPTION 'AI review export source version is outside execution scope';
  END IF;

  SELECT document_id, content_sha256
    INTO v_report_document_id, v_report_content_sha256
    FROM public.document_versions
   WHERE id = NEW.document_version_id
     AND deleted_at IS NULL
     AND source = 'ai_review_report';
  IF v_report_document_id IS NULL
     OR v_report_document_id IS DISTINCT FROM NEW.document_id
     OR v_report_content_sha256 IS DISTINCT FROM NEW.content_sha256
  THEN
    RAISE EXCEPTION 'AI review export report version is invalid';
  END IF;

  SELECT w.organization_id
    INTO v_organization_id
    FROM public.matters m
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = v_execution_matter_id;
  IF v_organization_id IS NULL THEN
    RAISE EXCEPTION 'AI review export organization scope is invalid';
  END IF;

  PERFORM 1
    FROM public.organizations
   WHERE id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review export organization does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_execution_matter_id
       AND mm.user_id = NEW.actor_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI review export actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_export_scope_guard_trigger
  ON public.ai_review_exports;
CREATE TRIGGER ai_review_export_scope_guard_trigger
  BEFORE INSERT ON public.ai_review_exports
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_export_scope_guard();

CREATE OR REPLACE FUNCTION public.ai_review_exports_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai_review_exports is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS ai_review_exports_insert_only_trigger
  ON public.ai_review_exports;
CREATE TRIGGER ai_review_exports_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_review_exports
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_exports_insert_only();

ALTER TABLE public.ai_review_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_review_exports FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ai_review_exports TO service_role;

REVOKE ALL ON FUNCTION public.ai_review_export_scope_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_export_scope_guard() TO service_role;
REVOKE ALL ON FUNCTION public.ai_review_exports_insert_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_exports_insert_only() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_ai_review(
  uuid, uuid, uuid, bigint, text, text
) TO service_role;

-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Bloque 3B2a: authenticated, immutable redline
-- instructions generated from an approved AI human review. This bundle is a
-- JSON contract for a future Word add-in; it never applies changes to a DOCX.

CREATE TABLE IF NOT EXISTS public.ai_redline_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_version text NOT NULL DEFAULT 'beta-0.1'
    CHECK (bundle_version = 'beta-0.1'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES public.matters(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_version_id uuid NOT NULL
    REFERENCES public.document_versions(id) ON DELETE CASCADE,
  source_document_sha256 text NOT NULL CHECK (source_document_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_id uuid NOT NULL REFERENCES public.ai_receipts(id) ON DELETE CASCADE,
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_json jsonb NOT NULL
    CHECK (jsonb_typeof(canonical_json) = 'object'),
  canonical_json_text text NOT NULL,
  bundle_sha256 text NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  actions_count integer NOT NULL CHECK (actions_count >= 1),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, source_document_version_id, revision)
);

CREATE INDEX IF NOT EXISTS ai_redline_bundles_matter_idx
  ON public.ai_redline_bundles(matter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_redline_bundles_review_idx
  ON public.ai_redline_bundles(review_id, source_document_version_id, revision);
CREATE INDEX IF NOT EXISTS ai_redline_bundles_actor_idx
  ON public.ai_redline_bundles(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.assert_ai_redline_bundle_access(
  p_matter uuid,
  p_user uuid,
  p_organization uuid,
  p_authorization_epoch bigint,
  p_intent text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_epoch bigint;
BEGIN
  -- revoke_organization_membership takes this same lock before deleting the
  -- organization membership and bumping the epoch. Whichever operation wins
  -- this lock is the linearization point for the request/revocation race.
  SELECT o.authorization_epoch
    INTO v_current_epoch
    FROM public.organizations o
   WHERE o.id = p_organization
   FOR UPDATE;

  IF NOT FOUND OR v_current_epoch IS DISTINCT FROM p_authorization_epoch THEN
    RAISE EXCEPTION 'AI redline bundle authorization changed'
      USING ERRCODE = '42501';
  END IF;

  IF p_intent NOT IN ('read', 'review') OR NOT EXISTS (
    SELECT 1
      FROM public.matters m
      JOIN public.workspaces w ON w.id = m.workspace_id
      JOIN public.matter_memberships mm
        ON mm.matter_id = m.id
       AND mm.user_id = p_user
      JOIN public.organization_memberships om
        ON om.organization_id = w.organization_id
       AND om.user_id = p_user
     WHERE m.id = p_matter
       AND w.organization_id = p_organization
       AND (
         (p_intent = 'read' AND mm.role IN (
           'matter_owner', 'editor', 'viewer', 'technical_operator'
         ))
         OR (p_intent = 'review' AND mm.role IN ('matter_owner', 'editor'))
       )
  ) THEN
    RAISE EXCEPTION 'AI redline bundle actor is not authorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_ai_redline_bundle_access(
  uuid, uuid, uuid, bigint, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_ai_redline_bundle_access(
  uuid, uuid, uuid, bigint, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.ai_redline_bundle_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_execution_matter_id uuid;
  v_execution_project_id uuid;
  v_execution_document_id uuid;
  v_execution_version_id uuid;
  v_execution_content_sha256 text;
  v_execution_status text;
  v_review_status text;
  v_review_matter_id uuid;
  v_review_project_id uuid;
  v_reviewer_user_id uuid;
  v_receipt_execution_id uuid;
  v_receipt_sha256 text;
  v_source_document_id uuid;
  v_source_sha256 text;
  v_organization_id uuid;
  v_action jsonb;
BEGIN
  SELECT
    e.matter_id,
    e.project_id,
    e.document_id,
    e.document_version_id,
    e.document_content_sha256,
    e.status,
    r.status,
    r.matter_id,
    r.project_id,
    r.reviewer_user_id
    INTO
      v_execution_matter_id,
      v_execution_project_id,
      v_execution_document_id,
      v_execution_version_id,
      v_execution_content_sha256,
      v_execution_status,
      v_review_status,
      v_review_matter_id,
      v_review_project_id,
      v_reviewer_user_id
    FROM public.ai_reviews r
    JOIN public.ai_executions e ON e.id = r.execution_id
   WHERE r.id = NEW.review_id
     AND e.id = NEW.execution_id;

  IF NOT FOUND
     OR v_execution_status IS DISTINCT FROM 'succeeded'
     OR v_review_status IS DISTINCT FROM 'approved'
     OR v_execution_matter_id IS NULL
     OR v_review_matter_id IS DISTINCT FROM v_execution_matter_id
     OR v_review_project_id IS DISTINCT FROM v_execution_project_id
     OR NEW.matter_id IS DISTINCT FROM v_execution_matter_id
     OR NEW.project_id IS DISTINCT FROM v_execution_project_id
     OR NEW.source_document_version_id IS DISTINCT FROM v_execution_version_id
     OR NEW.source_document_sha256 IS DISTINCT FROM v_execution_content_sha256
  THEN
    RAISE EXCEPTION 'AI redline bundle scope is invalid or review is not approved';
  END IF;

  SELECT document_id, content_sha256
    INTO v_source_document_id, v_source_sha256
    FROM public.document_versions
   WHERE id = NEW.source_document_version_id
     AND deleted_at IS NULL;
  IF v_source_document_id IS NULL
     OR v_source_document_id IS DISTINCT FROM v_execution_document_id
     OR v_source_sha256 IS DISTINCT FROM NEW.source_document_sha256
  THEN
    RAISE EXCEPTION 'AI redline bundle source version is invalid';
  END IF;

  SELECT execution_id, receipt_sha256
    INTO v_receipt_execution_id, v_receipt_sha256
    FROM public.ai_receipts
   WHERE id = NEW.receipt_id;
  IF v_receipt_execution_id IS DISTINCT FROM NEW.execution_id
     OR v_receipt_sha256 IS DISTINCT FROM NEW.receipt_sha256
  THEN
    RAISE EXCEPTION 'AI redline bundle receipt is invalid';
  END IF;

  IF NEW.canonical_json_text::jsonb IS DISTINCT FROM NEW.canonical_json
     OR encode(digest(NEW.canonical_json_text, 'sha256'), 'hex')
          IS DISTINCT FROM NEW.bundle_sha256
     OR NEW.canonical_json->>'bundle_version' IS DISTINCT FROM NEW.bundle_version
     OR NEW.canonical_json->>'review_id' IS DISTINCT FROM NEW.review_id::text
     OR NEW.canonical_json->>'execution_id' IS DISTINCT FROM NEW.execution_id::text
     OR NEW.canonical_json->>'matter_id' IS DISTINCT FROM NEW.matter_id::text
     OR NEW.canonical_json->>'source_document_version_id'
          IS DISTINCT FROM NEW.source_document_version_id::text
     OR NEW.canonical_json->>'source_document_sha256'
          IS DISTINCT FROM NEW.source_document_sha256
     OR NEW.canonical_json->>'receipt_id' IS DISTINCT FROM NEW.receipt_id::text
     OR NEW.canonical_json->>'receipt_sha256' IS DISTINCT FROM NEW.receipt_sha256
  THEN
    RAISE EXCEPTION 'AI redline bundle canonical JSON integrity failed';
  END IF;

  IF NEW.canonical_json->>'revision' IS NULL
     OR (NEW.canonical_json->>'revision') !~ '^[0-9]+$'
     OR (NEW.canonical_json->>'revision')::integer IS DISTINCT FROM NEW.revision
     OR jsonb_typeof(NEW.canonical_json->'actions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.canonical_json->'actions') <> NEW.actions_count
  THEN
    RAISE EXCEPTION 'AI redline bundle revision or actions are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.canonical_json->'actions') action
     GROUP BY action->>'action_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AI redline bundle contains duplicate action IDs';
  END IF;

  FOR v_action IN
    SELECT value FROM jsonb_array_elements(NEW.canonical_json->'actions')
  LOOP
    IF v_action->>'action_id' IS NULL
       OR v_action->>'item_id' IS NULL
       OR v_action->>'citation_id' IS NULL
       OR v_action->>'source_document_version_id'
            IS DISTINCT FROM NEW.source_document_version_id::text
       OR v_action->>'reviewer_user_id' IS DISTINCT FROM v_reviewer_user_id::text
       OR v_action->>'timestamp' IS NULL
       OR nullif(btrim(v_action->>'replacement_text'), '') IS NULL
       OR v_action->>'before_text_sha256' IS NULL
       OR (v_action->>'before_text_sha256') !~ '^[0-9a-f]{64}$'
       OR (v_action->>'start') IS NULL
       OR (v_action->>'end') IS NULL
       OR (v_action->>'start') !~ '^[0-9]+$'
       OR (v_action->>'end') !~ '^[0-9]+$'
       OR (v_action->>'start')::bigint >= (v_action->>'end')::bigint
    THEN
      RAISE EXCEPTION 'AI redline bundle action is invalid';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.ai_review_items i
       WHERE i.id::text = v_action->>'item_id'
         AND i.review_id = NEW.review_id
         AND i.status IN ('accepted', 'edited')
    ) THEN
      RAISE EXCEPTION 'AI redline bundle action item is outside review scope';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.ai_review_items i
        CROSS JOIN LATERAL jsonb_array_elements(i.citation_refs) citation
       WHERE i.id::text = v_action->>'item_id'
         AND i.review_id = NEW.review_id
         AND citation->>'citation_id' = v_action->>'citation_id'
         AND citation->>'document_version_id'
              = NEW.source_document_version_id::text
         AND citation->>'verified' = 'true'
    ) THEN
      RAISE EXCEPTION 'AI redline bundle action citation is outside review scope';
    END IF;
  END LOOP;

  SELECT w.organization_id
    INTO v_organization_id
    FROM public.matters m
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = v_execution_matter_id;
  IF v_organization_id IS NULL THEN
    RAISE EXCEPTION 'AI redline bundle organization scope is invalid';
  END IF;

  -- Serialize creation with organization revocation. The membership check
  -- cannot pass on a stale authorization snapshot after this lock is taken.
  PERFORM 1
    FROM public.organizations
   WHERE id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI redline bundle organization does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_execution_matter_id
       AND mm.user_id = NEW.actor_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI redline bundle actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_redline_bundle_scope_guard_trigger
  ON public.ai_redline_bundles;
CREATE TRIGGER ai_redline_bundle_scope_guard_trigger
  BEFORE INSERT ON public.ai_redline_bundles
  FOR EACH ROW EXECUTE FUNCTION public.ai_redline_bundle_scope_guard();

CREATE OR REPLACE FUNCTION public.ai_redline_bundles_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai_redline_bundles is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS ai_redline_bundles_insert_only_trigger
  ON public.ai_redline_bundles;
CREATE TRIGGER ai_redline_bundles_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_redline_bundles
  FOR EACH ROW EXECUTE FUNCTION public.ai_redline_bundles_insert_only();

ALTER TABLE public.ai_redline_bundles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_redline_bundles FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ai_redline_bundles TO service_role;

REVOKE ALL ON FUNCTION public.ai_redline_bundle_scope_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_redline_bundle_scope_guard()
  TO service_role;
REVOKE ALL ON FUNCTION public.ai_redline_bundles_insert_only()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_redline_bundles_insert_only()
  TO service_role;

-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Bloque 4A: publish an approved human-review DOCX
-- exactly once to an explicitly configured Google Shared Drive folder.

ALTER TABLE public.matters
  ADD COLUMN IF NOT EXISTS drive_folder_id text;

ALTER TABLE public.matters
  DROP CONSTRAINT IF EXISTS matters_drive_folder_id_check;

ALTER TABLE public.matters
  ADD CONSTRAINT matters_drive_folder_id_check
  CHECK (drive_folder_id IS NULL OR btrim(drive_folder_id) <> '');

CREATE TABLE IF NOT EXISTS public.ai_review_drive_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id uuid NOT NULL UNIQUE
    REFERENCES public.ai_review_exports(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES public.matters(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  drive_folder_id text NOT NULL CHECK (btrim(drive_folder_id) <> ''),
  file_id text,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  format_version text NOT NULL CHECK (format_version = 'beta-0.1'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'failed')),
  size_bytes bigint,
  checksum text,
  failure_code text CHECK (failure_code IN (
    'drive_upload_failed',
    'drive_file_invalid',
    'authorization_revoked',
    'publication_record_failed'
  )),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending'
      AND file_id IS NULL
      AND size_bytes IS NULL
      AND checksum IS NULL
      AND failure_code IS NULL)
    OR (status = 'published'
      AND nullif(btrim(file_id), '') IS NOT NULL
      AND size_bytes IS NOT NULL
      AND size_bytes >= 0
      AND nullif(btrim(checksum), '') IS NOT NULL
      AND failure_code IS NULL)
    OR (status = 'failed'
      AND file_id IS NULL
      AND size_bytes IS NULL
      AND checksum IS NULL
      AND failure_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_review_drive_publications_matter_idx
  ON public.ai_review_drive_publications(matter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_review_drive_publications_review_idx
  ON public.ai_review_drive_publications(review_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ai_review_drive_publication_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_export_review_id uuid;
  v_export_execution_id uuid;
  v_export_matter_id uuid;
  v_export_project_id uuid;
  v_export_sha256 text;
  v_review_status text;
  v_execution_status text;
  v_matter_project_id uuid;
  v_matter_folder_id text;
  v_organization_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT
      ex.review_id,
      ex.execution_id,
      ex.matter_id,
      ex.project_id,
      ex.content_sha256,
      r.status,
      e.status,
      m.project_id,
      m.drive_folder_id,
      w.organization_id
      INTO
        v_export_review_id,
        v_export_execution_id,
        v_export_matter_id,
        v_export_project_id,
        v_export_sha256,
        v_review_status,
        v_execution_status,
        v_matter_project_id,
        v_matter_folder_id,
        v_organization_id
      FROM public.ai_review_exports ex
      JOIN public.ai_reviews r ON r.id = ex.review_id
      JOIN public.ai_executions e ON e.id = ex.execution_id
      JOIN public.matters m ON m.id = ex.matter_id
      JOIN public.workspaces w ON w.id = m.workspace_id
     WHERE ex.id = NEW.export_id;

    IF NOT FOUND
       OR NEW.status IS DISTINCT FROM 'pending'
       OR v_review_status IS DISTINCT FROM 'approved'
       OR v_execution_status IS DISTINCT FROM 'succeeded'
       OR v_export_review_id IS DISTINCT FROM NEW.review_id
       OR v_export_execution_id IS DISTINCT FROM NEW.execution_id
       OR v_export_matter_id IS DISTINCT FROM NEW.matter_id
       OR v_export_project_id IS DISTINCT FROM NEW.project_id
       OR v_matter_project_id IS DISTINCT FROM NEW.project_id
       OR v_matter_folder_id IS NULL
       OR v_matter_folder_id IS DISTINCT FROM NEW.drive_folder_id
       OR v_export_sha256 IS DISTINCT FROM NEW.sha256
    THEN
      RAISE EXCEPTION 'AI review Drive publication scope is invalid';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.matter_memberships mm
        JOIN public.organization_memberships om
          ON om.organization_id = v_organization_id
         AND om.user_id = mm.user_id
       WHERE mm.matter_id = NEW.matter_id
         AND mm.user_id = NEW.actor_user_id
         AND mm.role IN ('matter_owner', 'editor')
    ) THEN
      RAISE EXCEPTION 'AI review Drive publication actor is not authorized'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM 'pending'
     OR NEW.export_id IS DISTINCT FROM OLD.export_id
     OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.drive_folder_id IS DISTINCT FROM OLD.drive_folder_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.format_version IS DISTINCT FROM OLD.format_version
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'AI review Drive publication identity is immutable';
  END IF;

  IF NEW.status NOT IN ('published', 'failed') THEN
    RAISE EXCEPTION 'Invalid AI review Drive publication status transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_drive_publication_guard_trigger
  ON public.ai_review_drive_publications;
CREATE TRIGGER ai_review_drive_publication_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_review_drive_publications
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_drive_publication_guard();

ALTER TABLE public.ai_review_drive_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_review_drive_publications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_review_drive_publications TO service_role;

REVOKE ALL ON FUNCTION public.ai_review_drive_publication_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_drive_publication_guard()
  TO service_role;
