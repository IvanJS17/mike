-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Bloque 3B1: immutable DOCX reports generated only
-- from an approved human review.

ALTER TABLE public.document_versions
  DROP CONSTRAINT IF EXISTS document_versions_source_check;

ALTER TABLE public.document_versions
  ADD CONSTRAINT document_versions_source_check
  CHECK (source = ANY (ARRAY[
    'upload'::text,
    'user_upload'::text,
    'assistant_edit'::text,
    'user_accept'::text,
    'user_reject'::text,
    'generated'::text,
    'ai_review_report'::text
  ]));

CREATE TABLE IF NOT EXISTS public.ai_review_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES public.matters(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  report_version integer NOT NULL DEFAULT 1 CHECK (report_version >= 1),
  filename text NOT NULL CHECK (filename = 'Informe de revision humana.docx'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, source_document_version_id),
  UNIQUE (document_version_id)
);

CREATE INDEX IF NOT EXISTS ai_review_exports_matter_idx
  ON public.ai_review_exports(matter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_review_exports_actor_idx
  ON public.ai_review_exports(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ai_review_export_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_execution_matter_id uuid;
  v_execution_project_id uuid;
  v_execution_document_id uuid;
  v_execution_version_id uuid;
  v_execution_status text;
  v_review_status text;
  v_review_matter_id uuid;
  v_review_project_id uuid;
  v_source_document_id uuid;
  v_report_document_id uuid;
  v_report_content_sha256 text;
  v_organization_id uuid;
BEGIN
  SELECT
    e.matter_id,
    e.project_id,
    e.document_id,
    e.document_version_id,
    e.status,
    r.status,
    r.matter_id,
    r.project_id
    INTO
      v_execution_matter_id,
      v_execution_project_id,
      v_execution_document_id,
      v_execution_version_id,
      v_execution_status,
      v_review_status,
      v_review_matter_id,
      v_review_project_id
    FROM public.ai_reviews r
    JOIN public.ai_executions e ON e.id = r.execution_id
   WHERE r.id = NEW.review_id
     AND e.id = NEW.execution_id;

  IF NOT FOUND
     OR v_execution_status IS DISTINCT FROM 'succeeded'
     OR v_review_status IS DISTINCT FROM 'approved'
     OR v_execution_matter_id IS NULL
     OR v_review_matter_id IS DISTINCT FROM v_execution_matter_id
     OR v_review_project_id IS DISTINCT FROM v_execution_project_id
     OR NEW.matter_id IS DISTINCT FROM v_execution_matter_id
     OR NEW.project_id IS DISTINCT FROM v_execution_project_id
     OR NEW.source_document_version_id IS DISTINCT FROM v_execution_version_id
  THEN
    RAISE EXCEPTION 'AI review export scope is invalid or review is not approved';
  END IF;

  SELECT document_id
    INTO v_source_document_id
    FROM public.document_versions
   WHERE id = NEW.source_document_version_id
     AND deleted_at IS NULL;
  IF v_source_document_id IS NULL
     OR v_source_document_id IS DISTINCT FROM v_execution_document_id
  THEN
    RAISE EXCEPTION 'AI review export source version is outside execution scope';
  END IF;

  SELECT document_id, content_sha256
    INTO v_report_document_id, v_report_content_sha256
    FROM public.document_versions
   WHERE id = NEW.document_version_id
     AND deleted_at IS NULL
     AND source = 'ai_review_report';
  IF v_report_document_id IS NULL
     OR v_report_document_id IS DISTINCT FROM NEW.document_id
     OR v_report_content_sha256 IS DISTINCT FROM NEW.content_sha256
  THEN
    RAISE EXCEPTION 'AI review export report version is invalid';
  END IF;

  SELECT w.organization_id
    INTO v_organization_id
    FROM public.matters m
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = v_execution_matter_id;
  IF v_organization_id IS NULL THEN
    RAISE EXCEPTION 'AI review export organization scope is invalid';
  END IF;

  -- Serialize export creation with organization revocation. The membership
  -- check therefore cannot pass on a stale authorization snapshot.
  PERFORM 1
    FROM public.organizations
   WHERE id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review export organization does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_execution_matter_id
       AND mm.user_id = NEW.actor_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI review export actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_export_scope_guard_trigger
  ON public.ai_review_exports;
CREATE TRIGGER ai_review_export_scope_guard_trigger
  BEFORE INSERT ON public.ai_review_exports
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_export_scope_guard();

CREATE OR REPLACE FUNCTION public.ai_review_exports_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai_review_exports is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS ai_review_exports_insert_only_trigger
  ON public.ai_review_exports;
CREATE TRIGGER ai_review_exports_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_review_exports
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_exports_insert_only();

ALTER TABLE public.ai_review_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_review_exports FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ai_review_exports TO service_role;

REVOKE ALL ON FUNCTION public.ai_review_export_scope_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_export_scope_guard() TO service_role;
REVOKE ALL ON FUNCTION public.ai_review_exports_insert_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_exports_insert_only() TO service_role;
