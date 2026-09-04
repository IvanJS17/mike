import { createHash } from "node:crypto";

export type CitationPageContext = {
  page: number;
  text: string;
  text_sha256: string;
};
export type CitationVerificationContext = {
  document_id: string;
  document_version_id: string;
  page_count: number;
  pages: CitationPageContext[];
};
export type VerifiedCitation = {
  citation_id: string;
  document_id: string;
  document_version_id: string;
  page: number;
  span: { start_char: number; end_char: number };
  quote_sha256: string;
  finding_text: string;
  verified: true;
};
export type CitationFailure = {
  ok: false;
  error_class: "citation_unresolvable";
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const CANDIDATE_KEYS = [
  "citation_id",
  "document_id",
  "document_version_id",
  "page",
  "span",
  "quote",
  "quote_sha256",
  "finding_text",
] as const;
const CONTEXT_KEYS = [
  "document_id",
  "document_version_id",
  "page_count",
  "pages",
] as const;
const PAGE_KEYS = ["page", "text", "text_sha256"] as const;
const SPAN_KEYS = ["start_char", "end_char"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
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
function failure(): CitationFailure {
  return Object.freeze({
    ok: false as const,
    error_class: "citation_unresolvable" as const,
  });
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseContext(value: unknown): CitationVerificationContext | null {
  if (
    !record(value) ||
    !exact(value, CONTEXT_KEYS) ||
    !nonEmpty(value.document_id) ||
    !nonEmpty(value.document_version_id)
  )
    return null;
  if (
    !Number.isInteger(value.page_count) ||
    (value.page_count as number) < 1 ||
    (value.page_count as number) > 100_000 ||
    !Array.isArray(value.pages)
  )
    return null;
  const pages: CitationPageContext[] = [];
  const seen = new Set<number>();
  for (const page of value.pages) {
    if (
      !record(page) ||
      !exact(page, PAGE_KEYS) ||
      !Number.isInteger(page.page) ||
      (page.page as number) < 1 ||
      (page.page as number) > (value.page_count as number) ||
      typeof page.text !== "string" ||
      typeof page.text_sha256 !== "string" ||
      !SHA256_RE.test(page.text_sha256) ||
      sha256(page.text) !== page.text_sha256 ||
      seen.has(page.page as number)
    )
      return null;
    seen.add(page.page as number);
    pages.push({
      page: page.page as number,
      text: page.text,
      text_sha256: page.text_sha256,
    });
  }
  return {
    document_id: value.document_id,
    document_version_id: value.document_version_id,
    page_count: value.page_count as number,
    pages,
  };
}

export function verifyCitationCandidate(
  candidate: unknown,
  contextValue: unknown,
): { ok: true; citation: VerifiedCitation } | CitationFailure {
  try {
    const context = parseContext(contextValue);
    if (!context || !record(candidate) || !exact(candidate, CANDIDATE_KEYS))
      return failure();
    const span = candidate.span;
    if (!record(span) || !exact(span, SPAN_KEYS)) return failure();
    const start = span.start_char;
    const end = span.end_char;
    if (
      !nonEmpty(candidate.citation_id) ||
      candidate.document_id !== context.document_id ||
      candidate.document_version_id !== context.document_version_id ||
      !Number.isInteger(candidate.page) ||
      (candidate.page as number) < 1 ||
      (candidate.page as number) > context.page_count ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) <= (start as number)
    )
      return failure();
    const page = context.pages.find((item) => item.page === candidate.page);
    if (
      !page ||
      (end as number) > page.text.length ||
      typeof candidate.quote !== "string" ||
      candidate.quote.length === 0 ||
      typeof candidate.quote_sha256 !== "string" ||
      !SHA256_RE.test(candidate.quote_sha256) ||
      !nonEmpty(candidate.finding_text)
    )
      return failure();
    const quote = page.text.slice(start as number, end as number);
    if (candidate.quote !== quote || candidate.quote_sha256 !== sha256(quote))
      return failure();
    const citation: VerifiedCitation = Object.freeze({
      citation_id: candidate.citation_id,
      document_id: context.document_id,
      document_version_id: context.document_version_id,
      page: candidate.page as number,
      span: Object.freeze({
        start_char: start as number,
        end_char: end as number,
      }),
      quote_sha256: candidate.quote_sha256,
      finding_text: candidate.finding_text.trim(),
      verified: true,
    });
    return Object.freeze({ ok: true as const, citation });
  } catch {
    return failure();
  }
}

export function verifyCitationBatch(
  candidates: unknown,
  context: unknown,
): { ok: true; citations: readonly VerifiedCitation[] } | CitationFailure {
  try {
    if (!Array.isArray(candidates)) return failure();
    const citations: VerifiedCitation[] = [];
    const ids = new Set<string>();
    for (const candidate of candidates) {
      const result = verifyCitationCandidate(candidate, context);
      if (!result.ok || ids.has(result.citation.citation_id)) return failure();
      ids.add(result.citation.citation_id);
      citations.push(result.citation);
    }
    citations.sort((left, right) =>
      codeUnitCompare(left.citation_id, right.citation_id),
    );
    return Object.freeze({
      ok: true as const,
      citations: Object.freeze(citations),
    });
  } catch {
    return failure();
  }
}
