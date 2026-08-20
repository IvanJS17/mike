-- Migration date: 2026-08-19
-- Bloque 3B2a fix: serialize the final redline-bundle access decision with
-- organization revocation before an existing bundle is returned.

CREATE OR REPLACE FUNCTION public.assert_ai_redline_bundle_access(
  p_matter uuid,
  p_user uuid,
  p_organization uuid,
  p_authorization_epoch bigint,
  p_intent text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_epoch bigint;
BEGIN
  -- revoke_organization_membership takes this same lock before deleting the
  -- organization membership and bumping the epoch. Whichever operation wins
  -- this lock is the linearization point for the request/revocation race.
  SELECT o.authorization_epoch
    INTO v_current_epoch
    FROM public.organizations o
   WHERE o.id = p_organization
   FOR UPDATE;

  IF NOT FOUND OR v_current_epoch IS DISTINCT FROM p_authorization_epoch THEN
    RAISE EXCEPTION 'AI redline bundle authorization changed'
      USING ERRCODE = '42501';
  END IF;

  IF p_intent NOT IN ('read', 'review') OR NOT EXISTS (
    SELECT 1
      FROM public.matters m
      JOIN public.workspaces w ON w.id = m.workspace_id
      JOIN public.matter_memberships mm
        ON mm.matter_id = m.id
       AND mm.user_id = p_user
      JOIN public.organization_memberships om
        ON om.organization_id = w.organization_id
       AND om.user_id = p_user
     WHERE m.id = p_matter
       AND w.organization_id = p_organization
       AND (
         (p_intent = 'read' AND mm.role IN (
           'matter_owner', 'editor', 'viewer', 'technical_operator'
         ))
         OR (p_intent = 'review' AND mm.role IN ('matter_owner', 'editor'))
       )
  ) THEN
    RAISE EXCEPTION 'AI redline bundle actor is not authorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_ai_redline_bundle_access(
  uuid, uuid, uuid, bigint, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_ai_redline_bundle_access(
  uuid, uuid, uuid, bigint, text
) TO service_role;
