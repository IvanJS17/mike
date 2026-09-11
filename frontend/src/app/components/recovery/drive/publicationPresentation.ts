import type { DrivePublicationStatus, DrivePublicationWriteResult } from "@/app/lib/mikeApi";

export type PublicationReview = {
  review_id: string; revision: number; execution_id: string; reviewer_user_id: string; execution_author_user_id: string;
  project_id: string; matter_id: string; organization_id: string; document_id: string; document_version_id: string;
  document_content_sha256: string; evidence_receipt_sha256: string;
  status: "pending" | "approved" | "changes_requested";
  items: readonly Readonly<Record<string, unknown>>[];
};
export type ApprovedReport = {
  export_id: string;
  artifact: { idempotency_key: string; review_id: string; review_revision: number; execution_id: string; organization_id: string; matter_id: string; project_id: string; document_id: string; document_version_id: string; source_document_sha256: string; evidence_receipt_sha256: string; filename: "Informe de revision humana.docx"; mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; artifact_sha256: string };
  receipt: { disposition: "applied" | "replayed"; review_id: string; review_revision: number; execution_id: string; artifact_sha256: string; idempotency_key: string };
};

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[^\s]{1,256}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const OUTCOMES = new Set(["pending", "uploaded", "unknown_outcome", "reconciled", "failed"]);
const DISPOSITIONS = new Set(["uploaded", "replayed", "reconciled", "failed", "unknown_outcome"]);
const ITEM_STATES = new Set(["pending", "accepted", "rejected", "edited"]);
const REPORT_FILENAME = "Informe de revision humana.docx";
const REPORT_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value) && value.trim() === value; }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function revision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function hash(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function clone(value: unknown): unknown { if (Array.isArray(value)) return value.map(clone); if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])); return value; }

export function parsePublicationReview(value: unknown, projectId: string, matterId: string, executionId: string): PublicationReview | null {
  if (!object(value) || !id(projectId) || !id(matterId) || !id(executionId)) return null;
  const v = value;
  if (!id(v.review_id) || !id(v.execution_id) || !id(v.reviewer_user_id) || !id(v.execution_author_user_id) || !id(v.project_id) || !id(v.matter_id) || !id(v.organization_id) || !id(v.document_id) || !id(v.document_version_id) || v.execution_id !== executionId || v.project_id !== projectId || v.matter_id !== matterId) return null;
  if (v.reviewer_user_id === v.execution_author_user_id || !revision(v.revision) || (v.status !== "pending" && v.status !== "approved" && v.status !== "changes_requested") || !Array.isArray(v.items) || v.items.length === 0) return null;
  if (!hash(v.document_content_sha256) || !hash(v.evidence_receipt_sha256)) return null;
  const items = v.items.map((item) => { if (!object(item) || !id(item.item_id) || !id(item.item_key) || !ITEM_STATES.has(item.status as string) || typeof item.finding_text !== "string") return null; return clone(item) as Readonly<Record<string, unknown>>; });
  if (items.some((item) => item === null)) return null;
  return { review_id: v.review_id, revision: v.revision, execution_id: v.execution_id, reviewer_user_id: v.reviewer_user_id, execution_author_user_id: v.execution_author_user_id, project_id: v.project_id, matter_id: v.matter_id, organization_id: v.organization_id, document_id: v.document_id, document_version_id: v.document_version_id, document_content_sha256: v.document_content_sha256, evidence_receipt_sha256: v.evidence_receipt_sha256, status: v.status, items: items as Readonly<Record<string, unknown>>[] };
}
export function canPublishReview(review: PublicationReview | null): boolean { return !!review && review.status === "approved" && review.items.length > 0 && review.items.every((item) => item.status !== "pending"); }
export function stablePublicationIdempotencyKey(review: PublicationReview): string { const key = `approved-report:${review.review_id}:${review.revision}`; if (!IDEMPOTENCY.test(key)) throw new Error("invalid idempotency key"); return key; }

export function parsePublicationStatus(value: unknown, review: PublicationReview, publicationId?: string): DrivePublicationStatus | null {
  if (!object(value) || !uuid(value.publication_id) || (publicationId !== undefined && value.publication_id !== publicationId)) return null;
  if (value.execution_id !== review.execution_id || !uuid(value.export_id) || !revision(value.review_revision) || value.review_revision !== review.revision || !revision(value.revision) || !OUTCOMES.has(value.outcome as string) || typeof value.attempts !== "number" || !Number.isSafeInteger(value.attempts) || value.attempts < 1 || value.attempts > 3 || !hash(value.approved_artifact_sha256)) return null;
  if (value.provider_file_id !== null && !id(value.provider_file_id)) return null;
  if (value.failure_code !== null && !id(value.failure_code)) return null;
  if ((value.outcome === "uploaded" || value.outcome === "reconciled") && (value.provider_file_id === null || value.failure_code !== null)) return null;
  if (value.outcome === "failed" && value.failure_code === null) return null;
  return { publication_id: value.publication_id, export_id: value.export_id, execution_id: value.execution_id, review_revision: value.review_revision, revision: value.revision, outcome: value.outcome as DrivePublicationStatus["outcome"], attempts: value.attempts, approved_artifact_sha256: value.approved_artifact_sha256, provider_file_id: value.provider_file_id, failure_code: value.failure_code };
}
export function parsePublicationWrite(value: unknown, review: PublicationReview, expected?: { publicationId?: string; exportId?: string; artifactHash?: string; previous?: DrivePublicationStatus }): DrivePublicationWriteResult | null {
  if (!object(value) || !OUTCOMES.has(value.outcome as string) || !DISPOSITIONS.has(value.disposition as string)) return null;
  const expectedDisposition = value.outcome === "pending" ? "unknown_outcome" : value.outcome;
  if (value.disposition !== "replayed" && value.disposition !== expectedDisposition) return null;
  const publication = parsePublicationStatus(value.publication, review, expected?.publicationId); const previous = expected?.previous;
  if (!publication || (expected?.exportId && publication.export_id !== expected.exportId) || (expected?.artifactHash && publication.approved_artifact_sha256 !== expected.artifactHash) || (previous && (publication.publication_id !== previous.publication_id || publication.export_id !== previous.export_id || publication.approved_artifact_sha256 !== previous.approved_artifact_sha256 || publication.revision < previous.revision || publication.attempts < previous.attempts)) || publication.outcome !== value.outcome) return null;
  return { outcome: publication.outcome, disposition: value.disposition as DrivePublicationWriteResult["disposition"], publication };
}
export function parseApprovedReport(value: unknown, review: PublicationReview, idempotencyKey: string): ApprovedReport | null {
  if (!object(value) || !uuid(value.export_id) || !object(value.artifact) || !object(value.receipt) || !IDEMPOTENCY.test(idempotencyKey)) return null;
  const a = value.artifact; const r = value.receipt;
  if (a.review_id !== review.review_id || a.execution_id !== review.execution_id || a.organization_id !== review.organization_id || a.project_id !== review.project_id || a.matter_id !== review.matter_id || a.document_id !== review.document_id || a.document_version_id !== review.document_version_id || a.review_revision !== review.revision || a.idempotency_key !== idempotencyKey || !hash(a.artifact_sha256) || a.source_document_sha256 !== review.document_content_sha256 || a.evidence_receipt_sha256 !== review.evidence_receipt_sha256 || a.filename !== REPORT_FILENAME || a.mime_type !== REPORT_MIME) return null;
  if ((r.disposition !== "applied" && r.disposition !== "replayed") || r.review_id !== review.review_id || r.execution_id !== review.execution_id || r.review_revision !== review.revision || r.idempotency_key !== idempotencyKey || r.artifact_sha256 !== a.artifact_sha256) return null;
  return { export_id: value.export_id, artifact: { ...a, filename: REPORT_FILENAME, mime_type: REPORT_MIME } as ApprovedReport["artifact"], receipt: { disposition: r.disposition, review_id: r.review_id, review_revision: r.review_revision, execution_id: r.execution_id, artifact_sha256: r.artifact_sha256, idempotency_key: r.idempotency_key } };
}
export function publicationLabel(status: DrivePublicationStatus): string { switch (status.outcome) { case "uploaded": case "reconciled": return "Publicación confirmada por el servidor."; case "unknown_outcome": return "El resultado es desconocido; reconcilia antes de reintentar."; case "failed": return "La publicación falló. Recarga la página para consultar el estado del servidor; no se iniciará otra carga."; default: return "Publicación pendiente; reconcilia el estado existente."; } }
