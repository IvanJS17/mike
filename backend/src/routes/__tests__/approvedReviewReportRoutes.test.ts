import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  exportRow: null as Record<string, unknown> | null,
  objects: new Map<string, Uint8Array>(),
  currentReview: null as Record<string, unknown> | null,
  currentEvidence: null as Record<string, unknown> | null,
  denied: false,
  commitThenThrow: false,
  rpcCalls: 0,
  uploadCalls: 0,
  epoch: 1,
  revokeAfterRead: false,
}));

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  execution: "00000000-0000-4000-8000-000000000002",
  review: "00000000-0000-4000-8000-000000000003",
  organization: "00000000-0000-4000-8000-000000000004",
  matter: "00000000-0000-4000-8000-000000000005",
  document: "00000000-0000-4000-8000-000000000006",
  version: "00000000-0000-4000-8000-000000000007",
};
const sourceHash = "a".repeat(64);
const outputText = "Approved finding";
const outputHash = createHash("sha256").update(outputText).digest("hex");

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

const receiptBody = {
  receipt_version: "evidence-v1",
  idempotency_key: "evidence:route",
  execution_id: ids.execution,
  tenant_scope: {
    organization_id: ids.organization,
    matter_id: ids.matter,
    project_id: ids.project,
    document_version_id: ids.version,
  },
  route: { provider: "openai", model: "gpt-5", credential_ref: "key-v1" },
  workflow: {
    workflow_key: "workflow",
    version: "1",
    content_hash: "b".repeat(64),
    source_commit: "c".repeat(40),
    distribution: "default",
    type: "assistant",
    source: "workflow.md",
    approval_provenance: "approved",
  },
  status: "completed",
  input_hashes: [sourceHash],
  page_hashes: [
    {
      document_id: ids.document,
      document_version_id: ids.version,
      page: 1,
      text_sha256: "d".repeat(64),
    },
  ],
  output_hash: outputHash,
  citation_hashes: [],
};
const receiptCanonical = canonical(receiptBody);
const receiptHash = createHash("sha256").update(receiptCanonical).digest("hex");

function makeReview(revision = 1): Record<string, unknown> {
  return {
    review_id: ids.review,
    revision,
    execution_id: ids.execution,
    execution_author_user_id: "00000000-0000-4000-8000-000000000008",
    reviewer_user_id: "00000000-0000-4000-8000-000000000009",
    organization_id: ids.organization,
    matter_id: ids.matter,
    project_id: ids.project,
    document_id: ids.document,
    document_version_id: ids.version,
    document_content_sha256: sourceHash,
    evidence_receipt_sha256: receiptHash,
    status: "approved",
    items: [
      {
        item_id: "finding-1",
        item_key: "finding-1",
        original_text: outputText,
        finding_text: outputText,
        status: "accepted",
        comment: null,
        citation: null,
      },
    ],
  };
}

function makeExecution(): Record<string, unknown> {
  return {
    execution_id: ids.execution,
    author_user_id: "00000000-0000-4000-8000-000000000008",
    status: "succeeded",
    organization_id: ids.organization,
    matter_id: ids.matter,
    project_id: ids.project,
    document_id: ids.document,
    document_version_id: ids.version,
    document_content_sha256: sourceHash,
    evidence_receipt_sha256: receiptHash,
    output_text: outputText,
    output_sha256: outputHash,
    citations: [],
  };
}

const tenancyPort = {
  getOrganizationMembership: vi.fn(async () => ({
    user_id: "00000000-0000-4000-8000-000000000009",
    organization_id: ids.organization,
    role: "org_owner",
    status: "active",
    authorization_epoch: state.epoch,
  })),
  getMatter: vi.fn(async () => ({
    matter_id: ids.matter,
    workspace_id: "00000000-0000-4000-8000-000000000010",
    organization_id: ids.organization,
    visibility: "public",
  })),
  getMatterMembership: vi.fn(),
};

const { from, rpc, repository, resourceScope } = vi.hoisted(() => {
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
        const matches =
          row !== null &&
          Object.entries(filters).every(([key, value]) => row[key] === value);
        return { data: matches ? row : null, error: null };
      }),
    };
    return query;
  });
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    state.rpcCalls += 1;
    const submitted = args.p_artifact as Record<string, unknown>;
    if (!state.exportRow) {
      const { document_id, document_version_id, ...metadata } = submitted;
      state.exportRow = {
        id: "00000000-0000-4000-8000-000000000011",
        ...metadata,
        source_document_id: document_id,
        source_document_version_id: document_version_id,
      };
    }
    const response = {
      data: {
        disposition: state.rpcCalls === 1 ? "applied" : "replayed",
        review_id: ids.review,
        review_revision: 1,
        execution_id: ids.execution,
        artifact_sha256: submitted.artifact_sha256,
        idempotency_key: submitted.idempotency_key,
      },
      error: null,
    };
    if (state.commitThenThrow) {
      state.commitThenThrow = false;
      throw new Error("unknown RPC outcome");
    }
    return response;
  });
  const repository = {
    loadExecutionEvidence: vi.fn(async () => state.currentEvidence),
    loadReview: vi.fn(async () => state.currentReview),
  };
  const resourceScope = {
    getEvidenceResourceScope: vi.fn(async () => ({
      organization_id: ids.organization,
      matter_id: ids.matter,
      project_id: ids.project,
      document_id: ids.document,
      document_version_id: ids.version,
      document_content_sha256: sourceHash,
    })),
  };
  return { from, rpc, repository, resourceScope };
});

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    res.locals.authenticatedIdentity = {
      user_id: "00000000-0000-4000-8000-000000000009",
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
  createSupabaseTenancyReadPort: vi.fn(() => tenancyPort),
}));
vi.mock(
  "../../lib/recovery/authorization/tenancyReadPort",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../lib/recovery/authorization/tenancyReadPort")
      >();
    return {
      ...actual,
      evaluateInitialAccess: vi.fn(async () =>
        state.denied
          ? { kind: "decision", decision: { outcome: "not_found" } }
          : {
              kind: "decision",
              decision: {
                outcome: "allow",
                scope: {
                  user_id: "00000000-0000-4000-8000-000000000009",
                  organization_id: ids.organization,
                  workspace_id: "00000000-0000-4000-8000-000000000010",
                  matter_id: ids.matter,
                  membership_role: "org_owner",
                  authorization_epoch: 1,
                  requires_explicit_matter_membership: false,
                },
              },
            },
      ),
    };
  },
);
vi.mock("../../lib/recovery/persistence/supabaseAiReadRepository", () => ({
  createSupabaseAiReadRepository: vi.fn(() => repository),
  createBoundEvidenceResourceScopePort: vi.fn(() => resourceScope),
}));
vi.mock("../../lib/storage", () => ({
  uploadFileIfAbsent: vi.fn(async (key: string, bytes: Uint8Array) => {
    state.uploadCalls += 1;
    if (state.objects.has(key)) return "exists";
    state.objects.set(key, new Uint8Array(bytes));
    return "created";
  }),
  downloadFileStrict: vi.fn(async (key: string) => {
    const bytes = state.objects.get(key) ?? null;
    if (state.revokeAfterRead) state.epoch = 2;
    return bytes;
  }),
}));

import { approvedDocxRenderer } from "../../lib/recovery/review/approvedDocxRenderer";
import { aiRecoveryRouter } from "../aiRecovery";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/ai-executions", aiRecoveryRouter);
  return app;
}

function binaryParser(
  response: NodeJS.ReadableStream,
  callback: (error: null, body: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
}

describe("approved review report routes", () => {
  let render: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.exportRow = null;
    state.objects.clear();
    state.currentReview = makeReview();
    state.currentEvidence = {
      execution: makeExecution(),
      evidence_receipt: {
        receipt_version: "evidence-v1",
        canonical_json: receiptCanonical,
        receipt_sha256: receiptHash,
      },
    };
    state.denied = false;
    state.commitThenThrow = false;
    state.rpcCalls = 0;
    state.uploadCalls = 0;
    state.epoch = 1;
    state.revokeAfterRead = false;
    render = vi.spyOn(approvedDocxRenderer, "render");
  });

  afterEach(() => {
    render.mockRestore();
  });

  it("creates a real approved DOCX, serves it, and replays without rendering or uploading", async () => {
    const path = `/projects/${ids.project}/ai-executions/${ids.execution}/review/approved-report`;
    const first = await request(makeApp())
      .post(path)
      .send({ expected_review_revision: 1, idempotency_key: "report:route" });
    expect(first.status).toBe(201);
    expect(first.body.receipt.disposition).toBe("applied");
    expect(first.body.export_id).toBe("00000000-0000-4000-8000-000000000011");
    expect(render).toHaveBeenCalledOnce();
    expect(state.uploadCalls).toBe(1);

    const served = await request(makeApp())
      .get(`${path}?revision=1`)
      .buffer(true)
      .parse(binaryParser);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(served.body.subarray(0, 2).toString()).toBe("PK");

    const replay = await request(makeApp())
      .post(path)
      .send({ expected_review_revision: 1, idempotency_key: "report:route" });
    expect(replay.status).toBe(200);
    expect(replay.body.receipt.disposition).toBe("replayed");
    expect(replay.body.export_id).toBe(first.body.export_id);
    expect(render).toHaveBeenCalledOnce();
    expect(state.uploadCalls).toBe(1);
  });

  it("rejects a malformed committed ID without deleting the committed artifact", async () => {
    const original = from.getMockImplementation()!;
    from.mockImplementation((table: string) => {
      const query = original(table);
      const read = query.maybeSingle.getMockImplementation()!;
      query.maybeSingle.mockImplementation(async () => {
        const result = await read();
        return result.data
          ? { ...result, data: { ...result.data, id: "not-a-uuid" } }
          : result;
      });
      return query;
    });
    try {
      const response = await request(makeApp())
        .post(
          `/projects/${ids.project}/ai-executions/${ids.execution}/review/approved-report`,
        )
        .send({
          expected_review_revision: 1,
          idempotency_key: "report:bad-receipt",
        });
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty("export_id");
      expect(state.exportRow?.id).toBe("00000000-0000-4000-8000-000000000011");
      expect(state.objects.size).toBe(1);
    } finally {
      from.mockImplementation(original);
    }
  });

  it("withholds the export ID after revocation during the final resource read", async () => {
    const original =
      resourceScope.getEvidenceResourceScope.getMockImplementation()!;
    let readsAfterCommit = 0;
    resourceScope.getEvidenceResourceScope.mockImplementation(async () => {
      const value = await original();
      if (state.exportRow && ++readsAfterCommit === 2) state.epoch += 1;
      return value;
    });
    try {
      const response = await request(makeApp())
        .post(
          `/projects/${ids.project}/ai-executions/${ids.execution}/review/approved-report`,
        )
        .send({
          expected_review_revision: 1,
          idempotency_key: "report:final-revocation",
        });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty("export_id");
      expect(state.exportRow).not.toBeNull();
      expect(state.uploadCalls).toBe(1);
    } finally {
      resourceScope.getEvidenceResourceScope.mockImplementation(original);
    }
  });

  it("reconciles a committed object after an unknown RPC outcome", async () => {
    state.commitThenThrow = true;
    const path = `/projects/${ids.project}/ai-executions/${ids.execution}/review/approved-report`;
    await expect(
      request(makeApp()).post(path).send({
        expected_review_revision: 1,
        idempotency_key: "report:unknown",
      }),
    ).resolves.toMatchObject({ status: 500 });
    const retry = await request(makeApp())
      .post(path)
      .send({ expected_review_revision: 1, idempotency_key: "report:unknown" });
    expect(retry.status).toBe(200);
    expect(retry.body.receipt.disposition).toBe("replayed");
    expect(state.uploadCalls).toBe(1);
  });

  it("fails closed on supersession, foreign scope, and tampered bytes", async () => {
    const path = `/projects/${ids.project}/ai-executions/${ids.execution}/review/approved-report`;
    const created = await request(makeApp())
      .post(path)
      .send({ expected_review_revision: 1, idempotency_key: "report:tamper" });
    expect(created.status).toBe(201);
    const objectKey = [...state.objects.keys()][0];
    state.objects.set(objectKey, new TextEncoder().encode("tampered"));
    expect((await request(makeApp()).get(path)).status).toBe(500);

    state.denied = true;
    expect((await request(makeApp()).get(path)).status).toBe(404);

    state.denied = false;
    state.currentReview = makeReview(2);
    expect(
      (
        await request(makeApp()).post(path).send({
          expected_review_revision: 1,
          idempotency_key: "report:tamper",
        })
      ).status,
    ).toBe(409);
  });

  it("rejects supersession during render and revocation during the async read", async () => {
    const path = `/projects/${ids.project}/ai-executions/${ids.execution}/review/approved-report`;
    const realRender = render.getMockImplementation()!;
    render.mockImplementationOnce(async (plan) => {
      state.currentReview = makeReview(2);
      return realRender(plan);
    });
    const superseded = await request(makeApp())
      .post(path)
      .send({ expected_review_revision: 1, idempotency_key: "report:race" });
    expect(superseded.status).toBe(500);
    expect(state.uploadCalls).toBe(0);
    expect(state.rpcCalls).toBe(0);

    state.currentReview = makeReview();
    const created = await request(makeApp())
      .post(path)
      .send({ expected_review_revision: 1, idempotency_key: "report:race" });
    expect(created.status).toBe(201);
    state.revokeAfterRead = true;
    expect((await request(makeApp()).get(path)).status).toBe(500);
  });

  it("keeps concurrent retries append-only and idempotent", async () => {
    const path = `/projects/${ids.project}/ai-executions/${ids.execution}/review/approved-report`;
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(makeApp()).post(path).send({
          expected_review_revision: 1,
          idempotency_key: "report:concurrent",
        }),
      ),
    );
    expect(
      responses.every((response) => [200, 201].includes(response.status)),
    ).toBe(true);
    expect(state.uploadCalls).toBe(1);
    expect(state.exportRow).not.toBeNull();
  });

  it("does not write for malformed idempotency or extra query keys", async () => {
    const path = `/projects/${ids.project}/ai-executions/${ids.execution}/review/approved-report`;
    expect(
      (
        await request(makeApp())
          .post(path)
          .send({ expected_review_revision: 1, idempotency_key: "bad key" })
      ).status,
    ).toBe(400);
    expect(
      (await request(makeApp()).get(`${path}?revision=1&extra=x`)).status,
    ).toBe(400);
    expect(state.rpcCalls).toBe(0);
    expect(state.uploadCalls).toBe(0);
  });
});
