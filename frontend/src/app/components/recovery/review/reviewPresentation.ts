export type ReviewItemStatus = "pending" | "rejected" | "edited" | "accepted";
export type ReviewCompletionStatus = "pending" | "approved";

export type ReviewPresentation = Readonly<{
  completion_status: ReviewCompletionStatus;
  presentation_state: "pending" | "approved" | "blocked";
  reviewer_separation_required: boolean;
  citations_verified: boolean;
  items: readonly Readonly<{
    status: ReviewItemStatus;
    citation_verified: boolean;
  }>[];
  authority: "presentation_only";
}>;

type UnknownRecord = Record<string, unknown>;

const ITEM_STATUSES: readonly string[] = [
  "pending",
  "rejected",
  "edited",
  "accepted",
];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
}

export function buildReviewPresentation(
  input: unknown,
): ReviewPresentation | null {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "completion_status",
      "reviewer_separation_required",
      "items",
    ]) ||
    (input.completion_status !== "pending" &&
      input.completion_status !== "approved") ||
    typeof input.reviewer_separation_required !== "boolean" ||
    !Array.isArray(input.items)
  ) {
    return null;
  }

  const items: Array<{
    status: ReviewItemStatus;
    citation_verified: boolean;
  }> = [];
  for (const item of input.items) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["status", "citation_verified"]) ||
      typeof item.status !== "string" ||
      !ITEM_STATUSES.includes(item.status) ||
      typeof item.citation_verified !== "boolean"
    ) {
      return null;
    }
    items.push(
      Object.freeze({
        status: item.status as ReviewItemStatus,
        citation_verified: item.citation_verified,
      }),
    );
  }

  const citationsVerified =
    items.length > 0 && items.every((item) => item.citation_verified);
  const hasPendingItems = items.some((item) => item.status === "pending");
  const presentationState =
    input.completion_status === "pending"
      ? "pending"
      : hasPendingItems || !citationsVerified
        ? "blocked"
        : "approved";

  return Object.freeze({
    completion_status: input.completion_status,
    presentation_state: presentationState,
    reviewer_separation_required: input.reviewer_separation_required,
    citations_verified: citationsVerified,
    items: Object.freeze(items),
    authority: "presentation_only",
  });
}
