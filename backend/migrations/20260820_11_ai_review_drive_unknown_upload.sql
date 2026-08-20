-- Migration date: 2026-08-20
-- Bloque 4B fix 2: an uploadDocx rejection has no verifiable remote id.
-- Treat that outcome as terminal so a later request cannot create a duplicate.

DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT conname
    INTO v_constraint
    FROM pg_constraint
   WHERE conrelid = 'public.ai_review_drive_publications'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%drive_upload_failed%'
   LIMIT 1;
  IF v_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.ai_review_drive_publications DROP CONSTRAINT %I',
      v_constraint
    );
  END IF;
END;
$$;

-- Rows written by the previous contract are terminal under the new semantics.
UPDATE public.ai_review_drive_publications
   SET failure_code = 'drive_upload_outcome_unknown',
       updated_at = now()
 WHERE failure_code = 'drive_upload_failed';

ALTER TABLE public.ai_review_drive_publications
  ADD CONSTRAINT ai_review_drive_publications_failure_code_check
  CHECK (failure_code IS NULL OR failure_code IN (
    'drive_upload_outcome_unknown',
    'drive_file_invalid',
    'authorization_revoked',
    'publication_record_failed',
    'drive_cleanup_failed'
  ));

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
  v_current_epoch bigint;
  v_retry boolean := false;
  v_revocation_recovery boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'Invalid AI review Drive publication insert status';
    END IF;
  ELSE
    IF NEW.export_id IS DISTINCT FROM OLD.export_id
       OR NEW.review_id IS DISTINCT FROM OLD.review_id
       OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
       OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch
       OR NEW.drive_folder_id IS DISTINCT FROM OLD.drive_folder_id
       OR NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.format_version IS DISTINCT FROM OLD.format_version
       OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'AI review Drive publication identity is immutable';
    END IF;

    IF OLD.status = 'pending' THEN
      IF NEW.status NOT IN ('published', 'failed') THEN
        RAISE EXCEPTION 'Invalid AI review Drive publication status transition';
      END IF;
    ELSIF OLD.status = 'failed' AND NEW.status = 'pending' THEN
      IF OLD.failure_code NOT IN (
        'drive_file_invalid',
        'publication_record_failed'
      ) THEN
        RAISE EXCEPTION 'AI review Drive publication failure cannot be retried';
      END IF;
      IF NEW.file_id IS NOT NULL
         OR NEW.size_bytes IS NOT NULL
         OR NEW.checksum IS NOT NULL
         OR NEW.failure_code IS NOT NULL
      THEN
        RAISE EXCEPTION 'AI review Drive retry must clear the previous failure';
      END IF;
      v_retry := true;
    ELSE
      RAISE EXCEPTION 'Invalid AI review Drive publication status transition';
    END IF;
  END IF;

  SELECT w.organization_id
    INTO v_organization_id
    FROM public.matters m
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = NEW.matter_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review Drive publication matter does not exist'
      USING ERRCODE = '42501';
  END IF;

  -- revoke_organization_membership takes this same lock before deleting the
  -- organization membership and bumping the epoch. Whichever operation wins
  -- is the linearization point for this publication decision.
  SELECT o.authorization_epoch
    INTO v_current_epoch
    FROM public.organizations o
   WHERE o.id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review Drive publication organization does not exist'
      USING ERRCODE = '42501';
  END IF;
  IF v_organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'AI review Drive publication organization scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF v_retry THEN
    IF v_current_epoch IS DISTINCT FROM NEW.authorization_epoch THEN
      RAISE EXCEPTION 'AI review Drive publication authorization changed'
        USING ERRCODE = '42501';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status = 'failed'
       AND NEW.failure_code = 'authorization_revoked'
       AND v_current_epoch > OLD.authorization_epoch
    THEN
      -- A revoke-wins cleanup may close a pending row after membership removal.
      -- A later retry remains blocked because authorization_revoked is terminal.
      v_revocation_recovery := true;
    ELSIF v_current_epoch IS DISTINCT FROM NEW.authorization_epoch THEN
      RAISE EXCEPTION 'AI review Drive publication authorization changed'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_current_epoch IS DISTINCT FROM NEW.authorization_epoch THEN
    RAISE EXCEPTION 'AI review Drive publication authorization changed'
      USING ERRCODE = '42501';
  END IF;

  -- INSERT and failed -> pending both revalidate the complete publication
  -- identity after the organization lock is held. The API separately verifies
  -- the bytes in storage immediately before claiming/uploading.
  IF TG_OP = 'INSERT' OR v_retry THEN
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
     WHERE ex.id = NEW.export_id
     FOR UPDATE;

    IF NOT FOUND
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
       OR v_organization_id IS DISTINCT FROM NEW.organization_id
    THEN
      RAISE EXCEPTION 'AI review Drive publication scope is invalid';
    END IF;
  END IF;

  IF v_revocation_recovery THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.matter_memberships mm
       WHERE mm.matter_id = NEW.matter_id
         AND mm.user_id = NEW.actor_user_id
         AND mm.role IN ('matter_owner', 'editor')
    ) THEN
      RAISE EXCEPTION 'AI review Drive publication actor is not authorized'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
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
END;
$$;

DROP TRIGGER IF EXISTS ai_review_drive_publication_guard_trigger
  ON public.ai_review_drive_publications;
CREATE TRIGGER ai_review_drive_publication_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_review_drive_publications
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_drive_publication_guard();

REVOKE ALL ON FUNCTION public.ai_review_drive_publication_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_drive_publication_guard()
  TO service_role;
