import type { createServerSupabase } from "./supabase";
import {
  canReadAiExecution,
  canReviewAiExecution,
  canStartAiExecution,
  type MatterRole,
} from "./aiExecutions";

type Db = ReturnType<typeof createServerSupabase>;

export type MatterAccess =
  | {
      ok: true;
      role: MatterRole;
      projectId: string | null;
      organizationId: string;
      authorizationEpoch: number;
    }
  | { ok: false };

/**
 * Resolve a matter's explicit assignment and active organization membership.
 * Service-role queries are deliberately followed by application checks because
 * this route is not allowed to treat workspace/org membership as matter access.
 */
export async function checkMatterAccess(
  matterId: string,
  userId: string,
  db: Db,
  intent: "read" | "write" | "review" = "read",
): Promise<MatterAccess> {
  const { data: matter } = await db
    .from("matters")
    .select("id, project_id, workspace_id")
    .eq("id", matterId)
    .maybeSingle();
  if (!matter) return { ok: false };

  const { data: membership } = await db
    .from("matter_memberships")
    .select("role")
    .eq("matter_id", matterId)
    .eq("user_id", userId)
    .maybeSingle();
  const role = (membership?.role as MatterRole) ?? null;
  if (
    !role ||
    (intent === "write"
      ? !canStartAiExecution(role)
      : intent === "review"
        ? !canReviewAiExecution(role)
        : !canReadAiExecution(role))
  ) {
    return { ok: false };
  }

  const { data: workspace } = await db
    .from("workspaces")
    .select("organization_id")
    .eq("id", matter.workspace_id)
    .maybeSingle();
  if (!workspace?.organization_id) return { ok: false };

  const { data: organizationMembership } = await db
    .from("organization_memberships")
    .select("user_id")
    .eq("organization_id", workspace.organization_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!organizationMembership) return { ok: false };

  const { data: organization } = await db
    .from("organizations")
    .select("authorization_epoch")
    .eq("id", workspace.organization_id)
    .maybeSingle();
  const authorizationEpoch = Number(organization?.authorization_epoch);
  if (!Number.isSafeInteger(authorizationEpoch) || authorizationEpoch < 0) {
    return { ok: false };
  }

  return {
    ok: true,
    role,
    projectId: (matter.project_id as string | null) ?? null,
    organizationId: workspace.organization_id,
    authorizationEpoch,
  };
}

/**
 * Re-check matter membership, organization membership, and the captured epoch
 * in one database transaction. The SQL function locks the organization row,
 * which is also the lock used by organization membership revocation.
 */
export async function assertMatterAccessFresh(
  matterId: string,
  userId: string,
  db: Db,
  access: Extract<MatterAccess, { ok: true }>,
  intent: "read" | "review",
): Promise<void> {
  const { error } = await db.rpc("assert_ai_redline_bundle_access", {
    p_matter: matterId,
    p_user: userId,
    p_organization: access.organizationId,
    p_authorization_epoch: access.authorizationEpoch,
    p_intent: intent,
  });
  if (error) {
    throw new Error(`matter access check failed: ${error.message}`);
  }
}
