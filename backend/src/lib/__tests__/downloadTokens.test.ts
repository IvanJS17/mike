import { describe, expect, it, vi } from "vitest";
import { createDownloadUrl } from "../downloadTokens";

function makeInsertDb() {
  let inserted: Record<string, unknown> | null = null;
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    inserted = row;
    return { data: null, error: null };
  });
  return {
    db: { from: vi.fn(() => ({ insert })) } as never,
    insert,
    getInserted: () => inserted,
  };
}

describe("createDownloadUrl", () => {
  it("stores an opaque user-bound expiring grant instead of the storage path", async () => {
    const { db, getInserted } = makeInsertDb();

    const url = await createDownloadUrl(db, {
      documentId: "doc-1",
      versionId: "version-1",
      storagePath: "documents/user-1/doc-1/source.pdf",
      filename: "contract.pdf",
      userId: "user-1",
    });

    expect(url).toMatch(/^\/download\/[A-Za-z0-9_-]+$/);
    expect(url).not.toContain("documents");
    const grant = getInserted();
    expect(grant).toMatchObject({
      document_id: "doc-1",
      document_version_id: "version-1",
      storage_path: "documents/user-1/doc-1/source.pdf",
      filename: "contract.pdf",
      issued_to_user: "user-1",
      consumed_at: null,
    });
    expect(grant?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(String(grant?.expires_at))).toBeGreaterThan(Date.now());
  });
});

function makeConsumeDb(grant: Record<string, unknown>) {
  let consumed = false;
  const query: Record<string, any> = {};
  query.update = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = vi.fn(() => query);
  query.gt = vi.fn(() => query);
  query.select = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => {
    if (consumed) return { data: null, error: null };
    consumed = true;
    return { data: grant, error: null };
  });
  return { db: { from: vi.fn(() => query) } as never, query };
}

describe("consumeDownloadGrant", () => {
  it("accepts a grant once and rejects the same token on reuse", async () => {
    const { consumeDownloadGrant } = await import("../downloadTokens");
    const grant = {
      document_id: "doc-1",
      document_version_id: "version-1",
      storage_path: "documents/user-1/doc-1/source.pdf",
      filename: "contract.pdf",
      issued_to_user: "user-1",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: new Date().toISOString(),
    };
    const { db, query } = makeConsumeDb(grant);

    const first = await consumeDownloadGrant(db, "opaque-token", "user-1");
    const second = await consumeDownloadGrant(db, "opaque-token", "user-1");

    expect(first).toEqual(grant);
    expect(second).toBeNull();
    expect(query.update).toHaveBeenCalledWith({ consumed_at: expect.any(String) });
    expect(query.is).toHaveBeenCalledWith("consumed_at", null);
    expect(query.eq).toHaveBeenCalledWith("issued_to_user", "user-1");
  });
});
