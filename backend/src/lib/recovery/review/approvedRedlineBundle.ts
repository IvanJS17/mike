import { createHash } from "node:crypto";

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
  type BoundEvidencePageHash,
  type HumanReview,
  type HumanReviewExecution,
} from "./humanReview";
import type { EvidenceResourceScopePort } from "../evidence/appendOnlyEvidence";

export type ApprovedRedlineAction = {
  action_id: string;
  review_item_id: string;
  citation_id: string;
  document_id: string;
  document_version_id: string;
  page: number;
  start: number;
  end: number;
  page_content_sha256: string;
  before_text_sha256: string;
  replacement_text: string;
  replacement_text_sha256: string;
};
export type ApprovedRedlineBundle = {
  bundle_version: "approved-redline-v1";
  revision: number;
  review_id: string;
  review_revision: number;
  execution_id: string;
  organization_id: string;
  matter_id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  source_document_sha256: string;
  evidence_receipt_version: "evidence-v1";
  evidence_receipt_sha256: string;
  reviewer_user_id: string;
  actions: readonly ApprovedRedlineAction[];
  canonical_json: string;
  bundle_sha256: string;
};
export type ApprovedRedlineAppend = ApprovedRedlineBundle & {
  idempotency_key: string;
};
export interface ApprovedRedlineAppendPort {
  append(bundle: ApprovedRedlineAppend): Promise<unknown>;
}
export type ApprovedRedlineAppendReceipt = {
  disposition: "applied" | "replayed";
  review_id: string;
  review_revision: number;
  execution_id: string;
  bundle_sha256: string;
  action_count: number;
  idempotency_key: string;
};
export type ApprovedRedlineFailure = {
  ok: false;
  error_class:
    | "invalid_approved_redline"
    | "approved_redline_authorization_failed"
    | "authorization_dependency_failed"
    | "approved_redline_append_failed";
};

type SourcePage = {
  document_id: string;
  document_version_id: string;
  page: number;
  content: string;
  content_sha256: string;
};
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SOURCE_KEYS = [
  "document_id",
  "document_version_id",
  "content_sha256",
] as const;
const PAGE_KEYS = [
  "document_id",
  "document_version_id",
  "page",
  "content",
  "content_sha256",
] as const;

const APPEND_RECEIPT_KEYS = [
  "disposition",
  "review_id",
  "review_revision",
  "execution_id",
  "bundle_sha256",
  "action_count",
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
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>))
      deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compare(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
function failure(
  error_class: ApprovedRedlineFailure["error_class"],
): ApprovedRedlineFailure {
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

function parsePages(
  value: unknown,
  execution: HumanReviewExecution,
  receiptPages: readonly BoundEvidencePageHash[],
): SourcePage[] | null {
  try {
    const raw = snapshot(value);
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100_000)
      return null;
    const pages: SourcePage[] = [];
    const seen = new Set<number>();
    for (const item of raw) {
      if (
        !record(item) ||
        !exact(item, PAGE_KEYS) ||
        item.document_id !== execution.document_id ||
        item.document_version_id !== execution.document_version_id ||
        !Number.isInteger(item.page) ||
        (item.page as number) < 1 ||
        seen.has(item.page as number) ||
        typeof item.content !== "string" ||
        typeof item.content_sha256 !== "string" ||
        !SHA256_RE.test(item.content_sha256) ||
        sha256(item.content) !== item.content_sha256
      )
        return null;
      seen.add(item.page as number);
      pages.push({
        document_id: item.document_id,
        document_version_id: item.document_version_id,
        page: item.page as number,
        content: item.content,
        content_sha256: item.content_sha256,
      });
    }
    pages.sort((left, right) => left.page - right.page);
    if (
      pages.length !== receiptPages.length ||
      pages.some((page, index) => {
        const expected = receiptPages[index];
        return (
          page.document_id !== expected.document_id ||
          page.document_version_id !== expected.document_version_id ||
          page.page !== expected.page ||
          page.content_sha256 !== expected.text_sha256
        );
      })
    )
      return null;
    return pages;
  } catch {
    return null;
  }
}
function validSource(value: unknown, execution: HumanReviewExecution): boolean {
  try {
    const raw = snapshot(value);
    return (
      record(raw) &&
      exact(raw, SOURCE_KEYS) &&
      raw.document_id === execution.document_id &&
      raw.document_version_id === execution.document_version_id &&
      raw.content_sha256 === execution.document_content_sha256 &&
      typeof raw.content_sha256 === "string" &&
      SHA256_RE.test(raw.content_sha256)
    );
  } catch {
    return false;
  }
}
function buildActions(
  review: HumanReview,
  pages: SourcePage[],
  revision: number,
): ApprovedRedlineAction[] | null {
  const actions: ApprovedRedlineAction[] = [];
  const citationIds = new Set<string>();
  for (const item of review.items) {
    if (item.status === "rejected") continue;
    if (
      (item.status !== "accepted" && item.status !== "edited") ||
      !item.citation ||
      citationIds.has(item.citation.citation_id)
    )
      return null;
    citationIds.add(item.citation.citation_id);
    const page = pages.find(
      (candidate) => candidate.page === item.citation!.page,
    );
    if (
      !page ||
      item.citation.document_id !== review.document_id ||
      item.citation.document_version_id !== review.document_version_id ||
      item.citation.span.end_char > page.content.length
    )
      return null;
    const before = page.content.slice(
      item.citation.span.start_char,
      item.citation.span.end_char,
    );
    if (sha256(before) !== item.citation.quote_sha256) return null;
    const identity = {
      bundle_version: "approved-redline-v1",
      revision,
      review_id: review.review_id,
      review_revision: review.revision,
      execution_id: review.execution_id,
      item_id: item.item_id,
      citation_id: item.citation.citation_id,
      page: item.citation.page,
      start: item.citation.span.start_char,
      end: item.citation.span.end_char,
    };
    actions.push({
      action_id: `action-${sha256(canonical(identity))}`,
      review_item_id: item.item_id,
      citation_id: item.citation.citation_id,
      document_id: review.document_id,
      document_version_id: review.document_version_id,
      page: item.citation.page,
      start: item.citation.span.start_char,
      end: item.citation.span.end_char,
      page_content_sha256: page.content_sha256,
      before_text_sha256: item.citation.quote_sha256,
      replacement_text: item.finding_text,
      replacement_text_sha256: sha256(item.finding_text),
    });
  }
  if (actions.length === 0) return null;
  actions.sort((left, right) => compare(left.action_id, right.action_id));
  const spans = [...actions].sort(
    (left, right) =>
      left.page - right.page ||
      left.start - right.start ||
      left.end - right.end,
  );
  for (let index = 1; index < spans.length; index += 1)
    if (
      spans[index - 1].page === spans[index].page &&
      spans[index].start < spans[index - 1].end
    )
      return null;
  return actions;
}
function parseAppendReceipt(
  value: unknown,
  bundle: ApprovedRedlineAppend,
): ApprovedRedlineAppendReceipt | null {
  try {
    const raw = snapshot(value);
    if (
      !record(raw) ||
      !exact(raw, APPEND_RECEIPT_KEYS) ||
      (raw.disposition !== "applied" && raw.disposition !== "replayed") ||
      raw.review_id !== bundle.review_id ||
      raw.review_revision !== bundle.review_revision ||
      raw.execution_id !== bundle.execution_id ||
      raw.bundle_sha256 !== bundle.bundle_sha256 ||
      raw.action_count !== bundle.actions.length ||
      raw.idempotency_key !== bundle.idempotency_key
    )
      return null;
    return deepFreeze(raw as ApprovedRedlineAppendReceipt);
  } catch {
    return null;
  }
}

export async function produceApprovedRedlineBundle(input: {
  identity: AuthenticatedIdentity;
  granted_scope: AuthorizationScope;
  tenancy_port: TenancyReadPort;
  resource_scope_port: EvidenceResourceScopePort;
  requires_mfa: boolean;
  idempotency_key: string;
  revision: number;
  expected_review_revision: number;
  review: unknown;
  execution: unknown;
  evidence_receipt: unknown;
  source_version: unknown;
  pages: unknown;
  append_port: ApprovedRedlineAppendPort;
}): Promise<
  | {
      ok: true;
      bundle: ApprovedRedlineBundle;
      receipt: ApprovedRedlineAppendReceipt;
    }
  | ApprovedRedlineFailure
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
      revision,
      expected_review_revision,
      review: rawReview,
      execution: rawExecution,
      evidence_receipt,
      source_version,
      pages: rawPages,
      append_port,
    } = input;
    const append = append_port?.append;
    values = {
      identity,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      revision,
      expected_review_revision,
      rawReview,
      rawExecution,
      evidence_receipt,
      source_version,
      rawPages,
      append_port,
      append,
    };
  } catch {
    return failure("invalid_approved_redline");
  }
  const review = parseHumanReview(values.rawReview);
  const execution = parseHumanReviewExecution(values.rawExecution);
  const evidenceReceipt = execution
    ? parseBoundEvidenceReceipt(values.evidence_receipt, execution)
    : null;
  if (
    !review ||
    !execution ||
    !Number.isInteger(values.revision) ||
    values.revision < 1 ||
    !Number.isInteger(values.expected_review_revision) ||
    values.expected_review_revision < 1 ||
    values.expected_review_revision !== review.revision ||
    typeof values.idempotency_key !== "string" ||
    !IDEMPOTENCY_RE.test(values.idempotency_key) ||
    !sameAuthority(review, execution, values.granted_scope) ||
    !evidenceReceipt ||
    !validSource(values.source_version, execution) ||
    !values.append_port ||
    !values.resource_scope_port ||
    typeof values.append !== "function"
  )
    return failure("invalid_approved_redline");
  const revision = values.revision as number;
  const pages = parsePages(
    values.rawPages,
    execution,
    evidenceReceipt.page_hashes,
  );
  if (!pages) return failure("invalid_approved_redline");
  const actions = buildActions(review, pages, revision);
  if (!actions) return failure("invalid_approved_redline");
  const canonicalBody = {
    bundle_version: "approved-redline-v1",
    revision,
    review_id: review.review_id,
    review_revision: review.revision,
    execution_id: review.execution_id,
    organization_id: review.organization_id,
    matter_id: review.matter_id,
    project_id: review.project_id,
    document_id: review.document_id,
    document_version_id: review.document_version_id,
    source_document_sha256: review.document_content_sha256,
    evidence_receipt_version: "evidence-v1",
    evidence_receipt_sha256: review.evidence_receipt_sha256,
    reviewer_user_id: review.reviewer_user_id,
    actions: actions.map(({ replacement_text: _text, ...action }) => action),
  };
  const canonical_json = canonical(canonicalBody);
  const bundle = deepFreeze({
    ...canonicalBody,
    actions,
    canonical_json,
    bundle_sha256: sha256(canonical_json),
  } as ApprovedRedlineBundle);
  const append = deepFreeze({
    ...bundle,
    idempotency_key: values.idempotency_key,
  });
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
    return failure("approved_redline_authorization_failed");
  const resource = await recheckHumanReviewResourceScope(
    values.resource_scope_port,
    review,
  );
  if (resource === "dependency_failed")
    return failure("authorization_dependency_failed");
  if (resource !== "match")
    return failure("approved_redline_authorization_failed");
  let receipt: ApprovedRedlineAppendReceipt | null;
  try {
    receipt = parseAppendReceipt(
      await values.append.call(values.append_port, append),
      append,
    );
  } catch {
    receipt = null;
  }
  return receipt
    ? deepFreeze({ ok: true as const, bundle, receipt })
    : failure("approved_redline_append_failed");
}
