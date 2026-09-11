import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  verifyCitationBatch,
  verifyCitationCandidate,
} from "./citationEvidence";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const text = "Árbol jurídico y contrato.";
const context = {
  document_id: "doc-1",
  document_version_id: "version-1",
  page_count: 1,
  pages: [{ page: 1, text, text_sha256: sha(text) }],
};
const candidate = {
  citation_id: "c-1",
  document_id: "doc-1",
  document_version_id: "version-1",
  page: 1,
  span: { start_char: 0, end_char: 5 },
  quote: "Árbol",
  quote_sha256: sha("Árbol"),
  finding_text: "Hallazgo útil",
};
const failure = { ok: false, error_class: "citation_unresolvable" };

describe("citation verifier", () => {
  it("verifies exact scope, page hash, code-unit span, quote and hash", () => {
    const result = verifyCitationCandidate(candidate, context);
    expect(result).toEqual({
      ok: true,
      citation: {
        citation_id: "c-1",
        document_id: "doc-1",
        document_version_id: "version-1",
        page: 1,
        span: { start_char: 0, end_char: 5 },
        quote_sha256: sha("Árbol"),
        finding_text: "Hallazgo útil",
        verified: true,
      },
    });
    if (!result.ok) return;
    expect(Object.isFrozen(result.citation)).toBe(true);
    expect(Object.isFrozen(result.citation.span)).toBe(true);
  });

  it.each([
    ["document", { document_id: "doc-2" }],
    ["version", { document_version_id: "version-2" }],
    ["page zero", { page: 0 }],
    ["page high", { page: 2 }],
    ["span float", { span: { start_char: 0.5, end_char: 5 } }],
    ["span inverted", { span: { start_char: 5, end_char: 1 } }],
    ["span bounds", { span: { start_char: 0, end_char: 999 } }],
    ["quote", { quote: "Arbol" }],
    ["quote hash", { quote_sha256: "0".repeat(64) }],
    ["uppercase hash", { quote_sha256: sha("Árbol").toUpperCase() }],
    ["finding", { finding_text: " " }],
    ["extra", { prompt: "secret" }],
    ["forged verified", { verified: true }],
  ])("rejects wrong %s", (_label, patch) => {
    expect(
      verifyCitationCandidate({ ...candidate, ...patch }, context),
    ).toEqual(failure);
  });

  it("rejects a tampered page text hash and malformed/throwing values opaquely", () => {
    expect(
      verifyCitationCandidate(candidate, {
        ...context,
        pages: [{ ...context.pages[0], text_sha256: "0".repeat(64) }],
      }),
    ).toEqual(failure);
    const throwing = Object.defineProperty({}, "citation_id", {
      enumerable: true,
      get: () => {
        throw new Error("raw SECRET");
      },
    });
    const result = verifyCitationCandidate(throwing, context);
    expect(result).toEqual(failure);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("rejects whitespace aliases for citation and scope identities", () => {
    expect(
      verifyCitationCandidate({ ...candidate, citation_id: " c-1" }, context),
    ).toEqual(failure);
    expect(
      verifyCitationCandidate(
        { ...candidate, document_id: " doc-1" },
        { ...context, document_id: " doc-1" },
      ),
    ).toEqual(failure);
    expect(
      verifyCitationCandidate(
        { ...candidate, document_version_id: "version-1 " },
        { ...context, document_version_id: "version-1 " },
      ),
    ).toEqual(failure);
  });

  it("sorts deterministically by code units and rejects duplicate ids atomically", () => {
    const z = { ...candidate, citation_id: "z" };
    const upper = { ...candidate, citation_id: "A" };
    const result = verifyCitationBatch([z, upper], context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.citations.map((item) => item.citation_id)).toEqual([
        "A",
        "z",
      ]);
      expect(Object.isFrozen(result.citations)).toBe(true);
    }
    expect(verifyCitationBatch([candidate, { ...candidate }], context)).toEqual(
      failure,
    );
  });
});
