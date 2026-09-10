import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovedDrivePublication } from "./ApprovedDrivePublication";

const api = vi.hoisted(() => ({ getHumanReviewState: vi.fn(), createApprovedReviewReport: vi.fn(), publishDrivePublication: vi.fn(), getDrivePublicationStatus: vi.fn(), reconcileDrivePublication: vi.fn(), isMfaRequiredError: vi.fn(() => false) }));
vi.mock("@/app/lib/mikeApi", () => api);
const review = { review_id: "00000000-0000-4000-8000-000000000001", revision: 2, execution_id: "execution-1", reviewer_user_id: "reviewer", execution_author_user_id: "author", project_id: "project-1", matter_id: "matter-1", organization_id: "org-1", document_id: "doc-1", document_version_id: "version-1", document_content_sha256: "a".repeat(64), evidence_receipt_sha256: "b".repeat(64), status: "approved", items: [{ item_id: "item-1", item_key: "finding", finding_text: "Finding", status: "accepted" }] };
const artifact = { idempotency_key: "approved-report:00000000-0000-4000-8000-000000000001:2", review_id: review.review_id, review_revision: 2, execution_id: "execution-1", organization_id: "org-1", matter_id: "matter-1", project_id: "project-1", document_id: "doc-1", document_version_id: "version-1", source_document_sha256: "a".repeat(64), evidence_receipt_sha256: "b".repeat(64), filename: "Informe de revision humana.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", artifact_sha256: "c".repeat(64) };
const status = { publication_id: "00000000-0000-4000-8000-000000000002", export_id: "00000000-0000-4000-8000-000000000003", execution_id: "execution-1", review_revision: 2, revision: 1, outcome: "uploaded", attempts: 1, approved_artifact_sha256: "c".repeat(64), provider_file_id: "drive-1", failure_code: null };
beforeEach(() => { Object.values(api).forEach((fn) => fn.mockReset()); api.isMfaRequiredError.mockReturnValue(false); api.getHumanReviewState.mockResolvedValue(review); api.createApprovedReviewReport.mockResolvedValue({ export_id: status.export_id, artifact, receipt: { disposition: "applied", review_id: review.review_id, review_revision: 2, execution_id: "execution-1", artifact_sha256: "c".repeat(64), idempotency_key: artifact.idempotency_key } }); api.publishDrivePublication.mockResolvedValue({ outcome: "uploaded", disposition: "uploaded", publication: status }); });
describe("ApprovedDrivePublication", () => {
  it("runs the approved report then publication chain once", async () => { const user = userEvent.setup(); render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" />); await user.click(await screen.findByRole("button", { name: /Publicar DOCX/ })); await waitFor(() => expect(api.publishDrivePublication).toHaveBeenCalledWith("project-1", "execution-1", status.export_id, 2)); expect(api.createApprovedReviewReport).toHaveBeenCalledTimes(1); expect(screen.getByText(/confirmada/)).toBeVisible(); });
  it("refuses an unapproved review and malformed scope", async () => { api.getHumanReviewState.mockResolvedValue({ ...review, status: "pending" }); render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" />); await waitFor(() => expect(screen.getByText(/debe estar aprobada/)).toBeVisible()); expect(screen.getByRole("button", { name: /Publicar DOCX/ })).toBeDisabled(); });
  it("reconciles an unknown persisted publication", async () => { api.getDrivePublicationStatus.mockResolvedValue({ ...status, outcome: "unknown_outcome", provider_file_id: null, failure_code: "drive_upload_outcome_unknown" }); api.reconcileDrivePublication.mockResolvedValue({ outcome: "uploaded", disposition: "replayed", publication: status }); const user = userEvent.setup(); render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" publicationId={status.publication_id} />); await user.click(await screen.findByRole("button", { name: /Reconciliar/ })); await waitFor(() => expect(api.reconcileDrivePublication).toHaveBeenCalledWith("project-1", "execution-1", status.publication_id)); expect(api.createApprovedReviewReport).not.toHaveBeenCalled(); });

  it("rejects a review from another matter before any action", async () => {
    api.getHumanReviewState.mockResolvedValue({ ...review, matter_id: "other-matter" });
    render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" />);
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Publicar DOCX/ })).toBeNull();
  });
  it("does not upload after navigation during report creation", async () => {
    let finish!: (value: unknown) => void;
    const validReport = await api.createApprovedReviewReport();
    api.createApprovedReviewReport.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    const view = render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" />);
    await user.click(await screen.findByRole("button", { name: /Publicar DOCX/ }));
    view.rerender(<ApprovedDrivePublication projectId="project-1" matterId="matter-2" executionId="execution-2" />);
    finish(validReport);
    await screen.findByRole("alert");
    expect(api.publishDrivePublication).not.toHaveBeenCalled();
  });
  it("keeps server publication lookup in URL for reload", async () => {
    const user = userEvent.setup();
    render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" />);
    await user.click(await screen.findByRole("button", { name: /Publicar DOCX/ }));
    await screen.findByText(/confirmada/);
    expect(new URL(window.location.href).searchParams.get("publicationId")).toBe(status.publication_id);
  });
  it("refuses a write acknowledgment for another committed export", async () => {
    api.publishDrivePublication.mockResolvedValue({outcome: "uploaded", disposition: "uploaded", publication: {...status, export_id: "other-export"}});
    const user = userEvent.setup();
    render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" />);
    await user.click(await screen.findByRole("button", { name: /Publicar DOCX/ }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByText(/confirmada/)).toBeNull();
  });
  it("offers reconciliation for persisted pending without a second upload", async () => {
    api.getDrivePublicationStatus.mockResolvedValue({...status, outcome: "pending", provider_file_id: null});
    render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" publicationId={status.publication_id} />);
    expect(await screen.findByRole("button", {name: /Reconciliar/})).toBeVisible();
    expect(api.publishDrivePublication).not.toHaveBeenCalled();
  });

  it("does not upload after the panel unmounts during report creation", async () => {
    const result = await api.createApprovedReviewReport();
    let finish!: (value: unknown) => void;
    api.createApprovedReviewReport.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup();
    const view = render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" />);
    await user.click(await screen.findByRole("button", {name:/Publicar DOCX/}));
    view.unmount(); finish(result);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.publishDrivePublication).not.toHaveBeenCalled();
  });
  it("rejects an empty lookup query rather than enabling a new upload", async () => {
    render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" publicationId="" />);
    expect(await screen.findByRole("alert")).toBeVisible();
  });

  it("labels the boundary fake-only even while loading", () => {
    render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" />);
    expect(screen.getByText(/sin llamadas reales a Google/i)).toBeVisible();
  });

 it.each(["publish", "reconcile"])("rejects contradictory %s acknowledgment without persisting URL", async action => {
   window.history.replaceState({}, "", "/publication-test");
   const malformed={outcome:"uploaded",disposition:"failed",publication:status};
   api.publishDrivePublication.mockResolvedValue(malformed);
   api.getDrivePublicationStatus.mockResolvedValue({...status,outcome:"unknown_outcome",provider_file_id:null,failure_code:"unknown"});
   api.reconcileDrivePublication.mockResolvedValue(malformed);
   const user=userEvent.setup();
   render(<ApprovedDrivePublication projectId="project-1" matterId="matter-1" executionId="execution-1" publicationId={action==="reconcile"?status.publication_id:null}/>);
   await user.click(await screen.findByRole("button",{name:action==="reconcile"?/Reconciliar/:/Publicar DOCX/}));
   expect(await screen.findByRole("alert")).toBeVisible();
   expect(screen.queryByText(/confirmada/)).toBeNull();
   expect(new URL(window.location.href).searchParams.get("publicationId")).toBeNull();
 });
});
