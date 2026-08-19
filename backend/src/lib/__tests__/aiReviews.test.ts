import { describe, expect, it } from "vitest";
import {
  applyAiReviewDecision,
  buildReviewItemSeeds,
  canReviewAiExecution,
  reviewCompletionError,
  type AiReviewItemState,
} from "../aiReviews";

const citations = [
  {
    citation_id: "c1",
    document_version_id: "version-1",
    page: 1,
    span: { start_char: 0, end_char: 8 },
    quote_sha256: "a".repeat(64),
    verified: true,
    finding_text: "La cláusula permite terminar el contrato.",
  },
  {
    citation_id: "c2",
    document_version_id: "version-1",
    page: 2,
    span: { start_char: 3, end_char: 12 },
    quote_sha256: "b".repeat(64),
    verified: true,
    finding_text: "El plazo de aviso es de treinta días.",
  },
];

const pendingItem: AiReviewItemState = {
  status: "pending",
  finding_text: "Hallazgo original",
  comment: null,
};

describe("AI human review rules", () => {
  it("allows only matter owners and editors to act as reviewers", () => {
    expect(canReviewAiExecution("matter_owner")).toBe(true);
    expect(canReviewAiExecution("editor")).toBe(true);
    expect(canReviewAiExecution("viewer")).toBe(false);
    expect(canReviewAiExecution("technical_operator")).toBe(false);
    expect(canReviewAiExecution(null)).toBe(false);
  });

  it("materializes one review item per verified citation and keeps finding text", () => {
    expect(
      buildReviewItemSeeds({
        output_text: "Resultado completo",
        citation_refs: citations,
      }),
    ).toEqual([
      {
        item_key: "c1",
        original_text: "La cláusula permite terminar el contrato.",
        citation_refs: [citations[0]],
      },
      {
        item_key: "c2",
        original_text: "El plazo de aviso es de treinta días.",
        citation_refs: [citations[1]],
      },
    ]);
  });

  it("keeps a citation-free output reviewable as one finding", () => {
    expect(
      buildReviewItemSeeds({
        output_text: "El documento no contiene hallazgos materiales.",
        citation_refs: [],
      }),
    ).toEqual([
      {
        item_key: "finding-1",
        original_text: "El documento no contiene hallazgos materiales.",
        citation_refs: [],
      },
    ]);
  });

  it("records the before and after state for an edited finding", () => {
    expect(
      applyAiReviewDecision(pendingItem, {
        decision: "edited",
        finding_text: "Hallazgo corregido",
        comment: "Ajusté el alcance.",
      }),
    ).toEqual({
      decision: "edited",
      before: pendingItem,
      after: {
        status: "edited",
        finding_text: "Hallazgo corregido",
        comment: "Ajusté el alcance.",
      },
    });
  });

  it("rejects an edit without non-empty finding text", () => {
    expect(() =>
      applyAiReviewDecision(pendingItem, {
        decision: "edited",
        finding_text: "  ",
        comment: null,
      }),
    ).toThrow("finding_text");
  });

  it("blocks approval for failed executions, pending items, or unverified citations", () => {
    expect(
      reviewCompletionError({
        executionStatus: "failed",
        items: [],
      }),
    ).toBe("execution_not_succeeded");
    expect(
      reviewCompletionError({
        executionStatus: "succeeded",
        items: [pendingItem],
      }),
    ).toBe("items_pending");
    expect(
      reviewCompletionError({
        executionStatus: "succeeded",
        items: [
          {
            status: "accepted",
            finding_text: "Hallazgo",
            comment: null,
            citation_refs: [{ verified: false }],
          },
        ],
      }),
    ).toBe("unverified_citation");
    expect(
      reviewCompletionError({
        executionStatus: "succeeded",
        items: [
          {
            status: "accepted",
            finding_text: "Hallazgo",
            comment: null,
            citation_refs: [{ verified: true }],
          },
        ],
      }),
    ).toBeNull();
  });
});
