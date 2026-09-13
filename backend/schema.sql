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
  jurisdiction text,
  practice_setting text
    check (
      practice_setting is null
      or practice_setting in ('private_practice', 'in_house', 'not_practising')
    ),
  professional_title text
    check (
      professional_title is null
      or professional_title in (
        'Partner',
        'Senior Associate',
        'Associate',
        'Law Clerk',
        'Counsel',
        'General Counsel',
        'Legal Counsel',
        'Other'
      )
    ),
  practice_areas text[] not null default '{}'::text[],
  onboarding_version smallint
    check (onboarding_version is null or onboarding_version >= 0),
  password_set_at timestamptz,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  title_model text,
  tabular_model text not null default 'gemini-3-flash-preview',
  last_selected_chat_model text,
  last_selected_reasoning_level text check (last_selected_reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  quote_model text,
  mfa_on_login boolean not null default true,
  quick_actions_visible boolean not null default true,
  dark_mode boolean not null default false,
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
  insert into public.user_profiles (
    user_id,
    email,
    display_name,
    organisation
  )
  values (
    new.id,
    lower(new.email),
    nullif(left(btrim(coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    )), 200), ''),
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'organisation', '')), 200), '')
  )
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = coalesce(
          nullif(btrim(user_profiles.display_name), ''),
          excluded.display_name
        ),
        organisation = coalesce(
          nullif(btrim(user_profiles.organisation), ''),
          excluded.organisation
        ),
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

create or replace function public.sync_user_password_set(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  recorded_at timestamptz;
begin
  update public.user_profiles as profile
  set password_set_at = coalesce(profile.password_set_at, now()),
      updated_at = now()
  where profile.user_id = p_user_id
    and exists (
      select 1
      from auth.users as auth_user
      where auth_user.id = p_user_id
        and auth_user.encrypted_password is not null
        and auth_user.encrypted_password::text <> ''
    )
  returning profile.password_set_at into recorded_at;

  return recorded_at;
end;
$$;

revoke all on function public.sync_user_password_set(uuid)
  from public, anon, authenticated;
grant execute on function public.sync_user_password_set(uuid)
  to service_role;

create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.user_profiles
  set email = lower(new.email),
      updated_at = now()
  where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute procedure public.handle_user_email_updated();

-- Short-lived OAuth handoffs let an Office dialog establish a separate,
-- partitioned HttpOnly session in the embedded Word task pane. Supabase tokens
-- are encrypted at rest and the opaque browser-visible ticket is single-use.
create table if not exists public.auth_handoff_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticket_hash text not null unique,
  request_id text not null,
  origin text not null,
  encrypted_session text not null,
  session_iv text not null,
  session_tag text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_auth_handoff_tickets_expires
  on public.auth_handoff_tickets(expires_at);

alter table public.auth_handoff_tickets enable row level security;

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'gemini', 'openai', 'openrouter', 'deepseek', 'opencode-zen', 'opencode-go', 'vercel')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  credential_ref text not null,
  enabled boolean not null default true,
  version integer not null default 1,
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
drop trigger if exists assign_user_api_key_credential_ref on public.user_api_keys;
create trigger assign_user_api_key_credential_ref
  before insert or update on public.user_api_keys
  for each row execute function public.assign_user_api_key_credential_ref();

create index if not exists idx_user_api_keys_user
  on public.user_api_keys(user_id);

alter table public.user_api_keys enable row level security;

-- Ordered, user-selected models for API routing gateways. Router slugs are
-- deliberately provider-neutral (for example `openrouter` or `vercel`).
create table if not exists public.user_router_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  router text not null
    check (router ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  model_id text not null
    check (
      model_id = btrim(model_id)
      and char_length(model_id) between 1 and 200
      and model_id !~ '\s'
    ),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, router, model_id)
);

create index if not exists idx_user_router_models_user_router_order
  on public.user_router_models (user_id, router, sort_order, created_at);

alter table public.user_router_models enable row level security;

create or replace function public.replace_user_router_models(
  target_user_id uuid,
  target_router text,
  target_model_ids text[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if target_router !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'Invalid router slug';
  end if;

  if coalesce(array_length(target_model_ids, 1), 0) > 50 then
    raise exception 'A router can have at most 50 selected models';
  end if;

  -- Serialize concurrent replacements of the SAME user+router selection.
  -- Two overlapping PATCHes would otherwise interleave delete+insert and one
  -- of them would die on the (user_id, router, model_id) unique constraint.
  -- An advisory xact lock is keyed by an application-chosen value (here a
  -- hash of user+router), blocks only the matching key, and releases itself
  -- at commit/rollback — no table-wide locking, nothing left behind.
  -- hashtextextended (int8, the repo's convention for advisory locks) rather
  -- than hashtext (int4): the wider namespace makes an accidental collision
  -- with an unrelated lock key vastly less likely, and every other advisory
  -- lock in this schema is already keyed the same way.
  perform pg_advisory_xact_lock(
    hashtextextended(target_user_id::text || ':' || target_router, 0)
  );

  delete from public.user_router_models
  where user_id = target_user_id and router = target_router;

  insert into public.user_router_models (
    user_id,
    router,
    model_id,
    sort_order
  )
  select
    target_user_id,
    target_router,
    model_id,
    ordinality - 1
  from unnest(coalesce(target_model_ids, '{}'::text[]))
    with ordinality as selected(model_id, ordinality);
end;
$$;

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
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  cm_number text,
  practice text,
  visibility text not null default 'private',
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user
  on public.projects(user_id);

create index if not exists projects_updated_at_idx
  on public.projects(updated_at desc, id);

create index if not exists projects_shared_with_idx
  on public.projects using gin (shared_with);

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project
  on public.project_subfolders(project_id);

create table if not exists public.library_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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
  user_id uuid not null references auth.users(id) on delete cascade,
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
  deleted_by uuid references auth.users(id) on delete set null,
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

-- Historical LiTT download grants remain the authoritative single-use,
-- expiring storage capability; Slice G may extend but must not replace them.
create table if not exists public.document_download_grants (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  issued_to_user text not null,
  token_hash text not null unique,
  storage_path text not null,
  filename text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists document_download_grants_expiry_idx
  on public.document_download_grants(expires_at)
  where consumed_at is null;
alter table public.document_download_grants enable row level security;

alter table public.documents
  add column if not exists current_version_id uuid
  references public.document_versions(id) on delete set null;

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
  user_id uuid references auth.users(id) on delete cascade,
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
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user
  on public.hidden_workflows(user_id);

create table if not exists public.workflow_shares (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  shared_by_user_id uuid not null references auth.users(id) on delete cascade,
  shared_with_email text not null,
  allow_edit boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_shares_workflow_email_unique
    unique(workflow_id, shared_with_email)
);

create index if not exists workflow_shares_workflow_id_idx
  on public.workflow_shares(workflow_id);

create index if not exists workflow_shares_email_idx
  on public.workflow_shares(shared_with_email);

create table if not exists public.default_workflow_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  default_key text not null,
  workflow_id uuid references public.workflows(id) on delete set null,
  installed_at timestamptz not null default now(),
  constraint default_workflow_installations_user_key_unique
    unique(user_id, default_key),
  constraint default_workflow_installations_workflow_unique
    unique(workflow_id)
);

create table if not exists public.quick_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  name text not null,
  prompt text not null default '',
  document_upload boolean not null default false,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  surface text not null default 'app',
  constraint quick_actions_surface_check check (surface in ('app', 'word'))
);

create index if not exists quick_actions_user_order_idx
  on public.quick_actions(user_id, sort_order, created_at);

create index if not exists quick_actions_user_surface_order_idx
  on public.quick_actions(user_id, surface, sort_order, created_at);

create index if not exists quick_actions_workflow_idx
  on public.quick_actions(workflow_id);

create table if not exists public.mike_workflows (
  id uuid primary key default gen_random_uuid(),
  workflow_key text not null,
  distribution text not null,
  version text,
  title text not null,
  description text,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  contributors jsonb,
  language text,
  practice text,
  jurisdictions text[],
  pack_key text,
  pack_title text,
  pack_description text,
  pack_version text,
  default_sort_order integer,
  quick_action_name text,
  quick_action_prompt text,
  document_upload boolean not null default false,
  word_quick_action boolean not null default false,
  word_quick_action_prompt text,
  source_commit text,
  content_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text,
  approval_provenance text,
  constraint mike_workflows_key_hash_unique
    unique(workflow_key, content_hash),
  constraint mike_workflows_distribution_check
    check(distribution in ('default', 'addon')),
  constraint mike_workflows_type_check
    check(type in ('assistant', 'tabular')),
  constraint mike_workflows_source_commit_check
    check(source_commit is null or source_commit ~ '^[0-9a-f]{40}$'),
  constraint mike_workflows_content_hash_check
    check(content_hash ~ '^[0-9a-f]{64}$')
);

create unique index if not exists mike_workflows_active_key_idx
  on public.mike_workflows(workflow_key)
  where active;

create index if not exists mike_workflows_active_distribution_type_idx
  on public.mike_workflows(active, distribution, type, title);

create index if not exists mike_workflows_active_pack_idx
  on public.mike_workflows(active, pack_key, title);

create table if not exists public.workflow_reference_documents (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  file_type text not null,
  storage_path text not null,
  size_bytes integer,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflow_reference_documents_workflow_idx
  on public.workflow_reference_documents(workflow_id, created_at);

create index if not exists workflow_reference_documents_user_idx
  on public.workflow_reference_documents(user_id);

create table if not exists public.mike_workflow_reference_files (
  id uuid primary key default gen_random_uuid(),
  mike_workflow_id uuid not null
    references public.mike_workflows(id) on delete cascade,
  filename text not null,
  file_type text not null,
  storage_path text not null,
  size_bytes integer,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint mike_workflow_reference_files_name_unique
    unique(mike_workflow_id, filename),
  constraint mike_workflow_reference_files_hash_check
    check(content_hash ~ '^[0-9a-f]{64}$')
);

-- Deprecated rollback-only objects. The unified-catalog backend never reads
-- or writes these tables; they remain for one phased rollout so an older
-- backend can be restored without losing the former add-on catalog.
create table if not exists public.workflow_addons (
  id uuid primary key default gen_random_uuid(),
  addon_key text not null unique,
  pack_key text,
  pack_title text,
  pack_description text,
  pack_version text,
  version text,
  title text not null,
  description text,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  contributors jsonb,
  language text,
  practice text,
  jurisdictions text[],
  content_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_addons_type_check
    check(type in ('assistant', 'tabular'))
);

create index if not exists workflow_addons_active_type_idx
  on public.workflow_addons(active, type, title);

create index if not exists workflow_addons_active_pack_idx
  on public.workflow_addons(active, pack_key, title);

create table if not exists public.workflow_addon_reference_files (
  id uuid primary key default gen_random_uuid(),
  addon_id uuid not null references public.workflow_addons(id) on delete cascade,
  filename text not null,
  file_type text not null,
  storage_path text not null,
  size_bytes integer,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint workflow_addon_reference_files_name_unique
    unique(addon_id, filename)
);

-- Replace the active catalog as one transaction. Content-addressed historical
-- rows remain available for old builtin-* workflow references.
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

-- Install each user's editable defaults and Quick Actions atomically. The
-- installation row remains after a default workflow is deleted so it is not
-- silently recreated on a later request.
create or replace function public.install_missing_default_workflows(
  p_user_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  catalog_item public.mike_workflows%rowtype;
  workflow_uuid uuid;
  installed_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  for catalog_item in
    select catalog.*
    from public.mike_workflows catalog
    where catalog.active
      and catalog.distribution = 'default'
    order by catalog.default_sort_order nulls last, catalog.workflow_key
  loop
    if exists (
      select 1
      from public.default_workflow_installations installation
      where installation.user_id::text = p_user_id
        and installation.default_key = catalog_item.workflow_key
    ) then
      continue;
    end if;

    insert into public.workflows (
      user_id, title, type, prompt_md, columns_config,
      language, practice, jurisdictions
    ) values (
      p_user_id::uuid,
      catalog_item.title,
      catalog_item.type,
      catalog_item.prompt_md,
      catalog_item.columns_config,
      coalesce(nullif(catalog_item.language, ''), 'English'),
      coalesce(nullif(catalog_item.practice, ''), 'General Transactions'),
      coalesce(catalog_item.jurisdictions, array['General']::text[])
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id, default_key, workflow_id
    ) values (
      p_user_id::uuid, catalog_item.workflow_key, workflow_uuid
    );

    if catalog_item.type = 'assistant'
       and catalog_item.quick_action_name is not null then
      insert into public.quick_actions (
        user_id, workflow_id, name, prompt, document_upload,
        enabled, sort_order, surface
      ) values (
        p_user_id::uuid,
        workflow_uuid,
        catalog_item.quick_action_name,
        coalesce(catalog_item.quick_action_prompt, ''),
        catalog_item.document_upload,
        true,
        coalesce(catalog_item.default_sort_order, installed_count),
        'app'
      );

      if catalog_item.word_quick_action then
        insert into public.quick_actions (
          user_id, workflow_id, name, prompt, document_upload,
          enabled, sort_order, surface
        ) values (
          p_user_id::uuid,
          workflow_uuid,
          catalog_item.quick_action_name,
          coalesce(
            catalog_item.word_quick_action_prompt,
            'Execute this workflow on this Word document.'
          ),
          false,
          true,
          coalesce(catalog_item.default_sort_order, installed_count),
          'word'
        );
      end if;
    end if;

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;

-- Deprecated rollback-only overload used by backend releases that predate
-- mike_workflows. New code calls the one-argument function above.
create or replace function public.install_missing_default_workflows(
  p_user_id text,
  p_defaults jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  workflow_uuid uuid;
  installed_count integer := 0;
  jurisdiction_values text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  for item in select value from jsonb_array_elements(coalesce(p_defaults, '[]'::jsonb))
  loop
    if nullif(trim(item->>'default_key'), '') is null then
      continue;
    end if;

    if exists (
      select 1
      from public.default_workflow_installations dwi
      where dwi.user_id::text = p_user_id
        and dwi.default_key = item->>'default_key'
    ) then
      continue;
    end if;

    select coalesce(array_agg(value), array['General']::text[])
      into jurisdiction_values
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(item->'jurisdictions') = 'array'
          then item->'jurisdictions'
        else '["General"]'::jsonb
      end
    );

    insert into public.workflows (
      user_id,
      title,
      type,
      prompt_md,
      columns_config,
      language,
      practice,
      jurisdictions
    ) values (
      p_user_id::uuid,
      item->>'title',
      item->>'type',
      nullif(item->>'prompt_md', ''),
      case
        when jsonb_typeof(item->'columns_config') = 'array'
          then item->'columns_config'
        else null
      end,
      coalesce(nullif(item->>'language', ''), 'English'),
      coalesce(nullif(item->>'practice', ''), 'General Transactions'),
      jurisdiction_values
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id,
      default_key,
      workflow_id
    ) values (
      p_user_id::uuid,
      item->>'default_key',
      workflow_uuid
    );

    if item->>'type' = 'assistant' then
      insert into public.quick_actions (
        user_id,
        workflow_id,
        name,
        prompt,
        document_upload,
        enabled,
        sort_order,
        surface
      ) values (
        p_user_id::uuid,
        workflow_uuid,
        coalesce(nullif(trim(item->>'quick_action_name'), ''), item->>'title'),
        coalesce(item->>'quick_action_prompt', ''),
        coalesce((item->>'document_upload')::boolean, false),
        true,
        coalesce((item->>'sort_order')::integer, installed_count),
        'app'
      );

      if coalesce((item->>'word_quick_action')::boolean, false) then
        insert into public.quick_actions (
          user_id,
          workflow_id,
          name,
          prompt,
          document_upload,
          enabled,
          sort_order,
          surface
        ) values (
          p_user_id::uuid,
          workflow_uuid,
          coalesce(nullif(trim(item->>'quick_action_name'), ''), item->>'title'),
          coalesce(
            item->>'word_quick_action_prompt',
            'Execute this workflow on this Word document.'
          ),
          false,
          true,
          coalesce((item->>'sort_order')::integer, installed_count),
          'word'
        );
      end if;
    end if;

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;

-- Review queue for user-submitted workflows that may later be published to the
-- open-source workflow repository. The backend writes with the service role.
create table if not exists public.workflow_open_source_submissions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  submitted_by_user_id uuid not null references auth.users(id) on delete cascade,
  submitter_email text,
  submitter_name text,
  contributor_mode text not null default 'anonymous',
  status text not null default 'pending',
  snapshot jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_notes text,
  constraint workflow_open_source_submissions_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint workflow_open_source_submissions_contributor_mode_check
    check (contributor_mode in ('named', 'anonymous'))
);

create unique index if not exists idx_workflow_open_source_submissions_pending
  on public.workflow_open_source_submissions(workflow_id, submitted_by_user_id)
  where status = 'pending';

create index if not exists idx_workflow_open_source_submissions_reviewer_queue
  on public.workflow_open_source_submissions(status, submitted_at desc);

create index if not exists idx_workflow_open_source_submissions_submitter
  on public.workflow_open_source_submissions(submitted_by_user_id, submitted_at desc);

alter table public.workflow_open_source_submissions enable row level security;

create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text default null,
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
  is_owner boolean,
  shared_by_name text
)
language sql
stable
as $$
  with owned as (
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
      true as is_owner,
      null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
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
      ws.allow_edit,
      false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
  )
  select
    vw.id,
    vw.user_id,
    vw.title,
    vw.type,
    vw.prompt_md,
    vw.columns_config,
    vw.language,
    vw.practice,
    vw.jurisdictions,
    vw.is_system,
    vw.created_at,
    vw.allow_edit,
    vw.is_owner,
    vw.shared_by_name
  from visible_workflows vw
  order by vw.sort_bucket asc, vw.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  model_provider text,
  model text,
  credential_ref text,
  reasoning_level text check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  created_at timestamptz not null default now(),
  constraint chats_model_route_consistent check (
    (model_provider is null and model is null and credential_ref is null)
    or (model_provider is not null and model is not null and credential_ref is not null)
  )
);

create index if not exists idx_chats_user
  on public.chats(user_id);

create index if not exists chats_user_created_idx
  on public.chats(user_id, created_at desc, id);

create index if not exists idx_chats_project
  on public.chats(project_id);

create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  model text,
  created_at timestamptz,
  project_name text
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.model,
    c.created_at,
    p.name as project_name
  from public.chats c
  left join public.projects p on p.id = c.project_id
  where c.user_id::text = p_user_id
     or (
       p.id is not null
       and p.user_id::text = p_user_id
     )
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
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

-- ---------------------------------------------------------------------------
-- Word add-in chats
-- ---------------------------------------------------------------------------
-- These conversations are document-scoped and deliberately separate from the
-- web assistant's chats/chat_messages history.

create table if not exists public.word_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_document_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_document_id)
);

create index if not exists idx_word_documents_user_updated
  on public.word_documents(user_id, updated_at desc);

create table if not exists public.word_chats (
  id uuid primary key default gen_random_uuid(),
  word_document_id uuid not null
    references public.word_documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  model text,
  reasoning_level text check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_word_chats_document_updated
  on public.word_chats(word_document_id, updated_at desc);

create index if not exists idx_word_chats_user
  on public.word_chats(user_id);

create table if not exists public.word_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.word_chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb,
  files jsonb,
  workflow jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_word_chat_messages_chat_created
  on public.word_chat_messages(chat_id, created_at);

create table if not exists public.word_document_edits (
  id uuid primary key default gen_random_uuid(),
  word_chat_message_id uuid not null
    references public.word_chat_messages(id) on delete cascade,
  block_index integer not null check (block_index >= 0),
  original_text text not null check (length(original_text) > 0),
  replacement_text text not null default '',
  formats text[] not null default '{}',
  occurrence text check (occurrence is null or occurrence = 'all'),
  reason text,
  apply_mode text not null
    check (apply_mode in ('direct', 'approval')),
  apply_status text not null default 'proposed'
    check (apply_status in ('proposed', 'applied', 'unmanaged', 'failed')),
  resolution_status text
    check (resolution_status is null or resolution_status in ('accepted', 'rejected')),
  matched_occurrences integer check (matched_occurrences is null or matched_occurrences >= 0),
  applied_occurrences integer check (applied_occurrences is null or applied_occurrences >= 0),
  error_code text,
  error_message text,
  applied_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (word_chat_message_id, block_index),
  constraint word_document_edits_resolution_requires_application
    check (resolution_status is null or apply_status = 'applied')
);

create index if not exists word_document_edits_message_idx
  on public.word_document_edits(word_chat_message_id, block_index);

create index if not exists word_document_edits_unresolved_idx
  on public.word_document_edits(word_chat_message_id)
  where apply_status = 'applied' and resolution_status is null;

alter table public.word_documents enable row level security;
alter table public.word_chats enable row level security;
alter table public.word_chat_messages enable row level security;
alter table public.word_document_edits enable row level security;

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
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  model text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  practice text,
  document_grouping text not null default 'document' check (document_grouping in ('document', 'folder')),
  shared_with jsonb not null default '[]'::jsonb,
  active_generation_id uuid,
  generation_lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user
  on public.tabular_reviews(user_id);

create index if not exists idx_tabular_reviews_project
  on public.tabular_reviews(project_id);

create index if not exists tabular_reviews_shared_with_idx
  on public.tabular_reviews using gin (shared_with);

create index if not exists tabular_reviews_title_trgm_idx
  on public.tabular_reviews using gin (lower(title) gin_trgm_ops);

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text default null
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
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
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id::text <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
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
    vp.user_id::text as user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    vp.created_at,
    vp.updated_at,
    vp.user_id::text = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
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
  generation_id uuid,
  created_at timestamptz not null default now()
);

create or replace function public.begin_tabular_review_generation(
  target_review_id uuid,
  expected_updated_at timestamptz,
  target_generation_id uuid,
  lease_seconds integer default 300
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_review public.tabular_reviews%rowtype;
begin
  select *
    into current_review
    from public.tabular_reviews
   where id = target_review_id
   for update;

  if not found then
    return 'not_found';
  end if;

  if current_review.active_generation_id is not null
     and current_review.generation_lease_expires_at > now() then
    return 'running';
  end if;

  if current_review.updated_at is distinct from expected_updated_at then
    return 'stale';
  end if;

  update public.tabular_reviews
     set active_generation_id = target_generation_id,
         generation_lease_expires_at = now()
           + make_interval(secs => greatest(60, least(lease_seconds, 3600)))
   where id = target_review_id;

  return 'started';
end;
$$;

create or replace function public.renew_tabular_review_generation(
  target_review_id uuid,
  target_generation_id uuid,
  lease_seconds integer default 300
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tabular_reviews
     set generation_lease_expires_at = now()
       + make_interval(secs => greatest(60, least(lease_seconds, 3600)))
   where id = target_review_id
     and active_generation_id = target_generation_id
  returning true;
$$;

create or replace function public.finish_tabular_review_generation(
  target_review_id uuid,
  target_generation_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tabular_reviews
     set active_generation_id = null,
         generation_lease_expires_at = null
   where id = target_review_id
     and active_generation_id = target_generation_id
  returning true;
$$;

create index if not exists idx_tabular_cells_review
  on public.tabular_cells(review_id, document_id, column_index);

create index if not exists idx_tabular_cells_review_row
  on public.tabular_cells(review_id, row_id, column_index);

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text,
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
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  document_count integer
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id::text <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
  ),
  visible_reviews as (
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
      and (
        p_project_id is null
        or exists (
          select 1
          from accessible_projects ap
          where ap.id::text = p_project_id
        )
      )
      and (
        tr.user_id::text = p_user_id
        or (
          tr.project_id in (select ap.id from accessible_projects ap)
          and tr.user_id::text <> p_user_id
        )
        or (
          p_project_id is null
          and coalesce(p_user_email, '') <> ''
          and tr.user_id::text <> p_user_id
          and tr.shared_with @> jsonb_build_array(p_user_email)
        )
      )
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
    vr.user_id::text as user_id,
    vr.title,
    vr.columns_config,
    vr.document_ids,
    vr.workflow_id,
    vr.shared_with,
    vr.created_at,
    vr.updated_at,
    vr.user_id::text = p_user_id as is_owner,
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
  p_user_email text default null,
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
  shared_with jsonb,
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
    p_user_email,
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
  p_user_email text,
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
  with accessible_projects as (
    select p.id
    from public.projects p
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id::text <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
  )
  select tr.id, tr.user_id::text as user_id
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
    and (
      p_project_id is null
      or exists (
        select 1
        from accessible_projects ap
        where ap.id::text = p_project_id
      )
    )
    and (
      tr.user_id::text = p_user_id
      or (
        tr.project_id in (select ap.id from accessible_projects ap)
        and tr.user_id::text <> p_user_id
      )
      or (
        p_project_id is null
        and coalesce(p_user_email, '') <> ''
        and tr.user_id::text <> p_user_id
        and tr.shared_with @> jsonb_build_array(p_user_email)
      )
    )
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create table if not exists public.tabular_review_chats (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  model text,
  reasoning_level text check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
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
-- Library search and lightweight overview facets
-- ---------------------------------------------------------------------------

create or replace function public.search_library_documents(
  p_user_id text,
  p_library_kind text,
  p_limit integer,
  p_offset integer,
  p_search_term text default null,
  p_file_type text default null,
  p_sort_key text default 'updated',
  p_sort_direction text default 'desc'
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  status text,
  folder_id uuid,
  library_kind text,
  library_folder_id uuid,
  current_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  file_type text,
  storage_path text,
  pdf_storage_path text,
  size_bytes integer,
  page_count integer,
  active_version_number integer
)
language sql
stable
as $$
  select
    d.id,
    d.project_id,
    d.user_id::text as user_id,
    d.status,
    d.folder_id,
    d.library_kind,
    d.library_folder_id,
    d.current_version_id,
    d.created_at,
    d.updated_at,
    coalesce(nullif(trim(v.filename), ''), 'Untitled document') as filename,
    v.file_type,
    v.storage_path,
    v.pdf_storage_path,
    v.size_bytes,
    v.page_count,
    v.version_number as active_version_number
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(v.filename, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(v.filename, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then lower(coalesce(v.file_type, '')) else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then lower(coalesce(v.file_type, '')) else null end desc,
    case when p_sort_key = 'size' and p_sort_direction = 'asc' then coalesce(v.size_bytes, 0) else null end asc,
    case when p_sort_key = 'size' and p_sort_direction = 'desc' then coalesce(v.size_bytes, 0) else null end desc,
    case when p_sort_key = 'version' and p_sort_direction = 'asc' then coalesce(v.version_number, 0) else null end asc,
    case when p_sort_key = 'version' and p_sort_direction = 'desc' then coalesce(v.version_number, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then d.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then d.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then d.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then d.updated_at else null end desc,
    d.updated_at desc,
    d.id asc
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_library_filter_options(
  p_user_id text,
  p_library_kind text
)
returns table (file_types text[])
language sql
stable
as $$
  select coalesce(
    array_agg(distinct lower(v.file_type) order by lower(v.file_type))
      filter (where nullif(trim(v.file_type), '') is not null),
    array[]::text[]
  ) as file_types
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    );
$$;

create or replace function public.get_project_filter_options(
  p_user_id text,
  p_user_email text default null
)
returns table (practices text[], owners jsonb)
language sql
stable
as $$
  with visible_projects as (
    select p.user_id, nullif(trim(p.practice), '') as practice
    from public.projects p
    where p.user_id::text = p_user_id
       or (
         coalesce(p_user_email, '') <> ''
         and p.user_id::text <> p_user_id
         and p.shared_with @> jsonb_build_array(p_user_email)
       )
  ),
  distinct_owners as (
    select distinct vp.user_id
    from visible_projects vp
  ),
  owner_options as (
    select
      o.user_id,
      case
        when o.user_id::text = p_user_id then 'Me'
        else coalesce(
          nullif(trim(up.display_name), ''),
          nullif(trim(up.email), ''),
          'Shared'
        )
      end as label
    from distinct_owners o
    left join public.user_profiles up
      on up.user_id::text = o.user_id::text
  )
  select
    coalesce(
      (select array_agg(distinct practice order by practice)
       from visible_projects
       where practice is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      (select jsonb_agg(
          jsonb_build_object('value', user_id, 'label', label)
          order by label, user_id
       ) from owner_options),
      '[]'::jsonb
    ) as owners;
$$;

create or replace function public.get_workflow_filter_options(
  p_user_id text,
  p_user_email text default null,
  p_type text default null,
  p_scope text default 'all'
)
returns table (
  practices text[],
  languages text[],
  jurisdictions text[]
)
language sql
stable
as $$
  with owned as (
    select w.practice, w.language, w.jurisdictions, 'owned'::text as source
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select w.practice, w.language, w.jurisdictions, 'shared'::text as source
    from public.workflow_shares ws
    join public.workflows w on w.id = ws.workflow_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  visible as (
    select * from owned
    union all
    select * from shared
  ),
  scoped as (
    select * from visible
    where coalesce(p_scope, 'all') = 'all' or source = p_scope
  )
  select
    coalesce(
      array_agg(distinct nullif(trim(practice), '') order by nullif(trim(practice), ''))
        filter (where nullif(trim(practice), '') is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      array_agg(distinct nullif(trim(language), '') order by nullif(trim(language), ''))
        filter (where nullif(trim(language), '') is not null),
      array[]::text[]
    ) as languages,
    coalesce(
      (select array_agg(distinct jurisdiction order by jurisdiction)
       from scoped s
       cross join lateral unnest(coalesce(s.jurisdictions, array[]::text[])) jurisdiction
       where nullif(trim(jurisdiction), '') is not null),
      array[]::text[]
    ) as jurisdictions
  from scoped;
$$;

create index if not exists document_versions_filename_trgm_idx
  on public.document_versions using gin (lower(filename) gin_trgm_ops)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Paginated project/workflow overviews and collection summary helpers
-- ---------------------------------------------------------------------------

-- Server-side pagination for the Projects overview page (/projects) and the
-- Workflows list page (/workflows), added the same day and combined into one
-- migration. Both mirror the pattern already built for Tabular Reviews in
-- 20260726_01_tabular_reviews_pagination.sql /
-- 20260727_01_tabular_review_ids_overview.sql.

-- ============================================================================
-- Projects overview pagination
-- ============================================================================
--   * a trigram index so leading-wildcard search can use an index scan
--   * a new, higher-arity overload of get_projects_overview that adds
--     scope/search/practice/owner filters, server-side sort, and limit/offset
--   * the existing 2-arg get_projects_overview (from 20260703_02_project_practice.sql)
--     is left completely untouched as the back-compat path for every caller
--     that doesn't ask for pagination (document-picker directory view and
--     tabular-review project pickers) — see backend/src/routes/projects.ts
--     for the routing logic that decides which overload to call.
--   * a lightweight get_project_ids_overview companion for "select all
--     matching" bulk actions.

create extension if not exists pg_trgm;

create index if not exists projects_name_trgm_idx
  on public.projects using gin (lower(name) gin_trgm_ops);

create index if not exists projects_updated_at_idx
  on public.projects(updated_at desc, id);

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_owner_user_id text
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
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
    where (
        p.user_id::text = p_user_id
        or (
          coalesce(p_user_email, '') <> ''
          and p.user_id::text <> p_user_id
          and p.shared_with @> jsonb_build_array(p_user_email)
        )
      )
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id::text = p_user_id)
        or (p_scope = 'shared' and p.user_id::text <> p_user_id)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(coalesce(p.name, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.cm_number, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.practice, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
      )
      and (p_practice is null or p.practice = p_practice)
      and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
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
    vp.user_id::text as user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    vp.created_at,
    vp.updated_at,
    vp.user_id::text = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then coalesce(dc.document_count, 0) else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then coalesce(dc.document_count, 0) else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then coalesce(cc.chat_count, 0) else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then coalesce(cc.chat_count, 0) else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then coalesce(rc.review_count, 0) else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then coalesce(rc.review_count, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight companion for bulk "select all matching" actions — id + owning
-- user only, no count joins. Duplicates visible_projects' predicate rather
-- than delegating to get_projects_overview (same rationale as
-- get_tabular_review_ids_overview: the count CTEs there would be pure waste
-- for a caller that only wants ids). Keep this predicate in sync by hand if
-- visible_projects above ever changes.
--
-- Paginated (not "return everything") because PostgREST enforces its own
-- row cap on every RPC response and truncates silently rather than erroring;
-- backend/src/routes/projects.ts pages through this on the caller's behalf.
create or replace function public.get_project_ids_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_owner_user_id text,
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
  select p.id, p.user_id::text as user_id
  from public.projects p
  where (
      p.user_id::text = p_user_id
      or (
        coalesce(p_user_email, '') <> ''
        and p.user_id::text <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
    )
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'mine' and p.user_id::text = p_user_id)
      or (p_scope = 'shared' and p.user_id::text <> p_user_id)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(p.name, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.cm_number, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.practice, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or p.practice = p_practice)
    and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  order by p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ============================================================================
-- Workflows overview pagination
-- ============================================================================
-- Mirrors the Projects pagination above. Catalog workflows live in the shared
-- mike_workflows table and have no user-data growth. They are deliberately
-- NOT part of this RPC. This migration only
-- paginates the one part of /workflows with real growth: a user's owned +
-- shared workflows, currently served by the 3-arg get_workflows_overview
-- defined in 20260625_01_workflow_metadata.sql, which is left completely
-- untouched — every other caller of GET /workflows (the workflow picker
-- modal, the chat slash-menu picker) keeps hitting that exact unpaginated
-- path, since the route only takes the new paginated branch when a
-- pagination-related query param is present.

create index if not exists workflows_title_trgm_idx
  on public.workflows using gin (lower(title) gin_trgm_ops);

create index if not exists workflows_jurisdictions_gin_idx
  on public.workflows using gin (jurisdictions);

-- p_scope here is 'all' | 'owned' | 'shared' — deliberately different
-- vocabulary from Projects' 'mine'/'shared', since this RPC (unlike
-- Projects' single source of truth) never includes system workflows at all;
-- keeping the words distinct avoids conflating this RPC-level scope with the
-- UI's separate "source" filter (system/user/shared), which does include
-- system rows client-side.
create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_language text,
  p_jurisdiction text
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
  is_owner boolean,
  shared_by_name text
)
language sql
stable
as $$
  with owned as (
    select
      w.id, w.user_id::text as user_id, w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      true as allow_edit, true as is_owner, null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id, w.user_id::text as user_id, w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      ws.allow_edit, false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
  )
  select
    vw.id, vw.user_id, vw.title, vw.type, vw.prompt_md, vw.columns_config,
    vw.language, vw.practice, vw.jurisdictions, vw.is_system, vw.created_at,
    vw.allow_edit, vw.is_owner, vw.shared_by_name
  from visible_workflows vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.sort_bucket = 0)
      or (p_scope = 'shared' and vw.sort_bucket = 1)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vw.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vw.title, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then vw.type else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then vw.type else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vw.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vw.created_at else null end desc,
    vw.sort_bucket asc,
    vw.created_at desc,
    vw.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight companion for bulk "select all matching" actions (owned
-- workflows only — see the route/hook layer; shared workflows are excluded
-- from bulk-delete eligibility since only the owner can delete, and system
-- workflows never need this since all 37 are always already in memory).
-- Duplicates the owned predicate directly rather than delegating to
-- get_workflows_overview, same rationale as get_project_ids_overview: no
-- need for the shared-by-name join when the caller only wants ids.
create or replace function public.get_workflow_ids_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_language text,
  p_jurisdiction text,
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
  with owned as (
    select w.id, w.user_id::text as user_id, w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select w.id, w.user_id::text as user_id, w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
  )
  select vw.id, vw.user_id
  from visible_workflows vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.sort_bucket = 0)
      or (p_scope = 'shared' and vw.sort_bucket = 1)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by vw.sort_bucket asc, vw.created_at desc, vw.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight sidebar project feed. The Projects overview RPC intentionally
-- computes file/chat/review counts for table sorting; the sidebar needs none
-- of those aggregates.
create or replace function public.get_project_summaries(
  p_user_id text,
  p_user_email text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean
)
language sql
stable
as $$
  select
    p.id,
    p.user_id::text as user_id,
    p.name,
    p.created_at,
    p.updated_at,
    p.user_id::text = p_user_id as is_owner
  from public.projects p
  where p.user_id::text = p_user_id
     or (
       coalesce(p_user_email, '') <> ''
       and p.user_id::text <> p_user_id
       and p.shared_with @> jsonb_build_array(p_user_email)
     )
  order by p.updated_at desc, p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 11), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ID-only Library query for select-all and bulk actions. This mirrors the
-- flat Library search predicate without returning document/version payloads.
create or replace function public.get_library_document_ids(
  p_user_id text,
  p_library_kind text,
  p_search_term text,
  p_file_type text,
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
  select d.id, d.user_id::text as user_id
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by d.updated_at desc, d.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Resolve uploaded folder paths against the complete server-side hierarchy.
-- Advisory transaction locks serialize path creation within one project or
-- one user library so two concurrent folder uploads cannot create the same
-- path. Existing top-level folders are reported to the caller before any
-- mutation so the UI can ask whether to delete and replace them or create a
-- suffixed copy. The `reuse` mode is reserved for nested segments after that
-- top-level choice has already been made.

create or replace function public.resolve_project_folder_path(
  target_project_id uuid,
  target_user_id uuid,
  base_folder_id uuid,
  path_segments text[],
  conflict_resolution text default 'error'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_parent_id uuid := base_folder_id;
  folder_row public.project_subfolders%rowtype;
  resolved_folders jsonb := '[]'::jsonb;
  segment text;
  resolved_name text;
  first_resolved_name text;
  candidate_name text;
  suffix integer;
  segment_index integer;
begin
  if conflict_resolution not in ('error', 'reuse', 'rename') then
    raise exception 'Invalid folder conflict resolution';
  end if;
  if coalesce(array_length(path_segments, 1), 0) = 0
     or array_length(path_segments, 1) > 100 then
    raise exception 'Folder path must contain between 1 and 100 segments';
  end if;
  if base_folder_id is not null and not exists (
    select 1 from public.project_subfolders
    where id = base_folder_id and project_id = target_project_id
  ) then
    raise exception 'Parent folder not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project-folder-path:' || target_project_id::text, 0)
  );

  for segment_index in 1..array_length(path_segments, 1) loop
    segment := btrim(path_segments[segment_index]);
    if segment = '' or length(segment) > 255 then
      raise exception 'Folder names must contain between 1 and 255 characters';
    end if;
    resolved_name := segment;

    select * into folder_row
    from public.project_subfolders
    where project_id = target_project_id
      and parent_folder_id is not distinct from current_parent_id
      and lower(btrim(name)) = lower(segment)
    order by created_at, id
    limit 1;

    if folder_row.id is not null and segment_index = 1 then
      suffix := 2;
      loop
        candidate_name := segment || ' (' || suffix || ')';
        exit when not exists (
          select 1 from public.project_subfolders
          where project_id = target_project_id
            and parent_folder_id is not distinct from current_parent_id
            and lower(btrim(name)) = lower(candidate_name)
        );
        suffix := suffix + 1;
      end loop;

      if conflict_resolution = 'error' then
        return jsonb_build_object(
          'conflict', true,
          'folder_name', folder_row.name,
          'existing_folder_id', folder_row.id,
          'suggested_name', candidate_name
        );
      elsif conflict_resolution = 'rename' then
        folder_row := null;
        resolved_name := candidate_name;
      end if;
    end if;

    if folder_row.id is null then
      insert into public.project_subfolders (
        project_id, user_id, name, parent_folder_id
      ) values (
        target_project_id, target_user_id, resolved_name, current_parent_id
      ) returning * into folder_row;
    end if;

    if segment_index = 1 then
      first_resolved_name := folder_row.name;
    end if;
    current_parent_id := folder_row.id;
    resolved_folders := resolved_folders || jsonb_build_array(to_jsonb(folder_row));
    folder_row := null;
  end loop;

  return jsonb_build_object(
    'conflict', false,
    'folder_id', current_parent_id,
    'resolved_name', first_resolved_name,
    'folders', resolved_folders
  );
end;
$$;

create or replace function public.resolve_library_folder_path(
  target_user_id uuid,
  target_library_kind text,
  base_folder_id uuid,
  path_segments text[],
  conflict_resolution text default 'error'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_parent_id uuid := base_folder_id;
  folder_row public.library_folders%rowtype;
  resolved_folders jsonb := '[]'::jsonb;
  segment text;
  resolved_name text;
  first_resolved_name text;
  candidate_name text;
  suffix integer;
  segment_index integer;
begin
  if target_library_kind not in ('file', 'template') then
    raise exception 'Invalid library kind';
  end if;
  if conflict_resolution not in ('error', 'reuse', 'rename') then
    raise exception 'Invalid folder conflict resolution';
  end if;
  if coalesce(array_length(path_segments, 1), 0) = 0
     or array_length(path_segments, 1) > 100 then
    raise exception 'Folder path must contain between 1 and 100 segments';
  end if;
  if base_folder_id is not null and not exists (
    select 1 from public.library_folders
    where id = base_folder_id
      and user_id = target_user_id
      and library_kind = target_library_kind
  ) then
    raise exception 'Parent folder not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'library-folder-path:' || target_user_id::text || ':' || target_library_kind,
      0
    )
  );

  for segment_index in 1..array_length(path_segments, 1) loop
    segment := btrim(path_segments[segment_index]);
    if segment = '' or length(segment) > 255 then
      raise exception 'Folder names must contain between 1 and 255 characters';
    end if;
    resolved_name := segment;

    select * into folder_row
    from public.library_folders
    where user_id = target_user_id
      and library_kind = target_library_kind
      and parent_folder_id is not distinct from current_parent_id
      and lower(btrim(name)) = lower(segment)
    order by created_at, id
    limit 1;

    if folder_row.id is not null and segment_index = 1 then
      suffix := 2;
      loop
        candidate_name := segment || ' (' || suffix || ')';
        exit when not exists (
          select 1 from public.library_folders
          where user_id = target_user_id
            and library_kind = target_library_kind
            and parent_folder_id is not distinct from current_parent_id
            and lower(btrim(name)) = lower(candidate_name)
        );
        suffix := suffix + 1;
      end loop;

      if conflict_resolution = 'error' then
        return jsonb_build_object(
          'conflict', true,
          'folder_name', folder_row.name,
          'existing_folder_id', folder_row.id,
          'suggested_name', candidate_name
        );
      elsif conflict_resolution = 'rename' then
        folder_row := null;
        resolved_name := candidate_name;
      end if;
    end if;

    if folder_row.id is null then
      insert into public.library_folders (
        user_id, library_kind, name, parent_folder_id
      ) values (
        target_user_id, target_library_kind, resolved_name, current_parent_id
      ) returning * into folder_row;
    end if;

    if segment_index = 1 then
      first_resolved_name := folder_row.name;
    end if;
    current_parent_id := folder_row.id;
    resolved_folders := resolved_folders || jsonb_build_array(to_jsonb(folder_row));
    folder_row := null;
  end loop;

  return jsonb_build_object(
    'conflict', false,
    'folder_id', current_parent_id,
    'resolved_name', first_resolved_name,
    'folders', resolved_folders
  );
end;
$$;

revoke all on function public.resolve_project_folder_path(uuid, uuid, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.resolve_project_folder_path(uuid, uuid, uuid, text[], text)
  to service_role;

revoke all on function public.resolve_library_folder_path(uuid, text, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.resolve_library_folder_path(uuid, text, uuid, text[], text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Direct client grant hardening
-- ---------------------------------------------------------------------------
--
-- The frontend uses Supabase directly only for authentication. Application
-- data access goes through the backend API with the service role after the
-- backend verifies the user's JWT. Do not grant the browser anon/authenticated
-- roles direct table privileges for backend-owned data.

-- Audit history of user actions (queried via the service-role backend only).
-- Defined here — above the service_role grant block — so `grant ... on all
-- tables in schema public` below covers it on a fresh install. Like every other
-- backend-owned table, direct browser roles are revoked and RLS is enabled with
-- no policies (defense in depth; service_role bypasses RLS for the backend path).
create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  organization_id uuid,
  event_type text not null,
  event_detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Optional metadata for new upstream-style actions; legacy evidence is unchanged.
  user_email text,
  status text,
  title text,
  surface text,
  project_id uuid,
  chat_id uuid,
  document_id uuid,
  review_id uuid,
  model text
);
create index if not exists audit_events_org_created_idx on public.audit_events(organization_id, created_at desc);
create index if not exists audit_events_type_idx on public.audit_events(event_type);
alter table public.audit_events enable row level security;
create or replace function public.audit_events_insert_only()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is insert-only; UPDATE/DELETE are forbidden (W1.13)';
end;
$$;
drop trigger if exists audit_events_insert_only_trigger on public.audit_events;
create trigger audit_events_insert_only_trigger
  before update or delete on public.audit_events
  for each row execute function public.audit_events_insert_only();

revoke all on public.user_profiles from anon, authenticated;
revoke all on public.projects from anon, authenticated;
revoke all on public.project_subfolders from anon, authenticated;
revoke all on public.library_folders from anon, authenticated;
revoke all on public.documents from anon, authenticated;
revoke all on public.document_versions from anon, authenticated;
revoke all on public.document_edits from anon, authenticated;
revoke all on public.workflows from anon, authenticated;
revoke all on public.hidden_workflows from anon, authenticated;
revoke all on public.workflow_shares from anon, authenticated;
revoke all on public.workflow_open_source_submissions from anon, authenticated;
revoke all on public.mike_workflows from anon, authenticated;
revoke all on public.mike_workflow_reference_files from anon, authenticated;
revoke all on public.workflow_addons from anon, authenticated;
revoke all on public.workflow_addon_reference_files from anon, authenticated;
revoke all on public.chats from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
revoke all on public.word_documents from anon, authenticated;
revoke all on public.word_chats from anon, authenticated;
revoke all on public.word_chat_messages from anon, authenticated;
revoke all on public.word_document_edits from anon, authenticated;
revoke all on public.tabular_reviews from anon, authenticated;
revoke all on public.tabular_cells from anon, authenticated;
revoke all on public.tabular_review_rows from anon, authenticated;
revoke all on public.tabular_review_row_sources from anon, authenticated;
revoke all on public.tabular_review_chats from anon, authenticated;
revoke all on public.tabular_review_chat_messages from anon, authenticated;
revoke all on public.user_api_keys from anon, authenticated;
revoke all on public.auth_handoff_tickets from anon, authenticated;
revoke all on public.user_router_models from anon, authenticated;
revoke all on public.user_mcp_connectors from anon, authenticated;
revoke all on public.user_mcp_oauth_tokens from anon, authenticated;
revoke all on public.user_mcp_oauth_states from anon, authenticated;
revoke all on public.user_mcp_connector_tools from anon, authenticated;
revoke all on public.user_mcp_tool_audit_logs from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;
revoke all on function public.replace_mike_workflows(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.install_missing_default_workflows(text)
  from public, anon, authenticated;
revoke all on function public.install_missing_default_workflows(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.replace_user_router_models(uuid, text, text[])
  from public, anon, authenticated;
revoke all on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.renew_tabular_review_generation(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.finish_tabular_review_generation(uuid, uuid)
  from public, anon, authenticated;

grant select, insert, update, delete
  on public.default_workflow_installations,
     public.quick_actions,
     public.mike_workflows,
     public.workflow_addons,
     public.workflow_reference_documents,
     public.mike_workflow_reference_files,
     public.workflow_addon_reference_files
  to service_role;

grant execute
  on function public.replace_mike_workflows(text, jsonb)
  to service_role;
grant execute
  on function public.install_missing_default_workflows(text)
  to service_role;
grant execute
  on function public.install_missing_default_workflows(text, jsonb)
  to service_role;
grant execute
  on function public.replace_user_router_models(uuid, text, text[])
  to service_role;
grant execute
  on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  to service_role;
grant execute
  on function public.renew_tabular_review_generation(uuid, uuid, integer)
  to service_role;
grant execute
  on function public.finish_tabular_review_generation(uuid, uuid)
  to service_role;

-- Tables created by this file are owned by the database bootstrap role. The
-- backend connects as service_role, so grant it only the data privileges that
-- the direct browser roles above intentionally do not have. RLS is still
-- enabled as defense in depth; service_role bypasses it for the backend path.
--
-- NOTE: this grant targets `all tables in schema public`, so every table it
-- must cover has to already exist above this point. audit_events is therefore
-- defined *before* this block (not after it) — otherwise a fresh plain-Postgres
-- install would create the table with no service_role privileges and the
-- backend's inserts would fail permission-denied (silently, since recordAudit
-- swallows errors).
grant select, insert, update, delete
  on all tables in schema public
  to service_role;
grant usage, select
  on all sequences in schema public
  to service_role;

-- ---------------------------------------------------------------------------
-- Slice A2a recovery tenancy (executable LiTT model, baseline
-- d9fa8380e63837b6441cef169cf5ef80dfb55e54). Defined here — after the
-- service_role grant block above — with explicit per-table grants because the
-- `all tables in schema public` grant above only covers tables that already
-- exist at that point. Final tenancy shape is identical to applying
-- migrations/20260831_01_recovery_identity_tenancy.sql on the exact LiTT
-- baseline: membership status (active|inactive|revoked, default active),
-- matter visibility (public|private, default private), active-membership
-- gated RLS helpers/policies, SELECT-only browser access, backend-mediated
-- mutations via service_role, and one linearized organization epoch increment
-- per membership authorization mutation.
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
  status text not null default 'active' check (
    status in ('active', 'inactive', 'revoked')
  ),
  primary key (organization_id, user_id)
);

alter table public.organization_memberships enable row level security;

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
  status text not null default 'active' check (
    status in ('active', 'inactive', 'revoked')
  ),
  primary key (workspace_id, user_id)
);

alter table public.workspace_memberships enable row level security;

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
  drive_folder_id text constraint matters_drive_folder_id_check
    check (drive_folder_id is null or (drive_folder_id ~ '^[A-Za-z0-9_-]+$' and char_length(drive_folder_id) <= 256)),
  project_id uuid references public.projects(id) on delete set null,
  visibility text not null default 'private' check (
    visibility in ('public', 'private')
  )
);

alter table public.matters enable row level security;

create index if not exists matters_project_id_idx
  on public.matters(project_id)
  where project_id is not null;

create table if not exists public.matter_memberships (
  matter_id uuid not null references public.matters(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (
    role in ('matter_owner', 'editor', 'viewer', 'technical_operator')
  ),
  created_at timestamptz not null default now(),
  status text not null default 'active' check (
    status in ('active', 'inactive', 'revoked')
  ),
  primary key (matter_id, user_id)
);

alter table public.matter_memberships enable row level security;

-- Resolved onboarding contract: one initial organization and active owner membership,
-- no implicit workspace or matter, with one idempotent marker per user profile.
alter table public.user_profiles
  add column if not exists onboarding_organization_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_profiles_onboarding_organization_id_fkey'
      and conrelid = 'public.user_profiles'::regclass
  ) then
    alter table public.user_profiles
      add constraint user_profiles_onboarding_organization_id_fkey
      foreign key (onboarding_organization_id)
      references public.organizations(id)
      on delete restrict;
  end if;
end
$$;

create unique index if not exists user_profiles_onboarding_organization_unique
  on public.user_profiles(onboarding_organization_id)
  where onboarding_organization_id is not null;

create or replace function public.provision_initial_organization(
  p_user_id uuid,
  p_organization_name text
)
returns table (
  disposition text,
  organization_id uuid,
  organization_name text,
  membership_user_id uuid,
  membership_role text,
  membership_status text,
  authorization_epoch bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_organization_id uuid;
  created_organization_id uuid;
begin
  if p_user_id is null then
    raise exception 'invalid onboarding user' using errcode = '22023';
  end if;
  if p_organization_name is null
     or btrim(p_organization_name) = ''
     or char_length(p_organization_name) > 200 then
    raise exception 'invalid onboarding organization name' using errcode = '22023';
  end if;

  select profile.onboarding_organization_id
    into existing_organization_id
  from public.user_profiles as profile
  where profile.user_id = p_user_id
  for update;

  if not found then
    raise exception 'onboarding profile unavailable' using errcode = 'P0002';
  end if;

  if existing_organization_id is not null then
    return query
      select
        'reused'::text,
        organization.id,
        organization.name,
        membership.user_id,
        membership.role,
        membership.status,
        organization.authorization_epoch
      from public.organizations as organization
      join public.organization_memberships as membership
        on membership.organization_id = organization.id
       and membership.user_id = p_user_id
      where organization.id = existing_organization_id
        and organization.created_by = p_user_id
        and membership.role = 'org_owner'
        and membership.status = 'active';

    if not found then
      raise exception 'onboarding organization invariant unavailable'
        using errcode = 'P0002';
    end if;
    return;
  end if;

  insert into public.organizations (name, created_by)
  values (p_organization_name, p_user_id)
  returning id into created_organization_id;

  insert into public.organization_memberships (
    organization_id,
    user_id,
    role,
    status
  )
  values (
    created_organization_id,
    p_user_id,
    'org_owner',
    'active'
  );

  update public.user_profiles
  set onboarding_organization_id = created_organization_id,
      updated_at = now()
  where user_id = p_user_id;

  return query
    select
      'created'::text,
      organization.id,
      organization.name,
      membership.user_id,
      membership.role,
      membership.status,
      organization.authorization_epoch
    from public.organizations as organization
    join public.organization_memberships as membership
      on membership.organization_id = organization.id
     and membership.user_id = p_user_id
    where organization.id = created_organization_id;
end;
$$;

revoke all on function public.provision_initial_organization(uuid, text)
  from public, anon, authenticated;
grant execute on function public.provision_initial_organization(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. RLS helpers (SECURITY DEFINER, fixed search_path, scope-id-only
--    signatures, auth.uid() internally, active-membership gated).
--    Replaces the baseline helpers, which did not gate on status and did not
--    revoke PUBLIC execute.
-- ---------------------------------------------------------------------------

create or replace function public.organization_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.organization_memberships
  where organization_id = p_org
    and user_id = auth.uid()
    and status = 'active'
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
    where organization_id = p_org
      and user_id = auth.uid()
      and status = 'active'
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
    select 1
    from public.workspaces w
    join public.organization_memberships m
      on m.organization_id = w.organization_id
    where w.id = p_ws
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('org_owner', 'workspace_admin')
  );
$$;

create or replace function public.matters_select_visible(p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.matters m
    join public.workspaces w on w.id = m.workspace_id
    join public.organization_memberships om
      on om.organization_id = w.organization_id
     and om.user_id = auth.uid()
     and om.status = 'active'
    where m.id = p_matter
      and m.visibility = 'public'
  );
$$;

create or replace function public.matter_role(p_matter uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- Matter role requires an active explicit matter membership on top of an
  -- active organization membership, so organization revocation stays
  -- effective immediately even if a descendant matter_memberships row
  -- remains (LiTT invariant preserved, now status-gated).
  select mm.role
  from public.matter_memberships mm
  join public.matters m on m.id = mm.matter_id
  join public.workspaces w on w.id = m.workspace_id
  join public.organization_memberships om
    on om.organization_id = w.organization_id
   and om.user_id = auth.uid()
   and om.status = 'active'
  where mm.matter_id = p_matter
    and mm.user_id = auth.uid()
    and mm.status = 'active'
  limit 1;
$$;

revoke execute on function public.organization_role(uuid)
  from public, anon, authenticated;
revoke execute on function public.is_organization_member(uuid)
  from public, anon, authenticated;
revoke execute on function public.is_workspace_admin(uuid)
  from public, anon, authenticated;
revoke execute on function public.matter_role(uuid)
  from public, anon, authenticated;

revoke execute on function public.matters_select_visible(uuid)
  from public, anon, authenticated;

grant execute on function public.organization_role(uuid) to authenticated;
grant execute on function public.is_organization_member(uuid) to authenticated;
grant execute on function public.is_workspace_admin(uuid) to authenticated;
grant execute on function public.matter_role(uuid) to authenticated;
grant execute on function public.matters_select_visible(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'audit_events_organization_id_fkey'
      and conrelid = 'public.audit_events'::regclass
  ) then
    alter table public.audit_events
      add constraint audit_events_organization_id_fkey
      foreign key (organization_id) references public.organizations(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Policies: keep the six LiTT SELECT policies (active-membership gated),
--    drop every baseline browser DML policy. Zero DML policies are created:
--    browser roles hold no table grants for mutations, so mutations are
--    backend-mediated via service_role.
-- ---------------------------------------------------------------------------

drop policy if exists organizations_select_member on public.organizations;
create policy organizations_select_member
  on public.organizations for select
  using (public.is_organization_member(id));

drop policy if exists organizations_update_owner on public.organizations;
drop policy if exists org_memberships_select_member on public.organization_memberships;
create policy org_memberships_select_member
  on public.organization_memberships for select
  using (user_id = auth.uid() or public.organization_role(organization_id) = 'org_owner');

drop policy if exists org_memberships_insert_owner on public.organization_memberships;
drop policy if exists org_memberships_delete_owner on public.organization_memberships;
drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member
  on public.workspaces for select
  using (public.is_organization_member(organization_id));

drop policy if exists workspaces_update_member on public.workspaces;
drop policy if exists workspace_memberships_select_member on public.workspace_memberships;
create policy workspace_memberships_select_member
  on public.workspace_memberships for select
  using (
    user_id = auth.uid()
    or public.is_workspace_admin(workspace_id)
  );

drop policy if exists workspace_memberships_insert_admin on public.workspace_memberships;
drop policy if exists workspace_memberships_delete_admin on public.workspace_memberships;
drop policy if exists matters_select_member on public.matters;
create policy matters_select_member
  on public.matters for select
  using (
    public.matter_role(id) is not null
    or public.matters_select_visible(id)
  );

drop policy if exists matters_update_member on public.matters;
drop policy if exists matter_memberships_select_member on public.matter_memberships;
create policy matter_memberships_select_member
  on public.matter_memberships for select
  using (public.matter_role(matter_id) is not null);

drop policy if exists matter_memberships_insert_owner on public.matter_memberships;
drop policy if exists matter_memberships_delete_owner on public.matter_memberships;

-- ---------------------------------------------------------------------------
-- 4. Grants: browser roles keep SELECT only; anon keeps nothing;
--    service_role keeps the intended backend-mediated data operations
--    (no ALL/TRUNCATE/REFERENCES/TRIGGER).
-- ---------------------------------------------------------------------------

revoke all on public.organizations from anon;
revoke all on public.organization_memberships from anon;
revoke all on public.workspaces from anon;
revoke all on public.workspace_memberships from anon;
revoke all on public.matters from anon;
revoke all on public.matter_memberships from anon;

revoke all on public.organizations from authenticated;
revoke all on public.organization_memberships from authenticated;
revoke all on public.workspaces from authenticated;
revoke all on public.workspace_memberships from authenticated;
revoke all on public.matters from authenticated;
revoke all on public.matter_memberships from authenticated;

grant select on public.organizations to authenticated;
grant select on public.organization_memberships to authenticated;
grant select on public.workspaces to authenticated;
grant select on public.workspace_memberships to authenticated;
grant select on public.matters to authenticated;
grant select on public.matter_memberships to authenticated;

grant select, insert, update, delete on public.organizations to service_role;
grant select, insert, update, delete on public.organization_memberships to service_role;
grant select, insert, update, delete on public.workspaces to service_role;
grant select, insert, update, delete on public.workspace_memberships to service_role;
grant select, insert, update, delete on public.matters to service_role;
grant select, insert, update, delete on public.matter_memberships to service_role;

-- ---------------------------------------------------------------------------
-- 5. Authorization epoch: exactly one linearized increment per authorization
--    mutation. The single increment site is bump_authorization_epoch; three
--    row triggers (one per membership table) call it for the owning
--    organization. The baseline revoke_organization_membership RPC is
--    redefined WITHOUT its manual increment so the trigger is the only bump
--    (no double bump); service_role keeps the revocation path.
-- ---------------------------------------------------------------------------

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

create or replace function
public.bump_epoch_for_organization_membership_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if tg_op = 'UPDATE'
     and new.role is not distinct from old.role
     and new.status is not distinct from old.status then
    return null;
  end if;
  v_org := coalesce(new.organization_id, old.organization_id);
  perform public.bump_authorization_epoch(v_org);
  return null;
end;
$$;

create or replace function
public.bump_epoch_for_workspace_membership_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if tg_op = 'UPDATE'
     and new.role is not distinct from old.role
     and new.status is not distinct from old.status then
    return null;
  end if;
  select w.organization_id
    into v_org
  from public.workspaces w
  where w.id = coalesce(new.workspace_id, old.workspace_id);
  if v_org is null then
    return null;
  end if;
  perform public.bump_authorization_epoch(v_org);
  return null;
end;
$$;

create or replace function
public.bump_epoch_for_matter_membership_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if tg_op = 'UPDATE'
     and new.role is not distinct from old.role
     and new.status is not distinct from old.status then
    return null;
  end if;
  select w.organization_id
    into v_org
  from public.matters m
  join public.workspaces w on w.id = m.workspace_id
  where m.id = coalesce(new.matter_id, old.matter_id);
  if v_org is null then
    return null;
  end if;
  perform public.bump_authorization_epoch(v_org);
  return null;
end;
$$;

drop trigger if exists organization_memberships_epoch_bump
  on public.organization_memberships;
create trigger organization_memberships_epoch_bump
  after insert or update or delete on public.organization_memberships
  for each row execute function
    public.bump_epoch_for_organization_membership_mutation();

drop trigger if exists workspace_memberships_epoch_bump
  on public.workspace_memberships;
create trigger workspace_memberships_epoch_bump
  after insert or update or delete on public.workspace_memberships
  for each row execute function
    public.bump_epoch_for_workspace_membership_mutation();

drop trigger if exists matter_memberships_epoch_bump
  on public.matter_memberships;
create trigger matter_memberships_epoch_bump
  after insert or update or delete on public.matter_memberships
  for each row execute function
    public.bump_epoch_for_matter_membership_mutation();

revoke execute on function public.bump_authorization_epoch(uuid)
  from public, anon, authenticated;
grant execute on function public.bump_authorization_epoch(uuid)
  to service_role;
revoke execute on function
  public.bump_epoch_for_organization_membership_mutation()
  from public, anon, authenticated;
revoke execute on function
  public.bump_epoch_for_workspace_membership_mutation()
  from public, anon, authenticated;
revoke execute on function
  public.bump_epoch_for_matter_membership_mutation()
  from public, anon, authenticated;

create or replace function public.revoke_organization_membership(
  p_org uuid,
  p_user uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
    from public.organizations
   where id = p_org
   for update;
  if not found then
    raise exception 'Organization does not exist';
  end if;

  update public.organization_memberships
     set status = 'revoked'
   where organization_id = p_org
     and user_id = p_user
     and status <> 'revoked';
end;
$$;

revoke all on function public.revoke_organization_membership(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_organization_membership(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Recovery AI evidence/review persistence (E2a)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_document_version_pages (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  document_version_id uuid not null,
  page integer not null,
  content text not null,
  content_sha256 text not null,
  created_at timestamptz not null default now(),
  constraint ai_document_version_pages_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete restrict,
  constraint ai_document_version_pages_document_version_id_fkey
    foreign key (document_version_id) references public.document_versions(id) on delete restrict,
  constraint ai_document_version_pages_page_check check (page >= 1),
  constraint ai_document_version_pages_content_integrity_check check (
    content_sha256 ~ '^[0-9a-f]{64}$'
    and content_sha256 = encode(pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8')), 'hex')
  ),
  constraint ai_document_version_pages_version_page_key
    unique (document_version_id, page)
);

create table if not exists public.ai_executions (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  evidence_version text not null default 'evidence-v1',
  author_user_id uuid not null,
  organization_id uuid,
  matter_id uuid,
  project_id uuid not null,
  chat_id uuid,
  workflow_key text not null,
  workflow_version text not null,
  workflow_content_hash text not null,
  workflow_source_commit text,
  workflow_distribution text,
  workflow_type text,
  workflow_source text,
  workflow_approval_provenance text,
  output_hashes text[] not null,
  citation_hashes text[] not null,
  document_id uuid not null,
  document_version_id uuid not null,
  document_content_sha256 text not null,
  input_hashes text[] not null,
  route_provider text not null,
  route_model text not null,
  credential_ref text not null,
  status text not null default 'pending',
  error_class text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint ai_executions_idempotency_key_key unique (idempotency_key),
  constraint ai_executions_author_user_id_fkey
    foreign key (author_user_id) references auth.users(id) on delete restrict,
  constraint ai_executions_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  constraint ai_executions_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  constraint ai_executions_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  constraint ai_executions_chat_id_fkey
    foreign key (chat_id) references public.chats(id) on delete restrict,
  constraint ai_executions_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete restrict,
  constraint ai_executions_document_version_id_fkey
    foreign key (document_version_id) references public.document_versions(id) on delete restrict,
  constraint ai_executions_evidence_version_check check (
    evidence_version in ('legacy-beta-0.1', 'evidence-v1')
  ),
  constraint ai_executions_workflow_content_hash_check check (
    workflow_content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_executions_document_content_hash_check check (
    document_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_executions_input_hashes_check check (
    cardinality(input_hashes) >= 1 and array_position(input_hashes, null) is null
  ),
  constraint ai_executions_output_hashes_check check (
    array_position(output_hashes, null) is null
  ),
  constraint ai_executions_citation_hashes_check check (
    array_position(citation_hashes, null) is null
  ),
  constraint ai_executions_status_check check (
    status in ('pending', 'running', 'succeeded', 'failed')
  ),
  constraint ai_executions_current_shape_check check (
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
  )
);
create index if not exists ai_executions_author_created_idx
  on public.ai_executions(author_user_id, created_at desc);
create index if not exists ai_executions_project_created_idx
  on public.ai_executions(project_id, created_at desc);
create index if not exists ai_executions_document_version_idx
  on public.ai_executions(document_version_id);

create table if not exists public.ai_output_versions (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null,
  output_format text not null,
  output_text text not null,
  output_sha256 text not null,
  citation_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_output_versions_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  constraint ai_output_versions_execution_id_key unique (execution_id),
  constraint ai_output_versions_format_check check (output_format = 'markdown'),
  constraint ai_output_versions_hash_check check (
    output_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_output_versions_citations_check check (
    jsonb_typeof(citation_refs) = 'array'
  )
);

create table if not exists public.ai_receipts (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null,
  idempotency_key text not null,
  receipt_version text not null default 'evidence-v1',
  canonical_json text not null,
  receipt_sha256 text not null,
  created_at timestamptz not null default now(),
  constraint ai_receipts_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  constraint ai_receipts_execution_id_key unique (execution_id),
  constraint ai_receipts_idempotency_key_key unique (idempotency_key),
  constraint ai_receipts_version_check check (
    receipt_version in ('legacy-beta-0.1', 'evidence-v1')
  ),
  constraint ai_receipts_hash_check check (
    receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_receipts_current_integrity_check check (
    receipt_version = 'legacy-beta-0.1'
    or receipt_sha256 = encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_json, 'UTF8')), 'hex')
  )
);

create table if not exists public.ai_reviews (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null,
  idempotency_key text not null,
  revision integer not null default 1,
  execution_author_user_id uuid not null,
  reviewer_user_id uuid not null,
  organization_id uuid not null,
  matter_id uuid not null,
  project_id uuid not null,
  document_id uuid not null,
  document_version_id uuid not null,
  document_content_sha256 text not null,
  evidence_receipt_sha256 text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ai_reviews_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  constraint ai_reviews_execution_author_user_id_fkey
    foreign key (execution_author_user_id) references auth.users(id) on delete restrict,
  constraint ai_reviews_reviewer_user_id_fkey
    foreign key (reviewer_user_id) references auth.users(id) on delete restrict,
  constraint ai_reviews_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  constraint ai_reviews_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  constraint ai_reviews_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  constraint ai_reviews_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete restrict,
  constraint ai_reviews_document_version_id_fkey
    foreign key (document_version_id) references public.document_versions(id) on delete restrict,
  constraint ai_reviews_execution_id_key unique (execution_id),
  constraint ai_reviews_idempotency_key_key unique (idempotency_key),
  constraint ai_reviews_revision_check check (revision >= 1),
  constraint ai_reviews_status_check check (
    status in ('pending', 'approved', 'changes_requested')
  ),
  constraint ai_reviews_document_hash_check check (
    document_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_reviews_receipt_hash_check check (
    evidence_receipt_sha256 ~ '^[0-9a-f]{64}$'
  )
);
create index if not exists ai_reviews_matter_created_idx
  on public.ai_reviews(matter_id, created_at desc);
create index if not exists ai_reviews_reviewer_created_idx
  on public.ai_reviews(reviewer_user_id, created_at desc);

create table if not exists public.ai_review_items (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null,
  item_id text not null,
  item_key text not null,
  original_text text not null,
  finding_text text not null,
  citation_refs jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_review_items_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  constraint ai_review_items_review_item_key unique (review_id, item_id),
  constraint ai_review_items_review_key_key unique (review_id, item_key),
  constraint ai_review_items_id_check check (btrim(item_id) <> ''),
  constraint ai_review_items_citations_check check (
    jsonb_typeof(citation_refs) = 'array'
  ),
  constraint ai_review_items_status_check check (
    status in ('pending', 'accepted', 'rejected', 'edited')
  ),
  constraint ai_review_items_comment_check check (
    comment is null or char_length(comment) <= 2000
  )
);
create index if not exists ai_review_items_review_created_idx
  on public.ai_review_items(review_id, created_at);

create table if not exists public.ai_review_decisions (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null,
  review_item_id uuid,
  actor_user_id uuid not null,
  operation text not null,
  revision integer not null,
  idempotency_key text not null,
  decision text not null,
  before_state jsonb not null,
  after_state jsonb not null,
  comment text,
  created_at timestamptz not null default now(),
  constraint ai_review_decisions_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  constraint ai_review_decisions_review_item_id_fkey
    foreign key (review_item_id) references public.ai_review_items(id) on delete restrict,
  constraint ai_review_decisions_actor_user_id_fkey
    foreign key (actor_user_id) references auth.users(id) on delete restrict,
  constraint ai_review_decisions_review_idempotency_key
    unique (review_id, idempotency_key),
  constraint ai_review_decisions_operation_check check (
    operation in ('create', 'decide', 'complete')
  ),
  constraint ai_review_decisions_revision_check check (revision >= 1),
  constraint ai_review_decisions_value_check check (
    decision in (
      'pending', 'accepted', 'rejected', 'edited', 'approved', 'changes_requested'
    )
  ),
  constraint ai_review_decisions_scope_check check (
    (operation = 'create' and review_item_id is null and decision = 'pending' and revision = 1)
    or (operation = 'decide' and review_item_id is not null
      and decision in ('accepted', 'rejected', 'edited'))
    or (operation = 'complete' and review_item_id is null
      and decision in ('approved', 'changes_requested'))
  ),
  constraint ai_review_decisions_state_check check (
    jsonb_typeof(before_state) = 'object' and jsonb_typeof(after_state) = 'object'
  ),
  constraint ai_review_decisions_comment_check check (
    comment is null or char_length(comment) <= 2000
  )
);
create index if not exists ai_review_decisions_review_created_idx
  on public.ai_review_decisions(review_id, created_at);
create index if not exists ai_review_decisions_item_created_idx
  on public.ai_review_decisions(review_item_id, created_at);

create table if not exists public.ai_review_exports (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  review_id uuid not null,
  review_revision integer not null,
  execution_id uuid not null,
  organization_id uuid not null,
  matter_id uuid not null,
  project_id uuid not null,
  source_document_id uuid not null,
  source_document_version_id uuid not null,
  artifact_document_id uuid not null,
  artifact_document_version_id uuid not null,
  source_document_sha256 text not null,
  evidence_receipt_sha256 text not null,
  filename text not null,
  mime_type text not null,
  artifact_sha256 text not null,
  storage_path text,
  size_bytes integer,
  created_at timestamptz not null default now(),
  constraint ai_review_exports_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  constraint ai_review_exports_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  constraint ai_review_exports_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  constraint ai_review_exports_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  constraint ai_review_exports_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  constraint ai_review_exports_source_document_id_fkey
    foreign key (source_document_id) references public.documents(id) on delete restrict,
  constraint ai_review_exports_source_document_version_id_fkey
    foreign key (source_document_version_id) references public.document_versions(id) on delete restrict,
  constraint ai_review_exports_artifact_document_id_fkey
    foreign key (artifact_document_id) references public.documents(id) on delete restrict,
  constraint ai_review_exports_artifact_document_version_id_fkey
    foreign key (artifact_document_version_id) references public.document_versions(id) on delete restrict,
  constraint ai_review_exports_review_revision_key
    unique (review_id, review_revision),
  constraint ai_review_exports_artifact_version_key
    unique (artifact_document_version_id),
  constraint ai_review_exports_idempotency_key_key unique (idempotency_key),
  constraint ai_review_exports_review_revision_check check (review_revision >= 1),
  constraint ai_review_exports_filename_check check (
    filename = 'Informe de revision humana.docx'
  ),
  constraint ai_review_exports_mime_check check (
    mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ),
  constraint ai_review_exports_source_hash_check check (
    source_document_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_review_exports_receipt_hash_check check (
    evidence_receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_review_exports_artifact_hash_check check (
    artifact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_review_exports_storage_metadata_check check (
    (storage_path is null and size_bytes is null)
    or (storage_path is not null and size_bytes is not null)
  ),
  constraint ai_review_exports_size_check check (size_bytes is null or size_bytes > 0),
  constraint ai_review_exports_storage_path_check check (storage_path is null or storage_path <> '')
);
create index if not exists ai_review_exports_matter_created_idx
  on public.ai_review_exports(matter_id, created_at desc);

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
  legacy_payload jsonb not null default '{}'::jsonb,
  constraint ai_review_drive_publications_export_id_fkey
    foreign key (export_id) references public.ai_review_exports(id) on delete restrict,
  constraint ai_review_drive_publications_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  constraint ai_review_drive_publications_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  constraint ai_review_drive_publications_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  constraint ai_review_drive_publications_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  constraint ai_review_drive_publications_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  constraint ai_review_drive_publications_actor_user_id_fkey
    foreign key (actor_user_id) references auth.users(id) on delete restrict,
  constraint ai_review_drive_publications_export_id_key unique (export_id),
  constraint ai_review_drive_publications_idempotency_key_key unique (idempotency_key),
  constraint ai_review_drive_publications_revision_check check (revision >= 1),
  constraint ai_review_drive_publications_authorization_epoch_check
    check (authorization_epoch >= 0),
  constraint ai_review_drive_publications_destination_check
    check (btrim(drive_folder_id) <> ''),
  constraint ai_review_drive_publications_sha256_check
    check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_review_drive_publications_format_version_check
    check (btrim(format_version) <> ''),
  constraint ai_review_drive_publications_failure_code_check check (
    failure_code is null or failure_code in (
      'drive_upload_outcome_unknown',
      'drive_upload_failed',
      'drive_file_invalid',
      'authorization_revoked',
      'publication_record_failed',
      'drive_cleanup_failed'
    )
  ),
  constraint ai_review_drive_publications_state_check check (
    status in (
      'pending',
      'uploaded',
      'unknown_outcome',
      'reconciled',
      'failed'
    )
  ),
  constraint ai_review_drive_publications_metadata_check check (
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
  constraint ai_review_drive_publications_legacy_payload_check
    check (jsonb_typeof(legacy_payload) = 'object')
);
create index if not exists ai_review_drive_publications_matter_idx
  on public.ai_review_drive_publications(matter_id, created_at desc);
create index if not exists ai_review_drive_publications_review_idx
  on public.ai_review_drive_publications(review_id, created_at desc);
create index if not exists ai_review_drive_publications_organization_idx
  on public.ai_review_drive_publications(organization_id, created_at desc);

create table if not exists public.ai_redline_bundles (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  bundle_version text not null default 'approved-redline-v1',
  revision integer not null default 1,
  review_id uuid not null,
  review_revision integer not null,
  execution_id uuid not null,
  organization_id uuid not null,
  matter_id uuid not null,
  project_id uuid not null,
  document_id uuid not null,
  document_version_id uuid not null,
  source_document_sha256 text not null,
  evidence_receipt_version text not null,
  evidence_receipt_sha256 text not null,
  reviewer_user_id uuid not null,
  actions jsonb not null,
  canonical_json text not null,
  bundle_sha256 text not null,
  created_at timestamptz not null default now(),
  constraint ai_redline_bundles_review_id_fkey
    foreign key (review_id) references public.ai_reviews(id) on delete restrict,
  constraint ai_redline_bundles_execution_id_fkey
    foreign key (execution_id) references public.ai_executions(id) on delete restrict,
  constraint ai_redline_bundles_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  constraint ai_redline_bundles_matter_id_fkey
    foreign key (matter_id) references public.matters(id) on delete restrict,
  constraint ai_redline_bundles_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete restrict,
  constraint ai_redline_bundles_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete restrict,
  constraint ai_redline_bundles_document_version_id_fkey
    foreign key (document_version_id) references public.document_versions(id) on delete restrict,
  constraint ai_redline_bundles_reviewer_user_id_fkey
    foreign key (reviewer_user_id) references auth.users(id) on delete restrict,
  constraint ai_redline_bundles_review_revision_key
    unique (review_id, review_revision, revision),
  constraint ai_redline_bundles_idempotency_key_key unique (idempotency_key),
  constraint ai_redline_bundles_version_check check (
    bundle_version in ('legacy-beta-0.1', 'approved-redline-v1')
  ),
  constraint ai_redline_bundles_revision_check check (revision >= 1),
  constraint ai_redline_bundles_review_revision_check check (review_revision >= 1),
  constraint ai_redline_bundles_source_hash_check check (
    source_document_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_redline_bundles_receipt_version_check check (
    evidence_receipt_version in ('legacy-beta-0.1', 'evidence-v1')
  ),
  constraint ai_redline_bundles_receipt_hash_check check (
    evidence_receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_redline_bundles_actions_check check (
    jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) >= 1
  ),
  constraint ai_redline_bundles_canonical_json_check check (
    btrim(canonical_json) <> ''
  ),
  constraint ai_redline_bundles_hash_check check (
    bundle_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_redline_bundles_current_integrity_check check (
    bundle_version = 'legacy-beta-0.1'
    or (
      evidence_receipt_version = 'evidence-v1'
      and bundle_sha256 = encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_json, 'UTF8')), 'hex')
    )
  )
);
create index if not exists ai_redline_bundles_matter_created_idx
  on public.ai_redline_bundles(matter_id, created_at desc);

alter table public.ai_document_version_pages enable row level security;
alter table public.ai_executions enable row level security;
alter table public.ai_output_versions enable row level security;
alter table public.ai_receipts enable row level security;
alter table public.ai_reviews enable row level security;
alter table public.ai_review_items enable row level security;
alter table public.ai_review_decisions enable row level security;
alter table public.ai_review_exports enable row level security;
alter table public.ai_review_drive_publications enable row level security;
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
revoke all on public.ai_review_drive_publications from anon, authenticated, service_role;
revoke all on public.ai_redline_bundles from anon, authenticated, service_role;
grant select on public.ai_document_version_pages to service_role;
grant select on public.ai_executions to service_role;
grant select on public.ai_output_versions to service_role;
grant select on public.ai_receipts to service_role;
grant select on public.ai_reviews to service_role;
grant select on public.ai_review_items to service_role;
grant select on public.ai_review_decisions to service_role;
grant select on public.ai_review_exports to service_role;
grant select on public.ai_review_drive_publications to service_role;
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
drop policy if exists ai_review_drive_publications_service_select
  on public.ai_review_drive_publications;
create policy ai_review_drive_publications_service_select
  on public.ai_review_drive_publications
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
revoke all on function public.ai_review_drive_publications_insert_only()
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

-- Recovery target keeps RLS enabled on every application relation. Backend
-- mutations use service_role; browser roles retain no direct table privileges.
alter table public.user_profiles enable row level security;
alter table public.auth_handoff_tickets enable row level security;
alter table public.user_api_keys enable row level security;
alter table public.user_router_models enable row level security;
alter table public.projects enable row level security;
alter table public.project_subfolders enable row level security;
alter table public.library_folders enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_download_grants enable row level security;
alter table public.document_edits enable row level security;
alter table public.workflows enable row level security;
alter table public.hidden_workflows enable row level security;
alter table public.workflow_shares enable row level security;
alter table public.default_workflow_installations enable row level security;
alter table public.quick_actions enable row level security;
alter table public.mike_workflows enable row level security;
alter table public.workflow_reference_documents enable row level security;
alter table public.mike_workflow_reference_files enable row level security;
alter table public.workflow_addons enable row level security;
alter table public.workflow_addon_reference_files enable row level security;
alter table public.workflow_open_source_submissions enable row level security;
alter table public.chats enable row level security;
alter table public.chat_messages enable row level security;
alter table public.word_documents enable row level security;
alter table public.word_chats enable row level security;
alter table public.word_chat_messages enable row level security;
alter table public.word_document_edits enable row level security;
alter table public.tabular_reviews enable row level security;
alter table public.tabular_review_rows enable row level security;
alter table public.tabular_review_row_sources enable row level security;
alter table public.tabular_cells enable row level security;
alter table public.tabular_review_chats enable row level security;
alter table public.tabular_review_chat_messages enable row level security;

-- Catalog, routing, folder-resolution, generation, and password helpers are
-- backend-only; do not inherit PUBLIC EXECUTE on fresh installs.
revoke all on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer) to service_role;
revoke all on function public.finish_tabular_review_generation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finish_tabular_review_generation(uuid, uuid) to service_role;
revoke all on function public.install_missing_default_workflows(text) from public, anon, authenticated;
grant execute on function public.install_missing_default_workflows(text) to service_role;
revoke all on function public.install_missing_default_workflows(text, jsonb) from public, anon, authenticated;
grant execute on function public.install_missing_default_workflows(text, jsonb) to service_role;
revoke all on function public.renew_tabular_review_generation(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_tabular_review_generation(uuid, uuid, integer) to service_role;
revoke all on function public.replace_mike_workflows(text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_mike_workflows(text, jsonb) to service_role;
revoke all on function public.replace_user_router_models(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.replace_user_router_models(uuid, text, text[]) to service_role;
revoke all on function public.resolve_library_folder_path(uuid, text, uuid, text[], text) from public, anon, authenticated;
grant execute on function public.resolve_library_folder_path(uuid, text, uuid, text[], text) to service_role;
revoke all on function public.resolve_project_folder_path(uuid, uuid, uuid, text[], text) from public, anon, authenticated;
grant execute on function public.resolve_project_folder_path(uuid, uuid, uuid, text[], text) to service_role;
revoke all on function public.sync_user_password_set(uuid) from public, anon, authenticated;
grant execute on function public.sync_user_password_set(uuid) to service_role;

-- Coordinator-owned 5.2 Drive publication persistence RPC boundary.
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

-- Matter-bound Drive folder settings are mutable only through this narrow
-- service-role RPC. The matter column remains the sole configuration store.
create or replace function public.update_matter_drive_folder(
  p_matter_id uuid,
  p_project_id uuid,
  p_drive_folder_id text,
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
  v_current_epoch bigint;
  v_matter_project_id uuid;
  v_matter_organization_id uuid;
  v_matter_id uuid;
begin
  if p_matter_id is null or p_project_id is null or p_actor_user_id is null
     or p_organization_id is null or p_authorization_epoch is null
     or p_authorization_epoch < 0
     or (p_drive_folder_id is not null
         and (p_drive_folder_id !~ '^[A-Za-z0-9_-]+$' or char_length(p_drive_folder_id) > 256)) then
    raise exception 'Invalid matter Drive folder request' using errcode = '22023';
  end if;

  select organization.authorization_epoch
    into v_current_epoch
    from public.organizations as organization
   where organization.id = p_organization_id
   for update;
  if not found or v_current_epoch is distinct from p_authorization_epoch then
    raise exception 'Matter Drive folder authorization is stale' using errcode = '42501';
  end if;

  perform public.ai_assert_active_matter_access(
    p_actor_user_id, p_organization_id, p_matter_id, p_project_id,
    p_authorization_epoch, 'write'
  );

  select matter.id, matter.project_id, workspace.organization_id
    into v_matter_id, v_matter_project_id, v_matter_organization_id
    from public.matters as matter
    join public.workspaces as workspace on workspace.id = matter.workspace_id
   where matter.id = p_matter_id
   for update of matter, workspace;
  if not found
     or v_matter_organization_id is distinct from p_organization_id
     or v_matter_project_id is distinct from p_project_id then
    raise exception 'Matter Drive folder scope is invalid' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organization_memberships as membership
     where membership.organization_id = p_organization_id
       and membership.user_id = p_actor_user_id
       and membership.status = 'active'
  ) then
    raise exception 'Matter Drive folder organization membership is inactive' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.matter_memberships as membership
     where membership.matter_id = p_matter_id
       and membership.user_id = p_actor_user_id
       and membership.role = 'matter_owner'
       and membership.status = 'active'
     for update
  ) then
    raise exception 'Matter Drive folder owner membership is inactive' using errcode = '42501';
  end if;

  update public.matters
     set drive_folder_id = p_drive_folder_id,
         updated_at = now()
   where id = p_matter_id
     and project_id = p_project_id;

  return jsonb_build_object(
    'matter_id', v_matter_id,
    'project_id', v_matter_project_id,
    'organization_id', v_matter_organization_id,
    'drive_folder_id', p_drive_folder_id
  );
end;
$$;

revoke all on function public.update_matter_drive_folder(uuid, uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.update_matter_drive_folder(uuid, uuid, text, uuid, uuid, bigint)
  to service_role;

-- S2 sync: durable queues + upload sessions (ported from upstream 7e3607e7; state after 20260910_01/02)

create table if not exists public.upload_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null,
  destination jsonb not null,
  expected_file_count integer not null,
  expected_total_bytes bigint not null,
  status text not null default 'pending_upload',
  expires_at timestamptz not null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  error_code text,
  cleaned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_email text,
  constraint upload_sessions_purpose_check check (
    purpose in (
      'document_create',
      'document_version_create',
      'document_version_replace',
      'workflow_reference_create',
      'workflow_reference_replace'
    )
  ),
  constraint upload_sessions_destination_object_check
    check (jsonb_typeof(destination) = 'object'),
  constraint upload_sessions_file_count_check
    check (expected_file_count between 1 and 50),
  constraint upload_sessions_total_bytes_check
    check (expected_total_bytes between 1 and 2147483648),
  constraint upload_sessions_status_check check (
    status in (
      'pending_upload',
      'verifying',
      'uploaded',
      'processing',
      'completed',
      'cancelled',
      'expired',
      'error'
    )
  )
);

create or replace function public.capture_upload_session_user_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select email
    into new.user_email
  from auth.users
  where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists capture_upload_session_user_email on public.upload_sessions;
create trigger capture_upload_session_user_email
  before insert on public.upload_sessions
  for each row
  execute function public.capture_upload_session_user_email();

revoke all on function public.capture_upload_session_user_email()
  from public, anon, authenticated;

create index if not exists upload_sessions_user_created_idx
  on public.upload_sessions(user_id, created_at desc);

drop index if exists public.upload_sessions_active_idx;
create index upload_sessions_active_idx
  on public.upload_sessions(user_id, expires_at)
  where status in ('pending_upload', 'verifying', 'uploaded', 'processing');

create table if not exists public.upload_session_files (
  id uuid primary key,
  session_id uuid not null references public.upload_sessions(id) on delete cascade,
  resource_id uuid not null,
  client_id text not null,
  filename text not null,
  target_folder_id uuid,
  file_type text not null,
  content_type text not null,
  expected_size_bytes bigint not null,
  observed_size_bytes bigint,
  staging_storage_path text not null,
  sealed_storage_path text not null,
  etag text,
  status text not null default 'pending_upload',
  error_code text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_session_files_client_id_check
    check (length(client_id) between 1 and 128),
  constraint upload_session_files_filename_check
    check (length(filename) between 1 and 255),
  constraint upload_session_files_file_type_check
    check (file_type in ('pdf', 'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt')),
  constraint upload_session_files_content_type_check
    check (length(content_type) between 1 and 255),
  constraint upload_session_files_size_check
    check (expected_size_bytes between 1 and 104857600),
  constraint upload_session_files_observed_size_check
    check (observed_size_bytes is null or observed_size_bytes >= 0),
  constraint upload_session_files_status_check
    check (status in ('pending_upload', 'verifying', 'uploaded', 'processing', 'completed', 'error')),
  constraint upload_session_files_session_client_unique unique(session_id, client_id),
  constraint upload_session_files_session_resource_unique unique(session_id, resource_id),
  constraint upload_session_files_staging_path_unique unique(staging_storage_path),
  constraint upload_session_files_sealed_path_unique unique(sealed_storage_path)
);

create index if not exists upload_session_files_session_idx
  on public.upload_session_files(session_id, created_at);

create table if not exists public.upload_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.upload_sessions(id) on delete cascade,
  file_id uuid not null unique references public.upload_session_files(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_processing_jobs_status_check
    check (status in ('queued', 'running', 'completed', 'error')),
  constraint upload_processing_jobs_attempts_check
    check (attempts between 0 and 10)
);

create index if not exists upload_processing_jobs_ready_idx
  on public.upload_processing_jobs(status, available_at, created_at)
  where status = 'queued';

create index if not exists upload_processing_jobs_session_idx
  on public.upload_processing_jobs(session_id, created_at);

create index if not exists upload_processing_jobs_running_user_idx
  on public.upload_processing_jobs(user_id, locked_at)
  where status = 'running';

alter table public.upload_sessions enable row level security;
alter table public.upload_session_files enable row level security;
alter table public.upload_processing_jobs enable row level security;

create or replace function public.create_upload_session(
  target_session_id uuid,
  target_user_id uuid,
  target_purpose text,
  target_destination jsonb,
  target_expires_at timestamptz,
  target_files jsonb,
  target_hourly_session_limit integer default 50
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  manifest_file_count integer;
  manifest_total_bytes bigint;
  recent_session_count integer;
begin
  if jsonb_typeof(target_files) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_upload_manifest';
  end if;
  -- The API issues a 30-minute expiry. Permit one minute of clock skew between
  -- the application host and Postgres while keeping the issued TTL unchanged.
  if target_expires_at <= now()
     or target_expires_at > now() + interval '31 minutes' then
    raise exception using errcode = '22023', message = 'invalid_upload_session_expiry';
  end if;
  if target_hourly_session_limit not between 1 and 1000000 then
    raise exception using errcode = '22023', message = 'invalid_upload_session_rate_limit';
  end if;

  select count(*), coalesce(sum(file_row.expected_size_bytes), 0)
    into manifest_file_count, manifest_total_bytes
  from jsonb_to_recordset(target_files) as file_row(
    id uuid,
    resource_id uuid,
    client_id text,
    filename text,
    target_folder_id uuid,
    file_type text,
    content_type text,
    expected_size_bytes bigint,
    staging_storage_path text,
    sealed_storage_path text
  );

  if manifest_file_count < 1 or manifest_file_count > 50 then
    raise exception using errcode = '22023', message = 'upload_file_count_limit_exceeded';
  end if;
  if manifest_total_bytes < 1 or manifest_total_bytes > 2147483648 then
    raise exception using errcode = '22023', message = 'upload_total_size_limit_exceeded';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(target_files) as file_row(
      id uuid,
      resource_id uuid,
      client_id text,
      filename text,
      target_folder_id uuid,
      file_type text,
      content_type text,
      expected_size_bytes bigint,
      staging_storage_path text,
      sealed_storage_path text
    )
    where file_row.id is null
       or file_row.resource_id is null
       or length(file_row.client_id) not between 1 and 128
       or length(file_row.filename) not between 1 and 255
       or file_row.file_type not in ('pdf', 'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt')
       or length(file_row.content_type) not between 1 and 255
       or file_row.expected_size_bytes not between 1 and 104857600
       or length(file_row.staging_storage_path) < 1
       or length(file_row.sealed_storage_path) < 1
  ) then
    raise exception using errcode = '22023', message = 'invalid_upload_manifest';
  end if;

  -- Namespace the advisory key: hashtextextended(user_id, 0) with no prefix is
  -- already taken by install_missing_default_workflows, and an un-namespaced
  -- key silently serializes unrelated features against each other (see the
  -- advisory-lock registry comment at the top of schema.sql).
  perform pg_advisory_xact_lock(
    hashtextextended('upload-session:' || target_user_id::text, 0)
  );

  -- Housekeeping runs FIRST, under the user lock: expire stale pending
  -- sessions and error out stale verifying ones before the busy check below.
  -- In the earlier draft these updates sat after the busy check, so the one
  -- branch where a stale session was exactly what blocked the caller
  -- (upload_target_busy) rolled them back and the 409 persisted until the
  -- 60-second background sweep happened to run.
  update public.upload_sessions
  set status = 'expired', updated_at = now()
  where user_id = target_user_id
    and status = 'pending_upload'
    and expires_at <= now();

  update public.upload_sessions
  set status = 'error', updated_at = now()
  where user_id = target_user_id
    and status = 'verifying'
    and updated_at <= now() - interval '5 minutes';

  if target_purpose in (
    'document_version_create',
    'document_version_replace',
    'workflow_reference_replace'
  ) and exists (
    select 1
    from public.upload_sessions
    where user_id = target_user_id
      and purpose = target_purpose
      and (
        (target_purpose = 'document_version_create'
          and destination ->> 'document_id' = target_destination ->> 'document_id')
        or (target_purpose = 'document_version_replace'
          and destination ->> 'document_id' = target_destination ->> 'document_id'
          and destination ->> 'version_id' = target_destination ->> 'version_id')
        or (target_purpose = 'workflow_reference_replace'
          and destination ->> 'workflow_id' = target_destination ->> 'workflow_id'
          and destination ->> 'reference_id' = target_destination ->> 'reference_id')
      )
      and status in ('pending_upload', 'verifying', 'uploaded', 'processing')
  ) then
    raise exception using errcode = 'P0001', message = 'upload_target_busy';
  end if;

  select count(*)
    into recent_session_count
  from public.upload_sessions
  where user_id = target_user_id
    and created_at > now() - interval '1 hour';

  if recent_session_count >= target_hourly_session_limit then
    raise exception using errcode = 'P0001', message = 'upload_session_rate_limit_exceeded';
  end if;

  insert into public.upload_sessions (
    id,
    user_id,
    purpose,
    destination,
    expected_file_count,
    expected_total_bytes,
    expires_at
  ) values (
    target_session_id,
    target_user_id,
    target_purpose,
    target_destination,
    manifest_file_count,
    manifest_total_bytes,
    target_expires_at
  );

  insert into public.upload_session_files (
    id,
    session_id,
    resource_id,
    client_id,
    filename,
    target_folder_id,
    file_type,
    content_type,
    expected_size_bytes,
    staging_storage_path,
    sealed_storage_path
  )
  select
    file_row.id,
    target_session_id,
    file_row.resource_id,
    file_row.client_id,
    file_row.filename,
    file_row.target_folder_id,
    file_row.file_type,
    file_row.content_type,
    file_row.expected_size_bytes,
    file_row.staging_storage_path,
    file_row.sealed_storage_path
  from jsonb_to_recordset(target_files) as file_row(
    id uuid,
    resource_id uuid,
    client_id text,
    filename text,
    target_folder_id uuid,
    file_type text,
    content_type text,
    expected_size_bytes bigint,
    staging_storage_path text,
    sealed_storage_path text
  );
end;
$$;

-- Extend a live session's deadline after per-file progress. The per-file
-- protocol gives a natural liveness signal: each successful completion proves
-- the client is still working, so the deadline slides (never shrinks), capped
-- at an absolute age so an abandoned-but-polling client cannot keep a session
-- alive forever. Without this, the largest supported batch (2 GB) on an
-- ordinary uplink outlives the fixed 30-minute TTL and is destroyed mid-upload.
create or replace function public.extend_upload_session_expiry(
  target_session_id uuid,
  target_extension_seconds integer default 1800,
  target_max_session_age_seconds integer default 14400
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if target_extension_seconds not between 60 and 3600
     or target_max_session_age_seconds not between 600 and 86400 then
    raise exception using errcode = '22023', message = 'invalid_upload_session_extension';
  end if;

  update public.upload_sessions
  set expires_at = greatest(
        expires_at,
        least(
          now() + make_interval(secs => target_extension_seconds),
          created_at + make_interval(secs => target_max_session_age_seconds)
        )
      ),
      updated_at = now()
  where id = target_session_id
    and status in ('pending_upload', 'verifying', 'uploaded', 'processing');
end;
$$;

create or replace function public.refresh_upload_session_status(
  target_session_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.upload_sessions%rowtype;
  pending_file_count integer;
  active_file_count integer;
  completed_file_count integer;
  failed_file_count integer;
  next_status text;
  next_error_code text;
  terminal_at timestamptz;
begin
  select *
    into session_row
  from public.upload_sessions
  where id = target_session_id
  for update;

  if session_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;
  if session_row.status in ('cancelled', 'expired') then
    return session_row.status;
  end if;

  select
    count(*) filter (where status in ('pending_upload', 'verifying')),
    count(*) filter (where status in ('uploaded', 'processing')),
    count(*) filter (where status = 'completed'),
    count(*) filter (where status = 'error')
    into pending_file_count, active_file_count, completed_file_count, failed_file_count
  from public.upload_session_files
  where session_id = target_session_id;

  if pending_file_count > 0 then
    next_status := 'pending_upload';
    next_error_code := null;
    terminal_at := null;
  elsif active_file_count > 0 then
    next_status := 'processing';
    next_error_code := null;
    terminal_at := null;
  elsif completed_file_count > 0 then
    next_status := 'completed';
    next_error_code := case when failed_file_count > 0 then 'partial_failure' else null end;
    terminal_at := now();
  else
    next_status := 'error';
    next_error_code := 'all_uploads_failed';
    terminal_at := now();
  end if;

  -- cleaned_at means "this session's storage objects have been deleted".
  -- A COMPLETED session's objects were already removed by the worker as part
  -- of processing, so stamping it here is truthful. An ERROR session's
  -- objects may still exist (the worker that would have deleted them is
  -- often exactly what died), so cleaned_at must stay null — it is the
  -- object sweeper's cursor, and stamping it here permanently hid errored
  -- sessions from the sweep, orphaning their sealed objects.
  -- The write is also guarded so repeated refreshes of an already-terminal
  -- session do not advance completed_at/updated_at: retention filters on
  -- updated_at, and an unconditional bump let any polling client defer the
  -- retention delete indefinitely.
  update public.upload_sessions
  set status = next_status,
      error_code = next_error_code,
      completed_at = case
        when terminal_at is null then null
        else coalesce(completed_at, terminal_at)
      end,
      cleaned_at = case
        when next_status = 'completed' then coalesce(cleaned_at, terminal_at)
        else cleaned_at
      end,
      updated_at = now()
  where id = target_session_id
    and (status is distinct from next_status
      or error_code is distinct from next_error_code);

  return next_status;
end;
$$;

create or replace function public.queue_upload_session_file_processing(
  target_session_id uuid,
  target_user_id uuid,
  target_file_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.upload_sessions%rowtype;
  file_row public.upload_session_files%rowtype;
  processing_job_id uuid;
begin
  -- Plain read: this function only needs to VALIDATE the session status, and
  -- taking FOR UPDATE here created a session->file->job lock order while
  -- claim_upload_processing_job acquires job->file->session — a genuine
  -- deadlock cycle on the documented completion-retry path (reproduced live
  -- during review). Locks below are acquired job-first to match the claim
  -- function's order.
  select *
    into session_row
  from public.upload_sessions
  where id = target_session_id
    and user_id = target_user_id;

  if session_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;
  if session_row.status in ('cancelled', 'expired') then
    raise exception using errcode = 'P0001', message = 'upload_session_not_active';
  end if;

  if not exists (
    select 1
    from public.upload_session_files
    where id = target_file_id
      and session_id = target_session_id
  ) then
    raise exception using errcode = 'P0002', message = 'upload_session_file_not_found';
  end if;

  -- Job first (matches claim_upload_processing_job's lock order). The no-op
  -- conflict update exists only to make RETURNING yield the existing id, so a
  -- repeated completion call is idempotent.
  insert into public.upload_processing_jobs (session_id, file_id, user_id)
  values (target_session_id, target_file_id, target_user_id)
  on conflict (file_id) do update
    set file_id = excluded.file_id
  returning id into processing_job_id;

  -- File second. A failed readiness check raises, which rolls the job upsert
  -- back with the rest of the transaction.
  select *
    into file_row
  from public.upload_session_files
  where id = target_file_id
    and session_id = target_session_id
  for update;

  if file_row.status not in ('uploaded', 'processing', 'completed') then
    raise exception using errcode = 'P0001', message = 'upload_session_file_not_ready';
  end if;

  return processing_job_id;
end;
$$;

drop function if exists public.claim_upload_processing_job(text, integer);

create or replace function public.claim_upload_processing_job(
  target_worker_id text,
  target_lease_seconds integer default 600,
  target_max_running_per_user integer default 4
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate_ids uuid[];
  candidate record;
  active_user_jobs integer;
  claimed_job_id uuid;
  claimed_session_id uuid;
  claimed_file_id uuid;
begin
  if length(target_worker_id) not between 1 and 200
     or target_lease_seconds not between 60 and 3600
     or target_max_running_per_user not between 1 and 64 then
    raise exception using errcode = '22023', message = 'invalid_upload_worker_claim';
  end if;

  -- Bound the candidate set BEFORE the per-row fairness work. The lateral
  -- running-count below sits under a sort, so without this cap every ready
  -- job pays a count on every poll of every worker even when nothing is
  -- claimable — one 50-file batch meant 50 lateral counts x 16 workers x 1/s.
  -- 32 candidates is plenty: a worker claims at most one job per poll.
  select array_agg(id)
    into candidate_ids
  from (
    select id
    from public.upload_processing_jobs
    where attempts < 3
      and ((
        status = 'queued'
        and available_at <= now()
      ) or (
        status = 'running'
        and locked_at <= now() - make_interval(secs => target_lease_seconds)
      ))
    order by available_at, created_at
    limit 32
  ) as ready;

  if candidate_ids is null then
    return null;
  end if;

  for candidate in
    select
      job.id,
      job.session_id,
      job.file_id,
      job.user_id,
      active.running_count
    from public.upload_processing_jobs as job
    cross join lateral (
      select count(*)::integer as running_count
      from public.upload_processing_jobs as running_job
      where running_job.user_id = job.user_id
        and running_job.status = 'running'
        and running_job.locked_at >
          now() - make_interval(secs => target_lease_seconds)
    ) as active
    where job.id = any(candidate_ids)
      and job.attempts < 3
      and active.running_count < target_max_running_per_user
      and ((
        job.status = 'queued'
        and job.available_at <= now()
      ) or (
        job.status = 'running'
        and job.locked_at <=
          now() - make_interval(secs => target_lease_seconds)
      ))
    order by active.running_count, job.available_at, job.created_at
    for update of job skip locked
  loop
    -- Serialize the count-and-claim decision for this user across every
    -- backend replica. A hash collision only delays a claim until the next
    -- poll; it cannot let a user exceed the cap.
    if not pg_try_advisory_xact_lock(
      hashtextextended(candidate.user_id::text, 8242026)
    ) then
      continue;
    end if;

    select count(*)::integer
      into active_user_jobs
    from public.upload_processing_jobs
    where user_id = candidate.user_id
      and status = 'running'
      and locked_at > now() - make_interval(secs => target_lease_seconds);

    if active_user_jobs >= target_max_running_per_user then
      continue;
    end if;

    claimed_job_id := candidate.id;
    claimed_session_id := candidate.session_id;
    claimed_file_id := candidate.file_id;
    exit;
  end loop;

  if claimed_job_id is null then
    return null;
  end if;

  update public.upload_processing_jobs
  set status = 'running',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = target_worker_id,
      error_code = null,
      updated_at = now()
  where id = claimed_job_id;

  update public.upload_session_files
  set status = 'processing', error_code = null, updated_at = now()
  where id = claimed_file_id
    and session_id = claimed_session_id
    and (status = 'uploaded' or (status = 'error' and error_code = 'processing_failed'));

  perform public.refresh_upload_session_status(claimed_session_id);

  return claimed_job_id;
end;
$$;

revoke all on public.upload_sessions from anon, authenticated;
revoke all on public.upload_session_files from anon, authenticated;
revoke all on public.upload_processing_jobs from anon, authenticated;
revoke all on function public.create_upload_session(uuid, uuid, text, jsonb, timestamptz, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.extend_upload_session_expiry(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.refresh_upload_session_status(uuid)
  from public, anon, authenticated;
revoke all on function public.queue_upload_session_file_processing(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_upload_processing_job(text, integer, integer)
  from public, anon, authenticated;

grant select, insert, update, delete on public.upload_sessions to service_role;
grant select, insert, update, delete on public.upload_session_files to service_role;
grant select, insert, update, delete on public.upload_processing_jobs to service_role;
grant execute on function public.create_upload_session(uuid, uuid, text, jsonb, timestamptz, jsonb, integer)
  to service_role;
grant execute on function public.extend_upload_session_expiry(uuid, integer, integer)
  to service_role;
grant execute on function public.refresh_upload_session_status(uuid)
  to service_role;
grant execute on function public.queue_upload_session_file_processing(uuid, uuid, uuid)
  to service_role;
grant execute on function public.claim_upload_processing_job(text, integer, integer)
  to service_role;

-- Migration date: 2026-08-29

-- Durable, Postgres-backed background jobs (the "DB queue").
--
-- WHY A SECOND QUEUE MECHANISM: the BullMQ queues (conversion/extraction) are
-- opt-in because they require Redis, which the default deployment does not
-- run. But some workloads must be durable in EVERY deployment — audit trails,
-- account deletion, export generation — and every deployment already has
-- Postgres. This table + claim function give those workloads at-least-once
-- execution with retries and crash recovery using nothing but the database
-- that is already there, so the DB queue can run BY DEFAULT with zero new
-- infrastructure (web, Word add-in, and Mac app stacks alike).
--
-- Concurrency model: workers claim batches via FOR UPDATE SKIP LOCKED, the
-- standard Postgres idiom for job queues — concurrent claimers never block
-- each other and never double-claim a row. Durable state machine per job:
--   pending --claim--> running --ok--> done
--                       |  \--error--> pending (run_at pushed back; retry)
--                       \--attempts exhausted--> failed (terminal, kept for
--                                                inspection)
-- Crash recovery: a worker that dies mid-job leaves it "running"; the claim
-- function re-claims running jobs whose claimed_at is older than the stale
-- threshold, so orphaned work resumes without any external supervisor.

create table if not exists public.db_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Handler selector, e.g. 'audit.chat_turn', 'account.delete',
  -- 'storage.cleanup', 'export.build'. Unknown kinds are failed permanently
  -- by the runner rather than retried forever.
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed')),
  -- Incremented at claim time (not completion), so a crash mid-run still
  -- counts the attempt and cannot produce an infinite crash loop.
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts >= 1),
  -- Earliest time the job may (re)run; retries push this into the future
  -- with exponential backoff.
  run_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  last_error text,
  -- Optional application-level dedupe (see partial unique index below): a
  -- second enqueue of the same key while one is pending/running is rejected
  -- by the index, and the caller treats unique-violation as "already queued".
  dedupe_key text,
  -- Handler-written result consumed by pollers (e.g. an export's storage
  -- path + filename once built).
  result jsonb,
  created_at timestamptz not null default now()
);

-- The claim scan: pending-and-due ordered by run_at. Partial index keeps it
-- tiny no matter how much done/failed history is retained.
create index if not exists db_jobs_claim_idx
  on public.db_jobs (run_at)
  where status = 'pending';

-- Stale-running recovery scan.
create index if not exists db_jobs_running_idx
  on public.db_jobs (claimed_at)
  where status = 'running';

-- Dedupe only among live jobs: once a job is done/failed the key is free to
-- be enqueued again (e.g. a second export of the same type tomorrow).
create unique index if not exists db_jobs_dedupe_live_idx
  on public.db_jobs (dedupe_key)
  where dedupe_key is not null and status in ('pending', 'running');

-- Retention sweep support (delete done/failed rows past their keep window).
create index if not exists db_jobs_finished_idx
  on public.db_jobs (finished_at)
  where status in ('done', 'failed');

alter table public.db_jobs enable row level security;
revoke all on public.db_jobs from anon, authenticated;
grant select, insert, update, delete on public.db_jobs to service_role;

-- Atomically claim up to p_limit runnable jobs. Returns the claimed rows.
--
-- "Runnable" is EITHER a due pending job OR a running job whose claim went
-- stale (worker crashed / was SIGKILLed mid-run) — folding crash recovery
-- into the claim itself means there is no separate reaper to keep in sync.
-- FOR UPDATE SKIP LOCKED makes concurrent claimers (multiple backend
-- replicas, or overlapping poll ticks) partition the work instead of racing:
-- locked rows are skipped, never waited on and never double-claimed.
--
-- THE ATTEMPT BUDGET APPLIES TO STALE RECOVERY TOO. The retry state machine
-- lives in the runner, which can only spend an attempt on a job whose handler
-- RETURNS control — it throws, the runner writes 'failed'. A job that kills
-- its worker (OOM, SIGKILL, a native crash in LibreOffice) never gets there:
-- it stays 'running', goes stale, and is reclaimed. Without the
-- attempts < max_attempts guard below that is an eternal crash loop — every
-- p_stale_seconds, forever, taking a worker with it each time. The guard makes
-- the budget mean the same thing for a crash as for an exception, and the
-- first CTE gives those spent rows the terminal 'failed' state they can never
-- reach on their own. The two sets are disjoint by construction (attempts >=
-- max_attempts versus attempts < max_attempts), so their order does not matter.
create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed',
           finished_at = now(),
           last_error = coalesce(
             last_error,
             'abandoned: worker died mid-run and attempts are exhausted'
           )
     where status = 'running'
       and claimed_at < now() - make_interval(secs => p_stale_seconds)
       and attempts >= max_attempts
    returning id
  ), candidates as (
    select id
      from public.db_jobs
     where (status = 'pending' and run_at <= now())
        or (status = 'running'
            and claimed_at < now() - make_interval(secs => p_stale_seconds)
            and attempts < max_attempts)
     order by run_at
     limit p_limit
       for update skip locked
  )
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         attempts = j.attempts + 1
    from candidates c
   where j.id = c.id
  returning j.*;
$$;

revoke execute on function public.claim_db_jobs(integer, integer)
  from anon, authenticated, public;
grant execute on function public.claim_db_jobs(integer, integer)
  to service_role;

-- Claim ONE job by id — the Redis-delivery path (transactional-outbox
-- pattern). When Redis is configured, enqueue also adds a BullMQ "delivery"
-- job carrying this row's id so pickup is instant; the worker still claims
-- through Postgres via this function, so a duplicate delivery (BullMQ retry,
-- poller backstop racing the delivery) can never double-run the job: the
-- second claimer matches zero rows. Same stale-running recovery as the batch
-- claim, including its attempt budget: a job that kills its worker must not be
-- redelivered forever. Terminally failing a spent stale row is left to the
-- batch claim above, which every deployment runs (as the delivery mechanism
-- without Redis, as the lost-delivery backstop with it).
create or replace function public.claim_db_job(
  p_id uuid,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
as $$
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         attempts = j.attempts + 1
   where j.id = p_id
     and ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'running'
           and j.claimed_at < now() - make_interval(secs => p_stale_seconds)
           and j.attempts < j.max_attempts))
  returning j.*;
$$;

revoke execute on function public.claim_db_job(uuid, integer)
  from anon, authenticated, public;
grant execute on function public.claim_db_job(uuid, integer)
  to service_role;

-- Cancellation for dedupe-keyed jobs (clear-cells in Postgres-driver mode):
-- pending jobs are deleted outright; running jobs get a persisted
-- `canceled: true` stamped into their payload, which handlers check on each
-- (re)claim — mirroring the BullMQ Job#updateData cancellation path.
create or replace function public.cancel_db_jobs(p_dedupe_keys text[])
returns integer
language sql
as $$
  with deleted as (
    delete from public.db_jobs
     where dedupe_key = any(p_dedupe_keys)
       and status = 'pending'
    returning 1
  ), marked as (
    update public.db_jobs
       set payload = payload || jsonb_build_object('canceled', true)
     where dedupe_key = any(p_dedupe_keys)
       and status = 'running'
    returning 1
  )
  select coalesce((select count(*) from deleted), 0)::integer
       + coalesce((select count(*) from marked), 0)::integer;
$$;

revoke execute on function public.cancel_db_jobs(text[])
  from anon, authenticated, public;
grant execute on function public.cancel_db_jobs(text[])
  to service_role;


-- ---------------------------------------------------------------------------
-- S3 sync: organization access & sharing (ported from upstream 7e3607e7;
-- state after 20260910_03/04). LiTT adaptations: organization_memberships
-- instead of org_members, no role defaults on grants or invitations, no
-- implicit org-role content grants (membership alone grants nothing; explicit
-- overrides only), last-org_owner guard, user_id NOT NULL preserved, legacy
-- shared_with/allow_edit columns preserved (backfill-only).
-- ---------------------------------------------------------------------------

create or replace function public.chat_access_role(p_chat_id uuid, p_chat_user_id uuid, p_project_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when p_chat_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.chat_access_grants g
      where g.chat_id = p_chat_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;
revoke all on function public.chat_access_role(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.chat_access_role(uuid, uuid, uuid, uuid, text, text) to service_role;

create or replace function public.cleanup_inherited_direct_grants()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'projects' then
    if new.org_id is not null then
      delete from public.project_access_grants where project_id = new.id;
    end if;
    delete from public.project_org_access_overrides
    where project_id = new.id and org_id is distinct from new.org_id;
  elsif tg_table_name = 'chats' then
    if new.project_id is not null then
      delete from public.chat_access_grants where chat_id = new.id;
    end if;
  elsif tg_table_name = 'tabular_reviews' then
    if new.project_id is not null then
      delete from public.tabular_review_access_grants where tabular_review_id = new.id;
    end if;
  elsif tg_table_name = 'workflows' then
    if new.org_id is not null then
      delete from public.workflow_shares where workflow_id = new.id;
    end if;
    delete from public.workflow_org_access_overrides
    where workflow_id = new.id and org_id is distinct from new.org_id;
  end if;
  return new;
end;
$$;
revoke all on function public.cleanup_inherited_direct_grants() from public, anon, authenticated;

create or replace function public.cleanup_removed_org_member_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' or new.status is distinct from 'active' then
    delete from public.project_org_access_overrides
    where org_id = old.organization_id and user_id = old.user_id;
    delete from public.workflow_org_access_overrides
    where org_id = old.organization_id and user_id = old.user_id;
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.cleanup_removed_org_member_overrides() from public, anon, authenticated;

create or replace function public.project_access_role(p_project_id uuid, p_project_user_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_org_id is not null then (
      select case
        when p_project_user_id::text = p_user_id then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else null
      end
      from public.organization_memberships m
      left join public.project_org_access_overrides o
        on o.project_id = p_project_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.organization_id = p_org_id
        and m.user_id::text = p_user_id
        and m.status = 'active'
    )
    when p_project_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.project_access_grants g
      where g.project_id = p_project_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;
revoke all on function public.project_access_role(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.project_access_role(uuid, uuid, uuid, text, text) to service_role;

create or replace function public.review_access_role(p_review_id uuid, p_review_user_id uuid, p_project_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when p_review_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.tabular_review_access_grants g
      where g.tabular_review_id = p_review_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;
revoke all on function public.review_access_role(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.review_access_role(uuid, uuid, uuid, uuid, text, text) to service_role;

create or replace function public.sync_project_child_org_id()
returns trigger
language plpgsql
set search_path = public
as $$
declare parent_org_id uuid;
begin
  if new.project_id is null then return new; end if;
  select p.org_id into parent_org_id
  from public.projects p where p.id = new.project_id for key share;
  if not found then
    raise exception 'Project not found' using errcode = '23503';
  end if;
  new.org_id := parent_org_id;
  return new;
end;
$$;
revoke all on function public.sync_project_child_org_id() from public, anon, authenticated;

create or replace function public.validate_direct_access_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare invalid_scope boolean;
begin
  case tg_table_name
    when 'project_access_grants' then
      select p.org_id is not null into invalid_scope
      from public.projects p where p.id = new.project_id for update;
    when 'chat_access_grants' then
      select c.project_id is not null into invalid_scope
      from public.chats c where c.id = new.chat_id for update;
    when 'tabular_review_access_grants' then
      select tr.project_id is not null into invalid_scope
      from public.tabular_reviews tr where tr.id = new.tabular_review_id for update;
    when 'workflow_shares' then
      select w.org_id is not null into invalid_scope
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported direct access table';
  end case;
  if coalesce(invalid_scope, true) then
    raise exception 'Direct grants are not allowed for organization or inherited content'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_direct_access_scope() from public, anon, authenticated;

create or replace function public.validate_org_access_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare resource_org_id uuid;
declare resource_creator_id uuid;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id into resource_org_id, resource_creator_id
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id into resource_org_id, resource_creator_id
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported organization override table';
  end case;

  if resource_org_id is null or resource_org_id is distinct from new.org_id then
    raise exception 'Organization override does not match the resource organization'
      using errcode = '23514';
  end if;
  if resource_creator_id = new.user_id then
    raise exception 'The creator is always an owner'
      using errcode = '23514';
  end if;
  perform 1
  from public.organization_memberships m
  where m.organization_id = new.org_id and m.user_id = new.user_id and m.status = 'active'
  for key share;
  if not found then
    raise exception 'Organization access overrides require active membership'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_org_access_override() from public, anon, authenticated;

create or replace function public.organization_memberships_protect_last_owner()
returns trigger
language plpgsql
set search_path = public
as $$
declare remaining_owners integer;
begin
  if old.role = 'org_owner' and old.status = 'active' then
    if tg_op = 'DELETE' or new.role <> 'org_owner' or new.status <> 'active' then
      if tg_op = 'DELETE' then
        if not exists (select 1 from public.organizations where id = old.organization_id) then
          return old; -- organization teardown cascade; nothing left to protect
        end if;
      end if;
      select count(*) into remaining_owners
      from public.organization_memberships
      where organization_id = old.organization_id
        and role = 'org_owner'
        and status = 'active'
        and user_id <> old.user_id;
      if remaining_owners = 0 then
        raise exception 'An organization must keep at least one owner'
          using errcode = '23514';
      end if;
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.organization_memberships_protect_last_owner() from public, anon, authenticated;

create or replace function public.workflow_access_role(p_workflow_id uuid, p_workflow_user_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_org_id is not null then (
      select case
        when p_workflow_user_id::text = p_user_id then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else null
      end
      from public.organization_memberships m
      left join public.workflow_org_access_overrides o
        on o.workflow_id = p_workflow_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.organization_id = p_org_id
        and m.user_id::text = p_user_id
        and m.status = 'active'
    )
    when p_workflow_user_id::text = p_user_id then 'owner'
    else (
      select s.role from public.workflow_shares s
      where s.workflow_id = p_workflow_id
        and coalesce(p_user_email, '') <> ''
        and s.shared_with_email = lower(p_user_email)
      limit 1
    )
  end;
$$;
revoke all on function public.workflow_access_role(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.workflow_access_role(uuid, uuid, uuid, text, text) to service_role;

create table if not exists public.chat_access_grants (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  email text not null,
  role text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_access_grants_chat_id_email_key unique (chat_id, email),
  constraint chat_access_grants_email_lowercase check (email = lower(email)),
  constraint chat_access_grants_role_check check (role in ('owner', 'editor', 'viewer'))
);
alter table public.chat_access_grants enable row level security;
create index if not exists idx_chat_access_grants_email on public.chat_access_grants(email);
create index if not exists idx_chat_access_grants_chat on public.chat_access_grants(chat_id);
drop trigger if exists chat_access_grants_scope_guard on public.chat_access_grants;
create trigger chat_access_grants_scope_guard
  before insert or update on public.chat_access_grants
  for each row execute function public.validate_direct_access_scope();
revoke all on public.chat_access_grants from anon;
revoke all on public.chat_access_grants from authenticated;
grant delete, insert, select, update on public.chat_access_grants to service_role;

create table if not exists public.project_access_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_access_grants_project_id_email_key unique (project_id, email),
  constraint project_access_grants_email_lowercase check (email = lower(email)),
  constraint project_access_grants_role_check check (role in ('owner', 'editor', 'viewer'))
);
alter table public.project_access_grants enable row level security;
create index if not exists idx_project_access_grants_email on public.project_access_grants(email);
create index if not exists idx_project_access_grants_project on public.project_access_grants(project_id);
drop trigger if exists project_access_grants_scope_guard on public.project_access_grants;
create trigger project_access_grants_scope_guard
  before insert or update on public.project_access_grants
  for each row execute function public.validate_direct_access_scope();
revoke all on public.project_access_grants from anon;
revoke all on public.project_access_grants from authenticated;
grant delete, insert, select, update on public.project_access_grants to service_role;

create table if not exists public.tabular_review_access_grants (
  id uuid primary key default gen_random_uuid(),
  tabular_review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  email text not null,
  role text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tabular_review_access_grants_tabular_review_id_email_key unique (tabular_review_id, email),
  constraint tabular_review_access_grants_email_lowercase check (email = lower(email)),
  constraint tabular_review_access_grants_role_check check (role in ('owner', 'editor', 'viewer'))
);
alter table public.tabular_review_access_grants enable row level security;
create index if not exists idx_tabular_review_access_grants_review on public.tabular_review_access_grants(tabular_review_id);
create index if not exists idx_tabular_review_access_grants_email on public.tabular_review_access_grants(email);
drop trigger if exists tabular_review_access_grants_scope_guard on public.tabular_review_access_grants;
create trigger tabular_review_access_grants_scope_guard
  before insert or update on public.tabular_review_access_grants
  for each row execute function public.validate_direct_access_scope();
revoke all on public.tabular_review_access_grants from anon;
revoke all on public.tabular_review_access_grants from authenticated;
grant delete, insert, select, update on public.tabular_review_access_grants to service_role;

create table if not exists public.project_org_access_overrides (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null,
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_org_access_overrides_org_id_user_id_fkey
    foreign key (org_id, user_id)
    references public.organization_memberships(organization_id, user_id) on delete cascade,
  constraint project_org_access_overrides_project_id_user_id_key unique (project_id, user_id),
  constraint project_org_access_overrides_role_check check (role in ('owner', 'editor', 'viewer', 'deny'))
);
alter table public.project_org_access_overrides enable row level security;
create index if not exists idx_project_org_access_overrides_user on public.project_org_access_overrides(user_id);
drop trigger if exists project_org_access_overrides_guard on public.project_org_access_overrides;
create trigger project_org_access_overrides_guard
  before insert or update on public.project_org_access_overrides
  for each row execute function public.validate_org_access_override();
revoke all on public.project_org_access_overrides from anon;
revoke all on public.project_org_access_overrides from authenticated;
grant delete, insert, select, update on public.project_org_access_overrides to service_role;

create table if not exists public.workflow_org_access_overrides (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null,
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_org_access_overrides_org_id_user_id_fkey
    foreign key (org_id, user_id)
    references public.organization_memberships(organization_id, user_id) on delete cascade,
  constraint workflow_org_access_overrides_workflow_id_user_id_key unique (workflow_id, user_id),
  constraint workflow_org_access_overrides_role_check check (role in ('owner', 'editor', 'viewer', 'deny'))
);
alter table public.workflow_org_access_overrides enable row level security;
create index if not exists idx_workflow_org_access_overrides_user on public.workflow_org_access_overrides(user_id);
drop trigger if exists workflow_org_access_overrides_guard on public.workflow_org_access_overrides;
create trigger workflow_org_access_overrides_guard
  before insert or update on public.workflow_org_access_overrides
  for each row execute function public.validate_org_access_override();
revoke all on public.workflow_org_access_overrides from anon;
revoke all on public.workflow_org_access_overrides from authenticated;
grant delete, insert, select, update on public.workflow_org_access_overrides to service_role;

create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null,
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending',
  expires_at timestamptz not null default (now() + '14 days'::interval),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  declined_at timestamptz,
  cancelled_at timestamptz,
  constraint org_invitations_email_lowercase check (email = lower(email)),
  constraint org_invitations_role_check check (role in ('org_owner', 'workspace_admin', 'editor', 'viewer', 'technical_operator')),
  constraint org_invitations_status_check check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired'))
);
alter table public.org_invitations enable row level security;
create index if not exists idx_org_invitations_org on public.org_invitations(org_id);
create index if not exists idx_org_invitations_email on public.org_invitations(email) where status = 'pending';
create unique index if not exists org_invitations_active_unique on public.org_invitations(org_id, email) where status = 'pending';
revoke all on public.org_invitations from anon;
revoke all on public.org_invitations from authenticated;
grant delete, insert, select, update on public.org_invitations to service_role;

alter table public.chats
  add column if not exists org_id uuid;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chats_org_requires_project'
      and conrelid = 'public.chats'::regclass
  ) then
    alter table public.chats
      add constraint chats_org_requires_project
      check (org_id is null or project_id is not null);
  end if;
end;
$$;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chats_org_id_fkey'
      and conrelid = 'public.chats'::regclass
  ) then
    alter table public.chats
      add constraint chats_org_id_fkey
      foreign key (org_id) references public.organizations(id) on delete restrict;
  end if;
end;
$$;
create index if not exists idx_chats_org on public.chats(org_id);
drop trigger if exists chats_cleanup_direct_grants on public.chats;
create trigger chats_cleanup_direct_grants
  after insert or update of project_id, org_id on public.chats
  for each row execute function public.cleanup_inherited_direct_grants();
drop trigger if exists chats_sync_project_org on public.chats;
create trigger chats_sync_project_org
  before insert or update of project_id, org_id on public.chats
  for each row execute function public.sync_project_child_org_id();

alter table public.documents
  add column if not exists org_id uuid;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_org_id_fkey'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_org_id_fkey
      foreign key (org_id) references public.organizations(id) on delete restrict;
  end if;
end;
$$;
create index if not exists idx_documents_org on public.documents(org_id);
drop trigger if exists documents_sync_project_org on public.documents;
create trigger documents_sync_project_org
  before insert or update of project_id, org_id on public.documents
  for each row execute function public.sync_project_child_org_id();

alter table public.projects
  add column if not exists org_id uuid;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'projects_org_id_fkey'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_org_id_fkey
      foreign key (org_id) references public.organizations(id) on delete restrict;
  end if;
end;
$$;
create index if not exists idx_projects_org on public.projects(org_id);
drop trigger if exists projects_cleanup_direct_grants on public.projects;
create trigger projects_cleanup_direct_grants
  after insert or update of org_id on public.projects
  for each row execute function public.cleanup_inherited_direct_grants();

alter table public.tabular_reviews
  add column if not exists org_id uuid;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tabular_reviews_org_id_fkey'
      and conrelid = 'public.tabular_reviews'::regclass
  ) then
    alter table public.tabular_reviews
      add constraint tabular_reviews_org_id_fkey
      foreign key (org_id) references public.organizations(id) on delete restrict;
  end if;
end;
$$;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tabular_reviews_org_requires_project'
      and conrelid = 'public.tabular_reviews'::regclass
  ) then
    alter table public.tabular_reviews
      add constraint tabular_reviews_org_requires_project
      check (org_id is null or project_id is not null);
  end if;
end;
$$;
create index if not exists idx_tabular_reviews_org on public.tabular_reviews(org_id);
drop trigger if exists tabular_reviews_cleanup_direct_grants on public.tabular_reviews;
create trigger tabular_reviews_cleanup_direct_grants
  after insert or update of project_id, org_id on public.tabular_reviews
  for each row execute function public.cleanup_inherited_direct_grants();
drop trigger if exists tabular_reviews_sync_project_org on public.tabular_reviews;
create trigger tabular_reviews_sync_project_org
  before insert or update of project_id, org_id on public.tabular_reviews
  for each row execute function public.sync_project_child_org_id();

alter table public.workflows
  add column if not exists org_id uuid;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workflows_org_id_fkey'
      and conrelid = 'public.workflows'::regclass
  ) then
    alter table public.workflows
      add constraint workflows_org_id_fkey
      foreign key (org_id) references public.organizations(id) on delete restrict;
  end if;
end;
$$;
create index if not exists idx_workflows_org on public.workflows(org_id);
drop trigger if exists workflows_cleanup_direct_grants on public.workflows;
create trigger workflows_cleanup_direct_grants
  after insert or update of org_id on public.workflows
  for each row execute function public.cleanup_inherited_direct_grants();

alter table public.workflow_shares
  add column if not exists role text not null default 'viewer';
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workflow_shares_role_check'
      and conrelid = 'public.workflow_shares'::regclass
  ) then
    alter table public.workflow_shares
      add constraint workflow_shares_role_check
      check (role in ('owner', 'editor', 'viewer'));
  end if;
end;
$$;
drop trigger if exists workflow_shares_scope_guard on public.workflow_shares;
create trigger workflow_shares_scope_guard
  before insert or update on public.workflow_shares
  for each row execute function public.validate_direct_access_scope();

drop trigger if exists organization_memberships_cleanup_access_overrides
  on public.organization_memberships;
create trigger organization_memberships_cleanup_access_overrides
  after update of status or delete on public.organization_memberships
  for each row execute function public.cleanup_removed_org_member_overrides();

drop trigger if exists organization_memberships_last_owner_guard
  on public.organization_memberships;
create trigger organization_memberships_last_owner_guard
  before update of role, status or delete on public.organization_memberships
  for each row execute function public.organization_memberships_protect_last_owner();
