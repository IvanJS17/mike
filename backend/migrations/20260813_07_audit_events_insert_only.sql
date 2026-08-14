-- Migration date: 2026-08-13
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
