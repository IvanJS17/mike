import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

// Gated real-stack regression. It is skipped by the ordinary unit suite and
// runs when scripts/test-stack.sh provides a Supabase URL and service key.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

async function must<T>(
  operation: PromiseLike<{
    data: T | null;
    error: { message: string } | null;
  }>,
  label: string,
): Promise<T> {
  const result = await operation;
  if (result.error || result.data === null) {
    throw new Error(`${label}: ${result.error?.message ?? "no data"}`);
  }
  return result.data;
}

async function assertOk(
  operation: PromiseLike<{ error: { message: string } | null }>,
  label: string,
): Promise<void> {
  const result = await operation;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

maybeDescribe("Supabase review authorization revocation", () => {
  it("rejects a stale decision and completion after revocation", async () => {
    const admin = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const password = `Revocation-${Math.random().toString(36).slice(2)}!7x`;
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const matterId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const reviewId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    let reviewerId = "";
    let authorId = "";

    async function createUser(label: string): Promise<string> {
      const created = await admin.auth.admin.createUser({
        email: `${label}-${suffix}@test.local`,
        password,
        email_confirm: true,
      });
      if (created.error || !created.data.user) {
        throw created.error ?? new Error(`no ${label} user`);
      }
      return created.data.user.id;
    }

    try {
      authorId = await createUser("review-author");
      reviewerId = await createUser("reviewer");

      await assertOk(
        admin.from("organizations").insert({
          id: orgId,
          name: `Revocation ${suffix}`,
          created_by: authorId,
        }),
        "organization",
      );
      await assertOk(
        admin.from("organization_memberships").insert({
          organization_id: orgId,
          user_id: reviewerId,
          role: "editor",
        }),
        "organization membership",
      );
      await assertOk(
        admin.from("workspaces").insert({
          id: workspaceId,
          organization_id: orgId,
          name: `Workspace ${suffix}`,
          created_by: authorId,
        }),
        "workspace",
      );
      await assertOk(
        admin.from("projects").insert({
          id: projectId,
          user_id: authorId,
          name: `Project ${suffix}`,
        }),
        "project",
      );
      await assertOk(
        admin.from("matters").insert({
          id: matterId,
          workspace_id: workspaceId,
          project_id: projectId,
          name: `Matter ${suffix}`,
          created_by: authorId,
        }),
        "matter",
      );
      await assertOk(
        admin.from("matter_memberships").insert({
          matter_id: matterId,
          user_id: reviewerId,
          role: "editor",
        }),
        "matter membership",
      );
      await assertOk(
        admin.from("documents").insert({
          id: documentId,
          project_id: projectId,
          user_id: authorId,
          status: "ready",
        }),
        "document",
      );
      await assertOk(
        admin.from("document_versions").insert({
          id: versionId,
          document_id: documentId,
          source: "upload",
          page_count: 1,
          content_sha256: "b".repeat(64),
        }),
        "document version",
      );
      await assertOk(
        admin.from("ai_executions").insert({
          id: executionId,
          user_id: authorId,
          matter_id: matterId,
          project_id: projectId,
          document_id: documentId,
          document_version_id: versionId,
          workflow_id: "revocation-test",
          workflow_version: "1",
          playbook_sha256: "a".repeat(64),
          document_content_sha256: "b".repeat(64),
          input_sha256: "c".repeat(64),
          route_provider: "deepseek",
          route_model: "deepseek-chat",
          credential_ref: "test:v1",
          status: "succeeded",
          finished_at: new Date().toISOString(),
        }),
        "AI execution",
      );
      await assertOk(
        admin.from("ai_reviews").insert({
          id: reviewId,
          execution_id: executionId,
          matter_id: matterId,
          project_id: projectId,
          reviewer_user_id: reviewerId,
          status: "in_progress",
        }),
        "AI review",
      );
      await assertOk(
        admin.from("ai_review_items").insert({
          id: itemId,
          review_id: reviewId,
          item_key: "finding-1",
          original_text: "Finding",
          finding_text: "Finding",
          citation_refs: [],
          status: "pending",
        }),
        "AI review item",
      );

      const before = await must<{ authorization_epoch: number }>(
        admin
          .from("organizations")
          .select("authorization_epoch")
          .eq("id", orgId)
          .single(),
        "authorization snapshot",
      );
      const capturedEpoch = Number(before.authorization_epoch);

      // The caller has already authorized the operation with this snapshot.
      // Revocation wins before either review side effect is attempted.
      const revoked = await admin.rpc("revoke_organization_membership", {
        p_org: orgId,
        p_user: reviewerId,
      });
      expect(revoked.error).toBeNull();

      const after = await must<{ authorization_epoch: number }>(
        admin
          .from("organizations")
          .select("authorization_epoch")
          .eq("id", orgId)
          .single(),
        "revoked authorization epoch",
      );
      expect(Number(after.authorization_epoch)).toBe(capturedEpoch + 1);

      const decision = await admin.rpc("apply_ai_review_item_decision", {
        p_review_id: reviewId,
        p_item_id: itemId,
        p_actor_user_id: reviewerId,
        p_organization_id: orgId,
        p_authorization_epoch: capturedEpoch,
        p_decision: "accepted",
        p_finding_text: "Finding",
        p_comment: null,
      });
      expect(decision.error?.message ?? "").toMatch(
        /active matter lawyer|authorization changed|authorized/i,
      );

      const completion = await admin.rpc("complete_ai_review", {
        p_review_id: reviewId,
        p_actor_user_id: reviewerId,
        p_organization_id: orgId,
        p_authorization_epoch: capturedEpoch,
        p_status: "changes_requested",
        p_comment: null,
      });
      expect(completion.error?.message ?? "").toMatch(
        /active matter lawyer|authorization changed|authorized/i,
      );

      const unchangedItem = await must<{ status: string }>(
        admin
          .from("ai_review_items")
          .select("status")
          .eq("id", itemId)
          .single(),
        "unchanged review item",
      );
      expect(unchangedItem.status).toBe("pending");

      const unchangedReview = await must<{
        status: string;
        completed_at: string | null;
      }>(
        admin
          .from("ai_reviews")
          .select("status, completed_at")
          .eq("id", reviewId)
          .single(),
        "unchanged review",
      );
      expect(unchangedReview).toMatchObject({
        status: "in_progress",
        completed_at: null,
      });

      const decisions = await must(
        admin
          .from("ai_review_decisions")
          .select("id")
          .eq("review_id", reviewId),
        "unchanged review decisions",
      );
      expect(decisions).toEqual([]);
    } finally {
      await admin.from("ai_executions").delete().eq("id", executionId);
      await admin.from("organizations").delete().eq("id", orgId);
      if (authorId) await admin.auth.admin.deleteUser(authorId);
      if (reviewerId) await admin.auth.admin.deleteUser(reviewerId);
    }
  });
});
