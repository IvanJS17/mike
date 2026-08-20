import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { canonicalJson, sha256Hex } from "../../lib/aiReceipts";

const {
  checkMatterAccess,
  assertMatterAccessFresh,
  assertEpochFresh,
  recordAuditEvent,
} = vi.hoisted(() => ({
  checkMatterAccess: vi.fn(),
  assertMatterAccessFresh: vi.fn(),
  assertEpochFresh: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

const sourceText = "Source A. Source B.";
const sourceSha256 = "f".repeat(64);
const receiptJson = {
  receipt_version: "beta-0.1",
  execution_id: "execution-1",
  input: { document_version_id: "source-version-1" },
  result: { status: "succeeded" },
};

const rows: Record<string, Record<string, unknown>[]> = {
  ai_executions: [
    {
      id: "execution-1",
      user_id: "author-1",
      matter_id: "matter-1",
      project_id: "project-1",
      document_id: "document-1",
      document_version_id: "source-version-1",
      document_content_sha256: sourceSha256,
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
      id: "item-accepted",
      review_id: "review-1",
      item_key: "finding-1",
      finding_text: "Reemplazo aceptado",
      status: "accepted",
      citation_refs: [
        {
          citation_id: "c1",
          document_id: "document-1",
          document_version_id: "source-version-1",
          page: 1,
          span: { start_char: 0, end_char: 9 },
          quote: "Source A.",
          quote_sha256: sha256Hex("Source A."),
          verified: true,
        },
      ],
      updated_at: "2026-08-19T12:04:00.000Z",
    },
    {
      id: "item-rejected",
      review_id: "review-1",
      item_key: "finding-2",
      finding_text: "No debe aparecer",
      status: "rejected",
      citation_refs: [{ verified: false }],
      updated_at: "2026-08-19T12:04:30.000Z",
    },
  ],
  ai_review_decisions: [],
  ai_receipts: [
    {
      id: "receipt-1",
      execution_id: "execution-1",
      receipt_version: "beta-0.1",
      canonical_json: receiptJson,
      receipt_sha256: sha256Hex(canonicalJson(receiptJson)),
    },
  ],
  document_versions: [
    {
      id: "source-version-1",
      document_id: "document-1",
      content_sha256: sourceSha256,
      deleted_at: null,
    },
  ],
  ai_document_version_pages: [
    {
      document_id: "document-1",
      document_version_id: "source-version-1",
      page: 1,
      content: sourceText,
      content_sha256: sha256Hex(sourceText),
    },
  ],
  ai_redline_bundles: [],
  organizations: [{ id: "org-1", authorization_epoch: 1 }],
};

let ids = 0;

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
    const inserted = { id: `bundle-${++ids}`, ...payload };
    rows[table].push(inserted);
    current = [inserted];
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

const db = { from: vi.fn((table: string) => queryFor(table)) };

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
  assertMatterAccessFresh: (...args: unknown[]) =>
    assertMatterAccessFresh(...args),
}));
vi.mock("../../lib/tenancy", () => ({
  assertEpochFresh: (...args: unknown[]) => assertEpochFresh(...args),
}));
vi.mock("../../lib/audit", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}));

import { app } from "../../app";

const route =
  "/projects/project-1/ai-executions/execution-1/review/redline-bundle";

beforeEach(() => {
  ids = 0;
  vi.clearAllMocks();
  rows.ai_redline_bundles.length = 0;
  rows.ai_reviews[0].status = "approved";
  rows.ai_reviews[0].matter_id = "matter-1";
  rows.ai_review_items[0].status = "accepted";
  rows.ai_review_items[0].citation_refs = [
    {
      citation_id: "c1",
      document_id: "document-1",
      document_version_id: "source-version-1",
      page: 1,
      span: { start_char: 0, end_char: 9 },
      quote: "Source A.",
      quote_sha256: sha256Hex("Source A."),
      verified: true,
    },
  ];
  rows.document_versions[0].content_sha256 = sourceSha256;
  checkMatterAccess.mockResolvedValue({
    ok: true,
    role: "editor",
    projectId: "project-1",
    organizationId: "org-1",
    authorizationEpoch: 1,
  });
  assertMatterAccessFresh.mockResolvedValue(undefined);
  assertEpochFresh.mockResolvedValue(undefined);
  recordAuditEvent.mockResolvedValue(undefined);
});

describe("AI redline bundle routes", () => {
  it("creates an authenticated immutable bundle with only actionable findings", async () => {
    const response = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      review_id: "review-1",
      execution_id: "execution-1",
      revision: 1,
      source_document_version_id: "source-version-1",
      bundle_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      download_url: `${route}/download`,
    });
    expect(response.body.canonical_json.actions).toHaveLength(1);
    expect(response.body.canonical_json.actions[0].item_id).toBe(
      "item-accepted",
    );
    expect(response.body.canonical_json.actions[0].replacement_text).toBe(
      "Reemplazo aceptado",
    );
    expect(JSON.stringify(response.body.canonical_json)).not.toContain(
      "No debe aparecer",
    );
    expect(rows.ai_redline_bundles).toHaveLength(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "ai.review.redline_bundle_created",
        eventDetail: expect.objectContaining({
          review_id: "review-1",
          receipt_id: "receipt-1",
        }),
      }),
    );
  });

  it("is idempotent for the same review, source version, and revision", async () => {
    const first = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    const second = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(rows.ai_redline_bundles).toHaveLength(1);
  });

  it("consults and downloads the canonical JSON only after verifying its digest", async () => {
    const created = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    expect(created.status).toBe(201);

    const queried = await request(app)
      .get(route)
      .set("Authorization", "Bearer test");
    expect(queried.status).toBe(200);
    expect(queried.body.bundle_sha256).toBe(created.body.bundle_sha256);

    const downloaded = await request(app)
      .get(`${route}/download`)
      .set("Authorization", "Bearer test");
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("application/json");
    expect(downloaded.headers["content-disposition"]).toContain(
      "ai-redline-bundle.json",
    );
    expect(downloaded.body.actions[0].citation_id).toBe("c1");
  });

  it("does not return a persisted bundle after the serialized access guard rejects", async () => {
    const created = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    expect(created.status).toBe(201);

    assertMatterAccessFresh.mockRejectedValueOnce(
      new Error("authorization revoked"),
    );
    const idempotent = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    expect(idempotent.status).toBe(403);
    expect(idempotent.body.code).toBe("authorization_revoked");
    expect(idempotent.body.canonical_json).toBeUndefined();

    assertMatterAccessFresh.mockRejectedValueOnce(
      new Error("authorization revoked"),
    );
    const read = await request(app)
      .get(route)
      .set("Authorization", "Bearer test");
    expect(read.status).toBe(403);
    expect(read.body.code).toBe("authorization_revoked");
    expect(read.body.canonical_json).toBeUndefined();
  });

  it("fails closed when persisted canonical JSON is tampered with", async () => {
    const created = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    expect(created.status).toBe(201);
    (
      rows.ai_redline_bundles[0].canonical_json as Record<string, unknown>
    ).matter_id = "other-matter";

    const response = await request(app)
      .get(route)
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("redline_bundle_integrity_failed");
  });

  it("does not create a bundle for an invalid included span or source version", async () => {
    rows.ai_review_items[0].citation_refs = [{ verified: true }];

    const response = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(rows.ai_redline_bundles).toHaveLength(0);
  });
});
