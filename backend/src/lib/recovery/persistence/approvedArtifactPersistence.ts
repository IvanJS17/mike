import { createHash } from "node:crypto";

import {
  authorizeObjectKey,
  buildCanonicalPrefix,
} from "../documents/documentStoragePolicy";
import type {
  ApprovedArtifactAppend,
  ApprovedArtifactAppendPort,
  ApprovedArtifactAppendReceipt,
} from "../review/approvedReviewReport";

const FAILURE = "approved artifact persistence failed";
const EXPORT_COLUMNS =
  "id,idempotency_key,review_id,review_revision,execution_id,organization_id,matter_id,project_id,source_document_id,source_document_version_id,artifact_document_id,artifact_document_version_id,source_document_sha256,evidence_receipt_sha256,filename,mime_type,artifact_sha256,storage_path,size_bytes";
const EXPORT_KEYS = EXPORT_COLUMNS.split(",");
const SHA256_RE = /^[0-9a-f]{64}$/;

type Query = {
  eq(column: string, value: unknown): Query;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
};
type QueryStart = { select(columns: string): Query };
export type ApprovedArtifactPersistenceClient = {
  from(table: string): QueryStart;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: unknown;
  }>;
};
export type ApprovedArtifactStorage = {
  putIfAbsent(
    key: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<"created" | "exists">;
  getStrict(key: string): Promise<Uint8Array | null>;
};
export type ApprovedArtifactRevalidator = () => Promise<boolean>;
export type ApprovedArtifactReadExpectation = {
  idempotency_key?: string;
  review_id: string;
  review_revision: number;
  execution_id: string;
  organization_id: string;
  matter_id: string;
  project_id: string;
  source_document_id: string;
  source_document_version_id: string;
  source_document_sha256: string;
  evidence_receipt_sha256: string;
  filename: ApprovedArtifactAppend["filename"];
  mime_type: ApprovedArtifactAppend["mime_type"];
  artifact_sha256?: string;
};
export type ApprovedArtifactPersistenceOptions = {
  client: ApprovedArtifactPersistenceClient;
  context: {
    actor_user_id: string;
    organization_id: string;
    authorization_epoch: number;
  };
  storage: ApprovedArtifactStorage;
  revalidateBeforeUpload: ApprovedArtifactRevalidator;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(): Error {
  return new Error(FAILURE);
}

function deterministicUuid(
  kind: "document" | "version",
  artifact: ApprovedArtifactReadExpectation,
): string {
  const seed = [
    "mike-approved-review-artifact-v1",
    kind,
    artifact.organization_id,
    artifact.matter_id,
    artifact.project_id,
    artifact.review_id,
    String(artifact.review_revision),
    artifact.execution_id,
    artifact.idempotency_key ?? "",
  ].join("\0");
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function expectedIds(artifact: ApprovedArtifactReadExpectation) {
  return {
    artifact_document_id: deterministicUuid("document", artifact),
    artifact_document_version_id: deterministicUuid("version", artifact),
  };
}

function expectedPath(
  artifact: ApprovedArtifactReadExpectation,
  artifactDocumentId: string,
  artifactHash: string,
): string {
  const ownership = {
    organization_id: artifact.organization_id,
    matter_id: artifact.matter_id,
    project_id: artifact.project_id,
    document_id: artifactDocumentId,
    version_hash: artifactHash,
    object_prefix: `orgs/${artifact.organization_id}/matters/${artifact.matter_id}/projects/${artifact.project_id}/documents/${artifactDocumentId}`,
  };
  const prefix = buildCanonicalPrefix(ownership);
  if (!prefix.ok) throw fail();
  return `${prefix.prefix}/${artifactHash}.docx`;
}

function validRow(
  value: unknown,
  expected: ApprovedArtifactReadExpectation,
): value is Record<string, unknown> {
  if (!record(value) || !exactKeys(value, EXPORT_KEYS)) return false;
  if (
    typeof value.idempotency_key !== "string" ||
    value.idempotency_key.length === 0
  )
    return false;
  const rowExpected = {
    ...expected,
    idempotency_key: expected.idempotency_key ?? value.idempotency_key,
  };
  const ids = expectedIds(rowExpected);
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (expected.idempotency_key === undefined ||
      value.idempotency_key === expected.idempotency_key) &&
    value.review_id === expected.review_id &&
    value.review_revision === expected.review_revision &&
    value.execution_id === expected.execution_id &&
    value.organization_id === expected.organization_id &&
    value.matter_id === expected.matter_id &&
    value.project_id === expected.project_id &&
    value.source_document_id === expected.source_document_id &&
    value.source_document_version_id === expected.source_document_version_id &&
    value.source_document_sha256 === expected.source_document_sha256 &&
    value.evidence_receipt_sha256 === expected.evidence_receipt_sha256 &&
    value.filename === expected.filename &&
    value.mime_type === expected.mime_type &&
    typeof value.artifact_sha256 === "string" &&
    SHA256_RE.test(value.artifact_sha256) &&
    (expected.artifact_sha256 === undefined ||
      value.artifact_sha256 === expected.artifact_sha256) &&
    value.artifact_document_id === ids.artifact_document_id &&
    value.artifact_document_version_id === ids.artifact_document_version_id &&
    typeof value.storage_path === "string" &&
    Number.isSafeInteger(value.size_bytes) &&
    (value.size_bytes as number) > 0 &&
    value.storage_path ===
      expectedPath(rowExpected, ids.artifact_document_id, value.artifact_sha256)
  );
}

function expectationFromArtifact(
  artifact: ApprovedArtifactAppend,
): ApprovedArtifactReadExpectation {
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

function receipt(
  value: unknown,
  artifact: ApprovedArtifactAppend,
): ApprovedArtifactAppendReceipt {
  if (
    !record(value) ||
    (value.disposition !== "applied" && value.disposition !== "replayed") ||
    value.review_id !== artifact.review_id ||
    value.review_revision !== artifact.review_revision ||
    value.execution_id !== artifact.execution_id ||
    value.artifact_sha256 !== artifact.artifact_sha256 ||
    value.idempotency_key !== artifact.idempotency_key
  )
    throw fail();
  return Object.freeze({
    disposition: value.disposition,
    review_id: value.review_id,
    review_revision: value.review_revision,
    execution_id: value.execution_id,
    artifact_sha256: value.artifact_sha256,
    idempotency_key: value.idempotency_key,
  }) as ApprovedArtifactAppendReceipt;
}

export function createApprovedArtifactPersistence(
  options: ApprovedArtifactPersistenceOptions,
): ApprovedArtifactAppendPort & {
  read(input: {
    export_id?: string;
    idempotency_key?: string;
    project_id?: string;
    execution_id?: string;
    review_revision?: number;
    expected: ApprovedArtifactReadExpectation;
    revalidateAfterRead?: ApprovedArtifactRevalidator;
  }): Promise<Uint8Array | null>;
} {
  const context = Object.freeze({ ...options.context });

  const read = async (input: {
    export_id?: string;
    idempotency_key?: string;
    project_id?: string;
    execution_id?: string;
    review_revision?: number;
    expected: ApprovedArtifactReadExpectation;
    revalidateAfterRead?: ApprovedArtifactRevalidator;
  }): Promise<Uint8Array | null> => {
    input = Object.freeze({
      ...input,
      expected: Object.freeze({ ...input.expected }),
    });
    const selectorCount = [
      input.export_id,
      input.idempotency_key,
      input.project_id,
    ].filter((value) => value !== undefined).length;
    if (selectorCount !== 1) throw fail();
    let result: { data: unknown; error: unknown };
    try {
      let query = options.client
        .from("ai_review_exports")
        .select(EXPORT_COLUMNS);
      if (input.export_id !== undefined)
        query = query.eq("id", input.export_id);
      if (input.idempotency_key !== undefined)
        query = query.eq("idempotency_key", input.idempotency_key);
      if (input.project_id !== undefined) {
        query = query.eq("project_id", input.project_id);
        if (input.execution_id !== undefined)
          query = query.eq("execution_id", input.execution_id);
        if (input.review_revision !== undefined)
          query = query.eq("review_revision", input.review_revision);
      }
      result = await query.maybeSingle();
    } catch {
      throw fail();
    }
    if (result.error != null) throw fail();
    if (result.data === null) return null;
    if (!record(result.data)) throw fail();
    const row = Object.freeze({ ...result.data });
    if (!validRow(row, input.expected)) throw fail();
    const filters = {
      id: input.export_id,
      idempotency_key: input.idempotency_key,
      project_id: input.project_id,
      execution_id: input.execution_id,
      review_revision: input.review_revision,
    };
    if (
      Object.entries(filters).some(
        ([key, value]) => value !== undefined && row[key] !== value,
      )
    )
      throw fail();
    const ownership = {
      organization_id: input.expected.organization_id,
      matter_id: input.expected.matter_id,
      project_id: input.expected.project_id,
      document_id: row.artifact_document_id as string,
      version_hash: row.artifact_sha256 as string,
      object_prefix: `orgs/${input.expected.organization_id}/matters/${input.expected.matter_id}/projects/${input.expected.project_id}/documents/${row.artifact_document_id}`,
    };
    const authorized = authorizeObjectKey(ownership, row.storage_path);
    if (!authorized.ok) throw fail();
    let bytes: Uint8Array | null;
    try {
      const borrowed = await options.storage.getStrict(authorized.key);
      bytes = borrowed === null ? null : new Uint8Array(borrowed);
    } catch {
      throw fail();
    }
    if (
      !bytes ||
      bytes.length !== row.size_bytes ||
      sha256(bytes) !== row.artifact_sha256
    )
      throw fail();
    if (input.revalidateAfterRead && !(await input.revalidateAfterRead()))
      throw fail();
    return bytes;
  };

  return {
    async append(artifact) {
      const bytes = new Uint8Array(artifact.docx_bytes);
      artifact = Object.freeze({ ...artifact, docx_bytes: bytes });
      if (
        bytes.length === 0 ||
        sha256(bytes) !== artifact.artifact_sha256 ||
        !SHA256_RE.test(artifact.artifact_sha256)
      )
        throw fail();
      const expected = expectationFromArtifact(artifact);
      const prior = await read({
        idempotency_key: artifact.idempotency_key,
        expected,
        revalidateAfterRead: options.revalidateBeforeUpload,
      });
      if (prior) {
        return receipt(
          {
            disposition: "replayed",
            review_id: artifact.review_id,
            review_revision: artifact.review_revision,
            execution_id: artifact.execution_id,
            artifact_sha256: artifact.artifact_sha256,
            idempotency_key: artifact.idempotency_key,
          },
          artifact,
        );
      }

      const ids = expectedIds(expected);
      const storagePath = expectedPath(
        expected,
        ids.artifact_document_id,
        artifact.artifact_sha256,
      );
      const ownership = {
        organization_id: artifact.organization_id,
        matter_id: artifact.matter_id,
        project_id: artifact.project_id,
        document_id: ids.artifact_document_id,
        version_hash: artifact.artifact_sha256,
        object_prefix: `orgs/${artifact.organization_id}/matters/${artifact.matter_id}/projects/${artifact.project_id}/documents/${ids.artifact_document_id}`,
      };
      const authorized = authorizeObjectKey(ownership, storagePath);
      if (!authorized.ok) throw fail();

      let before: Uint8Array | null;
      try {
        before = await options.storage.getStrict(authorized.key);
      } catch {
        throw fail();
      }
      if (
        before &&
        (before.length !== bytes.length ||
          sha256(before) !== artifact.artifact_sha256)
      )
        throw fail();
      if (!before) {
        let fresh = false;
        try {
          fresh = await options.revalidateBeforeUpload();
        } catch {
          throw fail();
        }
        if (!fresh) throw fail();
        try {
          await options.storage.putIfAbsent(
            authorized.key,
            bytes,
            artifact.mime_type,
          );
        } catch {
          throw fail();
        }
      }
      let after: Uint8Array | null;
      try {
        after = await options.storage.getStrict(authorized.key);
      } catch {
        throw fail();
      }
      if (
        !after ||
        after.length !== bytes.length ||
        sha256(after) !== artifact.artifact_sha256
      )
        throw fail();

      let response: { data: unknown; error: unknown };
      try {
        const { docx_bytes: _docxBytes, ...artifactMetadata } = artifact;
        response = await options.client.rpc("append_ai_review_export", {
          p_actor_user_id: context.actor_user_id,
          p_organization_id: context.organization_id,
          p_authorization_epoch: context.authorization_epoch,
          p_artifact: {
            ...artifactMetadata,
            ...ids,
            storage_path: storagePath,
            size_bytes: bytes.length,
          },
        });
      } catch {
        throw fail();
      }
      if (response.error != null) throw fail();
      const durable = await read({
        idempotency_key: artifact.idempotency_key,
        expected,
        revalidateAfterRead: options.revalidateBeforeUpload,
      });
      if (
        !durable ||
        durable.length !== bytes.length ||
        sha256(durable) !== artifact.artifact_sha256
      )
        throw fail();
      return receipt(response.data, artifact);
    },
    read,
  };
}
