import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createApprovedArtifactPersistence,
  type ApprovedArtifactReadExpectation,
} from "./approvedArtifactPersistence";

const bytes = new TextEncoder().encode("approved-docx");
const hash = createHash("sha256").update(bytes).digest("hex");
const artifact = {
  idempotency_key: "report:1",
  review_id: "review",
  review_revision: 2,
  execution_id: "execution",
  organization_id: "org",
  matter_id: "matter",
  project_id: "project",
  document_id: "document",
  document_version_id: "version",
  source_document_sha256: "a".repeat(64),
  evidence_receipt_sha256: "b".repeat(64),
  filename: "Informe de revision humana.docx" as const,
  mime_type:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const,
  artifact_sha256: hash,
  docx_bytes: bytes,
};

function stableUuid(kind: "document" | "version") {
  const seed = [
    "mike-approved-review-artifact-v1",
    kind,
    artifact.organization_id,
    artifact.matter_id,
    artifact.project_id,
    artifact.review_id,
    String(artifact.review_revision),
    artifact.execution_id,
    artifact.idempotency_key,
  ].join("\0");
  const value = createHash("sha256").update(seed).digest().subarray(0, 16);
  value[6] = (value[6] & 0x0f) | 0x50;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function expectation(): ApprovedArtifactReadExpectation {
  return {
    idempotency_key: artifact.idempotency_key,
    review_id: artifact.review_id,
    review_revision: artifact.review_revision,
    execution_id: artifact.execution_id,
    organization_id: artifact.organization_id,
    matter_id: artifact.matter_id,
    project_id: artifact.project_id,
    source_document_id: artifact.document_id,
    source_document_version_id: artifact.document_version_id,
    source_document_sha256: artifact.source_document_sha256,
    evidence_receipt_sha256: artifact.evidence_receipt_sha256,
    filename: artifact.filename,
    mime_type: artifact.mime_type,
    artifact_sha256: artifact.artifact_sha256,
  };
}

function row(): Record<string, unknown> {
  const documentId = stableUuid("document");
  return {
    id: "export",
    idempotency_key: artifact.idempotency_key,
    review_id: artifact.review_id,
    review_revision: artifact.review_revision,
    execution_id: artifact.execution_id,
    organization_id: artifact.organization_id,
    matter_id: artifact.matter_id,
    project_id: artifact.project_id,
    source_document_id: artifact.document_id,
    source_document_version_id: artifact.document_version_id,
    artifact_document_id: documentId,
    artifact_document_version_id: stableUuid("version"),
    source_document_sha256: artifact.source_document_sha256,
    evidence_receipt_sha256: artifact.evidence_receipt_sha256,
    filename: artifact.filename,
    mime_type: artifact.mime_type,
    artifact_sha256: artifact.artifact_sha256,
    storage_path: `orgs/org/matters/matter/projects/project/documents/${documentId}/${hash}.docx`,
    size_bytes: bytes.length,
  };
}

function client(initial: unknown = null) {
  let current = initial;
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({ data: current, error: null })),
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    expect(name).toBe("append_ai_review_export");
    const submitted = args.p_artifact as Record<string, unknown>;
    current = {
      id: "export",
      ...submitted,
      source_document_id: submitted.document_id,
      source_document_version_id: submitted.document_version_id,
    };
    delete (current as Record<string, unknown>).document_id;
    delete (current as Record<string, unknown>).document_version_id;
    return {
      data: {
        disposition: "applied",
        review_id: artifact.review_id,
        review_revision: artifact.review_revision,
        execution_id: artifact.execution_id,
        artifact_sha256: hash,
        idempotency_key: artifact.idempotency_key,
      },
      error: null,
    };
  });
  return {
    from: vi.fn(() => query),
    rpc,
    query,
    setCurrent: (value: unknown) => {
      current = value;
    },
  };
}

function options(
  db: ReturnType<typeof client>,
  storage: {
    putIfAbsent: (...args: never[]) => Promise<"created" | "exists">;
    getStrict: (...args: never[]) => Promise<Uint8Array | null>;
  },
) {
  return {
    client: db as never,
    context: {
      actor_user_id: "reviewer",
      organization_id: "org",
      authorization_epoch: 1,
    },
    storage,
    revalidateBeforeUpload: vi.fn(async () => true),
  };
}

describe("approved artifact persistence", () => {
  it("does not acknowledge committed replay after revocation during durable read", async () => {
    const db = client(row());
    const storage = {
      putIfAbsent: vi.fn(),
      getStrict: vi.fn(async () => bytes),
    };
    const config = options(db, storage as never);
    config.revalidateBeforeUpload.mockResolvedValue(false);
    await expect(
      createApprovedArtifactPersistence(config).append(artifact),
    ).rejects.toThrow("approved artifact persistence failed");
    expect(storage.putIfAbsent).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { export_id: "wrong-export" },
    { idempotency_key: "wrong-key" },
    { project_id: "wrong-project" },
    { project_id: artifact.project_id, execution_id: "wrong-execution" },
    {
      project_id: artifact.project_id,
      review_revision: artifact.review_revision + 1,
    },
  ])(
    "rejects an SDK row not matching literal selectors: %j",
    async (selectors) => {
      const db = client(row());
      const storage = {
        putIfAbsent: vi.fn(),
        getStrict: vi.fn(async () => bytes),
      };
      await expect(
        createApprovedArtifactPersistence(options(db, storage as never)).read({
          ...selectors,
          expected: expectation(),
        }),
      ).rejects.toThrow("approved artifact persistence failed");
      expect(storage.getStrict).not.toHaveBeenCalled();
    },
  );

  it("snapshots storage-owned bytes before awaiting the final authorization check", async () => {
    const db = client(row());
    const borrowed = new Uint8Array(bytes);
    const storage = {
      putIfAbsent: vi.fn(),
      getStrict: vi.fn(async () => borrowed),
    };
    const result = await createApprovedArtifactPersistence(
      options(db, storage as never),
    ).read({
      export_id: "export",
      expected: expectation(),
      revalidateAfterRead: async () => {
        borrowed.fill(0);
        return true;
      },
    });
    expect(result).toEqual(bytes);
    expect(result).not.toBe(borrowed);
  });
  it("uploads bytes before the authorized append RPC", async () => {
    const order: string[] = [];
    const db = client();
    const objects = new Map<string, Uint8Array>();
    const storage = {
      putIfAbsent: vi.fn(async (key: string, value: Uint8Array) => {
        order.push("storage");
        objects.set(key, new Uint8Array(value));
        return "created" as const;
      }),
      getStrict: vi.fn(async (key: string) => objects.get(key) ?? null),
    };
    db.rpc.mockImplementation(async (...args) => {
      order.push("rpc");
      const submitted = args[1]?.p_artifact as Record<string, unknown>;
      const { document_id, document_version_id, ...metadata } = submitted;
      db.setCurrent({
        id: "export",
        ...metadata,
        source_document_id: document_id,
        source_document_version_id: document_version_id,
      });
      return {
        data: {
          disposition: "applied",
          review_id: artifact.review_id,
          review_revision: artifact.review_revision,
          execution_id: artifact.execution_id,
          artifact_sha256: hash,
          idempotency_key: artifact.idempotency_key,
        },
        error: null,
      };
    });
    await expect(
      createApprovedArtifactPersistence(options(db, storage)).append(artifact),
    ).resolves.toMatchObject({ disposition: "applied" });
    expect(order).toEqual(["storage", "rpc"]);
  });

  it("uses stable identities and strict create-only storage reconciliation", async () => {
    const objects = new Map<string, Uint8Array>();
    const storage = {
      putIfAbsent: vi.fn(async (key: string, value: Uint8Array) => {
        if (objects.has(key)) return "exists" as const;
        objects.set(key, new Uint8Array(value));
        return "created" as const;
      }),
      getStrict: vi.fn(async (key: string) => objects.get(key) ?? null),
    };
    const db = client();
    await expect(
      createApprovedArtifactPersistence(options(db, storage)).append(artifact),
    ).resolves.toMatchObject({ disposition: "applied" });
    const submitted = db.rpc.mock.calls[0]?.[1]?.p_artifact as Record<
      string,
      unknown
    >;
    expect(submitted.artifact_document_id).toBe(stableUuid("document"));
    expect(submitted.artifact_document_version_id).toBe(stableUuid("version"));
    expect(storage.getStrict).toHaveBeenCalledTimes(3);
    expect(storage.putIfAbsent).toHaveBeenCalledOnce();
  });

  it("retains a written object when the RPC outcome is unknown and reconciles after restart", async () => {
    const objects = new Map<string, Uint8Array>();
    const storage = {
      putIfAbsent: vi.fn(async (key: string, value: Uint8Array) => {
        objects.set(key, new Uint8Array(value));
        return "created" as const;
      }),
      getStrict: vi.fn(async (key: string) => objects.get(key) ?? null),
    };
    const failedDb = client();
    failedDb.rpc.mockRejectedValue(new Error("network detail"));
    await expect(
      createApprovedArtifactPersistence(options(failedDb, storage)).append(
        artifact,
      ),
    ).rejects.toThrow("approved artifact persistence failed");

    const restartedDb = client();
    await expect(
      createApprovedArtifactPersistence(options(restartedDb, storage)).append(
        artifact,
      ),
    ).resolves.toMatchObject({ disposition: "applied" });
    expect(storage.putIfAbsent).toHaveBeenCalledOnce();
  });

  it("reads by export id and validates the durable row before releasing bytes", async () => {
    const db = client(row());
    const storage = {
      putIfAbsent: vi.fn(),
      getStrict: vi.fn(async () => bytes),
    };
    const persistence = createApprovedArtifactPersistence(
      options(db, storage as never),
    );
    await expect(
      persistence.read({ export_id: "export", expected: expectation() }),
    ).resolves.toEqual(bytes);
    expect(db.query.eq).toHaveBeenCalledWith("id", "export");
  });

  it("fails closed when the create-only object is tampered", async () => {
    const db = client();
    const storage = {
      putIfAbsent: vi.fn(),
      getStrict: vi.fn(async () => new TextEncoder().encode("tampered")),
    };
    await expect(
      createApprovedArtifactPersistence(options(db, storage as never)).append(
        artifact,
      ),
    ).rejects.toThrow("approved artifact persistence failed");
    expect(storage.putIfAbsent).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
