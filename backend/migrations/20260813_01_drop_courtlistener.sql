-- CourtListener (US case-law) is disabled product-wide (W1.3): drop its
-- tables and remove the provider from the user_api_keys constraint.
DROP TABLE IF EXISTS public.courtlistener_citation_index;
DROP TABLE IF EXISTS public.courtlistener_opinion_cluster_index;

ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;
ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider in ('claude', 'gemini', 'openai', 'openrouter', 'deepseek', 'opencode-zen', 'opencode-go'));

-- The per-profile legal-research flag is unused now that CourtListener is
-- disabled; drop the column (and its schema.sql definition).
ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS legal_research_us;
