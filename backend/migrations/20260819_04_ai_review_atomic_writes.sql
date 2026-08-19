-- Migration date: 2026-08-19
-- Bloque 3A fix 1B: keep each human-review mutation and its projection
-- inside one transaction while serializing it with organization revocation.

CREATE OR REPLACE FUNCTION public.apply_ai_review_item_decision(
  p_review_id uuid,
  p_item_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_decision text,
  p_finding_text text,
  p_comment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_matter_id uuid;
  v_reviewer_user_id uuid;
  v_review_status text;
  v_organization_id uuid;
  v_current_epoch bigint;
  v_item public.ai_review_items%ROWTYPE;
  v_updated_item public.ai_review_items%ROWTYPE;
  v_decision_row public.ai_review_decisions%ROWTYPE;
  v_before_state jsonb;
  v_after_state jsonb;
  v_finding_text text;
  v_comment text;
BEGIN
  IF p_decision NOT IN ('accepted', 'rejected', 'edited') THEN
    RAISE EXCEPTION 'Invalid AI review item decision';
  END IF;
  IF p_comment IS NOT NULL AND char_length(p_comment) > 2000 THEN
    RAISE EXCEPTION 'AI review comment is too long';
  END IF;
  IF p_decision = 'edited' AND nullif(btrim(p_finding_text), '') IS NULL THEN
    RAISE EXCEPTION 'Edited AI review finding must not be empty';
  END IF;

  -- Resolve the organization before taking its lock. The lock is then held for
  -- the complete RPC, including both the decision insert and item update.
  SELECT r.matter_id, r.reviewer_user_id, r.status, w.organization_id
    INTO v_matter_id, v_reviewer_user_id, v_review_status, v_organization_id
    FROM public.ai_reviews r
    JOIN public.matters m ON m.id = r.matter_id
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE r.id = p_review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review not found';
  END IF;
  IF v_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'AI review organization scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT o.authorization_epoch
    INTO v_current_epoch
    FROM public.organizations o
   WHERE o.id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND OR v_current_epoch IS DISTINCT FROM p_authorization_epoch THEN
    RAISE EXCEPTION 'AI review authorization changed'
      USING ERRCODE = '42501';
  END IF;

  IF v_reviewer_user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'AI review actor is not the assigned reviewer'
      USING ERRCODE = '42501';
  END IF;
  IF v_review_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'AI review is already complete';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_matter_id
       AND mm.user_id = p_actor_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI review actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize concurrent item decisions/completion against this review after
  -- the authorization lock has established the revocation ordering.
  SELECT *
    INTO v_item
    FROM public.ai_review_items i
   WHERE i.id = p_item_id
     AND i.review_id = p_review_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review item not found';
  END IF;

  v_comment := CASE
    WHEN p_comment IS NULL THEN NULL
    ELSE nullif(btrim(p_comment), '')
  END;
  v_finding_text := CASE
    WHEN p_decision = 'edited' THEN btrim(p_finding_text)
    ELSE v_item.finding_text
  END;
  v_before_state := jsonb_build_object(
    'status', v_item.status,
    'finding_text', v_item.finding_text,
    'comment', v_item.comment
  );
  v_after_state := jsonb_build_object(
    'status', p_decision,
    'finding_text', v_finding_text,
    'comment', v_comment
  );

  INSERT INTO public.ai_review_decisions (
    review_id,
    review_item_id,
    actor_user_id,
    decision,
    before_state,
    after_state,
    comment
  ) VALUES (
    p_review_id,
    p_item_id,
    p_actor_user_id,
    p_decision,
    v_before_state,
    v_after_state,
    v_comment
  )
  RETURNING * INTO v_decision_row;

  UPDATE public.ai_review_items
     SET status = p_decision,
         finding_text = v_finding_text,
         comment = v_comment,
         updated_at = now()
   WHERE id = p_item_id
     AND review_id = p_review_id
  RETURNING * INTO v_updated_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review item projection failed';
  END IF;

  RETURN jsonb_build_object(
    'item', to_jsonb(v_updated_item),
    'decision', to_jsonb(v_decision_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_ai_review_item_decision(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_ai_review_item_decision(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_ai_review(
  p_review_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_authorization_epoch bigint,
  p_status text,
  p_comment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_matter_id uuid;
  v_reviewer_user_id uuid;
  v_review_status text;
  v_organization_id uuid;
  v_current_epoch bigint;
  v_review public.ai_reviews%ROWTYPE;
  v_decision_row public.ai_review_decisions%ROWTYPE;
  v_comment text;
BEGIN
  IF p_status NOT IN ('approved', 'changes_requested') THEN
    RAISE EXCEPTION 'Invalid AI review completion status';
  END IF;
  IF p_comment IS NOT NULL AND char_length(p_comment) > 2000 THEN
    RAISE EXCEPTION 'AI review comment is too long';
  END IF;

  SELECT r.matter_id, r.reviewer_user_id, r.status, w.organization_id
    INTO v_matter_id, v_reviewer_user_id, v_review_status, v_organization_id
    FROM public.ai_reviews r
    JOIN public.matters m ON m.id = r.matter_id
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE r.id = p_review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review not found';
  END IF;
  IF v_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'AI review organization scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT o.authorization_epoch
    INTO v_current_epoch
    FROM public.organizations o
   WHERE o.id = v_organization_id
   FOR UPDATE;
  IF NOT FOUND OR v_current_epoch IS DISTINCT FROM p_authorization_epoch THEN
    RAISE EXCEPTION 'AI review authorization changed'
      USING ERRCODE = '42501';
  END IF;

  IF v_reviewer_user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'AI review actor is not the assigned reviewer'
      USING ERRCODE = '42501';
  END IF;
  IF v_review_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'AI review is already complete';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.matter_memberships mm
      JOIN public.organization_memberships om
        ON om.organization_id = v_organization_id
       AND om.user_id = mm.user_id
     WHERE mm.matter_id = v_matter_id
       AND mm.user_id = p_actor_user_id
       AND mm.role IN ('matter_owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'AI review actor is not an active matter lawyer'
      USING ERRCODE = '42501';
  END IF;

  -- The review update and terminal decision are deliberately ordered this way
  -- because the existing decision trigger requires the new terminal status.
  -- Both writes remain in this RPC transaction; any later trigger/constraint
  -- failure rolls the status update back with the decision insert.
  UPDATE public.ai_reviews
     SET status = p_status,
         completed_at = now()
   WHERE id = p_review_id
     AND status = 'in_progress'
  RETURNING * INTO v_review;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI review completion failed';
  END IF;

  v_comment := CASE
    WHEN p_comment IS NULL THEN NULL
    ELSE nullif(btrim(p_comment), '')
  END;

  INSERT INTO public.ai_review_decisions (
    review_id,
    review_item_id,
    actor_user_id,
    decision,
    before_state,
    after_state,
    comment
  ) VALUES (
    p_review_id,
    NULL,
    p_actor_user_id,
    p_status,
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object('status', p_status, 'comment', v_comment),
    v_comment
  )
  RETURNING * INTO v_decision_row;

  RETURN jsonb_build_object(
    'review', to_jsonb(v_review),
    'decision', to_jsonb(v_decision_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_ai_review(
  uuid, uuid, uuid, bigint, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_review(
  uuid, uuid, uuid, bigint, text, text
) TO service_role;
