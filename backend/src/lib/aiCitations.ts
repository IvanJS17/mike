import {
  canonicalJson,
  sha256Hex,
  type CanonicalReceipt,
} from "./aiReceipts";

const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;

export type CitationCandidate = Record<string, unknown>;

export type CitationPage = {
  page: number;
  text: string;
  textSha256: string;
};

export type CitationResolutionContext = {
  documentId: string;
  documentVersionId: string;
  documentContentSha256: string;
  sourceContentSha256: string | null;
  pageCount: number | null;
  pages: CitationPage[];
};

export type ResolvedCitation = {
  citation_id: string;
  document_id: string;
  document_version_id: string;
  page: number;
  span: { start_char: number; end_char: number };
  quote_sha256: string;
  finding_text: string;
  verified: true;
};

export type CitationResolutionFailure = {
  ok: false;
  error_class: "citation_unresolvable";
};

export type CitationResolution =
  | ResolvedCitation
  | CitationResolutionFailure;

export function parseStrictCitationBlock(text: string): {
  hasBlock: boolean;
  citations: CitationCandidate[];
  error: "citation_block_missing" | "citation_block_invalid" | null;
} {
  const match = text.match(CITATIONS_BLOCK_RE);
  if (!match) {
    return {
      hasBlock: false,
      citations: [],
      error: "citation_block_missing",
    };
  }
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    if (!Array.isArray(parsed)) throw new Error("not-array");
    const citations = parsed.filter(
      (value): value is CitationCandidate =>
        !!value && typeof value === "object" && !Array.isArray(value),
    );
    if (citations.length !== parsed.length) throw new Error("invalid-entry");
    return { hasBlock: true, citations, error: null };
  } catch {
    return {
      hasBlock: true,
      citations: [],
      error: "citation_block_invalid",
    };
  }
}

export function stripStrictCitationBlock(text: string): string {
  return text.replace(CITATIONS_BLOCK_RE, "").trim();
}

function failure(): CitationResolutionFailure {
  return { ok: false, error_class: "citation_unresolvable" };
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function resolveCitation(
  candidate: unknown,
  context: CitationResolutionContext,
): CitationResolution {
  if (
    !/^[a-f0-9]{64}$/.test(context.documentContentSha256)
    || context.sourceContentSha256 !== context.documentContentSha256
  ) {
    return failure();
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return failure();
  }
  const value = candidate as Record<string, unknown>;
  if (
    !isString(value.citation_id) ||
    !value.citation_id.trim() ||
    value.document_id !== context.documentId ||
    value.document_version_id !== context.documentVersionId
  ) {
    return failure();
  }

  const page = value.page;
  if (!isInteger(page) || page < 1) return failure();
  if (context.pageCount == null || page > context.pageCount) return failure();

  const span = value.span;
  if (!span || typeof span !== "object" || Array.isArray(span)) return failure();
  const start = (span as Record<string, unknown>).start_char;
  const end = (span as Record<string, unknown>).end_char;
  if (!isInteger(start) || !isInteger(end) || start < 0 || end <= start) {
    return failure();
  }

  const sourcePage = context.pages.find((row) => row.page === page);
  if (!sourcePage || sha256Hex(sourcePage.text) !== sourcePage.textSha256) {
    return failure();
  }
  if (end > sourcePage.text.length) return failure();
  if (!isString(value.quote) || !value.quote) return failure();
  if (!isString(value.finding_text) || !value.finding_text.trim()) {
    return failure();
  }

  const excerpt = sourcePage.text.slice(start, end);
  if (excerpt !== value.quote) return failure();
  if (
    !isString(value.quote_sha256)
    || !/^[a-f0-9]{64}$/.test(value.quote_sha256)
  ) {
    return failure();
  }
  const quote_sha256 = sha256Hex(excerpt);
  if (value.quote_sha256 !== quote_sha256) return failure();

  return {
    citation_id: value.citation_id,
    document_id: context.documentId,
    document_version_id: context.documentVersionId,
    page,
    span: { start_char: start, end_char: end },
    quote_sha256,
    finding_text: value.finding_text.trim(),
    verified: true,
  };
}

export function resolveCitations(
  candidates: unknown[],
  context: CitationResolutionContext,
): { ok: true; citations: ResolvedCitation[] } | CitationResolutionFailure {
  const citations = candidates.map((candidate) =>
    resolveCitation(candidate, context),
  );
  if (citations.some((citation) => "ok" in citation && !citation.ok)) {
    return failure();
  }
  return {
    ok: true,
    citations: citations as ResolvedCitation[],
  };
}

export function buildCitationReceiptFields(
  citations: ResolvedCitation[],
): CanonicalReceipt["citations"] {
  return citations.map((citation) => ({
    citation_id: citation.citation_id,
    document_id: citation.document_id,
    document_version_id: citation.document_version_id,
    page: citation.page,
    span: citation.span,
    quote_sha256: citation.quote_sha256,
    finding_text: citation.finding_text,
    verified: citation.verified,
  }));
}

export function citationBlockHash(citations: CitationCandidate[]): string {
  return sha256Hex(canonicalJson(citations));
}
