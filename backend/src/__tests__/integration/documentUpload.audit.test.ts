import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => ({ from: mocks.from })),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "user-1";
    res.locals.token = "jwt-user-1";
    next();
  },
  requireMfaIfEnrolled: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
}));

vi.mock("../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/storage")>()),
  uploadFile: mocks.uploadFile,
  deleteFile: mocks.deleteFile,
}));

vi.mock("../../lib/audit", () => ({
  recordAuditEvent: mocks.recordAuditEvent,
}));

vi.mock("../../lib/access", () => ({
  checkProjectAccess: vi.fn(async () => ({
    ok: true,
    isOwner: true,
    project: { id: "matter-1", user_id: "user-1" },
  })),
  ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
}));

import { app } from "../../app";

function makeQuery(table: string) {
  let operation = "";
  const query: Record<string, any> = {};
  query.insert = vi.fn(() => {
    operation = "insert";
    return query;
  });
  query.update = vi.fn(() => {
    operation = "update";
    return query;
  });
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.single = vi.fn(async () => {
    if (table === "documents" && operation === "insert") {
      return {
        data: {
          id: "doc-1",
          project_id: "matter-1",
          user_id: "user-1",
          status: "processing",
        },
        error: null,
      };
    }
    if (table === "document_versions" && operation === "insert") {
      return { data: { id: "version-1" }, error: null };
    }
    if (table === "documents" && operation === "select") {
      return {
        data: {
          id: "doc-1",
          project_id: "matter-1",
          user_id: "user-1",
          status: "ready",
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
  return query;
}

beforeEach(() => {
  mocks.from.mockReset().mockImplementation((table: string) => makeQuery(table));
  mocks.uploadFile.mockReset().mockResolvedValue(undefined);
  mocks.deleteFile.mockReset().mockResolvedValue(undefined);
  mocks.recordAuditEvent.mockReset();
});

describe("POST /projects/:projectId/documents — audit contract", () => {
  it("records a metadata-only document.uploaded event with version and correlation", async () => {
    const res = await request(app)
      .post("/projects/matter-1/documents")
      .set("Authorization", "Bearer jwt-user-1")
      .attach("file", Buffer.from("%PDF-1.4\n"), {
        filename: "contract.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "user-1",
        eventType: "document.uploaded",
        eventDetail: expect.objectContaining({
          project_id: "matter-1",
          document_id: "doc-1",
          document_version_id: "version-1",
          result: "success",
          correlation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      }),
    );
    const detail = mocks.recordAuditEvent.mock.calls[0][1].eventDetail;
    expect(detail).not.toHaveProperty("filename");
    expect(detail).not.toHaveProperty("content");
    expect(detail).not.toHaveProperty("body");
  });
});
