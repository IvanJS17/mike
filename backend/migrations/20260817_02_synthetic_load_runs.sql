-- WS2 disposable qualification queue ledger.
-- The production application denies this route and Compose forces its flag off;
-- the table exists only so an approved synthetic rehearsal can prove durable
-- failure/resume/idempotency instead of relying on process memory.
create table if not exists public.synthetic_load_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  load_run text not null,
  documents integer not null check (documents = 100),
  pages integer not null check (pages = 1000),
  induced_failures integer not null default 0 check (induced_failures between 0 and 10),
  resumed_count integer not null default 0 check (resumed_count between 0 and 1),
  status text not null default 'pending' check (status in ('pending', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, load_run)
);

create index if not exists idx_synthetic_load_runs_status
  on public.synthetic_load_runs(user_id, status, updated_at desc);

alter table public.synthetic_load_runs enable row level security;
revoke all privileges on table public.synthetic_load_runs from anon, authenticated;
