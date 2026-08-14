-- Migration date: 2026-08-13
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
  updated_at timestamptz not null default now()
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
  updated_at timestamptz not null default now()
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
  select role from public.matter_memberships
  where matter_id = p_matter and user_id = auth.uid()
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
  using (
    public.matter_role(id) is not null
    or exists (
      select 1 from public.workspaces w
      where w.id = matters.workspace_id
        and public.is_organization_member(w.organization_id)
    )
  );

drop policy if exists matters_update_member on public.matters;
create policy matters_update_member
  on public.matters for update
  using (public.matter_role(id) in ('matter_owner', 'editor'));

drop policy if exists matter_memberships_select_member on public.matter_memberships;
create policy matter_memberships_select_member
  on public.matter_memberships for select
  using (
    user_id = auth.uid()
    or public.matter_role(matter_id) is not null
    or exists (
      select 1 from public.matters m
      join public.workspaces w on w.id = m.workspace_id
      where m.id = matter_memberships.matter_id
        and public.is_organization_member(w.organization_id)
    )
  );

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
