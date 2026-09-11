import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
    parseCitations,
    parseCitationsWithDiagnostics,
    parsePartialCitationObjects,
    createCitation,
    CITATIONS_OPEN_TAG,
    CITATIONS_CLOSE_TAG,
} from "../chat/citations";
import type { DocIndex, DocStore } from "../chat/types";

function citationsBlock(json: string) {
    return `Answer text.\n${CITATIONS_OPEN_TAG}\n${json}\n${CITATIONS_CLOSE_TAG}`;
}

// ---------------------------------------------------------------------------
// parseCitationsWithDiagnostics
// ---------------------------------------------------------------------------

describe("parseCitationsWithDiagnostics", () => {
    it("reports no block when the tags are absent", () => {
        const { citations, diagnostics } =
            parseCitationsWithDiagnostics("plain answer");
        expect(citations).toEqual([]);
        expect(diagnostics).toEqual({ hasBlock: false, rawLength: 0, error: null });
    });

    it("reports a JSON parse error for malformed block content", () => {
        const { citations, diagnostics } = parseCitationsWithDiagnostics(
            citationsBlock("[{not json"),
        );
        expect(citations).toEqual([]);
        expect(diagnostics.hasBlock).toBe(true);
        expect(diagnostics.rawLength).toBeGreaterThan(0);
        expect(diagnostics.error).toBeTruthy();
    });

    it("reports an error when the block JSON is not an array", () => {
        const { citations, diagnostics } = parseCitationsWithDiagnostics(
            citationsBlock('{"ref": 1}'),
        );
        expect(citations).toEqual([]);
        expect(diagnostics.error).toBe("CITATIONS block JSON was not an array.");
    });

    it("does not spend unbounded time on a missing close tag", () => {
        const source = [
            "const { parseCitationsWithDiagnostics } = require(process.argv[1]);",
            "process.stdout.write(JSON.stringify(parseCitationsWithDiagnostics('<CITATIONS>' + '\\t'.repeat(100000))));",
        ].join("\n");
        const output = execFileSync(process.execPath, ["--import", "tsx", "-e", source, require.resolve("../chat/citations.ts")], {
            timeout: 5000,
            encoding: "utf8",
            stdio: "pipe",
        });
        expect(JSON.parse(output)).toEqual({
            citations: [],
            diagnostics: { hasBlock: false, rawLength: 0, error: null },
        });
    });
});

// ---------------------------------------------------------------------------
// parseCitations — document citations
// ---------------------------------------------------------------------------

describe("parseCitations (document citations)", () => {
    it("parses a minimal document citation", () => {
        const [citation] = parseCitations(
            citationsBlock(
                '[{"ref": 1, "doc_id": "doc-1", "page": 3, "quote": "the term"}]',
            ),
        );
        expect(citation).toMatchObject({
            kind: "document",
            ref: 1,
            doc_id: "doc-1",
            page: 3,
            quote: "the term",
        });
        expect(citation.quotes).toHaveLength(1);
    });

    it("derives ref from a [N] marker when ref is missing", () => {
        const [citation] = parseCitations(
            citationsBlock(
                '[{"marker": "[7]", "doc_id": "doc-1", "page": 1, "quote": "q"}]',
            ),
        );
        expect(citation.ref).toBe(7);
    });

    it("drops entries without a usable ref or marker", () => {
        expect(
            parseCitations(
                citationsBlock('[{"doc_id": "doc-1", "quote": "q", "marker": "nope"}]'),
            ),
        ).toEqual([]);
    });

    it("drops document entries without doc_id or quote", () => {
        expect(
            parseCitations(citationsBlock('[{"ref": 1, "doc_id": "doc-1"}]')),
        ).toEqual([]);
        expect(
            parseCitations(citationsBlock('[{"ref": 1, "quote": "q"}]')),
        ).toEqual([]);
    });

    it("drops non-object entries but keeps valid ones", () => {
        const citations = parseCitations(
            citationsBlock(
                '[null, "junk", {"ref": 2, "doc_id": "doc-2", "page": 4, "quote": "kept"}]',
            ),
        );
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 2, doc_id: "doc-2" });
    });

    it("accepts a text field as a quote alias", () => {
        const [citation] = parseCitations(
            citationsBlock('[{"ref": 1, "doc_id": "doc-1", "page": 2, "text": "aliased"}]'),
        );
        expect(citation.kind).toBe("document");
        expect((citation as { quote: string }).quote).toBe("aliased");
    });

    it("normalizes pages: numbers kept, ranges kept, junk becomes 1", () => {
        const citations = parseCitations(
            citationsBlock(
                '[{"ref": 1, "doc_id": "d", "page": 5, "quote": "a"},' +
                    '{"ref": 2, "doc_id": "d", "page": "3-5", "quote": "b"},' +
                    '{"ref": 3, "doc_id": "d", "page": "12", "quote": "c"},' +
                    '{"ref": 4, "doc_id": "d", "page": "unknown", "quote": "d"}]',
            ),
        );
        expect(citations.map((c) => (c as { page: number | string }).page)).toEqual([
            5,
            "3-5",
            12,
            1,
        ]);
    });

    it("keeps at most 3 quotes and inherits top-level page/sheet/cell", () => {
        const [citation] = parseCitations(
            citationsBlock(
                JSON.stringify([
                    {
                        ref: 1,
                        doc_id: "doc-1",
                        page: 9,
                        sheet: "Summary",
                        cell: "B7",
                        quotes: [
                            { quote: "one" },
                            { quote: "two", page: 2 },
                            { quote: "three", sheet: "Detail", cell: "C1" },
                            { quote: "four" },
                        ],
                    },
                ]),
            ),
        );
        expect(citation.kind).toBe("document");
        const doc = citation as {
            page: number | string;
            quotes: { page: number | string; quote: string; sheet?: string; cell?: string }[];
        };
        expect(doc.quotes).toHaveLength(3);
        expect(doc.quotes[0]).toEqual({
            page: 9,
            quote: "one",
            sheet: "Summary",
            cell: "B7",
        });
        expect(doc.quotes[1].page).toBe(2);
        expect(doc.quotes[2]).toMatchObject({ sheet: "Detail", cell: "C1" });
        // Top-level fields mirror the first quote.
        expect(doc.page).toBe(9);
    });

    it("skips quote rows without text", () => {
        const [citation] = parseCitations(
            citationsBlock(
                '[{"ref": 1, "doc_id": "doc-1", "page": 1,' +
                    ' "quotes": [{"page": 2}, {"quote": "  "}, {"quote": "real"}]}]',
            ),
        );
        expect((citation as { quotes: unknown[] }).quotes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// parsePartialCitationObjects
// ---------------------------------------------------------------------------

describe("parsePartialCitationObjects", () => {
    it("returns [] when no array has started", () => {
        expect(parsePartialCitationObjects("streaming <CITATIONS>")).toEqual([]);
    });

    it("extracts complete objects and ignores a trailing incomplete one", () => {
        const partial =
            '<CITATIONS>[{"ref": 1, "doc_id": "doc-1", "page": 2, "quote": "done"},' +
            ' {"ref": 2, "doc_id": "doc-2", "page": 3, "quote": "still stream';
        const citations = parsePartialCitationObjects(partial);
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 1, doc_id: "doc-1" });
    });

    it("handles braces and escaped quotes inside string values", () => {
        const partial =
            '<CITATIONS>[{"ref": 1, "doc_id": "doc-1", "page": 1,' +
            ' "quote": "clause {a} says \\"stop\\""}';
        const citations = parsePartialCitationObjects(partial);
        expect(citations).toHaveLength(1);
        expect((citations[0] as { quote: string }).quote).toBe(
            'clause {a} says "stop"',
        );
    });

    it("ignores content after the closing tag", () => {
        const text =
            '<CITATIONS>[{"ref": 1, "doc_id": "a", "page": 1, "quote": "q"}]</CITATIONS>' +
            '[{"ref": 9, "doc_id": "b", "page": 1, "quote": "after"}]';
        const citations = parsePartialCitationObjects(text);
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 1 });
    });

    it("stops at the array close bracket", () => {
        const text =
            '[{"ref": 1, "doc_id": "a", "page": 1, "quote": "q"}] {"ref": 2, "doc_id": "b", "page": 1, "quote": "outside"}';
        const citations = parsePartialCitationObjects(text);
        expect(citations).toHaveLength(1);
    });

    it("skips malformed objects but keeps later valid ones", () => {
        const text =
            '[{"ref": bad}, {"ref": 2, "doc_id": "doc-2", "page": 1, "quote": "ok"}';
        const citations = parsePartialCitationObjects(text);
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 2 });
    });
});

// ---------------------------------------------------------------------------
// createCitation
// ---------------------------------------------------------------------------

describe("createCitation", () => {
    const docIndex: DocIndex = {
        "doc-1": {
            document_id: "uuid-aaa",
            filename: "contract.pdf",
            version_id: "ver-1",
            version_number: 2,
        },
    };

    it("builds a document citation payload from the doc index", () => {
        const [parsed] = parseCitations(
            citationsBlock('[{"ref": 1, "doc_id": "doc-1", "page": 4, "quote": "q"}]'),
        );
        expect(createCitation(parsed, docIndex)).toMatchObject({
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "doc-1",
            document_id: "uuid-aaa",
            version_id: "ver-1",
            version_number: 2,
            filename: "contract.pdf",
            page: 4,
            quote: "q",
            document: {
                document_id: "uuid-aaa",
                title: "contract.pdf",
                type: "pdf",
                metadata: [],
                quotes: [{ quote: "q", target: { page: 4 } }],
            },
        });
    });

    it("falls back to the raw doc_id as filename when unresolvable", () => {
        const [parsed] = parseCitations(
            citationsBlock('[{"ref": 1, "doc_id": "doc-9", "page": 1, "quote": "q"}]'),
        );
        const citation = createCitation(parsed, docIndex);
        expect(citation).toMatchObject({
            filename: "doc-9",
            document_id: undefined,
            version_id: null,
        });
    });

    it("uses request-scoped document metadata for inline citations", () => {
        const [parsed] = parseCitations(
            citationsBlock('[{"ref": 1, "doc_id": "active-word-document", "quote": "q"}]'),
        );
        const docStore: DocStore = new Map([
            [
                "active-word-document",
                {
                    storage_path: "inline:word-document:test",
                    file_type: "text/markdown",
                    filename: "Contract.docx",
                    inline_text: "q",
                },
            ],
        ]);

        expect(createCitation(parsed, docIndex, docStore)).toMatchObject({
            filename: "Contract.docx",
            document: { title: "Contract.docx" },
        });
    });
});
