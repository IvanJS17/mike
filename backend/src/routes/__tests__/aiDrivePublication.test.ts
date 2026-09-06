import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  rpc,
  createSupabaseTenancyReadPort,
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
  createSupabaseAiReadRepository,
  createBoundEvidenceResourceScopePort,
  uploadFileIfAbsent,
  downloadFileStrict,
} = vi.hoisted(() => ({
  rpc: vi.fn(),
  createSupabaseTenancyReadPort: vi.fn(),
  evaluateInitialAccess: vi.fn(),
  recheckFreshAccessViaPort: vi.fn(),
  createSupabaseAiReadRepository: vi.fn(),
  createBoundEvidenceResourceScopePort: vi.fn(),
  uploadFileIfAbsent: vi.fn(),
  downloadFileStrict: vi.fn(),
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
      user_id: IDS.actor,
      transport: { kind: "web_session" },
      mfa_satisfied: true,
    };
    next();
  },
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => ({ rpc })),
}));

vi.mock("../../lib/recovery/authorization/supabaseTenancyReadPort", () => ({
  createSupabaseTenancyReadPort,
}));

vi.mock("../../lib/recovery/authorization/tenancyReadPort", () => ({
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
}));

vi.mock("../../lib/recovery/persistence/supabaseAiReadRepository", () => ({
  createSupabaseAiReadRepository,
  createBoundEvidenceResourceScopePort,
}));

vi.mock("../../lib/recovery/review/humanReview", () => ({
  completeHumanReview: vi.fn(),
  decideHumanReviewItem: vi.fn(),
  createHumanReview: vi.fn(),
  recheckHumanReviewResourceScope: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({ uploadFileIfAbsent, downloadFileStrict }));

import { aiRecoveryRouter } from "../aiRecovery";

const IDS = {
  actor: "00000000-0000-0000-0000-000000000001",
  organization: "00000000-0000-0000-0000-000000000002",
  matter: "00000000-0000-0000-0000-000000000003",
  project: "00000000-0000-0000-0000-000000000004",
  execution: "00000000-0000-0000-0000-000000000005",
  publication: "00000000-0000-0000-0000-000000000006",
  export: "00000000-0000-0000-0000-000000000007",
  artifact: "00000000-0000-0000-0000-000000000008",
  artifactVersion: "00000000-0000-0000-0000-000000000009",
  source: "00000000-0000-0000-0000-00000000000a",
  sourceVersion: "00000000-0000-0000-0000-00000000000b",
} as const;

const grantedScope = {
  user_id: IDS.actor,
  organization_id: IDS.organization,
  workspace_id: "00000000-0000-0000-0000-00000000000c",
  matter_id: IDS.matter,
  membership_role: "member",
  authorization_epoch: 7,
  requires_explicit_matter_membership: false,
};

const evidence = {
  execution_id: IDS.execution,
  author_user_id: "00000000-0000-0000-0000-00000000000d",
  status: "succeeded",
  organization_id: IDS.organization,
  matter_id: IDS.matter,
  project_id: IDS.project,
  document_id: IDS.source,
  document_version_id: IDS.sourceVersion,
  document_content_sha256: "a".repeat(64),
  evidence_receipt_sha256: "b".repeat(64),
  output_text: "opaque",
  output_sha256: "c".repeat(64),
  citations: [],
};

function publication(overrides: Record<string, unknown> = {}) {
  return {
    disposition: "read",
    publication_id: IDS.publication,
    export_id: IDS.export,
    review_id: "00000000-0000-0000-0000-00000000000e",
    execution_id: IDS.execution,
    matter_id: IDS.matter,
    project_id: IDS.project,
    organization_id: IDS.organization,
    actor_user_id: IDS.actor,
    authorization_epoch: 7,
    matter_folder_id: "drive-folder",
    approved_artifact_sha256: "d".repeat(64),
    idempotency_key: "export-1",
    attempts: 1,
    outcome: "uploaded",
    provider_file_id: "drive-file-1",
    revision: 2,
    review_revision: 3,
    artifact_document_id: IDS.artifact,
    artifact_document_version_id: IDS.artifactVersion,
    artifact_storage_path: `orgs/${IDS.organization}/matters/${IDS.matter}/projects/${IDS.project}/documents/${IDS.artifact}/${"d".repeat(64)}.docx`,
    artifact_size_bytes: 42,
    source_document_id: IDS.source,
    source_document_version_id: IDS.sourceVersion,
    remote_size_bytes: 42,
    remote_checksum: "d".repeat(64),
    failure_code: null,
    legacy_payload: {},
    ...overrides,
  };
}

function makeApp() {
  const app = express();
  app.use("/projects/:projectId/ai-executions", aiRecoveryRouter);
  return app;
}

describe("GET /projects/:projectId/ai-executions/:executionId/review/drive-publications/:publicationId", () => {
  beforeEach(() => {
    rpc.mockResolvedValue({ data: publication(), error: null });
    createSupabaseAiReadRepository.mockReturnValue({
      loadExecutionEvidence: vi.fn().mockResolvedValue({
        execution: evidence,
        evidence_receipt: {},
      }),
    });
    createSupabaseTenancyReadPort.mockReturnValue({ tenancy: true });
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision: { outcome: "allow", scope: grantedScope },
    });
    recheckFreshAccessViaPort.mockResolvedValue({
      kind: "recheck",
      result: { fresh: true },
    });
    createBoundEvidenceResourceScopePort.mockReturnValue({
      getEvidenceResourceScope: vi.fn().mockResolvedValue({
        organization_id: IDS.organization,
        matter_id: IDS.matter,
        project_id: IDS.project,
        document_id: IDS.artifact,
        document_version_id: IDS.artifactVersion,
        document_content_sha256: "d".repeat(64),
      }),
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("requires the existing authenticated session", async () => {
    const response = await request(makeApp()).get(
      `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
    );

    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads through the real persistence adapter and returns only the public DTO", async () => {
    const response = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      publication_id: IDS.publication,
      export_id: IDS.export,
      execution_id: IDS.execution,
      review_revision: 3,
      revision: 2,
      outcome: "uploaded",
      attempts: 1,
      approved_artifact_sha256: "d".repeat(64),
      provider_file_id: "drive-file-1",
      failure_code: null,
    });
    expect(Object.keys(response.body).sort()).toEqual([
      "approved_artifact_sha256",
      "attempts",
      "execution_id",
      "export_id",
      "failure_code",
      "outcome",
      "provider_file_id",
      "publication_id",
      "review_revision",
      "revision",
    ]);
    expect(response.text).not.toContain("artifact_storage_path");
    expect(response.text).not.toContain("idempotency_key");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("read_ai_review_drive_publication", {
      p_publication_id: IDS.publication,
      p_actor_user_id: IDS.actor,
      p_organization_id: IDS.organization,
      p_authorization_epoch: 7,
    });
    expect(recheckFreshAccessViaPort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({ user_id: IDS.actor }),
        requiresMfa: true,
      }),
    );
  });

  it("keeps missing publications opaque", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });

    const response = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
    expect(createBoundEvidenceResourceScopePort).not.toHaveBeenCalled();
  });

  it.each([
    ["private matter mismatch", { outcome: "not_found" }],
    [
      "revoked access",
      { outcome: "denied", code: "authorization_revoked", reason: "secret" },
    ],
  ])("keeps %s opaque before reading publication state", async (_name, decision) => {
    evaluateInitialAccess.mockResolvedValueOnce({
      kind: "decision",
      decision,
    });

    const response = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["execution", { execution_id: "00000000-0000-0000-0000-000000000010" }],
    [
      "project",
      {
        project_id: "00000000-0000-0000-0000-000000000010",
        artifact_storage_path: `orgs/${IDS.organization}/matters/${IDS.matter}/projects/00000000-0000-0000-0000-000000000010/documents/${IDS.artifact}/${"d".repeat(64)}.docx`,
      },
    ],
    [
      "matter",
      {
        matter_id: "00000000-0000-0000-0000-000000000010",
        artifact_storage_path: `orgs/${IDS.organization}/matters/00000000-0000-0000-0000-000000000010/projects/${IDS.project}/documents/${IDS.artifact}/${"d".repeat(64)}.docx`,
      },
    ],
  ])("keeps a publication with a mismatched %s opaque", async (_name, change) => {
    rpc.mockResolvedValueOnce({ data: publication(change), error: null });

    const response = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
    expect(createBoundEvidenceResourceScopePort).not.toHaveBeenCalled();
  });

  it("does not emit a status after the authorization epoch becomes stale", async () => {
    recheckFreshAccessViaPort.mockResolvedValueOnce({
      kind: "recheck",
      result: { fresh: false, code: "authorization_revoked" },
    });

    const response = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
    expect(
      createBoundEvidenceResourceScopePort.mock.results[0]?.value
        ?.getEvidenceResourceScope,
    ).toHaveBeenCalledTimes(1);
  });

  it("sanitizes malformed persisted DTOs and dependency failures", async () => {
    rpc.mockResolvedValueOnce({
      data: { ...publication(), outcome: "secret-outcome" },
      error: null,
    });
    let response = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(500);
    expect(response.body).toEqual(
      expect.objectContaining({ code: "internal_error" }),
    );
    expect(response.text).not.toContain("secret-outcome");

    rpc.mockRejectedValueOnce(new Error("provider secret and SQL details"));
    response = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");
    expect(response.status).toBe(500);
    expect(response.text).not.toContain("provider secret");
    expect(response.text).not.toContain("SQL details");
  });

  it("rechecks the bound resource and re-reads the RPC on every request without writes", async () => {
    const first = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");
    const second = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.every(([name]) => name === "read_ai_review_drive_publication")).toBe(true);
    expect(createBoundEvidenceResourceScopePort).toHaveBeenCalledTimes(2);
    expect(uploadFileIfAbsent).not.toHaveBeenCalled();
    expect(downloadFileStrict).not.toHaveBeenCalled();
  });

  it("denies revocation occurring while the artifact scope is being read", async () => {
    let revoked = false;
    recheckFreshAccessViaPort.mockImplementation(async () => ({
      kind: "recheck",
      result: { fresh: !revoked, code: "authorization_revoked" },
    }));
    createBoundEvidenceResourceScopePort.mockReturnValueOnce({
      getEvidenceResourceScope: vi.fn().mockImplementation(async () => {
        revoked = true;
        return {
          organization_id: IDS.organization,
          matter_id: IDS.matter,
          project_id: IDS.project,
          document_id: IDS.artifact,
          document_version_id: IDS.artifactVersion,
          document_content_sha256: "d".repeat(64),
        };
      }),
    });
    const response = await request(makeApp())
      .get(`/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`)
      .set("x-test-auth", "yes");
    expect(revoked).toBe(true);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
  });

  it("denies a resource-scope mismatch before emitting the DTO", async () => {
    createBoundEvidenceResourceScopePort.mockReturnValueOnce({
      getEvidenceResourceScope: vi.fn().mockResolvedValue({
        organization_id: IDS.organization,
        matter_id: IDS.matter,
        project_id: "00000000-0000-0000-0000-000000000010",
        document_id: IDS.artifact,
        document_version_id: IDS.artifactVersion,
        document_content_sha256: "d".repeat(64),
      }),
    });

    const response = await request(makeApp())
      .get(
        `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications/${IDS.publication}`,
      )
      .set("x-test-auth", "yes");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
  });
});
