import { canonicalJson, sha256Hex } from "./aiReceipts";

export type AiRedlineBundleFindingStatus = "accepted" | "rejected" | "edited";

export type AiRedlineBundleInput = {
  revision?: number;
  execution: {
    id: string;
    matter_id: string | null;
    project_id: string;
    document_id: string;
    document_version_id: string;
    document_content_sha256: string;
    status: string;
  };
  review: {
    id: string;
    execution_id: string;
    matter_id: string;
    project_id: string;
    reviewer_user_id: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  };
  items: {
    id: string;
    item_key: string;
    finding_text: string;
    status: string;
    citation_refs: unknown[];
    updated_at?: string | null;
  }[];
  source_version: {
    id: string;
    document_id: string;
    content_sha256: string | null;
    deleted_at?: string | null;
  };
  pages: {
    document_id: string;
    document_version_id: string;
    page: number;
    content: string;
    content_sha256: string;
  }[];
  receipt: {
    id: string;
    execution_id: string;
    receipt_version: string;
    canonical_json: unknown;
    receipt_sha256: string;
  } | null;
};

export type AiRedlineAction = {
  action_id: string;
  item_id: string;
  review_item_id: string;
  citation_id: string;
  source_document_version_id: string;
  page: number;
  start: number;
  end: number;
  before_text_sha256: string;
  replacement_text: string;
  reviewer_user_id: string;
  timestamp: string;
};

export type AiRedlineBundleJson = {
  bundle_version: "beta-0.1";
  revision: number;
  matter_id: string;
  review_id: string;
  execution_id: string;
  source_document_version_id: string;
  source_document_sha256: string;
  receipt_id: string;
  receipt_version: string;
  receipt_sha256: string;
  actions: AiRedlineAction[];
};

export type AiRedlineBundleErrorCode =
  | "execution_not_succeeded"
  | "review_not_approved"
  | "scope_mismatch"
  | "source_version_invalid"
  | "receipt_unavailable"
  | "receipt_invalid"
  | "pending_finding"
  | "unverified_citation"
  | "no_actions";

export type PreparedAiRedlineBundle = {
  ok: true;
  revision: number;
  canonical_json: AiRedlineBundleJson;
  canonical_json_text: string;
  bundle_sha256: string;
  actions: AiRedlineAction[];
};

export type AiRedlineBundlePreparation =
  | PreparedAiRedlineBundle
  | { ok: false; code: AiRedlineBundleErrorCode };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function actionTimestamp(
  item: AiRedlineBundleInput["items"][number],
  review: AiRedlineBundleInput["review"],
): string | null {
  if (nonEmptyText(item.updated_at)) return item.updated_at.trim();
  if (nonEmptyText(review.completed_at)) return review.completed_at.trim();
  if (nonEmptyText(review.created_at)) return review.created_at.trim();
  return null;
}

function citationAction(
  value: unknown,
  item: AiRedlineBundleInput["items"][number],
  input: AiRedlineBundleInput,
): AiRedlineAction | null {
  if (!isRecord(value) || value.verified !== true) return null;
  if (!nonEmptyText(value.citation_id)) return null;
  if (
    value.document_id !== input.execution.document_id ||
    value.document_version_id !== input.source_version.id
  ) {
    return null;
  }

  const page = value.page;
  const span = value.span;
  if (!isInteger(page) || page < 1 || !isRecord(span)) return null;
  const start = span.start_char;
  const end = span.end_char;
  if (
    !isInteger(start) ||
    !isInteger(end) ||
    start < 0 ||
    end <= start ||
    !isSha256(value.quote_sha256)
  ) {
    return null;
  }

  const sourcePage = input.pages.find(
    (candidate) =>
      candidate.page === page &&
      candidate.document_id === input.execution.document_id &&
      candidate.document_version_id === input.source_version.id,
  );
  if (!sourcePage) return null;
  if (
    !isSha256(sourcePage.content_sha256) ||
    sourcePage.content_sha256 !== sha256Hex(sourcePage.content) ||
    end > sourcePage.content.length
  ) {
    return null;
  }

  const beforeText = sourcePage.content.slice(start, end);
  if (nonEmptyText(value.quote) && value.quote !== beforeText) {
    return null;
  }
  const beforeTextSha256 = sha256Hex(beforeText);
  if (value.quote_sha256 !== beforeTextSha256) return null;

  const timestamp = actionTimestamp(item, input.review);
  if (
    !timestamp ||
    !nonEmptyText(item.id) ||
    !nonEmptyText(item.finding_text)
  ) {
    return null;
  }
  const citationId = value.citation_id.trim();
  const actionIdentity = {
    bundle_version: "beta-0.1",
    revision: input.revision ?? 1,
    review_id: input.review.id,
    source_document_version_id: input.source_version.id,
    item_id: item.id,
    citation_id: citationId,
    page,
    start,
    end,
  };

  return {
    action_id: `action-${sha256Hex(canonicalJson(actionIdentity))}`,
    item_id: item.id.trim(),
    review_item_id: item.id.trim(),
    citation_id: citationId,
    source_document_version_id: input.source_version.id,
    page,
    start,
    end,
    before_text_sha256: beforeTextSha256,
    replacement_text: item.finding_text.trim(),
    reviewer_user_id: input.review.reviewer_user_id,
    timestamp,
  };
}

function invalidRevision(value: unknown): boolean {
  return !isInteger(value) || value < 1;
}

export function prepareAiRedlineBundle(
  input: AiRedlineBundleInput,
): AiRedlineBundlePreparation {
  const revision = input.revision ?? 1;
  if (invalidRevision(revision)) return { ok: false, code: "scope_mismatch" };
  if (input.execution.status !== "succeeded") {
    return { ok: false, code: "execution_not_succeeded" };
  }
  if (input.review.status !== "approved") {
    return { ok: false, code: "review_not_approved" };
  }
  if (
    !input.execution.matter_id ||
    input.review.execution_id !== input.execution.id ||
    input.review.matter_id !== input.execution.matter_id ||
    input.review.project_id !== input.execution.project_id ||
    input.source_version.id !== input.execution.document_version_id ||
    input.source_version.document_id !== input.execution.document_id ||
    input.source_version.deleted_at != null
  ) {
    return { ok: false, code: "scope_mismatch" };
  }

  const sourceDocumentSha256 = input.source_version.content_sha256;
  if (
    !isSha256(sourceDocumentSha256) ||
    !isSha256(input.execution.document_content_sha256) ||
    sourceDocumentSha256 !== input.execution.document_content_sha256
  ) {
    return { ok: false, code: "source_version_invalid" };
  }

  if (!input.receipt) return { ok: false, code: "receipt_unavailable" };
  if (
    input.receipt.execution_id !== input.execution.id ||
    !isSha256(input.receipt.receipt_sha256) ||
    sha256Hex(canonicalJson(input.receipt.canonical_json)) !==
      input.receipt.receipt_sha256
  ) {
    return { ok: false, code: "receipt_invalid" };
  }

  const pages = new Set<string>();
  for (const page of input.pages) {
    const key = `${page.document_id}:${page.document_version_id}:${page.page}`;
    if (pages.has(key)) return { ok: false, code: "unverified_citation" };
    pages.add(key);
  }

  const actions: AiRedlineAction[] = [];
  for (const item of input.items) {
    if (item.status === "rejected") continue;
    if (item.status !== "accepted" && item.status !== "edited") {
      return { ok: false, code: "pending_finding" };
    }
    if (!Array.isArray(item.citation_refs) || item.citation_refs.length === 0) {
      return { ok: false, code: "unverified_citation" };
    }
    for (const citation of item.citation_refs) {
      const action = citationAction(citation, item, input);
      if (!action) {
        if (isRecord(citation)) {
          console.error("[ai-redline] citation-integrity-failure", {
            itemKey: item.item_key,
            citationId: typeof citation.citation_id === "string" ? citation.citation_id : null,
            documentId: typeof citation.document_id === "string" ? citation.document_id : null,
            documentVersionId: typeof citation.document_version_id === "string" ? citation.document_version_id : null,
            page: typeof citation.page === "number" ? citation.page : null,
            span: isRecord(citation.span)
              ? { start: citation.span.start_char, end: citation.span.end_char }
              : null,
          });
        }
        return { ok: false, code: "unverified_citation" };
      }
      actions.push(action);
    }
  }

  if (actions.length === 0) return { ok: false, code: "no_actions" };
  actions.sort((left, right) => left.action_id.localeCompare(right.action_id));

  const canonical_json: AiRedlineBundleJson = {
    bundle_version: "beta-0.1",
    revision,
    matter_id: input.execution.matter_id,
    review_id: input.review.id,
    execution_id: input.execution.id,
    source_document_version_id: input.source_version.id,
    source_document_sha256: sourceDocumentSha256,
    receipt_id: input.receipt.id,
    receipt_version: input.receipt.receipt_version,
    receipt_sha256: input.receipt.receipt_sha256,
    actions,
  };
  const canonical_json_text = canonicalJson(canonical_json);

  return {
    ok: true,
    revision,
    canonical_json,
    canonical_json_text,
    bundle_sha256: sha256Hex(canonical_json_text),
    actions,
  };
}
