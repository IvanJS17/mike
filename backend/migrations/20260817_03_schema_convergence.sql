-- WS2 fresh/incremental schema convergence.
-- Remove legacy plaintext API-key columns and normalize constraints/functions
-- that the dated migration chain otherwise leaves divergent.
alter table public.user_profiles
  drop column if exists claude_api_key,
  drop column if exists gemini_api_key;

do $$
begin
  if to_regclass('public.document_edits') is not null
     and to_regclass('public.chat_messages') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'document_edits_chat_message_id_fkey'
         and conrelid = 'public.document_edits'::regclass
     ) then
    alter table public.document_edits
      add constraint document_edits_chat_message_id_fkey
      foreign key (chat_message_id) references public.chat_messages(id) on delete set null;
  end if;
end
$$;

-- W1.8's owner-only overview is the final contract; do not leave the
-- pre-W1.8 three-argument overload on incremental databases.
drop function if exists public.get_workflows_overview(text, text, text);
