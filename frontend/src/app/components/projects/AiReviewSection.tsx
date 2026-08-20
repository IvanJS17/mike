"use client";

import { useEffect, useState } from "react";
import {
  completeAiExecutionReview,
  decideAiReviewItem,
  downloadAiReviewReport,
  exportAiReviewReport,
  getAiReviewDrivePublication,
  MikeApiError,
  publishAiReviewReportToDrive,
  type AiReview,
  type AiReviewDrivePublication,
  type AiReviewItem,
  type AiReviewReport,
} from "@/app/lib/mikeApi";

type Props = {
  projectId: string;
  executionId: string;
  review: AiReview;
  currentUserId: string | null;
  onReviewChange: (review: AiReview) => void;
};

function citationLabel(citation: Record<string, unknown>): string {
  const id =
    typeof citation.citation_id === "string" ? citation.citation_id : "cita";
  const page =
    typeof citation.page === "number" ? ` · página ${citation.page}` : "";
  const state = citation.verified === true ? "verificada" : "no verificada";
  return `Cita ${id}${page} · ${state}`;
}

function itemStateLabel(item: AiReviewItem): string {
  switch (item.status) {
    case "accepted":
      return "Aceptado";
    case "rejected":
      return "Rechazado";
    case "edited":
      return "Editado";
    default:
      return "Pendiente";
  }
}

function publicationStatusLabel(
  status: AiReviewDrivePublication["status"],
): string {
  switch (status) {
    case "pending":
      return "Pendiente";
    case "published":
      return "Publicado";
    case "failed":
      return "Falló";
  }
}

const uncertainUploadMessage =
  "No se pudo confirmar si Drive creó el archivo; esta publicación quedó bloqueada y no se puede reintentar.";

function publicationErrorMessage(error: unknown): string {
  if (!(error instanceof MikeApiError)) {
    return "No se pudo publicar el informe en Shared Drive.";
  }
  switch (error.code) {
    case "drive_folder_not_configured":
      return "Configura primero la carpeta Shared Drive del matter.";
    case "review_not_approved":
      return "Solo se puede publicar una revisión aprobada.";
    case "authorization_revoked":
      return "El acceso al matter cambió; no se publicó el informe.";
    case "drive_cleanup_failed":
      return "No se pudo confirmar la limpieza del archivo remoto; la publicación quedó bloqueada.";
    case "drive_upload_outcome_unknown":
      return uncertainUploadMessage;
    case "export_hash_mismatch":
    case "publication_integrity_failed":
      return "El informe aprobado cambió y no se puede publicar.";
    case "drive_publication_not_retryable":
      return "Esta publicación no se puede reintentar porque el estado de seguridad es terminal.";
    case "drive_publication_failed":
      return "La publicación falló. Puedes reintentar sin cambiar la carpeta.";
    default:
      return "No se pudo publicar el informe en Shared Drive.";
  }
}

function canRetryPublication(
  publication: AiReviewDrivePublication | null,
): boolean {
  return (
    publication?.status === "failed" &&
    (publication.failure_code === "drive_file_invalid" ||
      publication.failure_code === "publication_record_failed")
  );
}

function publicationFailureMessage(
  failureCode: AiReviewDrivePublication["failure_code"],
): string | null {
  switch (failureCode) {
    case "drive_upload_outcome_unknown":
      return uncertainUploadMessage;
    case "authorization_revoked":
      return "El acceso al matter cambió; no se publicó el informe.";
    case "drive_cleanup_failed":
      return "No se pudo confirmar la limpieza del archivo remoto; la publicación quedó bloqueada.";
    case "publication_failed":
      return "No se pudo publicar el informe en Shared Drive.";
    default:
      return null;
  }
}

export function AiReviewSection({
  projectId,
  executionId,
  review,
  currentUserId,
  onReviewChange,
}: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [closingComment, setClosingComment] = useState("");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [busyCompletion, setBusyCompletion] = useState(false);
  const [busyReport, setBusyReport] = useState(false);
  const [busyPublication, setBusyPublication] = useState(false);
  const [report, setReport] = useState<AiReviewReport | null>(null);
  const [publication, setPublication] =
    useState<AiReviewDrivePublication | null>(null);
  const [publicationStatus, setPublicationStatus] = useState<
    AiReviewDrivePublication["status"] | null
  >(null);
  const [publicationLoading, setPublicationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAssignedReviewer = currentUserId === review.reviewer_user_id;
  const canAct = isAssignedReviewer && review.status === "in_progress";

  useEffect(() => {
    let cancelled = false;
    setPublication(null);
    setPublicationStatus(null);
    setError(null);
    if (review.status !== "approved") {
      setPublicationLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setPublicationLoading(true);
    void getAiReviewDrivePublication(projectId, executionId)
      .then((nextPublication) => {
        if (cancelled) return;
        setPublication(nextPublication);
        setPublicationStatus(nextPublication.status);
        setError(
          nextPublication.status === "failed"
            ? publicationFailureMessage(nextPublication.failure_code)
            : null,
        );
      })
      .catch((publicationError) => {
        if (cancelled) return;
        if (
          publicationError instanceof MikeApiError &&
          publicationError.status === 404
        ) {
          return;
        }
        setError(publicationErrorMessage(publicationError));
      })
      .finally(() => {
        if (!cancelled) setPublicationLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [executionId, projectId, review.id, review.status]);

  async function decide(
    item: AiReviewItem,
    decision: "accepted" | "rejected" | "edited",
  ) {
    setBusyItemId(item.id);
    setError(null);
    try {
      const payload = {
        decision,
        ...(decision === "edited"
          ? { finding_text: drafts[item.id] ?? item.finding_text }
          : {}),
        comment: comments[item.id]?.trim() || null,
      } as {
        decision: "accepted" | "rejected" | "edited";
        finding_text?: string;
        comment: string | null;
      };
      const result = await decideAiReviewItem(
        projectId,
        executionId,
        item.id,
        payload,
      );
      onReviewChange({
        ...review,
        items: review.items.map((candidate) =>
          candidate.id === result.item.id ? result.item : candidate,
        ),
        decisions: [...review.decisions, result.decision],
      });
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : "No se pudo guardar la decisión.",
      );
    } finally {
      setBusyItemId(null);
    }
  }

  async function complete(status: "approved" | "changes_requested") {
    setBusyCompletion(true);
    setError(null);
    try {
      const completed = await completeAiExecutionReview(
        projectId,
        executionId,
        {
          status,
          comment: closingComment.trim() || null,
        },
      );
      onReviewChange(completed);
    } catch (completionError) {
      setError(
        completionError instanceof Error
          ? completionError.message
          : "No se pudo cerrar la revisión.",
      );
    } finally {
      setBusyCompletion(false);
    }
  }

  async function downloadReport() {
    if (busyReport || review.status !== "approved") return;
    setBusyReport(true);
    setError(null);
    try {
      const result = await downloadAiReviewReport(projectId, executionId);
      setReport(result.report);
      const blobUrl = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = result.filename ?? result.report.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (reportError) {
      setError(
        reportError instanceof Error
          ? reportError.message
          : "No se pudo descargar el informe Word.",
      );
    } finally {
      setBusyReport(false);
    }
  }

  async function publishReport() {
    if (busyPublication || review.status !== "approved") return;
    setBusyPublication(true);
    setError(null);
    setPublicationStatus("pending");
    try {
      if (!report) {
        const exported = await exportAiReviewReport(projectId, executionId);
        setReport(exported);
      }
      const nextPublication = await publishAiReviewReportToDrive(
        projectId,
        executionId,
      );
      setPublication(nextPublication);
      setPublicationStatus(nextPublication.status);
      setError(
        nextPublication.status === "failed"
          ? publicationFailureMessage(nextPublication.failure_code)
          : null,
      );
    } catch (publicationError) {
      if (
        publicationError instanceof MikeApiError &&
        publicationError.code === "drive_publication_failed"
      ) {
        setPublicationStatus("failed");
      } else {
        setPublicationStatus(null);
      }
      setError(publicationErrorMessage(publicationError));
    } finally {
      setBusyPublication(false);
    }
  }

  return (
    <section
      className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4"
      data-testid="ai-review-section"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-gray-800">Revisión humana</h2>
          <p className="mt-1 text-sm text-gray-600">
            Cada hallazgo conserva su cita verificada y las decisiones quedan
            auditadas.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-600">
          {review.status === "in_progress"
            ? "En curso"
            : review.status === "approved"
              ? "Aprobada"
              : "Cambios solicitados"}
        </span>
        {review.status === "approved" && (
          <>
            <button
              type="button"
              className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              onClick={() => void downloadReport()}
              disabled={busyReport || busyPublication}
            >
              {busyReport ? "Generando informe…" : "Descargar informe Word"}
            </button>
            {!publicationStatus && (
              <button
                type="button"
                className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void publishReport()}
                disabled={busyReport || busyPublication || publicationLoading}
              >
                {publicationLoading
                  ? "Consultando publicación…"
                  : "Publicar en Shared Drive"}
              </button>
            )}
          </>
        )}
      </div>

      {publicationStatus && (
        <div
          className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm"
          data-testid="drive-publication-status"
        >
          <span className="font-medium text-gray-700">
            Shared Drive: {publicationStatusLabel(publicationStatus)}
          </span>
          {publicationStatus === "published" && publication?.file_id && (
            <a
              className="font-mono text-xs text-emerald-700 underline"
              href={`https://drive.google.com/open?id=${encodeURIComponent(publication.file_id)}`}
              target="_blank"
              rel="noreferrer"
            >
              {publication.file_id}
            </a>
          )}
          {publicationStatus === "failed" &&
            canRetryPublication(publication) && (
              <button
                type="button"
                className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 disabled:opacity-50"
                onClick={() => void publishReport()}
                disabled={busyPublication}
              >
                {busyPublication ? "Reintentando…" : "Reintentar publicación"}
              </button>
            )}
        </div>
      )}

      {!isAssignedReviewer && (
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-gray-600">
          Revisión asignada a otro miembro
        </p>
      )}

      <div className="mt-4 space-y-4">
        {review.items.map((item) => {
          const itemBusy = busyItemId === item.id;
          return (
            <article
              key={item.id}
              className="rounded-lg border border-gray-200 bg-white p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-800">
                  Hallazgo {item.item_key}
                </h3>
                <span className="text-xs font-medium text-gray-500">
                  {itemStateLabel(item)}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-700">
                {item.finding_text}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {item.citation_refs.map((citation, index) => (
                  <span
                    key={`${item.id}-${index}`}
                    className={`rounded-full px-2 py-1 text-xs ${
                      citation.verified === true
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-red-50 text-red-700"
                    }`}
                  >
                    {citationLabel(citation)}
                  </span>
                ))}
              </div>
              <label className="mt-3 block text-xs font-medium text-gray-500">
                Editar hallazgo
                <textarea
                  aria-label={`Editar hallazgo ${item.item_key}`}
                  className="mt-1 min-h-20 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"
                  value={drafts[item.id] ?? item.finding_text}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [item.id]: event.target.value,
                    }))
                  }
                  disabled={!canAct || itemBusy || busyCompletion}
                />
              </label>
              <label className="mt-2 block text-xs font-medium text-gray-500">
                Comentario breve
                <textarea
                  aria-label={`Comentario del hallazgo ${item.item_key}`}
                  className="mt-1 min-h-16 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"
                  value={comments[item.id] ?? item.comment ?? ""}
                  onChange={(event) =>
                    setComments((current) => ({
                      ...current,
                      [item.id]: event.target.value,
                    }))
                  }
                  disabled={!canAct || itemBusy || busyCompletion}
                />
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                  onClick={() => void decide(item, "accepted")}
                  disabled={!canAct || itemBusy || busyCompletion}
                >
                  Aceptar hallazgo
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-rose-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                  onClick={() => void decide(item, "rejected")}
                  disabled={!canAct || itemBusy || busyCompletion}
                >
                  Rechazar hallazgo
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 disabled:opacity-40"
                  onClick={() => void decide(item, "edited")}
                  disabled={!canAct || itemBusy || busyCompletion}
                >
                  Guardar edición
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <label className="mt-4 block text-xs font-medium text-gray-500">
        Comentario de cierre
        <textarea
          aria-label="Comentario de cierre"
          className="mt-1 min-h-16 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700"
          value={closingComment}
          onChange={(event) => setClosingComment(event.target.value)}
          disabled={!canAct || busyCompletion}
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          onClick={() => void complete("approved")}
          disabled={!canAct || busyCompletion}
        >
          Aprobar revisión
        </button>
        <button
          type="button"
          className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-sm font-medium text-indigo-700 disabled:opacity-40"
          onClick={() => void complete("changes_requested")}
          disabled={!canAct || busyCompletion}
        >
          Solicitar cambios
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
