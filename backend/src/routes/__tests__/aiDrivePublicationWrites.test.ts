import { createHash } from "node:crypto";

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  exportRow: null as Record<string, unknown> | null,
  intent: null as Record<string, unknown> | null,
  evidence: null as Record<string, unknown> | null,
  access: null as Record<string, unknown> | null,
  fresh: true,
  resource: null as Record<string, unknown> | null,
  storage: new Map<string, Uint8Array>(),
}));

const IDS = {
  actor: "00000000-0000-0000-0000-000000000001",
  organization: "00000000-0000-0000-0000-000000000002",
  matter: "00000000-0000-0000-0000-000000000003",
  project: "00000000-0000-0000-0000-000000000004",
  execution: "00000000-0000-0000-0000-000000000005",
  export: "00000000-0000-0000-0000-000000000006",
  review: "00000000-0000-0000-0000-000000000007",
  artifact: "00000000-0000-0000-0000-000000000008",
  artifactVersion: "00000000-0000-0000-0000-000000000009",
  source: "00000000-0000-0000-0000-00000000000a",
  sourceVersion: "00000000-0000-0000-0000-00000000000b",
  publication: "00000000-0000-0000-0000-00000000000c",
} as const;

const artifactBytes = new Uint8Array([1, 2, 3, 4]);
const artifactHash = createHash("sha256").update(artifactBytes).digest("hex");
const sourceHash = "a".repeat(64);
const receiptHash = "b".repeat(64);
const MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const grantedScope = {
  user_id: IDS.actor,
  organization_id: IDS.organization,
  workspace_id: "00000000-0000-0000-0000-00000000000d",
  matter_id: IDS.matter,
  membership_role: "org_owner",
  authorization_epoch: 7,
  requires_explicit_matter_membership: false,
};

function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.export,
    idempotency_key: "approved-report:1",
    review_id: IDS.review,
    review_revision: 3,
    execution_id: IDS.execution,
    organization_id: IDS.organization,
    matter_id: IDS.matter,
    project_id: IDS.project,
    source_document_id: IDS.source,
    source_document_version_id: IDS.sourceVersion,
    artifact_document_id: IDS.artifact,
    artifact_document_version_id: IDS.artifactVersion,
    source_document_sha256: sourceHash,
    evidence_receipt_sha256: receiptHash,
    filename: "Informe de revision humana.docx",
    mime_type: MIME,
    artifact_sha256: artifactHash,
    storage_path: `orgs/${IDS.organization}/matters/${IDS.matter}/projects/${IDS.project}/documents/${IDS.artifact}/${artifactHash}.docx`,
    size_bytes: artifactBytes.length,
    ...overrides,
  };
}

function makeIntent(overrides: Record<string, unknown> = {}) {
  return {
    matter_folder_id: "matter-folder",
    approved_artifact_sha256: artifactHash,
    idempotency_key: "approved-report:1",
    attempts: 1,
    outcome: "unknown_outcome",
    publication_id: IDS.publication,
    export_id: IDS.export,
    review_id: IDS.review,
    execution_id: IDS.execution,
    matter_id: IDS.matter,
    project_id: IDS.project,
    organization_id: IDS.organization,
    actor_user_id: IDS.actor,
    authorization_epoch: 7,
    revision: 1,
    review_revision: 3,
    artifact_document_id: IDS.artifact,
    artifact_document_version_id: IDS.artifactVersion,
    artifact_storage_path: `orgs/${IDS.organization}/matters/${IDS.matter}/projects/${IDS.project}/documents/${IDS.artifact}/${artifactHash}.docx`,
    artifact_size_bytes: artifactBytes.length,
    source_document_id: IDS.source,
    source_document_version_id: IDS.sourceVersion,
    remote_size_bytes: null,
    remote_checksum: null,
    provider_file_id: null,
    failure_code: null,
    legacy_payload: {},
    ...overrides,
  };
}

const {
  from,
  rpc,
  createSupabaseAiReadRepository,
  createBoundEvidenceResourceScopePort,
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
  downloadFileStrict,
} = vi.hoisted(() => {
  const from = vi.fn((table: string) => {
    if (table !== "ai_review_exports") throw new Error("unexpected table");
    const filters: Record<string, unknown> = {};
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((column: string, value: unknown) => {
        filters[column] = value;
        return query;
      }),
      maybeSingle: vi.fn(async () => {
        const row = state.exportRow;
        return {
          data:
            row &&
            Object.entries(filters).every(([key, value]) => row[key] === value)
              ? row
              : null,
          error: null,
        };
      }),
    };
    return query;
  });

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "begin_ai_review_drive_publication") {
      if (!state.intent) state.intent = makeIntent();
      if (
        state.intent.outcome === "uploaded" ||
        state.intent.outcome === "reconciled"
      )
        return {
          data: { disposition: "replayed", ...state.intent },
          error: null,
        };
      expect(args.p_export_id).toBe(IDS.export);
      expect(args.p_review_revision).toBe(3);
      return { data: { disposition: "claimed", ...state.intent }, error: null };
    }
    if (name === "record_ai_review_drive_publication_outcome") {
      const next = makeIntent({
        ...state.intent,
        revision: Number(state.intent?.revision ?? 1) + 1,
        outcome: args.p_outcome,
        provider_file_id: args.p_provider_file_id,
        remote_size_bytes: args.p_remote_size_bytes,
        remote_checksum: args.p_remote_checksum,
        failure_code: null,
      });
      state.intent = next;
      return { data: { disposition: "applied", ...next }, error: null };
    }
    if (name === "read_ai_review_drive_publication") {
      if (
        !state.intent ||
        args.p_publication_id !== state.intent.publication_id
      )
        return { data: null, error: null };
      return { data: { disposition: "read", ...state.intent }, error: null };
    }
    throw new Error(`unexpected RPC ${name}`);
  });

  return {
    from,
    rpc,
    createSupabaseAiReadRepository: vi.fn(() => ({
      loadExecutionEvidence: vi.fn(async () =>
        state.evidence
          ? { execution: state.evidence, evidence_receipt: {} }
          : null,
      ),
      loadReview: vi.fn(),
    })),
    createBoundEvidenceResourceScopePort: vi.fn(() => ({
      getEvidenceResourceScope: vi.fn(async () => state.resource),
    })),
    evaluateInitialAccess: vi.fn(
      async () =>
        state.access ?? {
          kind: "decision",
          decision: { outcome: "not_found" },
        },
    ),
    recheckFreshAccessViaPort: vi.fn(async () => ({
      kind: "recheck",
      result: { fresh: state.fresh },
    })),
    downloadFileStrict: vi.fn(
      async (key: string) => state.storage.get(key) ?? null,
    ),
  };
});

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (_req.header("x-test-auth") !== "yes") {
      res.status(401).json({ code: "authentication_required" });
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
  createServerSupabase: vi.fn(() => ({ from, rpc })),
}));
vi.mock("../../lib/recovery/authorization/supabaseTenancyReadPort", () => ({
  createSupabaseTenancyReadPort: vi.fn(() => ({})),
}));
vi.mock("../../lib/recovery/authorization/tenancyReadPort", () => ({
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
}));
vi.mock("../../lib/recovery/persistence/supabaseAiReadRepository", () => ({
  createSupabaseAiReadRepository,
  createBoundEvidenceResourceScopePort,
}));
vi.mock("../../lib/storage", () => ({
  uploadFileIfAbsent: vi.fn(),
  downloadFileStrict,
}));

import { createFakeDrive } from "../../lib/recovery/drive/fakeDrive";
import { aiRecoveryRouter } from "../aiRecovery";

function makeApp(
  transport: unknown = createFakeDrive(),
  beforeRouter?: express.RequestHandler,
) {
  const app = express();
  app.use(express.json());
  if (beforeRouter) app.use(beforeRouter);
  if (transport !== undefined) app.locals.recoveryDriveTransport = transport;
  app.use("/projects/:projectId/ai-executions", aiRecoveryRouter);
  return app;
}

const publishPath = `/projects/${IDS.project}/ai-executions/${IDS.execution}/review/drive-publications`;

beforeEach(() => {
  state.exportRow = exportRow();
  state.intent = null;
  state.evidence = {
    execution_id: IDS.execution,
    author_user_id: IDS.actor,
    status: "succeeded",
    organization_id: IDS.organization,
    matter_id: IDS.matter,
    project_id: IDS.project,
    document_id: IDS.source,
    document_version_id: IDS.sourceVersion,
    document_content_sha256: sourceHash,
    evidence_receipt_sha256: receiptHash,
    output_text: "approved",
    output_sha256: "c".repeat(64),
    citations: [],
  };
  state.access = {
    kind: "decision",
    decision: { outcome: "allow", scope: grantedScope },
  };
  state.fresh = true;
  state.resource = {
    organization_id: IDS.organization,
    matter_id: IDS.matter,
    project_id: IDS.project,
    document_id: IDS.artifact,
    document_version_id: IDS.artifactVersion,
    document_content_sha256: artifactHash,
  };
  state.storage.clear();
  state.storage.set(
    exportRow().storage_path as string,
    new Uint8Array(artifactBytes),
  );
  from.mockClear();
  rpc.mockClear();
  evaluateInitialAccess.mockClear();
  recheckFreshAccessViaPort.mockClear();
  createSupabaseAiReadRepository.mockClear();
  createBoundEvidenceResourceScopePort.mockClear();
  downloadFileStrict.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("Drive publication write routes", () => {
  it("does not expose a successful response when revocation lands during its final resource read", async () => {
    let reads = 0;
    createBoundEvidenceResourceScopePort.mockImplementationOnce(() => ({
      getEvidenceResourceScope: vi.fn(async () => {
        if (++reads === 3) state.fresh = false;
        return state.resource;
      }),
    }));
    const drive = createFakeDrive();
    const response = await request(makeApp(drive))
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });
    expect(reads).toBe(3);
    expect(drive.uploadCount).toBe(1);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty("publication");
  });

  it("rejects a mismatched repository execution before creating any claim", async () => {
    state.evidence = { ...state.evidence, execution_id: IDS.publication };
    const response = await request(makeApp())
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });
    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("snapshots the mutable request export identifier exactly once", async () => {
    let reads = 0;
    const app = makeApp(createFakeDrive(), (req, _res, next) => {
      Object.defineProperty(req.body, "export_id", {
        enumerable: true,
        get: () => (++reads === 1 ? IDS.export : IDS.publication),
      });
      next();
    });
    const response = await request(app)
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });
    expect(response.status).toBe(201);
    expect(reads).toBe(1);
  });

  it("uploads once through the real service and replays without another upload", async () => {
    const drive = createFakeDrive();
    const app = makeApp(drive);
    const first = await request(app)
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });
    const second = await request(app)
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(first.body).toMatchObject({
      outcome: "uploaded",
      disposition: "uploaded",
      publication: {
        publication_id: IDS.publication,
        provider_file_id: "fake-file-1",
      },
    });
    expect(second.body).toMatchObject({
      outcome: "uploaded",
      disposition: "replayed",
    });
    expect(drive.uploadCount).toBe(1);
    expect(first.text).not.toContain("artifact_storage_path");
    expect(first.text).not.toContain("matter_folder_id");
    expect(first.text).not.toContain("authorization_epoch");
  });

  it.each([
    {
      export_id: IDS.export,
      expected_review_revision: 3,
      storage_path: "forbidden",
    },
    {
      export_id: IDS.export,
      expected_review_revision: 3,
      artifact_sha256: artifactHash,
    },
    {
      export_id: IDS.export,
      expected_review_revision: 3,
      matter_folder_id: "forbidden",
    },
  ])("rejects client authority field %# before a claim", async (body) => {
    const response = await request(makeApp())
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send(body);

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps outsiders opaque and reports MFA denial without claiming", async () => {
    state.access = { kind: "decision", decision: { outcome: "not_found" } };
    let response = await request(makeApp())
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });
    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();

    state.access = {
      kind: "decision",
      decision: { outcome: "denied", code: "mfa_required" },
    };
    response = await request(makeApp())
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: "mfa_required",
      detail: "MFA required.",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an export filtered to another execution or with another tenant before begin", async () => {
    let response = await request(makeApp())
      .post(
        `/projects/${IDS.project}/ai-executions/${IDS.publication}/review/drive-publications`,
      )
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });
    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();

    state.exportRow = exportRow({ organization_id: IDS.actor });
    response = await request(makeApp())
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });
    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not upload after fresh epoch/MFA revalidation is revoked", async () => {
    state.fresh = false;
    const drive = createFakeDrive();
    const response = await request(makeApp(drive))
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });

    expect(response.status).toBe(500);
    expect(drive.uploadCount).toBe(0);
  });

  it("reads and scopes a publication before reconciling its URL", async () => {
    state.intent = makeIntent({ outcome: "unknown_outcome" });
    const response = await request(makeApp())
      .post(`${publishPath}/${IDS.publication}/reconcile`)
      .set("x-test-auth", "yes")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "unknown_outcome",
      disposition: "unknown_outcome",
      publication: { publication_id: IDS.publication },
    });
    expect(rpc.mock.calls[0]?.[0]).toBe("read_ai_review_drive_publication");
    expect(response.text).not.toContain("artifact_storage_path");
  });

  it("keeps a wrong publication URI opaque before service reconciliation", async () => {
    state.intent = makeIntent({ outcome: "unknown_outcome" });
    const response = await request(makeApp())
      .post(`${publishPath}/00000000-0000-0000-0000-00000000000e/reconcile`)
      .set("x-test-auth", "yes")
      .send({});

    expect(response.status).toBe(404);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0]).toBe("read_ai_review_drive_publication");
  });

  it.each([undefined, { kind: "real", host: "drive.example" }])(
    "fails closed without a fake server transport (%#) and never claims",
    async (transport) => {
      const app = express();
      app.use(express.json());
      if (transport !== undefined)
        app.locals.recoveryDriveTransport = transport;
      app.use("/projects/:projectId/ai-executions", aiRecoveryRouter);
      const response = await request(app)
        .post(publishPath)
        .set("x-test-auth", "yes")
        .send({ export_id: IDS.export, expected_review_revision: 3 });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        code: "drive_publication_unavailable",
        detail: "Drive publication unavailable.",
      });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("sanitizes malformed transport metadata without exposing internal authority", async () => {
    const drive = createFakeDrive({
      returnedMetadata: { folder_id: "wrong-folder" },
    });
    const response = await request(makeApp(drive))
      .post(publishPath)
      .set("x-test-auth", "yes")
      .send({ export_id: IDS.export, expected_review_revision: 3 });

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe("unknown_outcome");
    expect(response.text).not.toContain("artifact_storage_path");
    expect(response.text).not.toContain("idempotency_key");
    expect(response.text).not.toContain("wrong-folder");
  });
});
