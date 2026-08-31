-- Migration date: 2026-08-31
--
-- Slice A2a — recovery identity/tenancy: migrate the executable LiTT tenancy
-- (baseline d9fa8380e63837b6441cef169cf5ef80dfb55e54:backend/schema.sql) onto
-- the upstream recovery branch.
--
-- Applies idempotently to the EXACT LiTT baseline: existing tenancy tables are
-- ALTERED (never recreated), and the baseline policies/grants/RPC are replaced
-- with the A1-contract target shape:
--
--   * membership status active|inactive|revoked on all three membership
--     tables, existing rows backfilled 'active', CHECK-enforced;
--   * matter visibility public|private, existing matters backfilled
--     'private';
--   * all helper/policy checks require active memberships;
--   * public matter: active org membership may read; private matter: active
--     org membership + active explicit matter membership;
--   * every org/workspace/matter membership authorization mutation advances
--     the owning organization's authorization_epoch exactly once (triggered,
--     single linearized increment);
--   * zero browser DML grants/policies: browser roles keep read access only,
--     mutations are backend-mediated via service_role;
--   * no onboarding defaults/seeds/implicit grants.
--
-- RLS helpers are SECURITY DEFINER with fixed search_path, take a scope id
-- only, bind the user through auth.uid() internally, and are revoked from
-- PUBLIC/anon.

-- ---------------------------------------------------------------------------
-- 1. Recovery deltas: membership status + matter visibility columns.
--    Backfill existing rows first, then enforce NOT NULL and closed CHECKs.
-- ---------------------------------------------------------------------------

alter table public.organization_memberships
  add column if not exists status text;
update public.organization_memberships set status = 'active' where status is null;
alter table public.organization_memberships
  alter column status set not null;
alter table public.organization_memberships
  alter column status set default 'active';
alter table public.organization_memberships
  drop constraint if exists organization_memberships_status_check;
alter table public.organization_memberships
  add constraint organization_memberships_status_check
  check (status in ('active', 'inactive', 'revoked'));

alter table public.workspace_memberships
  add column if not exists status text;
update public.workspace_memberships set status = 'active' where status is null;
alter table public.workspace_memberships
  alter column status set not null;
alter table public.workspace_memberships
  alter column status set default 'active';
alter table public.workspace_memberships
  drop constraint if exists workspace_memberships_status_check;
alter table public.workspace_memberships
  add constraint workspace_memberships_status_check
  check (status in ('active', 'inactive', 'revoked'));

alter table public.matter_memberships
  add column if not exists status text;
update public.matter_memberships set status = 'active' where status is null;
alter table public.matter_memberships
  alter column status set not null;
alter table public.matter_memberships
  alter column status set default 'active';
alter table public.matter_memberships
  drop constraint if exists matter_memberships_status_check;
alter table public.matter_memberships
  add constraint matter_memberships_status_check
  check (status in ('active', 'inactive', 'revoked'));

alter table public.matters
  add column if not exists visibility text;
update public.matters set visibility = 'private' where visibility is null;
alter table public.matters
  alter column visibility set not null;
alter table public.matters
  alter column visibility set default 'private';
alter table public.matters
  drop constraint if exists matters_visibility_check;
alter table public.matters
  add constraint matters_visibility_check
  check (visibility in ('public', 'private'));

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
