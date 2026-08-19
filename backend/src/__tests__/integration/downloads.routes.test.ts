import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  consumeDownloadGrant: vi.fn(),
  from: vi.fn(),
  downloadFile: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("../../lib/downloadTokens", () => ({
  consumeDownloadGrant: mocks.consumeDownloadGrant,
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

vi.mock("../../lib/access", () => ({
  ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
}));

vi.mock("../../lib/audit", () => ({
  recordAuditEvent: mocks.recordAuditEvent,
}));

vi.mock("../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/storage")>()),
  downloadFile: mocks.downloadFile,
}));

import { app } from "../../app";

const grant = {
  document_id: "doc-1",
  document_version_id: "version-1",
  storage_path: "documents/user-1/doc-1/source.pdf",
  filename: "contract.pdf",
  issued_to_user: "user-1",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  consumed_at: new Date().toISOString(),
};

function queryFor(data: unknown) {
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = vi.fn(() => query);
  query.single = vi.fn(async () => ({ data, error: null }));
  query.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return query;
}

beforeEach(() => {
  mocks.consumeDownloadGrant.mockReset();
  mocks.from.mockReset().mockImplementation((table: string) => {
    if (table === "documents") {
      return queryFor({ id: "doc-1", user_id: "user-1", project_id: "matter-1" });
    }
    if (table === "document_versions") {
      return queryFor({
        id: "version-1",
        document_id: "doc-1",
        storage_path: grant.storage_path,
        file_type: "pdf",
        filename: grant.filename,
        deleted_at: null,
      });
    }
    return queryFor(null);
  });
  mocks.downloadFile.mockResolvedValue(
    Uint8Array.from([37, 80, 68, 70]).buffer,
  );
  mocks.recordAuditEvent.mockReset();
});

describe("GET /download/:token", () => {
  it("consumes the grant once and records a metadata-only download event", async () => {
    mocks.consumeDownloadGrant
      .mockResolvedValueOnce(grant)
      .mockResolvedValueOnce(null);

    const first = await request(app)
      .get("/download/opaque-token")
      .set("Authorization", "Bearer jwt-user-1");
    const second = await request(app)
      .get("/download/opaque-token")
      .set("Authorization", "Bearer jwt-user-1");

    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toMatch(/application\/pdf/);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers.vary).toContain("Authorization");
    expect(second.status).toBe(404);
    expect(mocks.downloadFile).toHaveBeenCalledTimes(1);
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "user-1",
        eventType: "document.downloaded",
        eventDetail: expect.objectContaining({
          document_id: "doc-1",
          document_version_id: "version-1",
          result: "success",
        }),
      }),
    );
    const detail = mocks.recordAuditEvent.mock.calls[0][1].eventDetail;
    expect(detail).not.toHaveProperty("storage_path");
  });
});
