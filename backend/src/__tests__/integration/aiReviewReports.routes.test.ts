import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { canonicalJson, sha256Hex } from "../../lib/aiReceipts";

const {
  checkMatterAccess,
  assertEpochFresh,
  generateDocx,
  uploadFile,
  downloadFile,
  recordAuditEvent,
} = vi.hoisted(() => ({
  checkMatterAccess: vi.fn(),
  assertEpochFresh: vi.fn(),
  generateDocx: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

const rows: Record<string, Record<string, unknown>[]> = {
  ai_executions: [
    {
      id: "execution-1",
      user_id: "author-1",
      matter_id: "matter-1",
      project_id: "project-1",
      document_id: "source-document-1",
      document_version_id: "source-version-1",
      status: "succeeded",
    },
  ],
  ai_reviews: [
    {
      id: "review-1",
      execution_id: "execution-1",
      matter_id: "matter-1",
      project_id: "project-1",
      reviewer_user_id: "reviewer-1",
      status: "approved",
      created_at: "2026-08-19T12:00:00.000Z",
      completed_at: "2026-08-19T12:05:00.000Z",
    },
  ],
  ai_review_items: [
    {
      id: "item-1",
      review_id: "review-1",
      item_key: "finding-1",
      finding_text: "La cláusula permite terminar el contrato.",
      status: "accepted",
      citation_refs: [
        {
          citation_id: "c1",
          document_version_id: "source-version-1",
          page: 1,
          span: { start_char: 0, end_char: 10 },
          quote_sha256: "a".repeat(64),
          verified: true,
        },
      ],
    },
  ],
  ai_review_decisions: [],
  ai_receipts: [
    {
      id: "receipt-1",
      execution_id: "execution-1",
      receipt_version: "beta-0.1",
      canonical_json: {
        execution_id: "execution-1",
        result: { status: "succeeded" },
      },
      receipt_sha256: "",
    },
  ],
  ai_review_exports: [],
  documents: [],
  document_versions: [],
  organizations: [{ id: "org-1", authorization_epoch: 1 }],
};

let ids = 0;

function nextId(table: string): string {
  ids += 1;
  return `${table}-${ids}`;
}

function queryFor(table: string) {
  let current = [...(rows[table] ?? [])];
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => row[column] === value);
    return query;
  });
  query.is = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => (row[column] ?? null) === value);
    return query;
  });
  query.order = vi.fn(() => query);
  query.insert = vi.fn((payload: Record<string, unknown>) => {
    const inserted = { id: nextId(table), ...payload };
    rows[table].push(inserted);
    current = [inserted];
    return query;
  });
  query.update = vi.fn((payload: Record<string, unknown>) => {
    for (const row of current) Object.assign(row, payload);
    return query;
  });
  query.delete = vi.fn(() => {
    for (const row of current) {
      const index = rows[table].indexOf(row);
      if (index >= 0) rows[table].splice(index, 1);
    }
    return query;
  });
  query.single = vi.fn(async () => ({ data: current[0] ?? null, error: null }));
  query.maybeSingle = query.single;
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data: current, error: null }).then(resolve, reject);
  return query;
}

const db = {
  from: vi.fn((table: string) => queryFor(table)),
};

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => db),
}));
vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "reviewer-1";
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../lib/aiAccess", () => ({
  checkMatterAccess: (...args: unknown[]) => checkMatterAccess(...args),
}));
vi.mock("../../lib/tenancy", () => ({
  assertEpochFresh: (...args: unknown[]) => assertEpochFresh(...args),
}));
vi.mock("../../lib/chat/tools/documentOps", () => ({
  generateDocx: (...args: unknown[]) => generateDocx(...args),
}));
vi.mock("../../lib/storage", () => ({
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  deleteFile: vi.fn(),
  downloadFile: (...args: unknown[]) => downloadFile(...args),
  buildContentDisposition: (kind: string, filename: string) =>
    `${kind}; filename="${filename}"`,
}));
vi.mock("../../lib/audit", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}));

import { app } from "../../app";

const route = "/projects/project-1/ai-executions/execution-1/review/report";

beforeEach(() => {
  ids = 0;
  vi.clearAllMocks();
  rows.ai_review_exports.length = 0;
  rows.documents.length = 0;
  rows.document_versions.length = 0;
  rows.ai_reviews[0].status = "approved";
  rows.ai_reviews[0].matter_id = "matter-1";
  rows.ai_review_items[0].status = "accepted";
  rows.ai_review_items[0].citation_refs = [
    {
      citation_id: "c1",
      document_version_id: "source-version-1",
      page: 1,
      span: { start_char: 0, end_char: 10 },
      quote_sha256: "a".repeat(64),
      verified: true,
    },
  ];
  rows.ai_receipts[0].receipt_sha256 = sha256Hex(
    canonicalJson(rows.ai_receipts[0].canonical_json),
  );
  checkMatterAccess.mockResolvedValue({
    ok: true,
    role: "editor",
    projectId: "project-1",
    organizationId: "org-1",
    authorizationEpoch: 1,
  });
  assertEpochFresh.mockResolvedValue(undefined);
  generateDocx.mockResolvedValue({
    bytes: Buffer.from("real-docx-bytes"),
    filename: "Informe de revision humana.docx",
  });
  uploadFile.mockResolvedValue(undefined);
  const storedBytes = Buffer.from("real-docx-bytes");
  downloadFile.mockResolvedValue(
    storedBytes.buffer.slice(
      storedBytes.byteOffset,
      storedBytes.byteOffset + storedBytes.byteLength,
    ),
  );
  recordAuditEvent.mockResolvedValue(undefined);
});

describe("approved AI review report route", () => {
  it("creates one DOCX export record and returns a download endpoint", async () => {
    const response = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      review_id: "review-1",
      execution_id: "execution-1",
      report_version: 1,
      source_document_version_id: "source-version-1",
      filename: "Informe de revision humana.docx",
      download_url: `${route}/download`,
    });
    expect(generateDocx).toHaveBeenCalledOnce();
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(rows.ai_review_exports).toHaveLength(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "ai.review.report_exported",
        eventDetail: expect.objectContaining({
          review_id: "review-1",
          receipt_id: "receipt-1",
        }),
      }),
    );
  });

  it("serves the persisted report only when the bytes match its digest", async () => {
    const created = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    expect(created.status).toBe(201);

    const response = await request(app)
      .get(`${route}/download`)
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.headers["content-disposition"]).toContain(
      "Informe de revision humana.docx",
    );
  });

  it("does not download a version that is no longer an AI review report", async () => {
    const created = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    expect(created.status).toBe(201);
    rows.document_versions[0].source = "generated";
    downloadFile.mockClear();

    const response = await request(app)
      .get(`${route}/download`)
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(404);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "review_not_approved",
      () => {
        rows.ai_reviews[0].status = "in_progress";
      },
    ],
    [
      "unverified_citation",
      () => {
        rows.ai_review_items[0].citation_refs = [{ verified: false }];
      },
    ],
    [
      "revoked_authorization",
      () => {
        checkMatterAccess.mockResolvedValue({ ok: false });
      },
    ],
    [
      "cross_matter_scope",
      () => {
        rows.ai_reviews[0].matter_id = "other-matter";
      },
    ],
  ] as const)("does not generate a file for %s", async (_code, arrange) => {
    arrange();
    const response = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(generateDocx).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(rows.ai_review_exports).toHaveLength(0);
  });

  it("returns the existing export without duplicating a second version", async () => {
    const first = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    expect(first.status).toBe(201);
    generateDocx.mockClear();
    uploadFile.mockClear();

    const second = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.document_version_id).toBe(
      first.body.document_version_id,
    );
    expect(generateDocx).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(rows.ai_review_exports).toHaveLength(1);
  });
});
