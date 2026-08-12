-- Migration date: 2026-08-12

-- Versioned, server-only personal credentials. Replacing a row keeps the
-- provider unique while changing the non-secret reference used by pinned
-- chats; old references therefore fail closed after replacement or removal.
ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (
    provider IN (
      'claude',
      'gemini',
      'openai',
      'openrouter',
      'deepseek',
      'opencode-zen',
      'opencode-go',
      'courtlistener'
    )
  );

ALTER TABLE public.user_api_keys
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE public.user_api_keys
  ADD COLUMN IF NOT EXISTS credential_ref text;

ALTER TABLE public.user_api_keys
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

UPDATE public.user_api_keys
SET credential_ref = provider || ':v' || version::text
WHERE credential_ref IS NULL OR btrim(credential_ref) = '';

ALTER TABLE public.user_api_keys
  ALTER COLUMN credential_ref SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_api_keys_user_credential_ref_idx
  ON public.user_api_keys(user_id, credential_ref);

-- Allocate non-secret credential references while PostgreSQL holds the row
-- lock. This makes concurrent replacements monotonic and prevents callers
-- from choosing or reusing a version. Revocation keeps the current reference
-- disabled; the next real secret replacement advances it exactly once.
CREATE OR REPLACE FUNCTION public.assign_user_api_key_credential_ref()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
  ELSIF NEW.enabled AND (
    NOT OLD.enabled
    OR NEW.encrypted_key IS DISTINCT FROM OLD.encrypted_key
    OR NEW.iv IS DISTINCT FROM OLD.iv
    OR NEW.auth_tag IS DISTINCT FROM OLD.auth_tag
  ) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;

  NEW.credential_ref := NEW.provider || ':v' || NEW.version::text;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assign_user_api_key_credential_ref
  ON public.user_api_keys;
CREATE TRIGGER assign_user_api_key_credential_ref
  BEFORE INSERT OR UPDATE ON public.user_api_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_user_api_key_credential_ref();

-- New chats must carry one exact route. Existing unpinned rows remain
-- readable for historical purposes but are rejected by governed chat calls.
ALTER TABLE public.chats
  ADD COLUMN IF NOT EXISTS model_provider text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS credential_ref text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chats_model_route_consistent'
      AND conrelid = 'public.chats'::regclass
  ) THEN
    ALTER TABLE public.chats
      ADD CONSTRAINT chats_model_route_consistent
      CHECK (
        (model_provider IS NULL AND model IS NULL AND credential_ref IS NULL)
        OR
        (model_provider IS NOT NULL AND model IS NOT NULL AND credential_ref IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chats_model_route
  ON public.chats(model_provider, model, credential_ref);
