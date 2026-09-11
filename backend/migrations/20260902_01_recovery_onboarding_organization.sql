-- Migration date: 2026-09-02
-- Resolve the Slice A onboarding contract without constraining later organization creation.

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
