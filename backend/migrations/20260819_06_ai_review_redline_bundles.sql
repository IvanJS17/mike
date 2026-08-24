-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Bloque 3B2a: authenticated, immutable redline
-- instructions generated from an approved AI human review. This bundle is a
-- JSON contract for a future Word add-in; it never applies changes to a DOCX.

CREATE TABLE IF NOT EXISTS public.ai_redline_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_version text NOT NULL DEFAULT 'beta-0.1'
    CHECK (bundle_version = 'beta-0.1'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES public.matters(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_version_id uuid NOT NULL
    REFERENCES public.document_versions(id) ON DELETE CASCADE,
  source_document_sha256 text NOT NULL CHECK (source_document_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_id uuid NOT NULL REFERENCES public.ai_receipts(id) ON DELETE CASCADE,
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_json jsonb NOT NULL
    CHECK (jsonb_typeof(canonical_json) = 'object'),
  canonical_json_text text NOT NULL,
  bundle_sha256 text NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  actions_count integer NOT NULL CHECK (actions_count >= 1),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, source_document_version_id, revision)
);

CREATE INDEX IF NOT EXISTS ai_redline_bundles_matter_idx
  ON public.ai_redline_bundles(matter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_redline_bundles_review_idx
  ON public.ai_redline_bundles(review_id, source_document_version_id, revision);
CREATE INDEX IF NOT EXISTS ai_redline_bundles_actor_idx
  ON public.ai_redline_bundles(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ai_redline_bundle_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_execution_matter_id uuid;
  v_execution_project_id uuid;
  v_execution_document_id uuid;
  v_execution_version_id uuid;
  v_execution_content_sha256 text;
  v_execution_status text;
  v_review_status text;
  v_review_matter_id uuid;
  v_review_project_id uuid;
  v_reviewer_user_id uuid;
  v_receipt_execution_id uuid;
  v_receipt_sha256 text;
  v_source_document_id uuid;
  v_source_sha256 text;
  v_organization_id uuid;
  v_action jsonb;
BEGIN
  SELECT
    e.matter_id,
    e.project_id,
    e.document_id,
    e.document_version_id,
    e.document_content_sha256,
    e.status,
    r.status,
    r.matter_id,
    r.project_id,
    r.reviewer_user_id
    INTO
      v_execution_matter_id,
      v_execution_project_id,
      v_execution_document_id,
      v_execution_version_id,
      v_execution_content_sha256,
      v_execution_status,
      v_review_status,
      v_review_matter_id,
      v_review_project_id,
      v_reviewer_user_id
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
     OR NEW.source_document_sha256 IS DISTINCT FROM v_execution_content_sha256
  THEN
    RAISE EXCEPTION 'AI redline bundle scope is invalid or review is not approved';
  END IF;

  SELECT document_id, content_sha256
    INTO v_source_document_id, v_source_sha256
    FROM public.document_versions
   WHERE id = NEW.source_document_version_id
     AND deleted_at IS NULL;
  IF v_source_document_id IS NULL
     OR v_source_document_id IS DISTINCT FROM v_execution_document_id
     OR v_source_sha256 IS DISTINCT FROM NEW.source_document_sha256
  THEN
    RAISE EXCEPTION 'AI redline bundle source version is invalid';
  END IF;

  SELECT execution_id, receipt_sha256
    INTO v_receipt_execution_id, v_receipt_sha256
    FROM public.ai_receipts
   WHERE id = NEW.receipt_id;
  IF v_receipt_execution_id IS DISTINCT FROM NEW.execution_id
     OR v_receipt_sha256 IS DISTINCT FROM NEW.receipt_sha256
  THEN
    RAISE EXCEPTION 'AI redline bundle receipt is invalid';
  END IF;

  IF NEW.canonical_json_text::jsonb IS DISTINCT FROM NEW.canonical_json
     OR encode(digest(NEW.canonical_json_text, 'sha256'), 'hex')
          IS DISTINCT FROM NEW.bundle_sha256
     OR NEW.canonical_json->>'bundle_version' IS DISTINCT FROM NEW.bundle_version
     OR NEW.canonical_json->>'review_id' IS DISTINCT FROM NEW.review_id::text
     OR NEW.canonical_json->>'execution_id' IS DISTINCT FROM NEW.execution_id::text
     OR NEW.canonical_json->>'matter_id' IS DISTINCT FROM NEW.matter_id::text
     OR NEW.canonical_json->>'source_document_version_id'
          IS DISTINCT FROM NEW.source_document_version_id::text
     OR NEW.canonical_json->>'source_document_sha256'
          IS DISTINCT FROM NEW.source_document_sha256
     OR NEW.canonical_json->>'receipt_id' IS DISTINCT FROM NEW.receipt_id::text
     OR NEW.canonical_json->>'receipt_sha256' IS DISTINCT FROM NEW.receipt_sha256
  THEN
    RAISE EXCEPTION 'AI redline bundle canonical JSON integrity failed';
  END IF;

  IF NEW.canonical_json->>'revision' IS NULL
     OR (NEW.canonical_json->>'revision') !~ '^[0-9]+$'
     OR (NEW.canonical_json->>'revision')::integer IS DISTINCT FROM NEW.revision
     OR jsonb_typeof(NEW.canonical_json->'actions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.canonical_json->'actions') <> NEW.actions_count
  THEN
    RAISE EXCEPTION 'AI redline bundle revision or actions are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.canonical_json->'actions') action
     GROUP BY action->>'action_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AI redline bundle contains duplicate action IDs';
  END IF;

  FOR v_action IN
    SELECT value FROM jsonb_array_elements(NEW.canonical_json->'actions')
  LOOP
    IF v_action->>'action_id' IS NULL
       OR v_action->>'item_id' IS NULL
       OR v_action->>'citation_id' IS NULL
       OR v_action->>'source_document_version_id'
            IS DISTINCT FROM NEW.source_document_version_id::text
       OR v_action->>'reviewer_user_id' IS DISTINCT FROM v_reviewer_user_id::text
       OR v_action->>'timestamp' IS NULL
       OR nullif(btrim(v_action->>'replacement_text'), '') IS NULL
       OR v_action->>'before_text_sha256' IS NULL
       OR (v_action->>'before_text_sha256') !~ '^[0-9a-f]{64}$'
       OR (v_action->>'start') IS NULL
       OR (v_action->>'end') IS NULL
       OR (v_action->>'start') !~ '^[0-9]+$'
       OR (v_action->>'end') !~ '^[0-9]+$'
       OR (v_action->>'start')::bigint >= (v_action->>'end')::bigint
    THEN
      RAISE EXCEPTION 'AI redline bundle action is invalid';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.ai_review_items i
       WHERE i.id::text = v_action->>'item_id'
         AND i.review_id = NEW.review_id
         AND i.status IN ('accepted', 'edited')
    ) THEN
      RAISE EXCEPTION 'AI redline bundle action item is outside review scope';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.ai_review_items i
        CROSS JOIN LATERAL jsonb_array_elements(i.citation_refs) citation
       WHERE i.id::text = v_action->>'item_id'
         AND i.review_id = NEW.review_id
         AND citation->>'citation_id' = v_action->>'citation_id'
         AND citation->>'document_version_id'
              = NEW.source_document_version_id::text
         AND citation->>'verified' = 'true'
    ) THEN
      RAISE EXCEPTION 'AI redline bundle action citation is outside review scope';
    END IF;
  END LOOP;

  SELECT w.organization_id
    INTO v_organization_id
    FROM public.matters m
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = v_execution_matter_id;
  IF v_organization_id IS NULL THEN
    RAISE EXCEPTION 'AI redline bundle organization scope is invalid';
  END IF;

  -- Serialize creation with organization revocation. The membership check
  -- cannot pass on a stale authorization snapshot after this lock is taken.
  PERFORM 1
    FROM public.organizations
   WHERE id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI redline bundle organization does not exist';
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
    RAISE EXCEPTION 'AI redline bundle actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_redline_bundle_scope_guard_trigger
  ON public.ai_redline_bundles;
CREATE TRIGGER ai_redline_bundle_scope_guard_trigger
  BEFORE INSERT ON public.ai_redline_bundles
  FOR EACH ROW EXECUTE FUNCTION public.ai_redline_bundle_scope_guard();

CREATE OR REPLACE FUNCTION public.ai_redline_bundles_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai_redline_bundles is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS ai_redline_bundles_insert_only_trigger
  ON public.ai_redline_bundles;
CREATE TRIGGER ai_redline_bundles_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_redline_bundles
  FOR EACH ROW EXECUTE FUNCTION public.ai_redline_bundles_insert_only();

ALTER TABLE public.ai_redline_bundles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_redline_bundles FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ai_redline_bundles TO service_role;

REVOKE ALL ON FUNCTION public.ai_redline_bundle_scope_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_redline_bundle_scope_guard()
  TO service_role;
REVOKE ALL ON FUNCTION public.ai_redline_bundles_insert_only()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_redline_bundles_insert_only()
  TO service_role;
