-- Migration date: 2026-08-19
-- Bloque 3A fix 1: make organization revocation and human-review writes
-- linearizable at the organization authorization boundary.

-- Membership deletion and epoch invalidation must share one transaction and lock
-- the organization before deleting the membership. Review write guards acquire
-- the same lock, so a revocation that wins the race is observed before a write.
CREATE OR REPLACE FUNCTION public.revoke_organization_membership(
  p_org uuid,
  p_user uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM public.organizations
   WHERE id = p_org
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization does not exist';
  END IF;

  DELETE FROM public.organization_memberships
   WHERE organization_id = p_org
     AND user_id = p_user;

  UPDATE public.organizations
     SET authorization_epoch = authorization_epoch + 1
   WHERE id = p_org;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_organization_membership(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_organization_membership(uuid, uuid)
  TO service_role;

-- This trigger is the database-side write boundary for review mutations. The
-- API revalidates the captured organization/epoch immediately before each
-- side effect; this guard independently verifies the actor's live matter and
-- organization memberships and serializes the check with revocation.
CREATE OR REPLACE FUNCTION public.ai_review_write_authorization_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_review_id uuid;
  v_actor_id uuid;
  v_matter_id uuid;
  v_reviewer_id uuid;
  v_organization_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'ai_reviews' THEN
    v_review_id := NEW.id;
    v_actor_id := NEW.reviewer_user_id;
    v_matter_id := NEW.matter_id;
    v_reviewer_id := NEW.reviewer_user_id;
  ELSE
    v_review_id := NEW.review_id;
    SELECT r.matter_id, r.reviewer_user_id
      INTO v_matter_id, v_reviewer_id
      FROM public.ai_reviews r
     WHERE r.id = v_review_id
     FOR SHARE;
    IF TG_TABLE_NAME = 'ai_review_decisions' THEN
      v_actor_id := NEW.actor_user_id;
    ELSE
      -- Item projections do not carry an actor column. They can only be
      -- reached after the assigned reviewer's decision has passed the decision
      -- guard, and must still be protected against a revocation race.
      v_actor_id := v_reviewer_id;
    END IF;
  END IF;

  IF v_review_id IS NULL
     OR v_actor_id IS NULL
     OR v_matter_id IS NULL
     OR v_reviewer_id IS NULL
     OR v_actor_id IS DISTINCT FROM v_reviewer_id
  THEN
    RAISE EXCEPTION 'AI review actor is not authorized for this write'
      USING ERRCODE = '42501';
  END IF;

  SELECT w.organization_id
    INTO v_organization_id
    FROM public.matters m
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = v_matter_id;

  IF v_organization_id IS NULL THEN
    RAISE EXCEPTION 'AI review organization scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  -- The revocation RPC takes this lock before deleting membership and bumping
  -- the epoch. This gives the authorization check a deterministic order with
  -- a concurrent revocation instead of accepting a stale membership snapshot.
  PERFORM 1
    FROM public.organizations
   WHERE id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review organization does not exist'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_matter_id
       AND mm.user_id = v_actor_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI review actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aaa_ai_review_write_authorization_guard_trigger
  ON public.ai_reviews;
CREATE TRIGGER aaa_ai_review_write_authorization_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_reviews
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_write_authorization_guard();

DROP TRIGGER IF EXISTS aaa_ai_review_item_write_authorization_guard_trigger
  ON public.ai_review_items;
CREATE TRIGGER aaa_ai_review_item_write_authorization_guard_trigger
  BEFORE INSERT OR UPDATE ON public.ai_review_items
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_write_authorization_guard();

DROP TRIGGER IF EXISTS aaa_ai_review_decision_write_authorization_guard_trigger
  ON public.ai_review_decisions;
CREATE TRIGGER aaa_ai_review_decision_write_authorization_guard_trigger
  BEFORE INSERT ON public.ai_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.ai_review_write_authorization_guard();

REVOKE ALL ON FUNCTION public.ai_review_write_authorization_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_review_write_authorization_guard()
  TO service_role;
