-- Migration date: 2026-09-05
-- Persist the matter-bound Drive folder through one service-role mutation RPC.
begin;

alter table public.matters drop constraint if exists matters_drive_folder_id_check;
alter table public.matters add constraint matters_drive_folder_id_check
  check (drive_folder_id is null or (drive_folder_id ~ '^[A-Za-z0-9_-]+$' and char_length(drive_folder_id) <= 256));

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

commit;
