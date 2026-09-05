import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  from,
  rpc,
  createSupabaseTenancyReadPort,
  evaluateInitialAccess,
  createSupabaseAiReadRepository,
  createBoundEvidenceResourceScopePort,
  createSupabaseAiPersistencePorts,
  createHumanReview,
  decideHumanReviewItem,
  completeHumanReview,
  produceApprovedRedlineBundle,
} = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  createSupabaseTenancyReadPort: vi.fn(),
  evaluateInitialAccess: vi.fn(),
  createSupabaseAiReadRepository: vi.fn(),
  createBoundEvidenceResourceScopePort: vi.fn(),
  createSupabaseAiPersistencePorts: vi.fn(),
  createHumanReview: vi.fn(),
  decideHumanReviewItem: vi.fn(),
  completeHumanReview: vi.fn(),
  produceApprovedRedlineBundle: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.header("x-test-auth") !== "yes") {
      res.status(401).json({ detail: "authentication required" });
      return;
    }
    res.locals.authenticatedIdentity = {
      user_id: "user-1",
      transport: { kind: "web_session" },
      mfa_satisfied: false,
    };
    next();
  },
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => ({ from, rpc })),
}));

vi.mock("../../lib/recovery/authorization/supabaseTenancyReadPort", () => ({
  createSupabaseTenancyReadPort,
}));

vi.mock("../../lib/recovery/authorization/tenancyReadPort", () => ({
  evaluateInitialAccess,
}));

vi.mock("../../lib/recovery/persistence/supabaseAiReadRepository", () => ({
  createSupabaseAiReadRepository,
  createBoundEvidenceResourceScopePort,
}));

vi.mock("../../lib/recovery/persistence/supabaseAiPersistencePorts", () => ({
  createSupabaseAiPersistencePorts,
}));

vi.mock("../../lib/recovery/review/humanReview", () => ({
  createHumanReview,
  decideHumanReviewItem,
  completeHumanReview,
}));

vi.mock("../../lib/recovery/review/approvedRedlineBundle", () => ({
  produceApprovedRedlineBundle,
}));

import { aiRecoveryRouter } from "../aiRecovery";

const projectId = "project-1";
const visibleRow = {
  id: "execution-1",
  project_id: projectId,
  evidence_version: "evidence-v1",
  organization_id: "org-1",
  matter_id: "matter-1",
  document_id: "document-1",
  document_version_id: "version-1",
  document_content_sha256: "a".repeat(64),
  status: "succeeded",
  error_class: null,
  created_at: "2026-09-04T10:00:00.000Z",
  started_at: "2026-09-04T10:00:01.000Z",
  finished_at: "2026-09-04T10:00:02.000Z",
};

function makeQuery(result: { data: unknown; error: unknown }) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(result).then(resolve),
  };
  return query;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const redlineAction = {
  action_id: "action-1",
  review_item_id: "item-1",
  citation_id: "citation-1",
  document_id: "document-1",
  document_version_id: "version-1",
  page: 1,
  start: 0,
  end: 5,
  page_content_sha256: "b".repeat(64),
  before_text_sha256: "c".repeat(64),
  replacement_text_sha256: sha256("nuevo"),
};

function makeBundle(
  overrides: Record<string, unknown> = {},
  revision = 1,
  actionOverrides: Record<string, unknown> = {},
) {
  const action = { ...redlineAction, ...actionOverrides };
  const body = {
    bundle_version: "approved-redline-v1",
    revision,
    review_id: "review-1",
    review_revision: 2,
    execution_id: "execution-1",
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: projectId,
    document_id: "document-1",
    document_version_id: "version-1",
    source_document_sha256: "a".repeat(64),
    evidence_receipt_version: "evidence-v1",
    evidence_receipt_sha256: "d".repeat(64),
    reviewer_user_id: "reviewer-1",
    actions: [action],
  };
  const canonicalJson = canonical(body);
  return {
    id: "bundle-1",
    ...body,
    actions: [{ ...action, replacement_text: "nuevo" }],
    canonical_json: canonicalJson,
    bundle_sha256: sha256(canonicalJson),
    ...overrides,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/ai-executions", aiRecoveryRouter);
  return app;
}

describe("GET /projects/:projectId/ai-executions", () => {
  beforeEach(() => {
    from.mockReturnValue(makeQuery({ data: [visibleRow], error: null }));
    createSupabaseTenancyReadPort.mockReturnValue({});
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision: { outcome: "allow" },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires the existing auth middleware", async () => {
    const response = await request(makeApp()).get(
      `/projects/${projectId}/ai-executions`,
    );

    expect(response.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("filters current evidence, selects an explicit summary, authorizes, and preserves newest order", async () => {
    const olderRow = {
      ...visibleRow,
      id: "execution-older",
      created_at: "2026-09-03T10:00:00.000Z",
    };
    from.mockReturnValue(
      makeQuery({ data: [visibleRow, olderRow], error: null }),
    );
    const response = await request(makeApp())
      .get(`/projects/${projectId}/ai-executions`)
      .set("x-test-auth", "yes");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        id: visibleRow.id,
        project_id: visibleRow.project_id,
        matter_id: visibleRow.matter_id,
        document_id: visibleRow.document_id,
        document_version_id: visibleRow.document_version_id,
        document_content_sha256: visibleRow.document_content_sha256,
        status: visibleRow.status,
        error_class: visibleRow.error_class,
        created_at: visibleRow.created_at,
        started_at: visibleRow.started_at,
        finished_at: visibleRow.finished_at,
      },
      {
        id: olderRow.id,
        project_id: olderRow.project_id,
        matter_id: olderRow.matter_id,
        document_id: olderRow.document_id,
        document_version_id: olderRow.document_version_id,
        document_content_sha256: olderRow.document_content_sha256,
        status: olderRow.status,
        error_class: olderRow.error_class,
        created_at: olderRow.created_at,
        started_at: olderRow.started_at,
        finished_at: olderRow.finished_at,
      },
    ]);

    expect(from).toHaveBeenCalledWith("ai_executions");
    const query = from.mock.results[0]?.value;
    expect(query.select).toHaveBeenCalledWith(
      "id, project_id, evidence_version, organization_id, matter_id, document_id, document_version_id, document_content_sha256, status, error_class, created_at, started_at, finished_at",
    );
    expect(query.select.mock.calls[0][0]).not.toContain("*");
    expect(query.eq).toHaveBeenCalledWith("project_id", projectId);
    expect(query.eq).toHaveBeenCalledWith("evidence_version", "evidence-v1");
    expect(query.order).toHaveBeenCalledWith("created_at", {
      ascending: false,
    });
    expect(createSupabaseTenancyReadPort).toHaveBeenCalled();
    expect(evaluateInitialAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({ user_id: "user-1" }),
        organization_id: "org-1",
        matter_id: "matter-1",
        requiresMfa: false,
      }),
    );
  });

  it("omits denied, not-found, outsider, private, and legacy candidates", async () => {
    const outsider = {
      ...visibleRow,
      id: "outsider",
      organization_id: "org-2",
    };
    const privateRow = {
      ...visibleRow,
      id: "private",
      matter_id: "matter-private",
    };
    from.mockReturnValue(
      makeQuery({
        data: [
          visibleRow,
          outsider,
          privateRow,
          { ...visibleRow, id: "legacy", evidence_version: "legacy-beta-0.1" },
        ],
        error: null,
      }),
    );
    evaluateInitialAccess
      .mockResolvedValueOnce({
        kind: "decision",
        decision: { outcome: "allow" },
      })
      .mockResolvedValueOnce({
        kind: "decision",
        decision: { outcome: "not_found" },
      })
      .mockResolvedValueOnce({
        kind: "decision",
        decision: { outcome: "denied" },
      });

    const response = await request(makeApp())
      .get(`/projects/${projectId}/ai-executions`)
      .set("x-test-auth", "yes");

    expect(response.status).toBe(200);
    expect(response.body.map((row: { id: string }) => row.id)).toEqual([
      "execution-1",
    ]);
    expect(evaluateInitialAccess).toHaveBeenCalledTimes(3);
  });

  it("omits malformed persisted rows fail-closed", async () => {
    from.mockReturnValue(
      makeQuery({
        data: [{ ...visibleRow, document_content_sha256: "bad" }],
        error: null,
      }),
    );

    const response = await request(makeApp())
      .get(`/projects/${projectId}/ai-executions`)
      .set("x-test-auth", "yes");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(evaluateInitialAccess).not.toHaveBeenCalled();
  });

  it("returns a sanitized internal error for query and authorization failures", async () => {
    from.mockReturnValue(
      makeQuery({ data: null, error: new Error("provider secret") }),
    );
    let response = await request(makeApp())
      .get(`/projects/${projectId}/ai-executions`)
      .set("x-test-auth", "yes");
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.text).not.toContain("provider secret");

    from.mockReturnValue(makeQuery({ data: [visibleRow], error: null }));
    evaluateInitialAccess.mockResolvedValue({
      kind: "authorization_dependency_failed",
    });
    response = await request(makeApp())
      .get(`/projects/${projectId}/ai-executions`)
      .set("x-test-auth", "yes");
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.text).not.toContain("authorization_dependency_failed");
  });
});

describe("GET /projects/:projectId/ai-executions/:executionId/review/redline-bundle", () => {
  beforeEach(() => {
    from.mockReturnValue(makeQuery({ data: makeBundle(), error: null }));
    rpc.mockResolvedValue({ data: true, error: null });
    createSupabaseTenancyReadPort.mockReturnValue({});
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision: {
        outcome: "allow",
        scope: {
          user_id: "user-1",
          organization_id: "org-1",
          matter_id: "matter-1",
          authorization_epoch: 7,
        },
      },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("returns the bundle and authorizes before integrity validation", async () => {
    const response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...makeBundle(), id: undefined });
    expect(response.body.id).toBeUndefined();
    expect(from).toHaveBeenCalledWith("ai_redline_bundles");
    const query = from.mock.results[0]?.value;
    expect(query.select).toHaveBeenCalledWith(
      "id, bundle_version, revision, review_id, review_revision, execution_id, organization_id, matter_id, project_id, document_id, document_version_id, source_document_sha256, evidence_receipt_version, evidence_receipt_sha256, reviewer_user_id, actions, canonical_json, bundle_sha256",
    );
    expect(query.eq).toHaveBeenCalledWith("project_id", projectId);
    expect(query.eq).toHaveBeenCalledWith("execution_id", "execution-1");
    expect(query.eq).toHaveBeenCalledWith("revision", 1);
    expect(query.eq).toHaveBeenCalledWith(
      "bundle_version",
      "approved-redline-v1",
    );
    expect(rpc).toHaveBeenCalledWith("assert_ai_redline_bundle_access", {
      p_bundle_id: "bundle-1",
      p_actor_user_id: "user-1",
      p_organization_id: "org-1",
      p_authorization_epoch: 7,
      p_intent: "read",
    });
  });

  it.each(["0", "-1", "1.5", "abc"])(
    "rejects invalid revision %s",
    async (revision) => {
      const response = await request(makeApp())
        .get(
          `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle?revision=${revision}`,
        )
        .set("x-test-auth", "yes");
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "invalid_revision" });
      expect(from).not.toHaveBeenCalled();
    },
  );

  it("loads the requested positive revision", async () => {
    from.mockReturnValue(makeQuery({ data: makeBundle({}, 2), error: null }));
    const response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle?revision=2`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(200);
    expect(response.body.revision).toBe(2);
    expect(from.mock.results[0]?.value.eq).toHaveBeenCalledWith("revision", 2);
  });

  it("rejects a canonical authorized row whose revision differs from requested revision", async () => {
    from.mockReturnValue(makeQuery({ data: makeBundle({}, 2), error: null }));
    const response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle?revision=1`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "redline_bundle_integrity_failed",
    });
    expect(rpc).toHaveBeenCalled();
  });

  it("keeps missing and outsider bundles opaque", async () => {
    from.mockReturnValue(makeQuery({ data: null, error: null }));
    let response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("canonical_json");

    from.mockReturnValue(
      makeQuery({
        data: makeBundle({ organization_id: "org-2" }),
        error: null,
      }),
    );
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision: { outcome: "not_found" },
    });
    response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps revocation and dependency failures without bundle bytes", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "secret" },
    });
    let response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "authorization_revoked" });
    expect(response.text).not.toContain("canonical_json");

    evaluateInitialAccess.mockResolvedValue({
      kind: "authorization_dependency_failed",
    });
    response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
  });

  it.each([
    ["hash", { bundle_sha256: "e".repeat(64) }],
    ["canonical", { canonical_json: "{}" }],
    ["scope", { project_id: "project-2" }],
    ["actions", { actions: [] }],
    [
      "replacement",
      { actions: [{ ...redlineAction, replacement_text: "alterado" }] },
    ],
  ])("rejects %s tampering after authorization", async (_name, overrides) => {
    from.mockReturnValue(
      makeQuery({ data: makeBundle(overrides), error: null }),
    );
    const response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "redline_bundle_integrity_failed",
    });
    expect(response.text).not.toContain("canonical_json");
    expect(rpc).toHaveBeenCalled();
  });

  it.each([
    ["negative span", { start: -1 }],
    ["malformed hash", { before_text_sha256: "not-a-hash" }],
  ])("rejects a consistently invalid %s action", async (_name, action) => {
    from.mockReturnValue(
      makeQuery({ data: makeBundle({}, 1, action), error: null }),
    );

    const response = await request(makeApp())
      .get(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes");

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "redline_bundle_integrity_failed",
    });
    expect(rpc).toHaveBeenCalled();
  });
});

describe("human review endpoints", () => {
  const execution = {
    execution_id: "execution-1",
    author_user_id: "author-1",
    status: "succeeded",
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: projectId,
    document_id: "document-1",
    document_version_id: "version-1",
    document_content_sha256: "a".repeat(64),
    evidence_receipt_sha256: "d".repeat(64),
    output_text: "output",
    output_sha256: "e".repeat(64),
    citations: [],
  };
  const evidenceReceipt = {
    receipt_version: "evidence-v1",
    canonical_json: "{}",
    receipt_sha256: "d".repeat(64),
    page_hashes: [],
  };
  const review = {
    review_id: "review-1",
    revision: 1,
    execution_id: "execution-1",
    execution_author_user_id: "author-1",
    reviewer_user_id: "user-1",
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: projectId,
    document_id: "document-1",
    document_version_id: "version-1",
    document_content_sha256: "a".repeat(64),
    evidence_receipt_sha256: "d".repeat(64),
    status: "pending",
    items: [],
  };
  const grantedScope = {
    user_id: "user-1",
    organization_id: "org-1",
    workspace_id: "workspace-1",
    matter_id: "matter-1",
    membership_role: "member",
    authorization_epoch: 7,
    requires_explicit_matter_membership: false,
  };
  let repository: {
    loadExecutionEvidence: ReturnType<typeof vi.fn>;
    loadReview: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    repository = {
      loadExecutionEvidence: vi.fn().mockResolvedValue({
        execution,
        evidence_receipt: evidenceReceipt,
      }),
      loadReview: vi.fn().mockResolvedValue(review),
    };
    createSupabaseAiReadRepository.mockReturnValue(repository);
    createSupabaseTenancyReadPort.mockReturnValue({ tenancy: true });
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision: { outcome: "allow", scope: grantedScope },
    });
    createBoundEvidenceResourceScopePort.mockReturnValue({ resource: true });
    createSupabaseAiPersistencePorts.mockReturnValue({
      review: { create: vi.fn() },
    });
    createHumanReview.mockResolvedValue({
      ok: true,
      review,
      receipt: { disposition: "applied" },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("GET returns the persisted review only after exact evidence lookup and read authorization", async () => {
    const response = await request(makeApp())
      .get(`/projects/${projectId}/ai-executions/execution-1/review`)
      .set("x-test-auth", "yes");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(review);
    expect(createSupabaseAiReadRepository).toHaveBeenCalled();
    const repository = createSupabaseAiReadRepository.mock.results[0].value;
    expect(repository.loadExecutionEvidence).toHaveBeenCalledWith({
      project_id: projectId,
      execution_id: "execution-1",
    });
    expect(evaluateInitialAccess).toHaveBeenCalledWith(expect.anything(), {
      identity: expect.objectContaining({ user_id: "user-1" }),
      organization_id: "org-1",
      matter_id: "matter-1",
      requiresMfa: false,
    });
    expect(repository.loadReview).toHaveBeenCalledWith({
      project_id: projectId,
      execution_id: "execution-1",
    });
  });

  it("POST rejects extra body keys before creating or authorizing a write", async () => {
    const response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-1", review_id: "review-1", extra: true });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_review" });
    expect(createHumanReview).not.toHaveBeenCalled();
    expect(createSupabaseAiReadRepository).not.toHaveBeenCalled();
  });

  it("POST creates a review with MFA, the granted epoch, and execution-bound adapters", async () => {
    const response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-1", review_id: "review-1" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      review,
      receipt: { disposition: "applied" },
    });
    expect(evaluateInitialAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requiresMfa: true }),
    );
    expect(createBoundEvidenceResourceScopePort).toHaveBeenCalledWith(
      expect.anything(),
      {
        organization_id: "org-1",
        matter_id: "matter-1",
        project_id: projectId,
      },
    );
    expect(createSupabaseAiPersistencePorts).toHaveBeenCalledWith(
      expect.anything(),
      {
        actor_user_id: "user-1",
        organization_id: "org-1",
        authorization_epoch: 7,
      },
    );
    expect(createHumanReview).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ user_id: "user-1" }),
        granted_scope: grantedScope,
        tenancy_port: expect.anything(),
        resource_scope_port: expect.anything(),
        requires_mfa: true,
        idempotency_key: "idem-1",
        review_id: "review-1",
        execution,
        evidence_receipt: evidenceReceipt,
        mutation_port: expect.anything(),
      }),
    );
  });

  it("keeps missing and outsider executions opaque and does not load a review", async () => {
    repository.loadExecutionEvidence.mockResolvedValueOnce(null);
    let response = await request(makeApp())
      .get(`/projects/${projectId}/ai-executions/execution-1/review`)
      .set("x-test-auth", "yes");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
    expect(repository.loadReview).not.toHaveBeenCalled();

    evaluateInitialAccess.mockResolvedValueOnce({
      kind: "decision",
      decision: { outcome: "not_found" },
    });
    response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-1", review_id: "review-1" });
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("org-1");
    expect(createHumanReview).not.toHaveBeenCalled();
  });

  it("maps MFA, replay, and typed domain failures without leaking details", async () => {
    evaluateInitialAccess.mockResolvedValueOnce({
      kind: "decision",
      decision: { outcome: "denied", code: "mfa_required", reason: "secret" },
    });
    let response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-1", review_id: "review-1" });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "mfa_required" });
    expect(response.text).not.toContain("secret");

    createHumanReview.mockResolvedValueOnce({
      ok: true,
      review,
      receipt: { disposition: "replayed", operation: "create" },
    });
    response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-1", review_id: "review-1" });
    expect(response.status).toBe(200);

    for (const error_class of [
      "invalid_review",
      "review_authorization_failed",
      "authorization_dependency_failed",
      "review_write_failed",
    ] as const) {
      createHumanReview.mockResolvedValueOnce({ ok: false, error_class });
      response = await request(makeApp())
        .post(`/projects/${projectId}/ai-executions/execution-1/review`)
        .set("x-test-auth", "yes")
        .send({
          idempotency_key: `idem-${error_class}`,
          review_id: "review-1",
        });
      expect(response.status).toBe(
        error_class === "invalid_review"
          ? 400
          : error_class === "review_authorization_failed"
            ? 403
            : 500,
      );
      expect(response.body).toMatchObject({
        code:
          error_class === "invalid_review"
            ? "invalid_review"
            : error_class === "review_authorization_failed"
              ? "authorization_revoked"
              : "internal_error",
      });
      expect(response.text).not.toContain("secret");
    }
  });

  it("rejects malformed decision and completion bodies before any read or write", async () => {
    let response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/items/item-1/decision`,
      )
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-1", decision: "accepted", extra: true });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_review" });

    response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review/complete`)
      .set("x-test-auth", "yes")
      .send({
        idempotency_key: "idem-1",
        terminal_state: "approved",
        extra: true,
      });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_review" });
    expect(createSupabaseAiReadRepository).not.toHaveBeenCalled();
    expect(decideHumanReviewItem).not.toHaveBeenCalled();
    expect(completeHumanReview).not.toHaveBeenCalled();
  });

  it("decides an item using the persisted review, exact loaders, MFA, and bound context", async () => {
    const persistedReview = {
      ...review,
      items: [
        {
          item_id: "item-1",
          item_key: "finding-1",
          original_text: "original",
          finding_text: "original",
          status: "pending",
          comment: null,
          citation: null,
        },
      ],
    };
    repository.loadReview.mockResolvedValue(persistedReview);
    const transition = { decision: "edited" };
    const receipt = { disposition: "applied", operation: "decide" };
    decideHumanReviewItem.mockResolvedValue({
      ok: true,
      review: persistedReview,
      transition,
      receipt,
    });

    const response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/items/item-1/decision`,
      )
      .set("x-test-auth", "yes")
      .send({
        idempotency_key: "idem-decision",
        decision: "edited",
        finding_text: "edited finding",
        comment: "review comment",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      review: persistedReview,
      transition,
      receipt,
    });
    expect(repository.loadExecutionEvidence).toHaveBeenCalledWith({
      project_id: projectId,
      execution_id: "execution-1",
    });
    expect(repository.loadReview).toHaveBeenCalledWith({
      project_id: projectId,
      execution_id: "execution-1",
    });
    expect(evaluateInitialAccess).toHaveBeenCalledWith(expect.anything(), {
      identity: expect.objectContaining({ user_id: "user-1" }),
      organization_id: "org-1",
      matter_id: "matter-1",
      requiresMfa: true,
    });
    expect(createBoundEvidenceResourceScopePort).toHaveBeenCalledWith(
      expect.anything(),
      {
        organization_id: "org-1",
        matter_id: "matter-1",
        project_id: projectId,
      },
    );
    expect(createSupabaseAiPersistencePorts).toHaveBeenCalledWith(
      expect.anything(),
      {
        actor_user_id: "user-1",
        organization_id: "org-1",
        authorization_epoch: 7,
      },
    );
    expect(decideHumanReviewItem).toHaveBeenCalledWith({
      identity: expect.objectContaining({ user_id: "user-1" }),
      granted_scope: grantedScope,
      tenancy_port: expect.anything(),
      resource_scope_port: expect.anything(),
      requires_mfa: true,
      idempotency_key: "idem-decision",
      review: persistedReview,
      item_id: "item-1",
      decision: "edited",
      finding_text: "edited finding",
      comment: "review comment",
      mutation_port: expect.anything(),
    });
  });

  it("completes with the persisted review and execution and supports both terminal states", async () => {
    const receipt = { disposition: "applied", operation: "complete" };
    completeHumanReview.mockResolvedValue({ ok: true, review, receipt });
    for (const terminal_state of ["approved", "changes_requested"] as const) {
      const response = await request(makeApp())
        .post(
          `/projects/${projectId}/ai-executions/execution-1/review/complete`,
        )
        .set("x-test-auth", "yes")
        .send({ idempotency_key: `idem-${terminal_state}`, terminal_state });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ review, receipt });
    }
    expect(completeHumanReview).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ user_id: "user-1" }),
        granted_scope: grantedScope,
        requires_mfa: true,
        review,
        execution,
        terminal_state: "changes_requested",
        idempotency_key: "idem-changes_requested",
        tenancy_port: expect.anything(),
        resource_scope_port: expect.anything(),
        mutation_port: expect.anything(),
      }),
    );
  });

  it("keeps mutation failures and access failures sanitized, and denies a different reviewer before binding writes", async () => {
    repository.loadExecutionEvidence.mockResolvedValueOnce(null);
    let response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/items/item-1/decision`,
      )
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-missing", decision: "accepted" });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
    expect(repository.loadReview).not.toHaveBeenCalled();

    repository.loadReview.mockResolvedValueOnce(null);
    response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review/complete`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-no-review", terminal_state: "approved" });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });

    repository.loadReview.mockResolvedValue({
      ...review,
      reviewer_user_id: "other-user",
    });
    response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review/complete`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-1", terminal_state: "changes_requested" });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "authorization_revoked" });
    expect(createSupabaseAiPersistencePorts).not.toHaveBeenCalled();
    expect(completeHumanReview).not.toHaveBeenCalled();

    repository.loadReview.mockResolvedValue(review);
    for (const error_class of [
      "invalid_review",
      "review_authorization_failed",
      "authorization_dependency_failed",
      "review_write_failed",
    ] as const) {
      decideHumanReviewItem.mockResolvedValueOnce({ ok: false, error_class });
      response = await request(makeApp())
        .post(
          `/projects/${projectId}/ai-executions/execution-1/review/items/item-1/decision`,
        )
        .set("x-test-auth", "yes")
        .send({ idempotency_key: `idem-${error_class}`, decision: "accepted" });
      expect(response.status).toBe(
        error_class === "invalid_review"
          ? 400
          : error_class === "review_authorization_failed"
            ? 403
            : 500,
      );
      expect(response.body.code).toBe(
        error_class === "invalid_review"
          ? "invalid_review"
          : error_class === "review_authorization_failed"
            ? "authorization_revoked"
            : "internal_error",
      );
      expect(response.text).not.toContain("secret");
    }

    evaluateInitialAccess.mockResolvedValueOnce({
      kind: "decision",
      decision: { outcome: "denied", code: "mfa_required", reason: "secret" },
    });
    response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review/complete`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-mfa", terminal_state: "approved" });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "mfa_required" });
    expect(response.text).not.toContain("secret");

    evaluateInitialAccess.mockResolvedValueOnce({
      kind: "authorization_dependency_failed",
      detail: "provider secret",
    });
    response = await request(makeApp())
      .post(`/projects/${projectId}/ai-executions/execution-1/review/complete`)
      .set("x-test-auth", "yes")
      .send({ idempotency_key: "idem-dependency", terminal_state: "approved" });
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.text).not.toContain("provider");
  });
});

describe("POST /projects/:projectId/ai-executions/:executionId/review/redline-bundle", () => {
  const execution = {
    execution_id: "execution-1",
    author_user_id: "author-1",
    status: "succeeded",
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: projectId,
    document_id: "document-1",
    document_version_id: "version-1",
    document_content_sha256: "a".repeat(64),
    evidence_receipt_sha256: "d".repeat(64),
    output_text: "persisted output",
    output_sha256: "e".repeat(64),
    citations: [],
  };
  const evidenceReceipt = {
    receipt_version: "evidence-v1",
    canonical_json: "persisted receipt",
    receipt_sha256: "d".repeat(64),
    page_hashes: [],
  };
  const review = {
    review_id: "review-1",
    revision: 2,
    execution_id: "execution-1",
    execution_author_user_id: "author-1",
    reviewer_user_id: "user-1",
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: projectId,
    document_id: "document-1",
    document_version_id: "version-1",
    document_content_sha256: "a".repeat(64),
    evidence_receipt_sha256: "d".repeat(64),
    status: "approved",
    items: [],
  };
  const sourceVersion = {
    document_id: "document-1",
    document_version_id: "version-1",
    content_sha256: "a".repeat(64),
  };
  const pages = [
    {
      document_id: "document-1",
      document_version_id: "version-1",
      page: 1,
      content: "persisted page",
      content_sha256: "f".repeat(64),
    },
  ];
  const scope = {
    user_id: "user-1",
    organization_id: "org-1",
    matter_id: "matter-1",
    authorization_epoch: 9,
  };
  let repository: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    repository = {
      loadExecutionEvidence: vi.fn().mockResolvedValue({
        execution,
        evidence_receipt: evidenceReceipt,
      }),
      loadReview: vi.fn().mockResolvedValue(review),
      loadSourceVersion: vi.fn().mockResolvedValue(sourceVersion),
      loadPages: vi.fn().mockResolvedValue(pages),
    };
    createSupabaseAiReadRepository.mockReturnValue(repository);
    createSupabaseTenancyReadPort.mockReturnValue({ tenancy: true });
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision: { outcome: "allow", scope },
    });
    createBoundEvidenceResourceScopePort.mockReturnValue({ resource: true });
    createSupabaseAiPersistencePorts.mockReturnValue({
      redline: { append: vi.fn() },
    });
    produceApprovedRedlineBundle.mockResolvedValue({
      ok: true,
      bundle: {
        bundle_version: "approved-redline-v1",
        canonical_json: "opaque",
      },
      receipt: { disposition: "applied" },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it.each([
    {},
    {
      idempotency_key: "idem",
      revision: 1,
      expected_review_revision: 2,
      extra: true,
    },
    { idempotency_key: "", revision: 1, expected_review_revision: 2 },
    { idempotency_key: "idem", revision: 0, expected_review_revision: 2 },
    { idempotency_key: "idem", revision: 1.5, expected_review_revision: 2 },
    {
      idempotency_key: "idem",
      revision: 1,
      expected_review_revision: Number.MAX_SAFE_INTEGER + 1,
    },
  ])("rejects malformed body before any read or write: %j", async (body) => {
    const response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes")
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_approved_redline" });
    expect(createSupabaseAiReadRepository).not.toHaveBeenCalled();
    expect(produceApprovedRedlineBundle).not.toHaveBeenCalled();
    expect(response.text).not.toContain("canonical");
  });

  it("loads persisted inputs after MFA access and binds scope and epoch", async () => {
    const response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes")
      .send({
        idempotency_key: "idem-1",
        revision: 3,
        expected_review_revision: 2,
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      bundle: {
        bundle_version: "approved-redline-v1",
        canonical_json: "opaque",
      },
      receipt: { disposition: "applied" },
    });
    expect(repository.loadExecutionEvidence).toHaveBeenCalledWith({
      project_id: projectId,
      execution_id: "execution-1",
    });
    expect(evaluateInitialAccess).toHaveBeenCalledWith(expect.anything(), {
      identity: expect.objectContaining({ user_id: "user-1" }),
      organization_id: "org-1",
      matter_id: "matter-1",
      requiresMfa: true,
    });
    expect(repository.loadReview).toHaveBeenCalledWith({
      project_id: projectId,
      execution_id: "execution-1",
    });
    expect(repository.loadSourceVersion).toHaveBeenCalledWith({
      document_version_id: "version-1",
    });
    expect(repository.loadPages).toHaveBeenCalledWith({
      document_version_id: "version-1",
    });
    expect(
      repository.loadExecutionEvidence.mock.invocationCallOrder[0],
    ).toBeLessThan(evaluateInitialAccess.mock.invocationCallOrder[0]);
    expect(evaluateInitialAccess.mock.invocationCallOrder[0]).toBeLessThan(
      repository.loadReview.mock.invocationCallOrder[0],
    );
    expect(produceApprovedRedlineBundle).toHaveBeenCalledWith({
      identity: expect.objectContaining({ user_id: "user-1" }),
      granted_scope: scope,
      tenancy_port: { tenancy: true },
      resource_scope_port: { resource: true },
      requires_mfa: true,
      idempotency_key: "idem-1",
      revision: 3,
      expected_review_revision: 2,
      review,
      execution,
      evidence_receipt: evidenceReceipt,
      source_version: sourceVersion,
      pages,
      append_port: expect.anything(),
    });
    expect(createBoundEvidenceResourceScopePort).toHaveBeenCalledWith(
      expect.anything(),
      {
        organization_id: "org-1",
        matter_id: "matter-1",
        project_id: projectId,
      },
    );
    expect(createSupabaseAiPersistencePorts).toHaveBeenCalledWith(
      expect.anything(),
      {
        actor_user_id: "user-1",
        organization_id: "org-1",
        authorization_epoch: 9,
      },
    );
  });

  it.each([
    [
      "missing",
      null,
      { kind: "decision", decision: { outcome: "allow", scope } },
      404,
      "not_found",
    ],
    [
      "outsider",
      { execution, evidence_receipt: evidenceReceipt },
      { kind: "decision", decision: { outcome: "not_found" } },
      404,
      "not_found",
    ],
    [
      "mfa",
      { execution, evidence_receipt: evidenceReceipt },
      {
        kind: "decision",
        decision: { outcome: "denied", code: "mfa_required", reason: "secret" },
      },
      403,
      "mfa_required",
    ],
  ] as const)(
    "maps %s access without loading review or exposing bytes",
    async (_name, evidence, access, status, code) => {
      repository.loadExecutionEvidence.mockResolvedValueOnce(evidence);
      if (evidence) evaluateInitialAccess.mockResolvedValueOnce(access);
      const response = await request(makeApp())
        .post(
          `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
        )
        .set("x-test-auth", "yes")
        .send({
          idempotency_key: "idem-1",
          revision: 1,
          expected_review_revision: 2,
        });
      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({ code });
      expect(repository.loadReview).not.toHaveBeenCalled();
      expect(produceApprovedRedlineBundle).not.toHaveBeenCalled();
      expect(response.text).not.toContain("canonical");
    },
  );

  it("keeps missing persisted review/source opaque and access dependencies sanitized", async () => {
    repository.loadReview.mockResolvedValueOnce(null);
    let response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes")
      .send({
        idempotency_key: "idem-review",
        revision: 1,
        expected_review_revision: 2,
      });
    expect(response.status).toBe(404);
    expect(repository.loadSourceVersion).not.toHaveBeenCalled();
    expect(response.text).not.toContain("canonical");

    repository.loadSourceVersion.mockResolvedValueOnce(null);
    response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes")
      .send({
        idempotency_key: "idem-source",
        revision: 1,
        expected_review_revision: 2,
      });
    expect(response.status).toBe(404);
    expect(repository.loadPages).not.toHaveBeenCalled();

    evaluateInitialAccess.mockResolvedValueOnce({
      kind: "authorization_dependency_failed",
      detail: "provider secret",
    });
    response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes")
      .send({
        idempotency_key: "idem-dependency",
        revision: 1,
        expected_review_revision: 2,
      });
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.text).not.toContain("provider");
  });

  it.each([
    ["invalid_approved_redline", 409, "invalid_approved_redline"],
    ["approved_redline_authorization_failed", 403, "authorization_revoked"],
    ["authorization_dependency_failed", 500, "internal_error"],
    ["approved_redline_append_failed", 500, "internal_error"],
  ] as const)("maps producer failure %s", async (errorClass, status, code) => {
    produceApprovedRedlineBundle.mockResolvedValueOnce({
      ok: false,
      error_class: errorClass,
    });
    const response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes")
      .send({
        idempotency_key: "idem-1",
        revision: 1,
        expected_review_revision: 2,
      });
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code });
    expect(response.text).not.toContain("canonical");
    expect(response.text).not.toContain("bundle");
  });

  it("returns replayed bundles with status 200", async () => {
    produceApprovedRedlineBundle.mockResolvedValueOnce({
      ok: true,
      bundle: {
        bundle_version: "approved-redline-v1",
        canonical_json: "opaque",
      },
      receipt: { disposition: "replayed" },
    });
    const response = await request(makeApp())
      .post(
        `/projects/${projectId}/ai-executions/execution-1/review/redline-bundle`,
      )
      .set("x-test-auth", "yes")
      .send({
        idempotency_key: "idem-1",
        revision: 1,
        expected_review_revision: 2,
      });
    expect(response.status).toBe(200);
    expect(response.body.receipt).toEqual({ disposition: "replayed" });
  });
});
