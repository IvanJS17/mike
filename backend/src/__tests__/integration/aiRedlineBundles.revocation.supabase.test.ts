import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../app";
import { canonicalJson, sha256Hex } from "../../lib/aiReceipts";

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
  receiptId: string;
};

const sourceText = "Source A. Source B.";
const sourceSha256 = "b".repeat(64);
const receiptJson = {
  receipt_version: "beta-0.1",
  execution_id: "execution-placeholder",
  input: { document_version_id: "version-placeholder" },
  result: { status: "succeeded" },
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
  const password = `Bundle-${Math.random().toString(36).slice(2)}!7x`;
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
    receiptId: crypto.randomUUID(),
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

  fixture.authorId = await createUser("bundle-author");
  fixture.reviewerId = await createUser("bundle-reviewer");

  await assertOk(
    admin.from("organizations").insert({
      id: fixture.orgId,
      name: `Bundle ${suffix}`,
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
      content_sha256: sourceSha256,
    }),
    "document version",
  );
  await assertOk(
    admin.from("ai_document_version_pages").insert({
      document_id: fixture.documentId,
      document_version_id: fixture.versionId,
      page: 1,
      content: sourceText,
      content_sha256: sha256Hex(sourceText),
    }),
    "document page",
  );
  await assertOk(
    admin.from("ai_executions").insert({
      id: fixture.executionId,
      user_id: fixture.authorId,
      matter_id: fixture.matterId,
      project_id: fixture.projectId,
      document_id: fixture.documentId,
      document_version_id: fixture.versionId,
      workflow_id: "bundle-revocation-test",
      workflow_version: "1",
      playbook_sha256: "a".repeat(64),
      document_content_sha256: sourceSha256,
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
      original_text: "Source A.",
      finding_text: "Reemplazo aceptado",
      citation_refs: [
        {
          citation_id: "c1",
          document_id: fixture.documentId,
          document_version_id: fixture.versionId,
          page: 1,
          span: { start_char: 0, end_char: 9 },
          quote: "Source A.",
          quote_sha256: sha256Hex("Source A."),
          verified: true,
        },
      ],
      status: "accepted",
    }),
    "AI review item",
  );

  const actualReceipt = {
    ...receiptJson,
    execution_id: fixture.executionId,
    input: { document_version_id: fixture.versionId },
  };
  await assertOk(
    admin.from("ai_receipts").insert({
      id: fixture.receiptId,
      execution_id: fixture.executionId,
      receipt_version: "beta-0.1",
      canonical_json: actualReceipt,
      receipt_sha256: sha256Hex(canonicalJson(actualReceipt)),
    }),
    "AI receipt",
  );
  await assertOk(
    admin
      .from("ai_reviews")
      .update({
        status: "approved",
        completed_at: new Date().toISOString(),
      })
      .eq("id", fixture.reviewId),
    "approve AI review",
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
    email: `bundle-reviewer-${fixture.suffix}@test.local`,
    password: fixture.password,
  });
  if (result.error || !result.data.session) {
    throw result.error ?? new Error("reviewer session was not created");
  }
  return result.data.session.access_token;
}

function routePath(fixture: Fixture): string {
  return `/projects/${fixture.projectId}/ai-executions/${fixture.executionId}/review/redline-bundle`;
}

async function holdOrganizationLock(
  fixture: Fixture,
  barrierId: string,
): Promise<{
  release: () => Promise<void>;
  finish: () => Promise<void>;
}> {
  const quotedBarrierId = barrierId.replaceAll("'", "''");
  await runSql(`
    CREATE TABLE IF NOT EXISTS public.ai_redline_access_test_barriers (
      id text PRIMARY KEY,
      released boolean NOT NULL DEFAULT false
    );
    INSERT INTO public.ai_redline_access_test_barriers (id)
    VALUES ('${quotedBarrierId}')
    ON CONFLICT (id) DO UPDATE SET released = false;
    CREATE OR REPLACE FUNCTION public.ai_redline_test_hold_org_lock(
      p_org uuid,
      p_barrier text
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $barrier$
    DECLARE
      v_released boolean;
    BEGIN
      PERFORM 1 FROM public.organizations WHERE id = p_org FOR UPDATE;
      LOOP
        SELECT released INTO v_released
          FROM public.ai_redline_access_test_barriers
         WHERE id = p_barrier;
        EXIT WHEN v_released;
        PERFORM pg_sleep(0.02);
      END LOOP;
    END;
    $barrier$;
  `);

  const holder = execFileAsync(
    "psql",
    [
      dbUrl!,
      "-XAtq",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT public.ai_redline_test_hold_org_lock('${fixture.orgId}', '${quotedBarrierId}');`,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  await waitForSql(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND wait_event = 'PgSleep' AND query ILIKE '%ai_redline_test_hold_org_lock%')",
    "organization lock holder",
  );

  return {
    release: () =>
      runSql(
        `UPDATE public.ai_redline_access_test_barriers SET released = true WHERE id = '${quotedBarrierId}';`,
      ).then(() => undefined),
    finish: async () => {
      await holder;
      await runSql(`
        DROP FUNCTION IF EXISTS public.ai_redline_test_hold_org_lock(uuid, text);
        DELETE FROM public.ai_redline_access_test_barriers WHERE id = '${quotedBarrierId}';
        DROP TABLE IF EXISTS public.ai_redline_access_test_barriers;
      `);
    },
  };
}

async function runRevocationRace(
  fixture: Fixture,
  operationFactory: () => Promise<request.Response>,
): Promise<request.Response> {
  const barrier = await holdOrganizationLock(
    fixture,
    `bundle-access-${fixture.suffix}`,
  );
  let operation: Promise<request.Response> | undefined;
  let revocation: ReturnType<typeof fixture.admin.rpc> | undefined;
  try {
    revocation = fixture.admin.rpc("revoke_organization_membership", {
      p_org: fixture.orgId,
      p_user: fixture.reviewerId,
    });
    void revocation.then(
      () => undefined,
      () => undefined,
    );
    await waitForSql(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND query ILIKE '%revoke_organization_membership%')",
      "revocation to wait on the organization lock",
    );

    operation = operationFactory();
    void operation.then(
      () => undefined,
      () => undefined,
    );
    await waitForSql(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND query ILIKE '%assert_ai_redline_bundle_access%')",
      "bundle access guard to wait on the organization lock",
    );

    await barrier.release();
    const response = await operation;
    const revoked = await revocation;
    expect(revoked.error).toBeNull();
    return response;
  } finally {
    await barrier.release().catch(() => undefined);
    await Promise.allSettled(
      [operation, revocation].filter(Boolean) as Promise<unknown>[],
    );
    await barrier.finish();
  }
}

maybeDescribe("Supabase redline bundle revocation serialization", () => {
  it("preserves valid creation and blocks an idempotent POST without payload", async () => {
    const fixture = await createFixture();
    try {
      const token = await reviewerToken(fixture);
      const route = routePath(fixture);
      const created = await request(app)
        .post(route)
        .set("Authorization", `Bearer ${token}`);
      expect(created.status).toBe(201);
      expect(created.body.canonical_json).toBeDefined();

      const response = await runRevocationRace(fixture, () =>
        request(app).post(route).set("Authorization", `Bearer ${token}`),
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("authorization_revoked");
      expect(response.body.canonical_json).toBeUndefined();
      expect(response.body.id).toBeUndefined();
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("preserves a valid GET and blocks its response when revocation wins", async () => {
    const fixture = await createFixture();
    try {
      const token = await reviewerToken(fixture);
      const route = routePath(fixture);
      const created = await request(app)
        .post(route)
        .set("Authorization", `Bearer ${token}`);
      expect(created.status).toBe(201);

      const validRead = await request(app)
        .get(route)
        .set("Authorization", `Bearer ${token}`);
      expect(validRead.status).toBe(200);
      expect(validRead.body.canonical_json).toBeDefined();

      const response = await runRevocationRace(fixture, () =>
        request(app).get(route).set("Authorization", `Bearer ${token}`),
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("authorization_revoked");
      expect(response.body.canonical_json).toBeUndefined();
      expect(response.body.id).toBeUndefined();
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
