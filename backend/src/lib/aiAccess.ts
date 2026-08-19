import type { createServerSupabase } from "./supabase";
import { canReadAiExecution, canStartAiExecution, type MatterRole } from "./aiExecutions";

type Db = ReturnType<typeof createServerSupabase>;

export type MatterAccess =
  | { ok: true; role: MatterRole; projectId: string | null }
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
  intent: "read" | "write" = "read",
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
  if (!role || (intent === "write" ? !canStartAiExecution(role) : !canReadAiExecution(role))) {
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

  return { ok: true, role, projectId: (matter.project_id as string | null) ?? null };
}
