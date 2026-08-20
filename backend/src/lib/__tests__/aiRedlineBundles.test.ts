import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../aiReceipts";
import {
  prepareAiRedlineBundle,
  type AiRedlineBundleInput,
} from "../aiRedlineBundles";

const sourceText = "Source A. Source B.";
const sourceVersionSha256 = "f".repeat(64);
const receiptJson = {
  receipt_version: "beta-0.1",
  execution_id: "execution-1",
  input: { document_version_id: "source-version-1" },
  result: { status: "succeeded" },
};
const receiptSha256 = sha256Hex(canonicalJson(receiptJson));

function citation(
  citationId: string,
  start: number,
  end: number,
  quote: string,
) {
  return {
    citation_id: citationId,
    document_id: "document-1",
    document_version_id: "source-version-1",
    page: 1,
    span: { start_char: start, end_char: end },
    quote,
    quote_sha256: sha256Hex(quote),
    verified: true,
  };
}

const baseInput: AiRedlineBundleInput = {
  revision: 1,
  execution: {
    id: "execution-1",
    matter_id: "matter-1",
    project_id: "project-1",
    document_id: "document-1",
    document_version_id: "source-version-1",
    document_content_sha256: sourceVersionSha256,
    status: "succeeded",
  },
  review: {
    id: "review-1",
    execution_id: "execution-1",
    matter_id: "matter-1",
    project_id: "project-1",
    reviewer_user_id: "reviewer-1",
    status: "approved",
    created_at: "2026-08-19T12:00:00.000Z",
    completed_at: "2026-08-19T12:05:00.000Z",
  },
  items: [
    {
      id: "item-accepted",
      item_key: "finding-1",
      finding_text: "Reemplazo aceptado",
      status: "accepted",
      citation_refs: [citation("c1", 0, 9, "Source A.")],
      updated_at: "2026-08-19T12:04:00.000Z",
    },
    {
      id: "item-edited",
      item_key: "finding-2",
      finding_text: "Reemplazo editado",
      status: "edited",
      citation_refs: [citation("c2", 10, sourceText.length, "Source B.")],
      updated_at: "2026-08-19T12:04:30.000Z",
    },
    {
      id: "item-rejected",
      item_key: "finding-3",
      finding_text: "No debe salir",
      status: "rejected",
      citation_refs: [{ verified: false }],
      updated_at: "2026-08-19T12:04:45.000Z",
    },
  ],
  source_version: {
    id: "source-version-1",
    document_id: "document-1",
    content_sha256: sourceVersionSha256,
    deleted_at: null,
  },
  pages: [
    {
      document_id: "document-1",
      document_version_id: "source-version-1",
      page: 1,
      content: sourceText,
      content_sha256: sha256Hex(sourceText),
    },
  ],
  receipt: {
    id: "receipt-1",
    execution_id: "execution-1",
    receipt_version: "beta-0.1",
    canonical_json: receiptJson,
    receipt_sha256: receiptSha256,
  },
};

describe("AI redline bundle preparation", () => {
  it("includes only accepted and edited exact-span actions and authenticates canonical JSON", () => {
    const result = prepareAiRedlineBundle(baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.actions).toHaveLength(2);
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: "item-accepted",
          citation_id: "c1",
          start: 0,
          end: 9,
          before_text_sha256: sha256Hex("Source A."),
          replacement_text: "Reemplazo aceptado",
          reviewer_user_id: "reviewer-1",
          timestamp: "2026-08-19T12:04:00.000Z",
        }),
        expect.objectContaining({
          item_id: "item-edited",
          citation_id: "c2",
          start: 10,
          end: sourceText.length,
          replacement_text: "Reemplazo editado",
        }),
      ]),
    );
    expect(
      result.actions.some((action) => action.item_id === "item-rejected"),
    ).toBe(false);
    expect(result.canonical_json.source_document_sha256).toBe(
      sourceVersionSha256,
    );
    expect(result.canonical_json.receipt_id).toBe("receipt-1");
    expect(result.bundle_sha256).toBe(sha256Hex(result.canonical_json_text));
    expect(result.canonical_json_text).toBe(
      canonicalJson(result.canonical_json),
    );
  });

  it("is deterministic for the same review, source version, and revision", () => {
    const first = prepareAiRedlineBundle(baseInput);
    const second = prepareAiRedlineBundle({
      ...baseInput,
      items: [...baseInput.items],
    });

    expect(first).toEqual(second);
  });

  it.each([
    [
      "missing source hash",
      { source_version: { ...baseInput.source_version, content_sha256: null } },
    ],
    [
      "cross-version citation",
      {
        items: [
          {
            ...baseInput.items[0],
            citation_refs: [citation("c1", 0, 9, "Source A.")].map((value) => ({
              ...value,
              document_version_id: "other-version",
            })),
          },
        ],
      },
    ],
    [
      "tampered span hash",
      {
        items: [
          {
            ...baseInput.items[0],
            citation_refs: [
              {
                ...citation("c1", 0, 9, "Source A."),
                quote_sha256: "a".repeat(64),
              },
            ],
          },
        ],
      },
    ],
    [
      "missing exact span",
      {
        items: [{ ...baseInput.items[0], citation_refs: [{ verified: true }] }],
      },
    ],
  ] as const)("fails closed for %s", (_label, override) => {
    const result = prepareAiRedlineBundle({
      ...baseInput,
      ...override,
    } as AiRedlineBundleInput);

    expect(result.ok).toBe(false);
  });

  it("fails closed when an approved review has no actionable findings", () => {
    const result = prepareAiRedlineBundle({
      ...baseInput,
      items: [baseInput.items[2]],
    });

    expect(result).toMatchObject({ ok: false, code: "no_actions" });
  });
});
