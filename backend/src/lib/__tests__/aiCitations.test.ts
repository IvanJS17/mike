import { describe, expect, it } from "vitest";
import { sha256Hex } from "../aiReceipts";
import {
  parseStrictCitationBlock,
  resolveCitation,
  resolveCitations,
  type CitationResolutionContext,
} from "../aiCitations";

const pageText = "La parte compradora podrá terminar el contrato.";
const context: CitationResolutionContext = {
  documentId: "document-1",
  documentVersionId: "version-1",
  documentContentSha256: "f".repeat(64),
  sourceContentSha256: "f".repeat(64),
  pageCount: 1,
  pages: [
    {
      page: 1,
      text: pageText,
      textSha256: sha256Hex(pageText),
    },
  ],
};

const validCitation = {
  citation_id: "c1",
  document_id: "document-1",
  document_version_id: "version-1",
  page: 1,
  span: { start_char: 0, end_char: 12 },
  quote: "La parte com",
  quote_sha256: sha256Hex("La parte com"),
};

describe("strict AI citations", () => {
  it("resolves an exact document version, page, and span", () => {
    expect(resolveCitation(validCitation, context)).toEqual({
      citation_id: "c1",
      document_version_id: "version-1",
      page: 1,
      span: { start_char: 0, end_char: 12 },
      quote_sha256: sha256Hex("La parte com"),
      verified: true,
    });
  });

  it.each([
    ["crossed document", { document_id: "document-2" }],
    ["crossed version", { document_version_id: "version-2" }],
    ["invalid page", { page: 0 }],
    ["inverted span", { span: { start_char: 12, end_char: 2 } }],
    ["out of bounds span", { span: { start_char: 0, end_char: 999 } }],
    ["fabricated quote", { quote: "texto que no existe" }],
  ])("rejects a %s", (_label, patch) => {
    const result = resolveCitation({ ...validCitation, ...patch }, context);

    expect(result).toEqual({
      ok: false,
      error_class: "citation_unresolvable",
    });
  });

  it("rejects a tampered page source hash", () => {
    const result = resolveCitation(validCitation, {
      ...context,
      pages: [{ ...context.pages[0], textSha256: "0".repeat(64) }],
    });

    expect(result).toEqual({
      ok: false,
      error_class: "citation_unresolvable",
    });
  });

  it("rejects pages whose source bytes do not match the frozen version hash", () => {
    const result = resolveCitation(validCitation, {
      ...context,
      sourceContentSha256: "0".repeat(64),
    });

    expect(result).toEqual({
      ok: false,
      error_class: "citation_unresolvable",
    });
  });

  it.each([
    ["missing quote hash", undefined],
    ["malformed quote hash", "not-a-sha256"],
    ["mismatched quote hash", "0".repeat(64)],
  ])("rejects a %s", (_label, quoteSha256) => {
    const { quote_sha256: _validQuoteSha256, ...citationWithoutHash } = validCitation;
    const candidate = {
      ...citationWithoutHash,
      ...(quoteSha256 === undefined ? {} : { quote_sha256: quoteSha256 }),
    };

    expect(resolveCitation(candidate, context)).toEqual({
      ok: false,
      error_class: "citation_unresolvable",
    });
  });

  it("requires a strict citations block and rejects malformed JSON", () => {
    expect(
      parseStrictCitationBlock('<CITATIONS>[{"citation_id":"c1"}]</CITATIONS>'),
    ).toEqual({
      hasBlock: true,
      citations: [{ citation_id: "c1" }],
      error: null,
    });
    expect(parseStrictCitationBlock("answer without citations")).toEqual({
      hasBlock: false,
      citations: [],
      error: "citation_block_missing",
    });
    expect(parseStrictCitationBlock("<CITATIONS>{bad}</CITATIONS>")).toEqual({
      hasBlock: true,
      citations: [],
      error: "citation_block_invalid",
    });
  });

  it("returns only verified references for a successful batch", () => {
    expect(resolveCitations([validCitation], context)).toEqual({
      ok: true,
      citations: [
        {
          citation_id: "c1",
          document_version_id: "version-1",
          page: 1,
          span: { start_char: 0, end_char: 12 },
          quote_sha256: sha256Hex("La parte com"),
          verified: true,
        },
      ],
    });
  });
});
