-- Migration date: 2026-08-13
-- W1.6: enable row-level security on every public table (defense in depth).
-- The backend operates with the service_role path (bypasses RLS); browser
-- roles (anon/authenticated) hold no grants on these tables. RLS guarantees
-- that even a future accidental GRANT cannot expose rows directly.
-- Each table is guarded by to_regclass so this migration is safe on any
-- database, regardless of which older migrations ran. The literal
-- 'alter table public.X enable row level security' strings keep the CI
-- security-invariants check (scripts/check-security-invariants.sh) able to
-- see the coverage.

do $$ begin
  if to_regclass('public.user_profiles') is not null then execute 'alter table public.user_profiles enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.projects') is not null then execute 'alter table public.projects enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.project_subfolders') is not null then execute 'alter table public.project_subfolders enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.library_folders') is not null then execute 'alter table public.library_folders enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.documents') is not null then execute 'alter table public.documents enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.document_versions') is not null then execute 'alter table public.document_versions enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.document_edits') is not null then execute 'alter table public.document_edits enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.workflows') is not null then execute 'alter table public.workflows enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.hidden_workflows') is not null then execute 'alter table public.hidden_workflows enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.workflow_shares') is not null then execute 'alter table public.workflow_shares enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.chats') is not null then execute 'alter table public.chats enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.chat_messages') is not null then execute 'alter table public.chat_messages enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.tabular_reviews') is not null then execute 'alter table public.tabular_reviews enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.tabular_cells') is not null then execute 'alter table public.tabular_cells enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.tabular_review_chats') is not null then execute 'alter table public.tabular_review_chats enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.tabular_review_chat_messages') is not null then execute 'alter table public.tabular_review_chat_messages enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.workflow_open_source_submissions') is not null then execute 'alter table public.workflow_open_source_submissions enable row level security'; end if;
end $$;
do $$ begin
  if to_regclass('public.contact_messages') is not null then execute 'alter table public.contact_messages enable row level security'; end if;
end $$;
