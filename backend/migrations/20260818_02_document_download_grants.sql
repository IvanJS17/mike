-- Migration date: 2026-08-18
-- Beta Jurídica 0.1 Fase 1: authenticated, expiring, single-use document grants.
-- Store only a SHA-256 token hash; the bearer value never reaches the database.

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
