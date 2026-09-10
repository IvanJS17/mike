import { type DocIndex, type DocStore, resolveDoc } from "./types";
import {
  sourceDocumentType,
  type SourceDocumentQuote,
} from "../sourceDocuments";

// ---------------------------------------------------------------------------
// Internal citation parse types
// ---------------------------------------------------------------------------

type DocumentQuote = {
  page: number | string;
  quote: string;
  // Spreadsheet sources are located by cell instead of page: `sheet` is the
  // worksheet name and `cell` is an A1 address or range (e.g. "B7" or "B7:C9").
  sheet?: string;
  cell?: string;
};

type ParsedDocumentCitation = {
  kind: "document";
  ref: number;
  doc_id: string;
  page: number | string;
  quote: string;
  sheet?: string;
  cell?: string;
  quotes: DocumentQuote[];
};

function normalizeCitation(raw: unknown): ParsedDocumentCitation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const markerRef =
    typeof c.marker === "string"
      ? Number(c.marker.match(/^\[(\d+)\]$/)?.[1])
      : NaN;
  const ref =
    typeof c.ref === "number"
      ? c.ref
      : Number.isFinite(markerRef)
        ? markerRef
        : null;
  if (typeof ref !== "number") return null;
  const quote = typeof c.quote === "string" ? c.quote : c.text;

  if (typeof c.doc_id !== "string") return null;
  const quotes = normalizeDocumentCitationQuotes(c);
  if (!quotes.length) {
    if (typeof quote !== "string" || !quote) return null;
    quotes.push({
      page: normalizeCitationPage(c.page),
      quote,
      ...normalizeCellLocator(c),
    });
  }
  return {
    kind: "document",
    ref,
    doc_id: c.doc_id,
    page: quotes[0].page,
    quote: quotes[0].quote,
    sheet: quotes[0].sheet,
    cell: quotes[0].cell,
    quotes,
  };
}

/** Pull an optional spreadsheet `{sheet, cell}` locator off a raw object. */
function normalizeCellLocator(
  c: Record<string, unknown>,
): { sheet?: string; cell?: string } {
  const out: { sheet?: string; cell?: string } = {};
  if (typeof c.sheet === "string" && c.sheet.trim()) out.sheet = c.sheet.trim();
  if (typeof c.cell === "string" && c.cell.trim()) out.cell = c.cell.trim();
  return out;
}

function normalizeCitationPage(value: unknown): number | string {
  if (typeof value === "number") {
    return value;
  } else if (typeof value === "string" && /^\d+\s*-\s*\d+$/.test(value)) {
    return value;
  } else {
    const n = parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n)) return 1;
    return n;
  }
}

function normalizeDocumentCitationQuotes(
  c: Record<string, unknown>,
): DocumentQuote[] {
  if (!Array.isArray(c.quotes)) return [];
  return c.quotes
    .slice(0, 3)
    .map((raw): DocumentQuote | null => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const text = typeof row.quote === "string" ? row.quote : row.text;
      if (typeof text !== "string" || !text.trim()) return null;
      // Fall back to the top-level sheet/cell so a citation can set them once.
      return {
        page: normalizeCitationPage(row.page ?? c.page),
        quote: text,
        ...normalizeCellLocator({
          sheet: row.sheet ?? c.sheet,
          cell: row.cell ?? c.cell,
        }),
      };
    })
    .filter((quote): quote is DocumentQuote => !!quote);
}

// ---------------------------------------------------------------------------
// Citation block constants and parsers
// ---------------------------------------------------------------------------

export const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;
export const CITATIONS_OPEN_TAG = "<CITATIONS>";
export const CITATIONS_CLOSE_TAG = "</CITATIONS>";

type CitationParseDiagnostics = {
  hasBlock: boolean;
  rawLength: number;
  error: string | null;
};

export function parseCitationsWithDiagnostics(text: string): {
  citations: ParsedDocumentCitation[];
  diagnostics: CitationParseDiagnostics;
} {
  const match = text.match(CITATIONS_BLOCK_RE);
  if (!match) {
    return { citations: [], diagnostics: { hasBlock: false, rawLength: 0, error: null } };
  }
  const raw = match[1] ?? "";
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        citations: [],
        diagnostics: { hasBlock: true, rawLength: raw.length, error: "CITATIONS block JSON was not an array." },
      };
    }
    return {
      citations: parsed.map(normalizeCitation).filter((c): c is ParsedDocumentCitation => c !== null),
      diagnostics: { hasBlock: true, rawLength: raw.length, error: null },
    };
  } catch (error) {
    return {
      citations: [],
      diagnostics: {
        hasBlock: true,
        rawLength: raw.length,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function parseCitations(text: string): ParsedDocumentCitation[] {
  return parseCitationsWithDiagnostics(text).citations;
}

export function parsePartialCitationObjects(text: string): ParsedDocumentCitation[] {
  const beforeClose = text.split(CITATIONS_CLOSE_TAG)[0] ?? text;
  const arrayStart = beforeClose.indexOf("[");
  if (arrayStart < 0) return [];

  const parsed: ParsedDocumentCitation[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectStart = -1;

  for (let i = arrayStart + 1; i < beforeClose.length; i += 1) {
    const char = beforeClose[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = inString; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try {
          const raw = JSON.parse(beforeClose.slice(objectStart, i + 1));
          const citation = normalizeCitation(raw);
          if (citation) parsed.push(citation);
        } catch { /* ignore incomplete/malformed partial object */ }
        objectStart = -1;
      }
    } else if (char === "]" && depth === 0) {
      break;
    }
  }
  return parsed;
}

export function createCitation(
  citation: ParsedDocumentCitation,
  docIndex: DocIndex,
  docStore?: DocStore,
) {
  const docInfo = resolveDoc(citation.doc_id, docIndex);
  const requestScopedDocument = docStore?.get(citation.doc_id);
  const documentId = docInfo?.document_id ?? citation.doc_id;
  const filename =
    docInfo?.filename ?? requestScopedDocument?.filename ?? citation.doc_id;
  const quotes: SourceDocumentQuote[] = citation.quotes.map((quote) => ({
    quote: quote.quote,
    target: {
      page: quote.page,
      ...(quote.sheet ? { sheet: quote.sheet } : {}),
      ...(quote.cell ? { cell: quote.cell } : {}),
    },
  }));
  return {
    type: "citation_data",
    kind: "document",
    ref: citation.ref,
    document: {
      document_id: documentId,
      title: filename,
      type: sourceDocumentType(filename),
      metadata: [],
      quotes,
      version_id: docInfo?.version_id ?? null,
      version_number: docInfo?.version_number ?? null,
    },
    doc_id: citation.doc_id,
    document_id: docInfo?.document_id,
    version_id: docInfo?.version_id ?? null,
    version_number: docInfo?.version_number ?? null,
    filename,
    page: citation.page,
    quote: citation.quote,
    sheet: citation.sheet,
    cell: citation.cell,
    quotes: citation.quotes,
  };
}
