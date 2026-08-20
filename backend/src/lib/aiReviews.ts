import type { MatterRole } from "./aiExecutions";

export type AiReviewItemStatus = "pending" | "accepted" | "rejected" | "edited";
export type AiReviewDecision = Exclude<AiReviewItemStatus, "pending">;

export type AiReviewItemState = {
  status: AiReviewItemStatus;
  finding_text: string;
  comment: string | null;
  citation_refs?: unknown[];
};

export type AiReviewItemSeed = {
  item_key: string;
  original_text: string;
  citation_refs: unknown[];
};

export function canReviewAiExecution(role: MatterRole): boolean {
  return role === "matter_owner" || role === "editor";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildReviewItemSeeds(output: {
  output_text: string;
  citation_refs: unknown[];
}): AiReviewItemSeed[] {
  const citations = output.citation_refs.filter(isRecord);
  if (citations.length === 0) {
    return [
      {
        item_key: "finding-1",
        original_text: output.output_text,
        citation_refs: [],
      },
    ];
  }

  const findingTexts = citations.map((citation) =>
    nonEmptyText(citation.finding_text),
  );
  if (findingTexts.some((findingText) => findingText === null)) {
    throw new Error("citation finding_text is required");
  }

  return citations.map((citation, index) => ({
    item_key: nonEmptyText(citation.citation_id) ?? `finding-${index + 1}`,
    original_text: findingTexts[index] as string,
    citation_refs: [citation],
  }));
}

function normalizeComment(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("comment must be a string");
  const comment = value.trim();
  if (comment.length > 2000) throw new Error("comment is too long");
  return comment || null;
}

export function applyAiReviewDecision(
  before: AiReviewItemState,
  input: {
    decision: AiReviewDecision;
    finding_text?: unknown;
    comment?: unknown;
  },
): {
  decision: AiReviewDecision;
  before: AiReviewItemState;
  after: AiReviewItemState;
} {
  const comment = normalizeComment(input.comment);
  let findingText = before.finding_text;
  if (input.decision === "edited") {
    const parsed = nonEmptyText(input.finding_text);
    if (!parsed) throw new Error("finding_text must be a non-empty string");
    findingText = parsed;
  }
  return {
    decision: input.decision,
    before,
    after: {
      status: input.decision,
      finding_text: findingText,
      comment,
      ...(before.citation_refs ? { citation_refs: before.citation_refs } : {}),
    },
  };
}

export function reviewCompletionError(args: {
  executionStatus: "pending" | "running" | "succeeded" | "failed";
  items: AiReviewItemState[];
}): "execution_not_succeeded" | "items_pending" | "unverified_citation" | null {
  if (args.executionStatus !== "succeeded") return "execution_not_succeeded";
  if (
    args.items.length === 0 ||
    args.items.some((item) => item.status === "pending")
  ) {
    return "items_pending";
  }
  if (
    args.items.some((item) =>
      (item.citation_refs ?? []).some(
        (citation) => !isRecord(citation) || citation.verified !== true,
      ),
    )
  ) {
    return "unverified_citation";
  }
  return null;
}
