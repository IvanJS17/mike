import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiReview } from "@/app/lib/mikeApi";
import { AiReviewSection } from "./AiReviewSection";

const { decideAiReviewItem, completeAiExecutionReview } = vi.hoisted(() => ({
  decideAiReviewItem: vi.fn(),
  completeAiExecutionReview: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  decideAiReviewItem: (...args: unknown[]) => decideAiReviewItem(...args),
  completeAiExecutionReview: (...args: unknown[]) =>
    completeAiExecutionReview(...args),
}));

const review: AiReview = {
  id: "review-1",
  execution_id: "execution-1",
  matter_id: "matter-1",
  project_id: "project-1",
  reviewer_user_id: "reviewer-1",
  status: "in_progress",
  created_at: "2026-08-19T12:00:00.000Z",
  completed_at: null,
  items: [
    {
      id: "item-1",
      review_id: "review-1",
      item_key: "c1",
      original_text: "La cláusula permite terminar el contrato.",
      finding_text: "La cláusula permite terminar el contrato.",
      citation_refs: [{ citation_id: "c1", page: 1, verified: true }],
      status: "pending",
      comment: null,
      created_at: "2026-08-19T12:00:00.000Z",
      updated_at: "2026-08-19T12:00:00.000Z",
    },
  ],
  decisions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  decideAiReviewItem.mockResolvedValue({ item: review.items[0], decision: {} });
  completeAiExecutionReview.mockResolvedValue({
    ...review,
    status: "approved",
  });
});

describe("AiReviewSection", () => {
  it("shows verified citations and lets the assigned reviewer accept a finding", async () => {
    const user = userEvent.setup();
    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={review}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Cita c1 · página 1 · verificada"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Aceptar hallazgo" }));

    await waitFor(() => {
      expect(decideAiReviewItem).toHaveBeenCalledWith(
        "project-1",
        "execution-1",
        "item-1",
        { decision: "accepted", comment: null },
      );
    });
  });

  it("keeps completion controls unavailable to another member", () => {
    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={review}
        currentUserId="another-member"
        onReviewChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Revisión asignada a otro miembro"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Aprobar revisión" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Solicitar cambios" }),
    ).toBeDisabled();
  });
});
