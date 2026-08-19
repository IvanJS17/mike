import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../app";

const execFileAsync = promisify(execFile);
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_TEST_ANON_KEY;
const dbUrl = process.env.SUPABASE_TEST_DB_URL;

if (url && serviceKey) {
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SECRET_KEY = serviceKey;
}

const maybeDescribe =
  url && serviceKey && anonKey && dbUrl ? describe : describe.skip;

type Fixture = {
  admin: SupabaseClient<any, "public", any>;
  suffix: string;
  password: string;
  authorId: string;
  reviewerId: string;
  orgId: string;
  workspaceId: string;
  matterId: string;
  projectId: string;
  documentId: string;
  versionId: string;
  executionId: string;
  reviewId: string;
  itemId: string;
};

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

async function runSql(sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "psql",
    [dbUrl!, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}

async function waitForSql(sql: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if ((await runSql(sql)) === "t") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function createFixture(): Promise<Fixture> {
  const admin = createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const password = `Atomic-${Math.random().toString(36).slice(2)}!7x`;
  const fixture: Fixture = {
    admin,
    suffix,
    password,
    authorId: "",
    reviewerId: "",
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    matterId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    reviewId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
  };

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

  fixture.authorId = await createUser("atomic-author");
  fixture.reviewerId = await createUser("atomic-reviewer");

  await assertOk(
    admin.from("organizations").insert({
      id: fixture.orgId,
      name: `Atomic ${suffix}`,
      created_by: fixture.authorId,
    }),
    "organization",
  );
  await assertOk(
    admin.from("organization_memberships").insert({
      organization_id: fixture.orgId,
      user_id: fixture.reviewerId,
      role: "editor",
    }),
    "organization membership",
  );
  await assertOk(
    admin.from("workspaces").insert({
      id: fixture.workspaceId,
      organization_id: fixture.orgId,
      name: `Workspace ${suffix}`,
      created_by: fixture.authorId,
    }),
    "workspace",
  );
  await assertOk(
    admin.from("projects").insert({
      id: fixture.projectId,
      user_id: fixture.authorId,
      name: `Project ${suffix}`,
    }),
    "project",
  );
  await assertOk(
    admin.from("matters").insert({
      id: fixture.matterId,
      workspace_id: fixture.workspaceId,
      project_id: fixture.projectId,
      name: `Matter ${suffix}`,
      created_by: fixture.authorId,
    }),
    "matter",
  );
  await assertOk(
    admin.from("matter_memberships").insert({
      matter_id: fixture.matterId,
      user_id: fixture.reviewerId,
      role: "editor",
    }),
    "matter membership",
  );
  await assertOk(
    admin.from("documents").insert({
      id: fixture.documentId,
      project_id: fixture.projectId,
      user_id: fixture.authorId,
      status: "ready",
    }),
    "document",
  );
  await assertOk(
    admin.from("document_versions").insert({
      id: fixture.versionId,
      document_id: fixture.documentId,
      source: "upload",
      page_count: 1,
      content_sha256: "b".repeat(64),
    }),
    "document version",
  );
  await assertOk(
    admin.from("ai_executions").insert({
      id: fixture.executionId,
      user_id: fixture.authorId,
      matter_id: fixture.matterId,
      project_id: fixture.projectId,
      document_id: fixture.documentId,
      document_version_id: fixture.versionId,
      workflow_id: "atomic-revocation-test",
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
      id: fixture.reviewId,
      execution_id: fixture.executionId,
      matter_id: fixture.matterId,
      project_id: fixture.projectId,
      reviewer_user_id: fixture.reviewerId,
      status: "in_progress",
    }),
    "AI review",
  );
  await assertOk(
    admin.from("ai_review_items").insert({
      id: fixture.itemId,
      review_id: fixture.reviewId,
      item_key: "finding-1",
      original_text: "Finding",
      finding_text: "Finding",
      citation_refs: [{ verified: true }],
      status: "pending",
    }),
    "AI review item",
  );

  return fixture;
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.admin
    .from("ai_executions")
    .delete()
    .eq("id", fixture.executionId);
  await fixture.admin.from("organizations").delete().eq("id", fixture.orgId);
  if (fixture.authorId)
    await fixture.admin.auth.admin.deleteUser(fixture.authorId);
  if (fixture.reviewerId)
    await fixture.admin.auth.admin.deleteUser(fixture.reviewerId);
}

async function reviewerToken(fixture: Fixture): Promise<string> {
  const client = createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const result = await client.auth.signInWithPassword({
    email: `atomic-reviewer-${fixture.suffix}@test.local`,
    password: fixture.password,
  });
  if (result.error || !result.data.session) {
    throw result.error ?? new Error("reviewer session was not created");
  }
  return result.data.session.access_token;
}

function routePath(fixture: Fixture, suffix: string): string {
  return `/projects/${fixture.projectId}/ai-executions/${fixture.executionId}/review${suffix}`;
}

async function installBarrier(
  id: string,
  target: "item" | "completion",
): Promise<{ release: () => Promise<void>; cleanup: () => Promise<void> }> {
  const safeId = id.replace(/[^a-zA-Z0-9_]/g, "_");
  const quotedId = id.replaceAll("'", "''");
  const functionName = `ai_review_test_barrier_${safeId}`;
  const triggerName = `zzz_ai_review_test_barrier_${safeId}`;
  const table = target === "item" ? "ai_review_items" : "ai_reviews";
  const event = target === "item" ? "BEFORE UPDATE" : "AFTER UPDATE";
  await runSql(`
    CREATE TABLE IF NOT EXISTS public.ai_review_test_barriers (
      id text PRIMARY KEY,
      reached boolean NOT NULL DEFAULT false,
      released boolean NOT NULL DEFAULT false
    );
    INSERT INTO public.ai_review_test_barriers (id)
    VALUES ('${quotedId}')
    ON CONFLICT (id) DO UPDATE SET reached = false, released = false;
    CREATE OR REPLACE FUNCTION public.${functionName}()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $barrier$
    DECLARE
      v_released boolean;
    BEGIN
      LOOP
        SELECT released INTO v_released
          FROM public.ai_review_test_barriers
         WHERE id = '${quotedId}';
        EXIT WHEN v_released;
        PERFORM pg_sleep(0.02);
      END LOOP;
      RETURN NEW;
    END;
    $barrier$;
    DROP TRIGGER IF EXISTS ${triggerName} ON public.${table};
    CREATE TRIGGER ${triggerName}
      ${event} ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}();
  `);

  return {
    release: async () => {
      await runSql(
        `UPDATE public.ai_review_test_barriers SET released = true WHERE id = '${quotedId}';`,
      );
    },
    cleanup: async () => {
      await runSql(`
        DROP TRIGGER IF EXISTS ${triggerName} ON public.${table};
        DROP FUNCTION IF EXISTS public.${functionName}();
        DELETE FROM public.ai_review_test_barriers WHERE id = '${quotedId}';
        DROP TABLE IF EXISTS public.ai_review_test_barriers;
      `);
    },
  };
}

async function waitForRpcBarrier(functionName: string): Promise<void> {
  await waitForSql(
    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND wait_event = 'PgSleep' AND query ILIKE '%${functionName}%')`,
    `${functionName} barrier`,
  );
}

async function waitForRevocationLock(): Promise<void> {
  await waitForSql(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND query ILIKE '%revoke_organization_membership%')",
    "revocation to wait on the organization lock",
  );
}

maybeDescribe("Supabase atomic human-review revocation", () => {
  it("does not leave an item decision partial when revocation races the projection", async () => {
    const fixture = await createFixture();
    const token = await reviewerToken(fixture);
    const barrier = await installBarrier(`item-${fixture.suffix}`, "item");
    let operation: Promise<request.Response> | undefined;
    let revocation: ReturnType<typeof fixture.admin.rpc> | undefined;
    try {
      operation = request(app)
        .post(routePath(fixture, `/items/${fixture.itemId}/decision`))
        .set("Authorization", `Bearer ${token}`)
        .send({ decision: "accepted" });
      void operation.then(
        () => undefined,
        () => undefined,
      );
      await waitForRpcBarrier("apply_ai_review_item_decision");

      // The RPC already inserted the decision and is blocked immediately before
      // its projection update. Revocation must wait for the same organization
      // lock instead of interleaving between those two writes.
      revocation = fixture.admin.rpc("revoke_organization_membership", {
        p_org: fixture.orgId,
        p_user: fixture.reviewerId,
      });
      void revocation.then(
        () => undefined,
        () => undefined,
      );
      await waitForRevocationLock();
      await barrier.release();

      const response = await operation;
      expect(response.status).toBe(200);
      const revoked = await revocation;
      expect(revoked.error).toBeNull();

      const item = await must<{ status: string }>(
        fixture.admin
          .from("ai_review_items")
          .select("status")
          .eq("id", fixture.itemId)
          .single(),
        "item after race",
      );
      expect(item.status).toBe("accepted");
      const decisions = await must<{ id: string }[]>(
        fixture.admin
          .from("ai_review_decisions")
          .select("id")
          .eq("review_id", fixture.reviewId)
          .eq("review_item_id", fixture.itemId),
        "item decisions after race",
      );
      expect(decisions).toHaveLength(1);
    } finally {
      await barrier.release();
      if (operation || revocation) {
        await Promise.allSettled(
          [operation, revocation].filter(Boolean) as Promise<unknown>[],
        );
      }
      await barrier.cleanup();
      await cleanupFixture(fixture);
    }
  });

  it("does not leave review completion partial when revocation races the terminal decision", async () => {
    const fixture = await createFixture();
    const token = await reviewerToken(fixture);
    let operation: Promise<request.Response> | undefined;
    let revocation: ReturnType<typeof fixture.admin.rpc> | undefined;
    const barrier = await installBarrier(
      `completion-${fixture.suffix}`,
      "completion",
    );
    try {
      const itemDecision = await request(app)
        .post(routePath(fixture, `/items/${fixture.itemId}/decision`))
        .set("Authorization", `Bearer ${token}`)
        .send({ decision: "accepted" });
      expect(itemDecision.status).toBe(200);

      operation = request(app)
        .post(routePath(fixture, "/complete"))
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "approved" });
      void operation.then(
        () => undefined,
        () => undefined,
      );
      await waitForRpcBarrier("complete_ai_review");

      // The review status is changed inside the same RPC before its terminal
      // decision insert. The organization lock prevents revocation from
      // observing or creating a partial completion at this barrier.
      revocation = fixture.admin.rpc("revoke_organization_membership", {
        p_org: fixture.orgId,
        p_user: fixture.reviewerId,
      });
      void revocation.then(
        () => undefined,
        () => undefined,
      );
      await waitForRevocationLock();
      await barrier.release();

      const response = await operation;
      expect(response.status).toBe(200);
      const revoked = await revocation;
      expect(revoked.error).toBeNull();

      const review = await must<{
        status: string;
        completed_at: string | null;
      }>(
        fixture.admin
          .from("ai_reviews")
          .select("status, completed_at")
          .eq("id", fixture.reviewId)
          .single(),
        "review after race",
      );
      expect(review.status).toBe("approved");
      expect(review.completed_at).not.toBeNull();
      const terminalDecisions = await must<{ id: string }[]>(
        fixture.admin
          .from("ai_review_decisions")
          .select("id")
          .eq("review_id", fixture.reviewId)
          .is("review_item_id", null),
        "terminal decisions after race",
      );
      expect(terminalDecisions).toHaveLength(1);
    } finally {
      await barrier.release();
      if (operation || revocation) {
        await Promise.allSettled(
          [operation, revocation].filter(Boolean) as Promise<unknown>[],
        );
      }
      await barrier.cleanup();
      await cleanupFixture(fixture);
    }
  });

  it("rejects both atomic RPCs with no writes after revocation wins first", async () => {
    const fixture = await createFixture();
    try {
      const revoked = await fixture.admin.rpc(
        "revoke_organization_membership",
        {
          p_org: fixture.orgId,
          p_user: fixture.reviewerId,
        },
      );
      expect(revoked.error).toBeNull();

      const decision = await fixture.admin.rpc(
        "apply_ai_review_item_decision",
        {
          p_review_id: fixture.reviewId,
          p_item_id: fixture.itemId,
          p_actor_user_id: fixture.reviewerId,
          p_organization_id: fixture.orgId,
          p_authorization_epoch: 0,
          p_decision: "accepted",
          p_finding_text: "Finding",
          p_comment: null,
        },
      );
      expect(decision.error?.message ?? "").toMatch(
        /authorization changed|active matter lawyer|authorized/i,
      );

      const completion = await fixture.admin.rpc("complete_ai_review", {
        p_review_id: fixture.reviewId,
        p_actor_user_id: fixture.reviewerId,
        p_organization_id: fixture.orgId,
        p_authorization_epoch: 0,
        p_status: "changes_requested",
        p_comment: null,
      });
      expect(completion.error?.message ?? "").toMatch(
        /authorization changed|active matter lawyer|authorized/i,
      );

      const item = await must<{ status: string }>(
        fixture.admin
          .from("ai_review_items")
          .select("status")
          .eq("id", fixture.itemId)
          .single(),
        "unchanged item",
      );
      expect(item.status).toBe("pending");
      const review = await must<{
        status: string;
        completed_at: string | null;
      }>(
        fixture.admin
          .from("ai_reviews")
          .select("status, completed_at")
          .eq("id", fixture.reviewId)
          .single(),
        "unchanged review",
      );
      expect(review).toMatchObject({
        status: "in_progress",
        completed_at: null,
      });
      const decisions = await must<{ id: string }[]>(
        fixture.admin
          .from("ai_review_decisions")
          .select("id")
          .eq("review_id", fixture.reviewId),
        "unchanged decisions",
      );
      expect(decisions).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
