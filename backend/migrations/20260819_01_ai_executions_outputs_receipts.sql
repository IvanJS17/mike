-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Fase 2: durable AI executions, immutable outputs,
-- canonical receipts and version-bound citation pages.
--
-- The API uses service_role after authentication and authorization. Browser
-- roles receive no grants on these tables; the triggers below remain active
-- for service_role so append-only and identity invariants cannot be bypassed.

-- A matter may optionally be the private domain scope for a legacy project.
ALTER TABLE public.matters
  ADD COLUMN IF NOT EXISTS project_id uuid
  REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS matters_project_id_idx
  ON public.matters(project_id)
  WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ai_document_version_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  page integer NOT NULL CHECK (page >= 1),
  content text NOT NULL,
  content_sha256 text NOT NULL CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND content_sha256 = encode(digest(content, 'sha256'), 'hex')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_version_id, page)
);

CREATE INDEX IF NOT EXISTS ai_document_version_pages_version_idx
  ON public.ai_document_version_pages(document_version_id, page);

CREATE TABLE IF NOT EXISTS public.ai_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  matter_id uuid REFERENCES public.matters(id) ON DELETE SET NULL,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  chat_id uuid REFERENCES public.chats(id) ON DELETE SET NULL,
  workflow_id text NOT NULL,
  workflow_version text NOT NULL,
  playbook_sha256 text NOT NULL CHECK (playbook_sha256 ~ '^[0-9a-f]{64}$'),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  document_content_sha256 text NOT NULL CHECK (document_content_sha256 ~ '^[0-9a-f]{64}$'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  route_provider text NOT NULL CHECK (
    route_provider IN ('openai', 'claude', 'gemini', 'openrouter', 'deepseek', 'opencode-zen', 'opencode-go')
  ),
  route_model text NOT NULL,
  credential_ref text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed')
  ),
  error_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_executions_user_created_idx
  ON public.ai_executions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_executions_document_version_idx
  ON public.ai_executions(document_version_id);
CREATE INDEX IF NOT EXISTS ai_executions_project_idx
  ON public.ai_executions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_output_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  output_format text NOT NULL CHECK (output_format = 'markdown'),
  output_text text NOT NULL,
  output_sha256 text NOT NULL CHECK (output_sha256 ~ '^[0-9a-f]{64}$'),
  citation_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_output_versions_execution_idx
  ON public.ai_output_versions(execution_id);

CREATE TABLE IF NOT EXISTS public.ai_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  receipt_version text NOT NULL DEFAULT 'beta-0.1',
  canonical_json jsonb NOT NULL,
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_receipts_execution_idx
  ON public.ai_receipts(execution_id);

CREATE OR REPLACE FUNCTION public.ai_document_version_pages_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  version_document_id uuid;
BEGIN
  SELECT document_id
    INTO version_document_id
    FROM public.document_versions
   WHERE id = NEW.document_version_id
     AND deleted_at IS NULL;
  IF version_document_id IS NULL OR version_document_id IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'AI citation page does not belong to document version';
  END IF;
  IF NEW.content_sha256 IS DISTINCT FROM encode(digest(NEW.content, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'AI citation page content hash mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_document_version_pages_integrity_trigger
  ON public.ai_document_version_pages;
CREATE TRIGGER ai_document_version_pages_integrity_trigger
  BEFORE INSERT OR UPDATE ON public.ai_document_version_pages
  FOR EACH ROW EXECUTE FUNCTION public.ai_document_version_pages_integrity();

CREATE OR REPLACE FUNCTION public.ai_execution_scope_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  version_document_id uuid;
  matter_project_id uuid;
BEGIN
  SELECT document_id
    INTO version_document_id
    FROM public.document_versions
   WHERE id = NEW.document_version_id
     AND deleted_at IS NULL;
  IF version_document_id IS NULL OR version_document_id IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'AI execution document version does not belong to document';
  END IF;
  IF NEW.matter_id IS NOT NULL THEN
    SELECT project_id
      INTO matter_project_id
      FROM public.matters
     WHERE id = NEW.matter_id;
    IF matter_project_id IS NULL OR matter_project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'AI execution matter does not belong to project';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_execution_scope_integrity_trigger
  ON public.ai_executions;
CREATE TRIGGER ai_execution_scope_integrity_trigger
  BEFORE INSERT OR UPDATE ON public.ai_executions
  FOR EACH ROW EXECUTE FUNCTION public.ai_execution_scope_integrity();

CREATE OR REPLACE FUNCTION public.ai_execution_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'Terminal AI execution is immutable';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.chat_id IS DISTINCT FROM OLD.chat_id
     OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
     OR NEW.workflow_version IS DISTINCT FROM OLD.workflow_version
     OR NEW.playbook_sha256 IS DISTINCT FROM OLD.playbook_sha256
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.document_content_sha256 IS DISTINCT FROM OLD.document_content_sha256
     OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
     OR NEW.route_provider IS DISTINCT FROM OLD.route_provider
     OR NEW.route_model IS DISTINCT FROM OLD.route_model
     OR NEW.credential_ref IS DISTINCT FROM OLD.credential_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'AI execution identity is immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('running', 'failed'))
    OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Invalid AI execution status transition';
  END IF;

  IF NEW.status = 'succeeded' AND (
    NEW.finished_at IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.ai_output_versions WHERE execution_id = NEW.id)
    OR NOT EXISTS (SELECT 1 FROM public.ai_receipts WHERE execution_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'Succeeded AI execution requires output and receipt';
  END IF;
  IF NEW.status = 'failed' AND nullif(btrim(NEW.error_class), '') IS NULL THEN
    RAISE EXCEPTION 'Failed AI execution requires error class';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_execution_update_guard_trigger
  ON public.ai_executions;
CREATE TRIGGER ai_execution_update_guard_trigger
  BEFORE UPDATE ON public.ai_executions
  FOR EACH ROW EXECUTE FUNCTION public.ai_execution_update_guard();

CREATE OR REPLACE FUNCTION public.ai_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI pages, outputs and receipts are insert-only';
END;
$$;

DROP TRIGGER IF EXISTS ai_document_version_pages_insert_only_trigger
  ON public.ai_document_version_pages;
CREATE TRIGGER ai_document_version_pages_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_document_version_pages
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();

DROP TRIGGER IF EXISTS ai_output_versions_insert_only_trigger
  ON public.ai_output_versions;
CREATE TRIGGER ai_output_versions_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_output_versions
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();

DROP TRIGGER IF EXISTS ai_receipts_insert_only_trigger
  ON public.ai_receipts;
CREATE TRIGGER ai_receipts_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_receipts
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();

ALTER TABLE public.ai_document_version_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_output_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_document_version_pages FROM anon, authenticated;
REVOKE ALL ON public.ai_executions FROM anon, authenticated;
REVOKE ALL ON public.ai_output_versions FROM anon, authenticated;
REVOKE ALL ON public.ai_receipts FROM anon, authenticated;

GRANT SELECT, INSERT ON public.ai_document_version_pages TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_executions TO service_role;
GRANT SELECT, INSERT ON public.ai_output_versions TO service_role;
GRANT SELECT, INSERT ON public.ai_receipts TO service_role;
