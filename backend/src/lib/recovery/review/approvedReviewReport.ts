import { createHash } from "node:crypto";
import JSZip from "jszip";

import type { AuthenticatedIdentity } from "../identity/authStateMatrix";
import type { AuthorizationScope } from "../authorization/evaluateAccess";
import {
  recheckFreshAccessViaPort,
  type TenancyReadPort,
} from "../authorization/tenancyReadPort";
import {
  parseHumanReview,
  parseHumanReviewExecution,
  parseBoundEvidenceReceipt,
  recheckHumanReviewResourceScope,
  reviewMatchesExecutionEvidence,
  type HumanReview,
  type HumanReviewExecution,
} from "./humanReview";
import type { EvidenceResourceScopePort } from "../evidence/appendOnlyEvidence";

export const APPROVED_REVIEW_REPORT_FILENAME =
  "Informe de revision humana.docx" as const;
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export type ApprovedReviewReportCitation = {
  citation_id: string;
  document_id: string;
  document_version_id: string;
  page: number;
  span: { start_char: number; end_char: number };
  quote_sha256: string;
};
export type ApprovedReviewReportFinding = {
  item_id: string;
  item_key: string;
  status: "accepted" | "edited";
  finding_text: string;
  citation: ApprovedReviewReportCitation | null;
};
export type ApprovedReviewReportPlan = {
  title: "Informe de revisión humana";
  review_id: string;
  review_revision: number;
  execution_id: string;
  matter_id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  evidence_receipt_sha256: string;
  findings: readonly ApprovedReviewReportFinding[];
  sections: readonly { heading: string; content: string }[];
};
export interface ApprovedDocxRendererPort {
  render(plan: ApprovedReviewReportPlan): Promise<unknown>;
}
export type ApprovedArtifactAppend = {
  idempotency_key: string;
  review_id: string;
  review_revision: number;
  execution_id: string;
  organization_id: string;
  matter_id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  source_document_sha256: string;
  evidence_receipt_sha256: string;
  filename: typeof APPROVED_REVIEW_REPORT_FILENAME;
  mime_type: typeof DOCX_MIME;
  artifact_sha256: string;
  docx_bytes: Uint8Array;
};
export interface ApprovedArtifactAppendPort {
  append(artifact: ApprovedArtifactAppend): Promise<unknown>;
}
export type ApprovedArtifactAppendReceipt = {
  disposition: "applied" | "replayed";
  review_id: string;
  review_revision: number;
  execution_id: string;
  artifact_sha256: string;
  idempotency_key: string;
};
export type ApprovedReportFailure = {
  ok: false;
  error_class:
    | "invalid_approved_report"
    | "approved_report_authorization_failed"
    | "authorization_dependency_failed"
    | "approved_report_render_failed"
    | "approved_report_append_failed";
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const APPEND_RECEIPT_KEYS = [
  "disposition",
  "review_id",
  "review_revision",
  "execution_id",
  "artifact_sha256",
  "idempotency_key",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
function snapshot(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("cyclic boundary");
  ancestors.add(value);
  try {
    if (ArrayBuffer.isView(value)) {
      if (!(value instanceof Uint8Array)) throw new TypeError("invalid bytes");
      return new Uint8Array(value);
    }
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      const length = value.length;
      for (let index = 0; index < length; index += 1)
        output.push(snapshot(value[index], ancestors));
      return output;
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>))
      output[key] = snapshot(
        (value as Record<string, unknown>)[key],
        ancestors,
      );
    return output;
  } finally {
    ancestors.delete(value);
  }
}
function deepFreeze<T>(value: T): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>))
      deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(
  error_class: ApprovedReportFailure["error_class"],
): ApprovedReportFailure {
  return Object.freeze({ ok: false as const, error_class });
}
function sameAuthority(
  review: HumanReview,
  execution: HumanReviewExecution,
  scope: AuthorizationScope,
): boolean {
  return (
    review.status === "approved" &&
    review.reviewer_user_id === scope.user_id &&
    review.organization_id === scope.organization_id &&
    review.matter_id === scope.matter_id &&
    review.execution_id === execution.execution_id &&
    review.execution_author_user_id === execution.author_user_id &&
    review.organization_id === execution.organization_id &&
    review.matter_id === execution.matter_id &&
    review.project_id === execution.project_id &&
    review.document_id === execution.document_id &&
    review.document_version_id === execution.document_version_id &&
    review.document_content_sha256 === execution.document_content_sha256 &&
    review.evidence_receipt_sha256 === execution.evidence_receipt_sha256 &&
    reviewMatchesExecutionEvidence(review, execution) &&
    review.items.every((item) => item.status !== "pending")
  );
}
function buildPlan(review: HumanReview): ApprovedReviewReportPlan | null {
  const retained = review.items
    .filter((item) => item.status === "accepted" || item.status === "edited")
    .sort((left, right) => codeUnitCompare(left.item_id, right.item_id))
    .map((item) => ({
      item_id: item.item_id,
      item_key: item.item_key,
      status: item.status as "accepted" | "edited",
      finding_text: item.finding_text,
      citation: item.citation
        ? {
            citation_id: item.citation.citation_id,
            document_id: item.citation.document_id,
            document_version_id: item.citation.document_version_id,
            page: item.citation.page,
            span: { ...item.citation.span },
            quote_sha256: item.citation.quote_sha256,
          }
        : null,
    }));
  if (retained.length === 0) return null;
  const findingContent = retained
    .map(
      (item, index) =>
        `${index + 1}. ${item.item_key} — ${item.status === "edited" ? "Editado" : "Aceptado"}\n${item.finding_text}`,
    )
    .join("\n\n");
  const citationContent = retained
    .flatMap((item) =>
      item.citation
        ? [
            `Cita ${item.citation.citation_id} · Documento ${item.citation.document_id} · Versión ${item.citation.document_version_id} · Página ${item.citation.page} · Rango ${item.citation.span.start_char}-${item.citation.span.end_char} · SHA-256 ${item.citation.quote_sha256}`,
          ]
        : [],
    )
    .join("\n");
  return deepFreeze({
    title: "Informe de revisión humana" as const,
    review_id: review.review_id,
    review_revision: review.revision,
    execution_id: review.execution_id,
    matter_id: review.matter_id,
    project_id: review.project_id,
    document_id: review.document_id,
    document_version_id: review.document_version_id,
    evidence_receipt_sha256: review.evidence_receipt_sha256,
    findings: retained,
    sections: [
      {
        heading: "Identificación",
        content: `Review ID: ${review.review_id}\nExecution ID: ${review.execution_id}\nMatter ID: ${review.matter_id}\nProject ID: ${review.project_id}\nDocument ID: ${review.document_id}\nVersión: ${review.document_version_id}`,
      },
      { heading: "Hallazgos aprobados", content: findingContent },
      {
        heading: "Citas verificadas",
        content: citationContent || "No se registraron citas.",
      },
      {
        heading: "Evidencia",
        content: `Receipt SHA-256: ${review.evidence_receipt_sha256}`,
      },
    ],
  });
}
function parseAppendReceipt(
  value: unknown,
  artifact: ApprovedArtifactAppend,
): ApprovedArtifactAppendReceipt | null {
  try {
    const raw = snapshot(value);
    if (!record(raw) || !exact(raw, APPEND_RECEIPT_KEYS)) return null;
    if (
      (raw.disposition !== "applied" && raw.disposition !== "replayed") ||
      raw.review_id !== artifact.review_id ||
      raw.review_revision !== artifact.review_revision ||
      raw.execution_id !== artifact.execution_id ||
      raw.artifact_sha256 !== artifact.artifact_sha256 ||
      raw.idempotency_key !== artifact.idempotency_key
    )
      return null;
    return deepFreeze(raw as ApprovedArtifactAppendReceipt);
  } catch {
    return null;
  }
}

async function validateDocx(value: unknown): Promise<Uint8Array | null> {
  try {
    const bytes = snapshot(value);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length === 0 ||
      bytes.length > 25_000_000
    )
      return null;
    const zip = await JSZip.loadAsync(bytes);
    const required = [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
    ];
    let total = 0;
    for (const path of required) {
      const entry = zip.file(path);
      if (!entry) return null;
      const content = await entry.async("uint8array");
      total += content.length;
      if (content.length === 0 || total > 5_000_000) return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

export async function produceApprovedReviewReport(input: {
  identity: AuthenticatedIdentity;
  granted_scope: AuthorizationScope;
  tenancy_port: TenancyReadPort;
  resource_scope_port: EvidenceResourceScopePort;
  requires_mfa: boolean;
  idempotency_key: string;
  expected_review_revision: number;
  review: unknown;
  execution: unknown;
  evidence_receipt: unknown;
  renderer: ApprovedDocxRendererPort;
  append_port: ApprovedArtifactAppendPort;
}): Promise<
  | {
      ok: true;
      plan: ApprovedReviewReportPlan;
      artifact: Readonly<Omit<ApprovedArtifactAppend, "docx_bytes">>;
      receipt: ApprovedArtifactAppendReceipt;
    }
  | ApprovedReportFailure
> {
  let values;
  try {
    const {
      identity,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      expected_review_revision,
      review: rawReview,
      execution: rawExecution,
      evidence_receipt,
      renderer,
      append_port,
    } = input;
    const render = renderer?.render;
    const append = append_port?.append;
    values = {
      identity,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      expected_review_revision,
      rawReview,
      rawExecution,
      evidence_receipt,
      renderer,
      render,
      append_port,
      append,
    };
  } catch {
    return failure("invalid_approved_report");
  }
  const review = parseHumanReview(values.rawReview);
  const execution = parseHumanReviewExecution(values.rawExecution);
  if (
    !review ||
    !execution ||
    !Number.isInteger(values.expected_review_revision) ||
    values.expected_review_revision < 1 ||
    values.expected_review_revision !== review.revision ||
    !IDEMPOTENCY_RE.test(values.idempotency_key) ||
    !sameAuthority(review, execution, values.granted_scope) ||
    !parseBoundEvidenceReceipt(values.evidence_receipt, execution) ||
    !values.resource_scope_port ||
    typeof values.render !== "function" ||
    typeof values.append !== "function"
  )
    return failure("invalid_approved_report");
  const plan = buildPlan(review);
  if (!plan) return failure("invalid_approved_report");
  let fresh;
  try {
    fresh = await recheckFreshAccessViaPort(values.tenancy_port, {
      scope: values.granted_scope,
      identity: values.identity,
      requiresMfa: values.requires_mfa,
    });
  } catch {
    return failure("authorization_dependency_failed");
  }
  if (fresh.kind === "authorization_dependency_failed")
    return failure("authorization_dependency_failed");
  if (!fresh.result.fresh)
    return failure("approved_report_authorization_failed");
  const resource = await recheckHumanReviewResourceScope(
    values.resource_scope_port,
    review,
  );
  if (resource === "dependency_failed")
    return failure("authorization_dependency_failed");
  if (resource !== "match")
    return failure("approved_report_authorization_failed");
  let bytes: Uint8Array | null;
  try {
    bytes = await validateDocx(await values.render.call(values.renderer, plan));
  } catch {
    bytes = null;
  }
  if (!bytes) return failure("approved_report_render_failed");
  const artifact = deepFreeze({
    idempotency_key: values.idempotency_key,
    review_id: review.review_id,
    review_revision: values.expected_review_revision,
    execution_id: execution.execution_id,
    organization_id: review.organization_id,
    matter_id: review.matter_id,
    project_id: review.project_id,
    document_id: review.document_id,
    document_version_id: review.document_version_id,
    source_document_sha256: review.document_content_sha256,
    evidence_receipt_sha256: review.evidence_receipt_sha256,
    filename: APPROVED_REVIEW_REPORT_FILENAME,
    mime_type: DOCX_MIME,
    artifact_sha256: sha256(bytes),
    docx_bytes: bytes,
  });
  let receipt: ApprovedArtifactAppendReceipt | null;
  try {
    receipt = parseAppendReceipt(
      await values.append.call(values.append_port, artifact),
      artifact,
    );
  } catch {
    receipt = null;
  }
  const { docx_bytes: _bytes, ...artifactMetadata } = artifact;
  return receipt
    ? deepFreeze({
        ok: true as const,
        plan,
        artifact: artifactMetadata,
        receipt,
      })
    : failure("approved_report_append_failed");
}
