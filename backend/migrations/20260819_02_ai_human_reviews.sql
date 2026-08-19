-- Migration date: 2026-08-19
-- Beta Jurídica 0.1 / Bloque 3A: human review of finalized AI output.
-- Reviews are assigned to a second matter lawyer. Item projections are mutable
-- only while a review is open; every decision is insert-only with actor and
-- before/after state snapshots.

CREATE TABLE IF NOT EXISTS public.ai_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES public.ai_executions(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES public.matters(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'in_progress' CHECK (
    status IN ('in_progress', 'approved', 'changes_requested')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_reviews_matter_idx
  ON public.ai_reviews(matter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_reviews_reviewer_idx
  ON public.ai_reviews(reviewer_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  original_text text NOT NULL,
  finding_text text NOT NULL,
  citation_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citation_refs) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'rejected', 'edited')
  ),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, item_key)
);

CREATE INDEX IF NOT EXISTS ai_review_items_review_idx
  ON public.ai_review_items(review_id, created_at);

CREATE TABLE IF NOT EXISTS public.ai_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.ai_reviews(id) ON DELETE CASCADE,
  review_item_id uuid REFERENCES public.ai_review_items(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (
    decision IN ('accepted', 'rejected', 'edited', 'approved', 'changes_requested')
  ),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (review_item_id IS NULL AND decision IN ('approved', 'changes_requested'))
    OR (review_item_id IS NOT NULL AND decision IN ('accepted', 'rejected', 'edited'))
  )
);

CREATE INDEX IF NOT EXISTS ai_review_decisions_review_idx
  ON public.ai_review_decisions(review_id, created_at);
CREATE INDEX IF NOT EXISTS ai_review_decisions_item_idx
  ON public.ai_review_decisions(review_item_id, created_at);

CREATE OR REPLACE FUNCTION public.ai_review_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  execution_user_id uuid;
  execution_matter_id uuid;
  execution_project_id uuid;
  execution_status text;
BEGIN
  SELECT user_id, matter_id, project_id, status
    INTO execution_user_id, execution_matter_id, execution_project_id, execution_status
    FROM public.ai_executions
   WHERE id = NEW.execution_id;

  IF execution_user_id IS NULL
     OR execution_status IS DISTINCT FROM 'succeeded'
     OR execution_matter_id IS DISTINCT FROM NEW.matter_id
     OR execution_project_id IS DISTINCT FROM NEW.project_id
  THEN
    RAISE EXCEPTION 'AI review execution scope is invalid or not finalized';
  END IF;

  IF NEW.reviewer_user_id IS NOT DISTINCT FROM execution_user_id THEN
    RAISE EXCEPTION 'AI execution author cannot be its reviewer';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.matters m ON m.id = mm.matter_id
      JOIN public.workspaces w ON w.id = m.workspace_id
      JOIN public.organization_memberships om
        ON om.organization_id = w.organization_id
       AND om.user_id = NEW.reviewer_user_id
     WHERE mm.matter_id = NEW.matter_id
       AND mm.user_id = NEW.reviewer_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI reviewer is not an active matter lawyer';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.execution_id IS DISTINCT FROM OLD.execution_id
    OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'AI review identity is immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_scope_guard_trigger ON public.ai_reviews;
CREATE TRIGGER ai_review_scope_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_reviews
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_scope_guard();

CREATE OR REPLACE FUNCTION public.ai_review_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'Completed AI review is immutable';
  END IF;
  IF NEW.status NOT IN ('approved', 'changes_requested') THEN
    RAISE EXCEPTION 'Invalid AI review status transition';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.ai_executions e
       WHERE e.id = NEW.execution_id
         AND e.status = 'succeeded'
    ) THEN
      RAISE EXCEPTION 'AI review cannot be approved for an unfinished execution';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.ai_review_items i WHERE i.review_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'AI review requires at least one finding';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.ai_review_items i
        CROSS JOIN LATERAL jsonb_array_elements(i.citation_refs) citation
       WHERE i.review_id = NEW.id
         AND COALESCE(citation->>'verified', 'false') <> 'true'
    ) THEN
      RAISE EXCEPTION 'AI review cannot be approved with an unverified citation';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.ai_review_items i
       WHERE i.review_id = NEW.id
         AND i.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'AI review cannot be approved with pending findings';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_update_guard_trigger ON public.ai_reviews;
CREATE TRIGGER ai_review_update_guard_trigger
  BEFORE UPDATE ON public.ai_reviews
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_update_guard();

CREATE OR REPLACE FUNCTION public.ai_review_item_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  review_status text;
BEGIN
  IF NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.item_key IS DISTINCT FROM OLD.item_key
     OR NEW.original_text IS DISTINCT FROM OLD.original_text
     OR NEW.citation_refs IS DISTINCT FROM OLD.citation_refs
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'AI review item source is immutable';
  END IF;
  SELECT status INTO review_status FROM public.ai_reviews WHERE id = OLD.review_id;
  IF review_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'Completed AI review items are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_item_update_guard_trigger ON public.ai_review_items;
CREATE TRIGGER ai_review_item_update_guard_trigger
  BEFORE UPDATE ON public.ai_review_items
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_item_update_guard();

CREATE OR REPLACE FUNCTION public.ai_review_decision_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  review_reviewer uuid;
  review_status text;
  item_review_id uuid;
BEGIN
  SELECT reviewer_user_id, status
    INTO review_reviewer, review_status
    FROM public.ai_reviews
   WHERE id = NEW.review_id;
  IF review_reviewer IS NULL OR NEW.actor_user_id IS DISTINCT FROM review_reviewer THEN
    RAISE EXCEPTION 'AI review decision actor is not the assigned reviewer';
  END IF;

  IF NEW.review_item_id IS NULL THEN
    IF review_status IS DISTINCT FROM NEW.decision THEN
      RAISE EXCEPTION 'AI review completion decision does not match review status';
    END IF;
  ELSE
    SELECT review_id INTO item_review_id
      FROM public.ai_review_items
     WHERE id = NEW.review_item_id;
    IF item_review_id IS DISTINCT FROM NEW.review_id OR review_status IS DISTINCT FROM 'in_progress' THEN
      RAISE EXCEPTION 'AI item decision scope is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_review_decision_insert_guard_trigger ON public.ai_review_decisions;
CREATE TRIGGER ai_review_decision_insert_guard_trigger
  BEFORE INSERT ON public.ai_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_decision_insert_guard();

CREATE OR REPLACE FUNCTION public.ai_review_decisions_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai_review_decisions is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS ai_review_decisions_insert_only_trigger ON public.ai_review_decisions;
CREATE TRIGGER ai_review_decisions_insert_only_trigger
  BEFORE UPDATE OR DELETE ON public.ai_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_decisions_insert_only();

ALTER TABLE public.ai_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_review_decisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_reviews FROM anon, authenticated;
REVOKE ALL ON public.ai_review_items FROM anon, authenticated;
REVOKE ALL ON public.ai_review_decisions FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.ai_reviews TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_review_items TO service_role;
GRANT SELECT, INSERT ON public.ai_review_decisions TO service_role;
