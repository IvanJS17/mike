import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  type AiReview,
  type AiReviewDrivePublication,
} from "@/app/lib/mikeApi";
import { AiReviewSection } from "./AiReviewSection";

const {
  decideAiReviewItem,
  completeAiExecutionReview,
  downloadAiReviewReport,
  exportAiReviewReport,
  getAiReviewDrivePublication,
  publishAiReviewReportToDrive,
} = vi.hoisted(() => ({
  decideAiReviewItem: vi.fn(),
  completeAiExecutionReview: vi.fn(),
  downloadAiReviewReport: vi.fn(),
  exportAiReviewReport: vi.fn(),
  getAiReviewDrivePublication: vi.fn(),
  publishAiReviewReportToDrive: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  decideAiReviewItem: (...args: unknown[]) => decideAiReviewItem(...args),
  completeAiExecutionReview: (...args: unknown[]) =>
    completeAiExecutionReview(...args),
  downloadAiReviewReport: (...args: unknown[]) =>
    downloadAiReviewReport(...args),
  exportAiReviewReport: (...args: unknown[]) => exportAiReviewReport(...args),
  getAiReviewDrivePublication: (...args: unknown[]) =>
    getAiReviewDrivePublication(...args),
  publishAiReviewReportToDrive: (...args: unknown[]) =>
    publishAiReviewReportToDrive(...args),
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

function drivePublication(
  overrides: Partial<AiReviewDrivePublication> = {},
): AiReviewDrivePublication {
  return {
    id: "publication-1",
    export_id: "export-1",
    review_id: "review-1",
    execution_id: "execution-1",
    matter_id: "matter-1",
    project_id: "project-1",
    drive_folder_id: "folder-1",
    file_id: null,
    sha256: "a".repeat(64),
    format_version: "beta-0.1",
    status: "pending",
    size_bytes: null,
    checksum: null,
    failure_code: null,
    actor_user_id: "reviewer-1",
    created_at: "2026-08-19T12:06:00.000Z",
    updated_at: "2026-08-19T12:06:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAiReviewDrivePublication.mockRejectedValue(
    new MikeApiError({
      message: "publication not found",
      status: 404,
    }),
  );
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

  it("shows the Word report download action only after approval", () => {
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
      items: [{ ...review.items[0], status: "accepted" }],
    };
    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Descargar informe Word" }),
    ).toBeEnabled();
  });

  it("rehydrates a pending publication once without starting publication", async () => {
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
    };
    getAiReviewDrivePublication.mockResolvedValue(drivePublication());

    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByTestId("drive-publication-status"),
    ).toHaveTextContent("Pendiente");
    expect(getAiReviewDrivePublication).toHaveBeenCalledTimes(1);
    expect(exportAiReviewReport).not.toHaveBeenCalled();
    expect(publishAiReviewReportToDrive).not.toHaveBeenCalled();
  });

  it("rehydrates a recoverable failed publication and exposes retry", async () => {
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
    };
    getAiReviewDrivePublication.mockResolvedValue(
      drivePublication({
        status: "failed",
        failure_code: "drive_file_invalid",
      }),
    );

    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByTestId("drive-publication-status"),
    ).toHaveTextContent("Falló");
    expect(
      screen.getByRole("button", { name: "Reintentar publicación" }),
    ).toBeInTheDocument();
    expect(publishAiReviewReportToDrive).not.toHaveBeenCalled();
  });

  it("rehydrates a terminal failed publication without retry", async () => {
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
    };
    getAiReviewDrivePublication.mockResolvedValue(
      drivePublication({
        status: "failed",
        failure_code: "drive_upload_outcome_unknown",
      }),
    );

    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByTestId("drive-publication-status"),
    ).toHaveTextContent("Falló");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo confirmar si Drive creó el archivo",
    );
    expect(
      screen.queryByRole("button", { name: "Reintentar publicación" }),
    ).not.toBeInTheDocument();
    expect(publishAiReviewReportToDrive).not.toHaveBeenCalled();
  });

  it("rehydrates a published publication and exposes only its Drive link", async () => {
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
    };
    getAiReviewDrivePublication.mockResolvedValue(
      drivePublication({ status: "published", file_id: "drive-file-1" }),
    );

    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByTestId("drive-publication-status"),
    ).toHaveTextContent("Publicado");
    expect(screen.getByRole("link", { name: "drive-file-1" })).toHaveAttribute(
      "href",
      "https://drive.google.com/open?id=drive-file-1",
    );
    expect(publishAiReviewReportToDrive).not.toHaveBeenCalled();
  });

  it("does not show publication data when rehydration is revoked", async () => {
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
    };
    getAiReviewDrivePublication.mockRejectedValue(
      new MikeApiError({
        message: "internal authorization details",
        status: 403,
        code: "authorization_revoked",
      }),
    );

    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "El acceso al matter cambió; no se publicó el informe.",
    );
    expect(
      screen.queryByTestId("drive-publication-status"),
    ).not.toBeInTheDocument();
    expect(publishAiReviewReportToDrive).not.toHaveBeenCalled();
  });

  it("exports and publishes the approved report, then exposes the Drive file link", async () => {
    const user = userEvent.setup();
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
    };
    exportAiReviewReport.mockResolvedValue({ id: "export-1" });
    publishAiReviewReportToDrive.mockResolvedValue({
      id: "publication-1",
      export_id: "export-1",
      review_id: "review-1",
      execution_id: "execution-1",
      matter_id: "matter-1",
      project_id: "project-1",
      drive_folder_id: "folder-1",
      file_id: "drive-file-1",
      sha256: "a".repeat(64),
      format_version: "beta-0.1",
      status: "published",
      size_bytes: 10,
      checksum: "checksum-1",
      failure_code: null,
      actor_user_id: "reviewer-1",
      created_at: "2026-08-19T12:06:00.000Z",
      updated_at: "2026-08-19T12:06:00.000Z",
    });

    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: "Publicar en Shared Drive" });
    await user.click(
      screen.getByRole("button", { name: "Publicar en Shared Drive" }),
    );

    await waitFor(() => {
      expect(exportAiReviewReport).toHaveBeenCalledWith(
        "project-1",
        "execution-1",
      );
      expect(publishAiReviewReportToDrive).toHaveBeenCalledWith(
        "project-1",
        "execution-1",
      );
    });
    expect(screen.getByTestId("drive-publication-status")).toHaveTextContent(
      "Publicado",
    );
    expect(screen.getByRole("link", { name: "drive-file-1" })).toHaveAttribute(
      "href",
      "https://drive.google.com/open?id=drive-file-1",
    );
  });

  it("shows a failed publication and retries through the same idempotent endpoint", async () => {
    const user = userEvent.setup();
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
    };
    exportAiReviewReport.mockResolvedValue({ id: "export-1" });
    publishAiReviewReportToDrive
      .mockResolvedValueOnce({
        id: "publication-1",
        export_id: "export-1",
        review_id: "review-1",
        execution_id: "execution-1",
        matter_id: "matter-1",
        project_id: "project-1",
        drive_folder_id: "folder-1",
        file_id: null,
        sha256: "a".repeat(64),
        format_version: "beta-0.1",
        status: "failed",
        size_bytes: null,
        checksum: null,
        failure_code: "publication_record_failed",
        actor_user_id: "reviewer-1",
        created_at: "2026-08-19T12:06:00.000Z",
        updated_at: "2026-08-19T12:06:00.000Z",
      })
      .mockResolvedValueOnce({
        id: "publication-1",
        export_id: "export-1",
        review_id: "review-1",
        execution_id: "execution-1",
        matter_id: "matter-1",
        project_id: "project-1",
        drive_folder_id: "folder-1",
        file_id: "drive-file-2",
        sha256: "a".repeat(64),
        format_version: "beta-0.1",
        status: "published",
        size_bytes: 10,
        checksum: "checksum-2",
        failure_code: null,
        actor_user_id: "reviewer-1",
        created_at: "2026-08-19T12:06:00.000Z",
        updated_at: "2026-08-19T12:07:00.000Z",
      });

    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: "Publicar en Shared Drive" });
    await user.click(
      screen.getByRole("button", { name: "Publicar en Shared Drive" }),
    );
    expect(
      await screen.findByTestId("drive-publication-status"),
    ).toHaveTextContent("Falló");
    await user.click(
      screen.getByRole("button", { name: "Reintentar publicación" }),
    );

    await waitFor(() => {
      expect(publishAiReviewReportToDrive).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId("drive-publication-status")).toHaveTextContent(
      "Publicado",
    );
  });

  it("does not offer retry for an uncertain upload publication", async () => {
    const user = userEvent.setup();
    const approved: AiReview = {
      ...review,
      status: "approved",
      completed_at: "2026-08-19T12:05:00.000Z",
    };
    exportAiReviewReport.mockResolvedValue({ id: "export-1" });
    publishAiReviewReportToDrive.mockResolvedValue({
      id: "publication-1",
      export_id: "export-1",
      review_id: "review-1",
      execution_id: "execution-1",
      matter_id: "matter-1",
      project_id: "project-1",
      drive_folder_id: "folder-1",
      file_id: null,
      sha256: "a".repeat(64),
      format_version: "beta-0.1",
      status: "failed",
      size_bytes: null,
      checksum: null,
      failure_code: "drive_upload_outcome_unknown",
      actor_user_id: "reviewer-1",
      created_at: "2026-08-19T12:06:00.000Z",
      updated_at: "2026-08-19T12:06:00.000Z",
    });

    render(
      <AiReviewSection
        projectId="project-1"
        executionId="execution-1"
        review={approved}
        currentUserId="reviewer-1"
        onReviewChange={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: "Publicar en Shared Drive" });
    await user.click(
      screen.getByRole("button", { name: "Publicar en Shared Drive" }),
    );
    expect(
      await screen.findByTestId("drive-publication-status"),
    ).toHaveTextContent("Falló");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No se pudo confirmar si Drive creó el archivo",
    );
    expect(
      screen.queryByRole("button", { name: "Reintentar publicación" }),
    ).not.toBeInTheDocument();
  });
});
