-- CourtListener/US research is excluded from the recovered product.
BEGIN;
ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS legal_research_us;
COMMIT;
