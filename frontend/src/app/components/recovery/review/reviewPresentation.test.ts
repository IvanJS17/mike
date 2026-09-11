import { describe, expect, it } from "vitest";
import * as moduleExports from "./reviewPresentation";
import { buildReviewPresentation } from "./reviewPresentation";

function payload() {
  return {
    completion_status: "pending",
    reviewer_separation_required: true,
    items: [
      { status: "pending", citation_verified: true },
      { status: "rejected", citation_verified: true },
      { status: "edited", citation_verified: true },
      { status: "accepted", citation_verified: true },
    ],
  };
}

describe("human review presentation", () => {
  it("projects only the frozen item and completion statuses", () => {
    expect(buildReviewPresentation(payload())).toEqual({
      completion_status: "pending",
      presentation_state: "pending",
      reviewer_separation_required: true,
      citations_verified: true,
      items: [
        { status: "pending", citation_verified: true },
        { status: "rejected", citation_verified: true },
        { status: "edited", citation_verified: true },
        { status: "accepted", citation_verified: true },
      ],
      authority: "presentation_only",
    });
  });

  it("presents approval only with zero pending items and all citations verified", () => {
    const result = buildReviewPresentation({
      completion_status: "approved",
      reviewer_separation_required: true,
      items: [
        { status: "accepted", citation_verified: true },
        { status: "edited", citation_verified: true },
        { status: "rejected", citation_verified: true },
      ],
    });

    expect(result).toMatchObject({
      completion_status: "approved",
      presentation_state: "approved",
      citations_verified: true,
      reviewer_separation_required: true,
      authority: "presentation_only",
    });
    expect(result).not.toHaveProperty("reviewer_id");
    expect(result).not.toHaveProperty("legal_approval");
    expect(result).not.toHaveProperty("can_persist");
    expect(result).not.toHaveProperty("can_export");
  });

  it.each([
    ["no supplied citation flags", []],
    [
      "pending item",
      [{ status: "pending", citation_verified: true }],
    ],
    [
      "unverified citation",
      [{ status: "accepted", citation_verified: false }],
    ],
  ])("blocks a false approved presentation with %s", (_name, items) => {
    expect(
      buildReviewPresentation({
        completion_status: "approved",
        reviewer_separation_required: true,
        items,
      }),
    ).toMatchObject({
      completion_status: "approved",
      presentation_state: "blocked",
    });
  });

  it("keeps reviewer separation visible without inventing reviewer authority", () => {
    const result = buildReviewPresentation({
      completion_status: "approved",
      reviewer_separation_required: false,
      items: [{ status: "accepted", citation_verified: true }],
    });

    expect(result).toMatchObject({
      presentation_state: "approved",
      reviewer_separation_required: false,
      authority: "presentation_only",
    });
  });

  it.each([
    null,
    {},
    { ...payload(), completion_status: "rejected" },
    {
      ...payload(),
      items: [{ status: "approved", citation_verified: true }],
    },
    {
      ...payload(),
      items: [{ status: "accepted" }],
    },
    { ...payload(), reviewer_separation_required: "yes" },
    { ...payload(), reviewer_id: "invented" },
    { ...payload(), raw_error: "private" },
  ])("rejects malformed or expanded payloads %#", (input) => {
    expect(buildReviewPresentation(input)).toBeNull();
  });

  it("returns deeply immutable output", () => {
    const result = buildReviewPresentation(payload());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.items)).toBe(true);
    expect(Object.isFrozen(result?.items[0])).toBe(true);
  });

  it("locks the runtime export surface", () => {
    expect(Object.keys(moduleExports)).toEqual(["buildReviewPresentation"]);
  });
});
