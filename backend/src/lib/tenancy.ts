/**
 * Tenancy helpers (W1.7): monotonic authorization epochs.
 *
 * Revoking a membership must take effect immediately: the membership row is
 * deleted, the organization's authorization_epoch is incremented (invalidating
 * any snapshot a long-running job captured), and the user's Auth sessions are
 * revoked so in-flight tokens stop working.
 */

import { createServerSupabase } from "./supabase";
import { recordAuditEvent } from "./audit";

type Db = ReturnType<typeof createServerSupabase>;
type Admin = {
  auth: {
    admin: {
      signOut: (userId: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

/**
 * Revoke a user's membership in an organization.
 * Deletes the membership, bumps the org epoch, and signs the user out.
 */
export async function revokeOrganizationMembership(
  db: Db,
  admin: Admin,
  organizationId: string,
  userId: string,
): Promise<{ ok: boolean; detail?: string }> {
  const { error: deleteError } = await db
    .from("organization_memberships")
    .delete()
    .eq("organization_id", organizationId)
    .eq("user_id", userId);

  if (deleteError) {
    return { ok: false, detail: `Failed to remove membership: ${deleteError.message}` };
  }

  const { error: epochError } = await db.rpc("bump_authorization_epoch", {
    p_org: organizationId,
  });

  if (epochError) {
    return { ok: false, detail: `Failed to bump epoch: ${epochError.message}` };
  }

  const { error: signOutError } = await admin.auth.admin.signOut(userId);
  if (signOutError) {
    return { ok: false, detail: `Failed to revoke sessions: ${signOutError.message}` };
  }

  await recordAuditEvent(db, {
    actorUserId: userId,
    organizationId,
    eventType: "membership.revoked",
  });

  return { ok: true };
}

/**
 * Assert that a caller's epoch snapshot is still current for the organization.
 * Long-running jobs capture the epoch when they start and call this before
 * committing side effects; a newer epoch means a revocation happened in
 * between and the job must abort.
 */
export async function assertEpochFresh(
  db: Db,
  organizationId: string,
  epochSnapshot: number,
): Promise<void> {
  const { data, error } = await db
    .from("organizations")
    .select("authorization_epoch")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    throw new Error(`epoch check failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`epoch check failed: organization ${organizationId} not found`);
  }
  if (data.authorization_epoch > epochSnapshot) {
    throw new Error(
      `authorization epoch changed (${epochSnapshot} -> ${data.authorization_epoch}): revoke detected, abort`,
    );
  }
}
