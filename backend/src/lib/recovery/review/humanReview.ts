import { createHash } from "node:crypto";

import type { AuthenticatedIdentity } from "../identity/authStateMatrix";
import type { AuthorizationScope } from "../authorization/evaluateAccess";
import {
  recheckFreshAccessViaPort,
  type TenancyReadPort,
} from "../authorization/tenancyReadPort";
import type { VerifiedCitation } from "../evidence/citationEvidence";
import type {
  CanonicalEvidenceReceipt,
  EvidenceResourceScope,
  EvidenceResourceScopePort,
} from "../evidence/appendOnlyEvidence";

export const HUMAN_REVIEW_ITEM_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "edited",
] as const;
export const HUMAN_REVIEW_TERMINAL_STATES = [
  "approved",
  "changes_requested",
] as const;
export type HumanReviewItemStatus = (typeof HUMAN_REVIEW_ITEM_STATUSES)[number];
export type HumanReviewDecision = Exclude<HumanReviewItemStatus, "pending">;
export type HumanReviewTerminalState =
  (typeof HUMAN_REVIEW_TERMINAL_STATES)[number];

export type HumanReviewScope = {
  organization_id: string;
  matter_id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  document_content_sha256: string;
};
export type HumanReviewExecution = HumanReviewScope & {
  execution_id: string;
  author_user_id: string;
  chat_id?: string;
  status: "succeeded";
  evidence_receipt_sha256: string;
  output_text: string;
  output_sha256: string;
  citations: readonly VerifiedCitation[];
};
export type BoundEvidencePageHash = {
  document_id: string;
  document_version_id: string;
  page: number;
  text_sha256: string;
};
export type BoundEvidenceReceipt = Readonly<CanonicalEvidenceReceipt> & {
  readonly page_hashes: readonly Readonly<BoundEvidencePageHash>[];
};
export type HumanReviewItem = {
  item_id: string;
  item_key: string;
  original_text: string;
  finding_text: string;
  status: HumanReviewItemStatus;
  comment: string | null;
  citation: VerifiedCitation | null;
};
export type HumanReview = HumanReviewScope & {
  review_id: string;
  revision: number;
  execution_id: string;
  execution_author_user_id: string;
  reviewer_user_id: string;
  evidence_receipt_sha256: string;
  status: "pending" | HumanReviewTerminalState;
  items: readonly HumanReviewItem[];
};
export type HumanReviewTransition = {
  decision: HumanReviewDecision;
  before: HumanReviewItem;
  after: HumanReviewItem;
};

type MutationEnvelope = {
  idempotency_key: string;
  review: HumanReview;
};
export type HumanReviewCreateMutation = MutationEnvelope;
export type HumanReviewDecisionMutation = MutationEnvelope & {
  item: HumanReviewItem;
  transition: HumanReviewTransition;
};
export type HumanReviewCompleteMutation = MutationEnvelope;
export interface HumanReviewMutationPort {
  create(value: HumanReviewCreateMutation): Promise<unknown>;
  decide(value: HumanReviewDecisionMutation): Promise<unknown>;
  complete(value: HumanReviewCompleteMutation): Promise<unknown>;
}
export type HumanReviewMutationReceipt = {
  disposition: "applied" | "replayed";
  operation: "create" | "decide" | "complete";
  review_id: string;
  item_id: string | null;
  revision: number;
  idempotency_key: string;
};
export type HumanReviewFailure = {
  ok: false;
  error_class:
    | "invalid_review"
    | "review_authorization_failed"
    | "authorization_dependency_failed"
    | "review_write_failed";
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAX_TEXT = 100_000;
const MAX_COMMENT = 2_000;
const MAX_ITEMS = 10_000;
const EXECUTION_KEYS = [
  "execution_id",
  "author_user_id",
  "status",
  "organization_id",
  "matter_id",
  "project_id",
  "document_id",
  "document_version_id",
  "document_content_sha256",
  "evidence_receipt_sha256",
  "output_text",
  "output_sha256",
  "citations",
] as const;
const EXECUTION_CHAT_KEYS = [...EXECUTION_KEYS, "chat_id"] as const;
const REVIEW_KEYS = [
  "review_id",
  "revision",
  "execution_id",
  "execution_author_user_id",
  "reviewer_user_id",
  "organization_id",
  "matter_id",
  "project_id",
  "document_id",
  "document_version_id",
  "document_content_sha256",
  "evidence_receipt_sha256",
  "status",
  "items",
] as const;
const ITEM_KEYS = [
  "item_id",
  "item_key",
  "original_text",
  "finding_text",
  "status",
  "comment",
  "citation",
] as const;
const CITATION_KEYS = [
  "citation_id",
  "document_id",
  "document_version_id",
  "page",
  "span",
  "quote_sha256",
  "finding_text",
  "verified",
] as const;
const SPAN_KEYS = ["start_char", "end_char"] as const;
const EVIDENCE_RECEIPT_KEYS = [
  "receipt_version",
  "canonical_json",
  "receipt_sha256",
] as const;
const EVIDENCE_BODY_KEYS = [
  "receipt_version",
  "idempotency_key",
  "execution_id",
  "tenant_scope",
  "route",
  "workflow",
  "status",
  "input_hashes",
  "page_hashes",
  "output_hash",
  "citation_hashes",
] as const;
const TENANT_SCOPE_KEYS = [
  "organization_id",
  "matter_id",
  "project_id",
  "document_version_id",
] as const;
const ROUTE_KEYS = ["provider", "model", "credential_ref"] as const;
const WORKFLOW_KEYS = [
  "workflow_key",
  "version",
  "content_hash",
  "source_commit",
  "distribution",
  "type",
  "source",
  "approval_provenance",
] as const;
const PAGE_HASH_KEYS = [
  "document_id",
  "document_version_id",
  "page",
  "text_sha256",
] as const;
const CITATION_HASH_KEYS = [
  "citation_id",
  "document_id",
  "document_version_id",
  "page",
  "span",
  "quote_sha256",
  "finding_sha256",
] as const;
const RESOURCE_SCOPE_KEYS = [
  "organization_id",
  "matter_id",
  "project_id",
  "document_id",
  "document_version_id",
  "document_content_sha256",
] as const;
const RECEIPT_KEYS = [
  "disposition",
  "operation",
  "review_id",
  "item_id",
  "revision",
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
function identity(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}
function text(value: unknown, max = MAX_TEXT): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}
function snapshot(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("cyclic boundary");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = value.length;
      const output: unknown[] = [];
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
function failure(
  error_class: HumanReviewFailure["error_class"],
): HumanReviewFailure {
  return Object.freeze({ ok: false as const, error_class });
}
function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

function parseCitation(value: unknown): VerifiedCitation | null {
  if (!record(value) || !exact(value, CITATION_KEYS)) return null;
  const span = value.span;
  if (
    !identity(value.citation_id) ||
    !identity(value.document_id) ||
    !identity(value.document_version_id) ||
    !Number.isInteger(value.page) ||
    (value.page as number) < 1 ||
    !record(span) ||
    !exact(span, SPAN_KEYS) ||
    !Number.isInteger(span.start_char) ||
    !Number.isInteger(span.end_char) ||
    (span.start_char as number) < 0 ||
    (span.end_char as number) <= (span.start_char as number) ||
    typeof value.quote_sha256 !== "string" ||
    !SHA256_RE.test(value.quote_sha256) ||
    !text(value.finding_text) ||
    value.verified !== true
  )
    return null;
  return deepFreeze({
    citation_id: value.citation_id,
    document_id: value.document_id,
    document_version_id: value.document_version_id,
    page: value.page as number,
    span: {
      start_char: span.start_char as number,
      end_char: span.end_char as number,
    },
    quote_sha256: value.quote_sha256,
    finding_text: value.finding_text.trim(),
    verified: true as const,
  });
}

export function parseHumanReviewExecution(
  value: unknown,
): HumanReviewExecution | null {
  try {
    const raw = snapshot(value);
    if (
      !record(raw) ||
      !exact(
        raw,
        raw.chat_id === undefined ? EXECUTION_KEYS : EXECUTION_CHAT_KEYS,
      )
    )
      return null;
    if (
      !identity(raw.execution_id) ||
      !identity(raw.author_user_id) ||
      raw.status !== "succeeded" ||
      !identity(raw.organization_id) ||
      !identity(raw.matter_id) ||
      !identity(raw.project_id) ||
      (raw.chat_id !== undefined && !identity(raw.chat_id)) ||
      !identity(raw.document_id) ||
      !identity(raw.document_version_id) ||
      typeof raw.document_content_sha256 !== "string" ||
      !SHA256_RE.test(raw.document_content_sha256) ||
      typeof raw.evidence_receipt_sha256 !== "string" ||
      !SHA256_RE.test(raw.evidence_receipt_sha256) ||
      !text(raw.output_text) ||
      typeof raw.output_sha256 !== "string" ||
      !SHA256_RE.test(raw.output_sha256) ||
      sha256(raw.output_text) !== raw.output_sha256 ||
      !Array.isArray(raw.citations) ||
      raw.citations.length > MAX_ITEMS
    )
      return null;
    const citations: VerifiedCitation[] = [];
    const ids = new Set<string>();
    for (const item of raw.citations) {
      const citation = parseCitation(item);
      if (
        !citation ||
        citation.document_id !== raw.document_id ||
        citation.document_version_id !== raw.document_version_id ||
        ids.has(citation.citation_id)
      )
        return null;
      ids.add(citation.citation_id);
      citations.push(citation);
    }
    citations.sort((left, right) =>
      codeUnitCompare(left.citation_id, right.citation_id),
    );
    return deepFreeze({
      execution_id: raw.execution_id,
      author_user_id: raw.author_user_id,
      status: "succeeded" as const,
      organization_id: raw.organization_id,
      matter_id: raw.matter_id,
      project_id: raw.project_id,
      ...(raw.chat_id === undefined ? {} : { chat_id: raw.chat_id }),
      document_id: raw.document_id,
      document_version_id: raw.document_version_id,
      document_content_sha256: raw.document_content_sha256,
      evidence_receipt_sha256: raw.evidence_receipt_sha256,
      output_text: raw.output_text,
      output_sha256: raw.output_sha256,
      citations,
    });
  } catch {
    return null;
  }
}

function parseItem(value: unknown): HumanReviewItem | null {
  if (!record(value) || !exact(value, ITEM_KEYS)) return null;
  if (
    !identity(value.item_id) ||
    !identity(value.item_key) ||
    !text(value.original_text) ||
    !text(value.finding_text) ||
    !(HUMAN_REVIEW_ITEM_STATUSES as readonly unknown[]).includes(
      value.status,
    ) ||
    !(
      value.comment === null ||
      (typeof value.comment === "string" &&
        value.comment.trim() === value.comment &&
        value.comment.length > 0 &&
        value.comment.length <= MAX_COMMENT)
    )
  )
    return null;
  if (value.status !== "edited" && value.finding_text !== value.original_text)
    return null;
  const citation =
    value.citation === null ? null : parseCitation(value.citation);
  if (value.citation !== null && !citation) return null;
  return deepFreeze({
    item_id: value.item_id,
    item_key: value.item_key,
    original_text: value.original_text,
    finding_text: value.finding_text,
    status: value.status as HumanReviewItemStatus,
    comment: value.comment as string | null,
    citation,
  });
}

export function parseHumanReview(value: unknown): HumanReview | null {
  try {
    const raw = snapshot(value);
    if (!record(raw) || !exact(raw, REVIEW_KEYS)) return null;
    if (
      !identity(raw.review_id) ||
      !Number.isInteger(raw.revision) ||
      (raw.revision as number) < 1 ||
      !identity(raw.execution_id) ||
      !identity(raw.execution_author_user_id) ||
      !identity(raw.reviewer_user_id) ||
      !identity(raw.organization_id) ||
      !identity(raw.matter_id) ||
      !identity(raw.project_id) ||
      !identity(raw.document_id) ||
      !identity(raw.document_version_id) ||
      typeof raw.document_content_sha256 !== "string" ||
      !SHA256_RE.test(raw.document_content_sha256) ||
      typeof raw.evidence_receipt_sha256 !== "string" ||
      !SHA256_RE.test(raw.evidence_receipt_sha256) ||
      !(
        raw.status === "pending" ||
        (HUMAN_REVIEW_TERMINAL_STATES as readonly unknown[]).includes(
          raw.status,
        )
      ) ||
      !Array.isArray(raw.items) ||
      raw.items.length === 0 ||
      raw.items.length > MAX_ITEMS
    )
      return null;
    const items: HumanReviewItem[] = [];
    const ids = new Set<string>();
    for (const value of raw.items) {
      const item = parseItem(value);
      if (!item || ids.has(item.item_id)) return null;
      ids.add(item.item_id);
      if (
        item.citation &&
        (item.citation.document_id !== raw.document_id ||
          item.citation.document_version_id !== raw.document_version_id)
      )
        return null;
      items.push(item);
    }
    return deepFreeze({
      review_id: raw.review_id,
      revision: raw.revision as number,
      execution_id: raw.execution_id,
      execution_author_user_id: raw.execution_author_user_id,
      reviewer_user_id: raw.reviewer_user_id,
      organization_id: raw.organization_id,
      matter_id: raw.matter_id,
      project_id: raw.project_id,
      document_id: raw.document_id,
      document_version_id: raw.document_version_id,
      document_content_sha256: raw.document_content_sha256,
      evidence_receipt_sha256: raw.evidence_receipt_sha256,
      status: raw.status as HumanReview["status"],
      items,
    });
  } catch {
    return null;
  }
}

function validMutationContext(input: {
  identity: AuthenticatedIdentity;
  granted_scope: AuthorizationScope;
  idempotency_key: unknown;
}): boolean {
  return (
    typeof input.idempotency_key === "string" &&
    IDEMPOTENCY_RE.test(input.idempotency_key) &&
    input.identity.user_id === input.granted_scope.user_id &&
    (input.granted_scope.membership_role === "matter_owner" ||
      input.granted_scope.membership_role === "editor")
  );
}
function reviewMatchesScope(
  review: HumanReview,
  scope: AuthorizationScope,
): boolean {
  return (
    review.organization_id === scope.organization_id &&
    review.matter_id === scope.matter_id &&
    review.reviewer_user_id === scope.user_id
  );
}
function executionMatchesReview(
  execution: HumanReviewExecution,
  review: HumanReview,
): boolean {
  return (
    execution.execution_id === review.execution_id &&
    execution.author_user_id === review.execution_author_user_id &&
    execution.organization_id === review.organization_id &&
    execution.matter_id === review.matter_id &&
    execution.project_id === review.project_id &&
    execution.document_id === review.document_id &&
    execution.document_version_id === review.document_version_id &&
    execution.document_content_sha256 === review.document_content_sha256 &&
    execution.evidence_receipt_sha256 === review.evidence_receipt_sha256
  );
}

export function parseBoundEvidenceReceipt(
  value: unknown,
  execution: HumanReviewExecution,
): BoundEvidenceReceipt | null {
  try {
    const raw = snapshot(value);
    if (!record(raw) || !exact(raw, EVIDENCE_RECEIPT_KEYS)) return null;
    if (
      raw.receipt_version !== "evidence-v1" ||
      typeof raw.canonical_json !== "string" ||
      typeof raw.receipt_sha256 !== "string" ||
      !SHA256_RE.test(raw.receipt_sha256) ||
      sha256(raw.canonical_json) !== raw.receipt_sha256 ||
      raw.receipt_sha256 !== execution.evidence_receipt_sha256
    )
      return null;
    const body = JSON.parse(raw.canonical_json) as unknown;
    if (!record(body) || !exact(body, EVIDENCE_BODY_KEYS)) return null;
    const tenant = body.tenant_scope;
    const route = body.route;
    const workflow = body.workflow;
    if (
      body.receipt_version !== "evidence-v1" ||
      body.execution_id !== execution.execution_id ||
      body.status !== "completed" ||
      typeof body.idempotency_key !== "string" ||
      !IDEMPOTENCY_RE.test(body.idempotency_key) ||
      !record(tenant) ||
      !exact(
        tenant,
        tenant.chat_id === undefined
          ? TENANT_SCOPE_KEYS
          : [...TENANT_SCOPE_KEYS, "chat_id"],
      ) ||
      tenant.organization_id !== execution.organization_id ||
      tenant.matter_id !== execution.matter_id ||
      tenant.project_id !== execution.project_id ||
      tenant.chat_id !== execution.chat_id ||
      (tenant.chat_id !== undefined && !identity(tenant.chat_id)) ||
      tenant.document_version_id !== execution.document_version_id ||
      !record(route) ||
      !exact(route, ROUTE_KEYS) ||
      !identity(route.provider) ||
      !identity(route.model) ||
      !identity(route.credential_ref) ||
      !record(workflow) ||
      !exact(workflow, WORKFLOW_KEYS) ||
      !identity(workflow.workflow_key) ||
      !identity(workflow.version) ||
      typeof workflow.content_hash !== "string" ||
      !SHA256_RE.test(workflow.content_hash) ||
      typeof workflow.source_commit !== "string" ||
      !/^[0-9a-f]{40}$/.test(workflow.source_commit) ||
      (workflow.distribution !== "default" &&
        workflow.distribution !== "addon") ||
      (workflow.type !== "assistant" && workflow.type !== "tabular") ||
      !identity(workflow.source) ||
      !identity(workflow.approval_provenance) ||
      !Array.isArray(body.input_hashes) ||
      !body.input_hashes.every(
        (hash) => typeof hash === "string" && SHA256_RE.test(hash),
      ) ||
      !body.input_hashes.every(
        (hash, index) =>
          index === 0 ||
          codeUnitCompare(
            (body.input_hashes as string[])[index - 1],
            hash as string,
          ) <= 0,
      ) ||
      !body.input_hashes.includes(execution.document_content_sha256) ||
      body.output_hash !== execution.output_sha256 ||
      !Array.isArray(body.page_hashes) ||
      body.page_hashes.length === 0 ||
      !Array.isArray(body.citation_hashes) ||
      body.citation_hashes.length !== execution.citations.length
    )
      return null;
    const pageNumbers = new Set<number>();
    let previousPage = 0;
    for (const page of body.page_hashes) {
      if (
        !record(page) ||
        !exact(page, PAGE_HASH_KEYS) ||
        page.document_id !== execution.document_id ||
        page.document_version_id !== execution.document_version_id ||
        !Number.isInteger(page.page) ||
        (page.page as number) < 1 ||
        (page.page as number) <= previousPage ||
        pageNumbers.has(page.page as number) ||
        typeof page.text_sha256 !== "string" ||
        !SHA256_RE.test(page.text_sha256)
      )
        return null;
      pageNumbers.add(page.page as number);
      previousPage = page.page as number;
    }
    const citationIds = new Set<string>();
    let previousCitationId: string | null = null;
    for (const item of body.citation_hashes) {
      if (!record(item) || !exact(item, CITATION_HASH_KEYS)) return null;
      const citation = execution.citations.find(
        (candidate) => candidate.citation_id === item.citation_id,
      );
      if (
        !citation ||
        citationIds.has(citation.citation_id) ||
        (previousCitationId !== null &&
          codeUnitCompare(previousCitationId, citation.citation_id) >= 0) ||
        item.document_id !== citation.document_id ||
        item.document_version_id !== citation.document_version_id ||
        item.page !== citation.page ||
        !record(item.span) ||
        !exact(item.span, SPAN_KEYS) ||
        item.span.start_char !== citation.span.start_char ||
        item.span.end_char !== citation.span.end_char ||
        item.quote_sha256 !== citation.quote_sha256 ||
        item.finding_sha256 !== sha256(citation.finding_text) ||
        !pageNumbers.has(citation.page)
      )
        return null;
      citationIds.add(citation.citation_id);
      previousCitationId = citation.citation_id;
    }
    if (canonicalize(body) !== raw.canonical_json) return null;
    return deepFreeze({
      ...(raw as CanonicalEvidenceReceipt),
      page_hashes: (body.page_hashes as BoundEvidencePageHash[]).map(
        (page) => ({
          document_id: page.document_id,
          document_version_id: page.document_version_id,
          page: page.page,
          text_sha256: page.text_sha256,
        }),
      ),
    });
  } catch {
    return null;
  }
}

export async function recheckHumanReviewResourceScope(
  port: EvidenceResourceScopePort,
  expected: HumanReviewScope,
): Promise<"match" | "mismatch" | "dependency_failed"> {
  try {
    const method = port.getEvidenceResourceScope;
    if (typeof method !== "function") return "dependency_failed";
    const raw = snapshot(
      await method.call(port, {
        document_version_id: expected.document_version_id,
      }),
    );
    if (!record(raw) || !exact(raw, RESOURCE_SCOPE_KEYS)) return "mismatch";
    for (const key of RESOURCE_SCOPE_KEYS)
      if (raw[key] !== expected[key]) return "mismatch";
    return "match";
  } catch {
    return "dependency_failed";
  }
}

export function reviewMatchesExecutionEvidence(
  review: HumanReview,
  execution: HumanReviewExecution,
): boolean {
  if (
    review.items.some(
      (item) =>
        item.status !== "edited" && item.finding_text !== item.original_text,
    )
  )
    return false;
  if (!executionMatchesReview(execution, review)) return false;
  if (execution.citations.length === 0) {
    return (
      review.items.length === 1 &&
      review.items[0].citation === null &&
      review.items[0].item_key === "finding-1" &&
      review.items[0].original_text === execution.output_text
    );
  }
  if (review.items.length !== execution.citations.length) return false;
  return review.items.every((item) => {
    if (!item.citation) return false;
    const citation = execution.citations.find(
      (candidate) => candidate.citation_id === item.citation!.citation_id,
    );
    return (
      citation !== undefined &&
      item.item_key === citation.citation_id &&
      item.original_text === citation.finding_text &&
      item.citation.document_id === citation.document_id &&
      item.citation.document_version_id === citation.document_version_id &&
      item.citation.page === citation.page &&
      item.citation.span.start_char === citation.span.start_char &&
      item.citation.span.end_char === citation.span.end_char &&
      item.citation.quote_sha256 === citation.quote_sha256 &&
      item.citation.finding_text === citation.finding_text
    );
  });
}
async function authorize(input: {
  identity: AuthenticatedIdentity;
  granted_scope: AuthorizationScope;
  tenancy_port: TenancyReadPort;
  requires_mfa: boolean;
}): Promise<HumanReviewFailure | null> {
  try {
    const result = await recheckFreshAccessViaPort(input.tenancy_port, {
      scope: input.granted_scope,
      identity: input.identity,
      requiresMfa: input.requires_mfa,
    });
    if (result.kind === "authorization_dependency_failed")
      return failure("authorization_dependency_failed");
    return result.result.fresh ? null : failure("review_authorization_failed");
  } catch {
    return failure("authorization_dependency_failed");
  }
}
function parseReceipt(
  value: unknown,
  expected: {
    operation: HumanReviewMutationReceipt["operation"];
    review_id: string;
    item_id: string | null;
    revision: number;
    idempotency_key: string;
  },
): Readonly<HumanReviewMutationReceipt> | null {
  try {
    const raw = snapshot(value);
    if (!record(raw) || !exact(raw, RECEIPT_KEYS)) return null;
    if (
      (raw.disposition !== "applied" && raw.disposition !== "replayed") ||
      raw.operation !== expected.operation ||
      raw.review_id !== expected.review_id ||
      raw.item_id !== expected.item_id ||
      raw.revision !== expected.revision ||
      raw.idempotency_key !== expected.idempotency_key
    )
      return null;
    return deepFreeze(raw as HumanReviewMutationReceipt);
  } catch {
    return null;
  }
}

export async function createHumanReview(input: {
  identity: AuthenticatedIdentity;
  granted_scope: AuthorizationScope;
  tenancy_port: TenancyReadPort;
  resource_scope_port: EvidenceResourceScopePort;
  requires_mfa: boolean;
  idempotency_key: string;
  review_id: string;
  execution: unknown;
  evidence_receipt: unknown;
  mutation_port: HumanReviewMutationPort;
}): Promise<
  | { ok: true; review: HumanReview; receipt: HumanReviewMutationReceipt }
  | HumanReviewFailure
> {
  let values;
  try {
    const {
      identity: actor,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      review_id,
      execution: rawExecution,
      evidence_receipt,
      mutation_port,
    } = input;
    const create = mutation_port?.create;
    values = {
      actor,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      review_id,
      rawExecution,
      evidence_receipt,
      mutation_port,
      create,
    };
  } catch {
    return failure("invalid_review");
  }
  const execution = parseHumanReviewExecution(values.rawExecution);
  if (
    !validMutationContext({
      identity: values.actor,
      granted_scope: values.granted_scope,
      idempotency_key: values.idempotency_key,
    }) ||
    !identity(values.review_id) ||
    !execution ||
    !parseBoundEvidenceReceipt(values.evidence_receipt, execution) ||
    execution.author_user_id === values.actor.user_id ||
    execution.organization_id !== values.granted_scope.organization_id ||
    execution.matter_id !== values.granted_scope.matter_id ||
    !values.resource_scope_port ||
    !values.mutation_port ||
    typeof values.create !== "function"
  )
    return failure("invalid_review");
  const items = execution.citations.length
    ? execution.citations.map((citation) => ({
        item_id: `${values.review_id}:${citation.citation_id}`,
        item_key: citation.citation_id,
        original_text: citation.finding_text,
        finding_text: citation.finding_text,
        status: "pending" as const,
        comment: null,
        citation,
      }))
    : [
        {
          item_id: `${values.review_id}:finding-1`,
          item_key: "finding-1",
          original_text: execution.output_text,
          finding_text: execution.output_text,
          status: "pending" as const,
          comment: null,
          citation: null,
        },
      ];
  const review = deepFreeze({
    review_id: values.review_id,
    revision: 1,
    execution_id: execution.execution_id,
    execution_author_user_id: execution.author_user_id,
    reviewer_user_id: values.actor.user_id,
    organization_id: execution.organization_id,
    matter_id: execution.matter_id,
    project_id: execution.project_id,
    document_id: execution.document_id,
    document_version_id: execution.document_version_id,
    document_content_sha256: execution.document_content_sha256,
    evidence_receipt_sha256: execution.evidence_receipt_sha256,
    status: "pending" as const,
    items,
  });
  const denied = await authorize({
    identity: values.actor,
    granted_scope: values.granted_scope,
    tenancy_port: values.tenancy_port,
    requires_mfa: values.requires_mfa,
  });
  if (denied) return denied;
  const resource = await recheckHumanReviewResourceScope(
    values.resource_scope_port,
    execution,
  );
  if (resource === "dependency_failed")
    return failure("authorization_dependency_failed");
  if (resource !== "match") return failure("review_authorization_failed");
  let receipt: HumanReviewMutationReceipt | null;
  try {
    const raw = await values.create.call(
      values.mutation_port,
      deepFreeze({ idempotency_key: values.idempotency_key, review }),
    );
    receipt = parseReceipt(raw, {
      operation: "create",
      review_id: review.review_id,
      item_id: null,
      revision: review.revision,
      idempotency_key: values.idempotency_key,
    });
  } catch {
    receipt = null;
  }
  return receipt
    ? deepFreeze({ ok: true as const, review, receipt })
    : failure("review_write_failed");
}

export async function decideHumanReviewItem(input: {
  identity: AuthenticatedIdentity;
  granted_scope: AuthorizationScope;
  tenancy_port: TenancyReadPort;
  resource_scope_port: EvidenceResourceScopePort;
  requires_mfa: boolean;
  idempotency_key: string;
  review: unknown;
  item_id: string;
  decision: HumanReviewDecision;
  finding_text?: unknown;
  comment?: unknown;
  mutation_port: HumanReviewMutationPort;
}): Promise<
  | {
      ok: true;
      review: HumanReview;
      transition: HumanReviewTransition;
      receipt: HumanReviewMutationReceipt;
    }
  | HumanReviewFailure
> {
  let values;
  try {
    const {
      identity: actor,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      review: rawReview,
      item_id,
      decision,
      finding_text,
      comment,
      mutation_port,
    } = input;
    const decide = mutation_port?.decide;
    values = {
      actor,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      rawReview,
      item_id,
      decision,
      finding_text,
      comment,
      mutation_port,
      decide,
    };
  } catch {
    return failure("invalid_review");
  }
  const review = parseHumanReview(values.rawReview);
  if (
    !validMutationContext({
      identity: values.actor,
      granted_scope: values.granted_scope,
      idempotency_key: values.idempotency_key,
    }) ||
    !review ||
    review.status !== "pending" ||
    !reviewMatchesScope(review, values.granted_scope) ||
    review.execution_author_user_id === values.actor.user_id ||
    !(HUMAN_REVIEW_ITEM_STATUSES as readonly unknown[]).includes(
      values.decision,
    ) ||
    values.decision === ("pending" as HumanReviewDecision) ||
    !identity(values.item_id) ||
    !values.mutation_port ||
    typeof values.decide !== "function"
  )
    return failure("invalid_review");
  const decision = values.decision as HumanReviewDecision;
  const before = review.items.find((item) => item.item_id === values.item_id);
  if (!before) return failure("invalid_review");
  let findingText = before.original_text;
  if (decision === "edited") {
    if (!text(values.finding_text)) return failure("invalid_review");
    findingText = values.finding_text.trim();
  } else if (values.finding_text !== undefined)
    return failure("invalid_review");
  let comment: string | null = null;
  if (values.comment !== undefined && values.comment !== null) {
    if (
      typeof values.comment !== "string" ||
      values.comment.length > MAX_COMMENT
    )
      return failure("invalid_review");
    comment = values.comment.trim() || null;
  }
  const candidateAfter = {
    ...before,
    status: decision,
    finding_text: findingText,
    comment,
  };
  const next = parseHumanReview({
    ...review,
    revision: review.revision + 1,
    items: review.items.map((item) =>
      item.item_id === values.item_id ? candidateAfter : item,
    ),
  });
  if (!next) return failure("invalid_review");
  const after = next.items.find((item) => item.item_id === values.item_id);
  if (!after) return failure("invalid_review");
  const transition = deepFreeze({
    decision,
    before,
    after,
  });
  const denied = await authorize({
    identity: values.actor,
    granted_scope: values.granted_scope,
    tenancy_port: values.tenancy_port,
    requires_mfa: values.requires_mfa,
  });
  if (denied) return denied;
  const resource = await recheckHumanReviewResourceScope(
    values.resource_scope_port,
    review,
  );
  if (resource === "dependency_failed")
    return failure("authorization_dependency_failed");
  if (resource !== "match") return failure("review_authorization_failed");
  let receipt: HumanReviewMutationReceipt | null;
  try {
    const raw = await values.decide.call(
      values.mutation_port,
      deepFreeze({
        idempotency_key: values.idempotency_key,
        review: next,
        item: after,
        transition,
      }),
    );
    receipt = parseReceipt(raw, {
      operation: "decide",
      review_id: next.review_id,
      item_id: after.item_id,
      revision: next.revision,
      idempotency_key: values.idempotency_key,
    });
  } catch {
    receipt = null;
  }
  return receipt
    ? deepFreeze({ ok: true as const, review: next, transition, receipt })
    : failure("review_write_failed");
}

export async function completeHumanReview(input: {
  identity: AuthenticatedIdentity;
  granted_scope: AuthorizationScope;
  tenancy_port: TenancyReadPort;
  resource_scope_port: EvidenceResourceScopePort;
  requires_mfa: boolean;
  idempotency_key: string;
  review: unknown;
  execution: unknown;
  terminal_state: HumanReviewTerminalState;
  mutation_port: HumanReviewMutationPort;
}): Promise<
  | { ok: true; review: HumanReview; receipt: HumanReviewMutationReceipt }
  | HumanReviewFailure
> {
  let values;
  try {
    const {
      identity: actor,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      review: rawReview,
      execution: rawExecution,
      terminal_state,
      mutation_port,
    } = input;
    const complete = mutation_port?.complete;
    values = {
      actor,
      granted_scope,
      tenancy_port,
      resource_scope_port,
      requires_mfa,
      idempotency_key,
      rawReview,
      rawExecution,
      terminal_state,
      mutation_port,
      complete,
    };
  } catch {
    return failure("invalid_review");
  }
  const review = parseHumanReview(values.rawReview);
  const execution = parseHumanReviewExecution(values.rawExecution);
  if (
    !validMutationContext({
      identity: values.actor,
      granted_scope: values.granted_scope,
      idempotency_key: values.idempotency_key,
    }) ||
    !review ||
    !execution ||
    review.status !== "pending" ||
    !reviewMatchesScope(review, values.granted_scope) ||
    !reviewMatchesExecutionEvidence(review, execution) ||
    review.execution_author_user_id === values.actor.user_id ||
    !(HUMAN_REVIEW_TERMINAL_STATES as readonly unknown[]).includes(
      values.terminal_state,
    ) ||
    !values.mutation_port ||
    typeof values.complete !== "function"
  )
    return failure("invalid_review");
  if (
    values.terminal_state === "approved" &&
    review.items.some(
      (item) =>
        item.status === "pending" ||
        (item.citation?.verified !== true && item.citation !== null),
    )
  )
    return failure("invalid_review");
  const next = deepFreeze({
    ...review,
    revision: review.revision + 1,
    status: values.terminal_state,
  });
  const denied = await authorize({
    identity: values.actor,
    granted_scope: values.granted_scope,
    tenancy_port: values.tenancy_port,
    requires_mfa: values.requires_mfa,
  });
  if (denied) return denied;
  const resource = await recheckHumanReviewResourceScope(
    values.resource_scope_port,
    review,
  );
  if (resource === "dependency_failed")
    return failure("authorization_dependency_failed");
  if (resource !== "match") return failure("review_authorization_failed");
  let receipt: HumanReviewMutationReceipt | null;
  try {
    const raw = await values.complete.call(
      values.mutation_port,
      deepFreeze({ idempotency_key: values.idempotency_key, review: next }),
    );
    receipt = parseReceipt(raw, {
      operation: "complete",
      review_id: next.review_id,
      item_id: null,
      revision: next.revision,
      idempotency_key: values.idempotency_key,
    });
  } catch {
    receipt = null;
  }
  return receipt
    ? deepFreeze({ ok: true as const, review: next, receipt })
    : failure("review_write_failed");
}
