-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Bloque 4A: publish an approved human-review DOCX
-- exactly once to an explicitly configured Google Shared Drive folder.

ALTER TABLE public.matters
  ADD COLUMN IF NOT EXISTS drive_folder_id text;

ALTER TABLE public.matters
  DROP CONSTRAINT IF EXISTS matters_drive_folder_id_check;

ALTER TABLE public.matters
  ADD CONSTRAINT matters_drive_folder_id_check
  CHECK (drive_folder_id IS NULL OR btrim(drive_folder_id) <> '');

CREATE TABLE IF NOT EXISTS public.ai_review_drive_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id uuid NOT NULL UNIQUE
    REFERENCES public.ai_review_exports(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES public.matters(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  drive_folder_id text NOT NULL CHECK (btrim(drive_folder_id) <> ''),
  file_id text,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  format_version text NOT NULL CHECK (format_version = 'beta-0.1'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'failed')),
  size_bytes bigint,
  checksum text,
  failure_code text CHECK (failure_code IN (
    'drive_upload_failed',
    'drive_file_invalid',
    'authorization_revoked',
    'publication_record_failed'
  )),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending'
      AND file_id IS NULL
      AND size_bytes IS NULL
      AND checksum IS NULL
      AND failure_code IS NULL)
    OR (status = 'published'
      AND nullif(btrim(file_id), '') IS NOT NULL
      AND size_bytes IS NOT NULL
      AND size_bytes >= 0
      AND nullif(btrim(checksum), '') IS NOT NULL
      AND failure_code IS NULL)
    OR (status = 'failed'
      AND file_id IS NULL
      AND size_bytes IS NULL
      AND checksum IS NULL
      AND failure_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_review_drive_publications_matter_idx
  ON public.ai_review_drive_publications(matter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_review_drive_publications_review_idx
  ON public.ai_review_drive_publications(review_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ai_review_drive_publication_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_export_review_id uuid;
  v_export_execution_id uuid;
  v_export_matter_id uuid;
  v_export_project_id uuid;
  v_export_sha256 text;
  v_review_status text;
  v_execution_status text;
  v_matter_project_id uuid;
  v_matter_folder_id text;
  v_organization_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT
      ex.review_id,
      ex.execution_id,
      ex.matter_id,
      ex.project_id,
      ex.content_sha256,
      r.status,
      e.status,
      m.project_id,
      m.drive_folder_id,
      w.organization_id
      INTO
        v_export_review_id,
        v_export_execution_id,
        v_export_matter_id,
        v_export_project_id,
        v_export_sha256,
        v_review_status,
        v_execution_status,
        v_matter_project_id,
        v_matter_folder_id,
        v_organization_id
      FROM public.ai_review_exports ex
      JOIN public.ai_reviews r ON r.id = ex.review_id
      JOIN public.ai_executions e ON e.id = ex.execution_id
      JOIN public.matters m ON m.id = ex.matter_id
      JOIN public.workspaces w ON w.id = m.workspace_id
     WHERE ex.id = NEW.export_id;

    IF NOT FOUND
       OR NEW.status IS DISTINCT FROM 'pending'
       OR v_review_status IS DISTINCT FROM 'approved'
       OR v_execution_status IS DISTINCT FROM 'succeeded'
       OR v_export_review_id IS DISTINCT FROM NEW.review_id
       OR v_export_execution_id IS DISTINCT FROM NEW.execution_id
       OR v_export_matter_id IS DISTINCT FROM NEW.matter_id
       OR v_export_project_id IS DISTINCT FROM NEW.project_id
       OR v_matter_project_id IS DISTINCT FROM NEW.project_id
       OR v_matter_folder_id IS NULL
       OR v_matter_folder_id IS DISTINCT FROM NEW.drive_folder_id
       OR v_export_sha256 IS DISTINCT FROM NEW.sha256
    THEN
      RAISE EXCEPTION 'AI review Drive publication scope is invalid';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.matter_memberships mm
        JOIN public.organization_memberships om
          ON om.organization_id = v_organization_id
         AND om.user_id = mm.user_id
       WHERE mm.matter_id = NEW.matter_id
         AND mm.user_id = NEW.actor_user_id
         AND mm.role IN ('matter_owner', 'editor')
    ) THEN
      RAISE EXCEPTION 'AI review Drive publication actor is not authorized'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM 'pending'
     OR NEW.export_id IS DISTINCT FROM OLD.export_id
     OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.drive_folder_id IS DISTINCT FROM OLD.drive_folder_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.format_version IS DISTINCT FROM OLD.format_version
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'AI review Drive publication identity is immutable';
  END IF;

  IF NEW.status NOT IN ('published', 'failed') THEN
    RAISE EXCEPTION 'Invalid AI review Drive publication status transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_drive_publication_guard_trigger
  ON public.ai_review_drive_publications;
CREATE TRIGGER ai_review_drive_publication_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_review_drive_publications
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_drive_publication_guard();

ALTER TABLE public.ai_review_drive_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_review_drive_publications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_review_drive_publications TO service_role;

REVOKE ALL ON FUNCTION public.ai_review_drive_publication_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_drive_publication_guard()
  TO service_role;
