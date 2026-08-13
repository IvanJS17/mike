-- Migration date: 2026-08-13
-- W1.8: remove email-based sharing (no acceptance).
-- Access becomes owner-only until the tenancy memberships (W1.5) and the
-- nominal invitation flow (W1.11) replace it.

drop index if exists public.projects_shared_with_idx;
alter table public.projects drop column if exists shared_with;

alter table public.tabular_reviews drop column if exists shared_with;

drop table if exists public.workflow_shares;
