-- Migration date: 2026-08-18
-- W1.5 privacy correction: matter access requires an explicit assignment
-- together with an active organization membership. Organization/workspace
-- roles alone never grant access to private matter content or memberships.

create or replace function public.matter_role(p_matter uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
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

drop policy if exists matters_select_member on public.matters;
create policy matters_select_member
  on public.matters for select
  using (public.matter_role(id) is not null);

drop policy if exists matter_memberships_select_member on public.matter_memberships;
create policy matter_memberships_select_member
  on public.matter_memberships for select
  using (public.matter_role(matter_id) is not null);
