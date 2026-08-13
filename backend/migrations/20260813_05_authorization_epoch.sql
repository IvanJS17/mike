-- Migration date: 2026-08-13
-- W1.7: monotonic authorization epochs.
-- Each organization carries an authorization_epoch that increments whenever a
-- membership is revoked. Long-running jobs capture the epoch at start and
-- abort (assertEpochFresh) if it moved; revocation also deletes the
-- membership row and signs the user out of Auth.

alter table public.organizations
  add column if not exists authorization_epoch bigint not null default 0;

-- Atomic, monotonic bump (backend calls this via RPC on revocation).
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
