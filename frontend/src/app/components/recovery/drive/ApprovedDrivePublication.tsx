"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { LIQUID_SUBTLE_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { errorCode } from "@/app/lib/userFacingError";
import { createApprovedReviewReport, getDrivePublicationStatus, getHumanReviewState, isMfaRequiredError, publishDrivePublication, reconcileDrivePublication, type DrivePublicationStatus } from "@/app/lib/mikeApi";
import { canPublishReview, parseApprovedReport, parsePublicationReview, parsePublicationStatus, parsePublicationWrite, publicationLabel, stablePublicationIdempotencyKey, type PublicationReview } from "./publicationPresentation";

const INVALID = "La respuesta del servidor no es válida.";
const LOAD_ERROR = "La revisión aprobada no está disponible.";
const ACTION_ERROR = "No se pudo completar la publicación. Lee el estado de nuevo.";
const MFA = "Se requiere verificar MFA antes de publicar.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeError(error: unknown) { return isMfaRequiredError(error) || errorCode(error) === "mfa_required" || errorCode(error) === "mfa_verification_required" ? MFA : ACTION_ERROR; }
function rememberPublicationId(id: string) { const url = new URL(window.location.href); url.searchParams.set("publicationId", id); window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`); }

export interface ApprovedDrivePublicationProps { projectId: string; matterId: string; executionId: string; publicationId?: string | null; }
export function ApprovedDrivePublication({ projectId, matterId, executionId, publicationId }: ApprovedDrivePublicationProps) {
  const [review, setReview] = useState<PublicationReview | null>(null); const [status, setStatus] = useState<DrivePublicationStatus | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const generation = useRef(0); const busyRef = useRef(false); const lookupId = useRef(publicationId ?? null); const scopeRef = useRef("");
  const scope = `${projectId}:${matterId}:${executionId}`; scopeRef.current = scope;
  const freshRead = useCallback(() => {
    const current = ++generation.current; const lookup = lookupId.current; let active = true;
    busyRef.current = false; setBusy(false); setLoading(true); setReview(null); setStatus(null); setError(null);
    void getHumanReviewState(projectId, executionId).then(async (raw) => {
      if (!active || current !== generation.current || scopeRef.current !== scope) return;
      const parsed = parsePublicationReview(raw, projectId, matterId, executionId);
      if (!parsed) { setError(INVALID); return; } setReview(parsed);
      if (lookup === null) return;
      if (!UUID.test(lookup)) { setReview(null); setError(INVALID); return; }
      const value = await getDrivePublicationStatus(projectId, executionId, lookup);
      if (!active || current !== generation.current || scopeRef.current !== scope) return;
      const parsedStatus = parsePublicationStatus(value, parsed, lookup);
      if (!parsedStatus) { setReview(null); setError(INVALID); return; } setStatus(parsedStatus);
    }).catch((e: unknown) => { if (active && current === generation.current && scopeRef.current === scope) { setReview(null); setStatus(null); setError(safeError(e) === MFA ? MFA : LOAD_ERROR); } }).finally(() => { if (active && current === generation.current && scopeRef.current === scope) setLoading(false); });
    return () => { active = false; generation.current += 1; };
  }, [projectId, matterId, executionId, scope]);
  useEffect(() => { lookupId.current = publicationId ?? null; return freshRead(); }, [publicationId, freshRead]);

  async function act(kind: "publish" | "reconcile") {
    const current = generation.current; const currentScope = scope; const isCurrent = () => current === generation.current && scopeRef.current === currentScope;
    const lookup = lookupId.current;
    if (busyRef.current || !review || !canPublishReview(review)) return;
    if (kind === "reconcile" && (!lookup || !status || (status.outcome !== "unknown_outcome" && status.outcome !== "pending"))) return;
    if (kind === "publish" && status) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      if (kind === "reconcile") {
        const before = status!; const result = await reconcileDrivePublication(projectId, executionId, lookup!);
        if (!isCurrent()) return;
        const parsed = parsePublicationWrite(result, review, { publicationId: lookup!, previous: before });
        if (!parsed) throw new Error("invalid acknowledgment"); setStatus(parsed.publication);
      } else {
        const key = stablePublicationIdempotencyKey(review); const reportValue = await createApprovedReviewReport(projectId, executionId, review.revision, key);
        if (!isCurrent()) return;
        const report = parseApprovedReport(reportValue, review, key); if (!report) throw new Error("invalid report acknowledgment");
        const writeValue = await publishDrivePublication(projectId, executionId, report.export_id, review.revision);
        if (!isCurrent()) return;
        const parsed = parsePublicationWrite(writeValue, review, { exportId: report.export_id, artifactHash: report.artifact.artifact_sha256 });
        if (!parsed) throw new Error("invalid publication acknowledgment");
        lookupId.current = parsed.publication.publication_id; rememberPublicationId(lookupId.current); setStatus(parsed.publication);
      }
    } catch (e: unknown) { if (isCurrent()) { setReview(null); setStatus(null); setError(safeError(e)); } }
    finally { if (isCurrent()) { busyRef.current = false; setBusy(false); } }
  }

  return <main className="min-h-full px-4 py-6 md:px-8"><div className="mx-auto max-w-2xl"><header className="mb-5"><p className="mb-1 text-xs text-gray-500">Asunto</p><h1 className="font-serif text-2xl text-gray-900">Publicar DOCX aprobado</h1><p className="mt-2 text-sm text-gray-600">Recuperación con Drive simulado, sin llamadas reales a Google. La carpeta del asunto y los permisos se validan en el servidor.</p></header><section className={`${LIQUID_SUBTLE_PANEL_SURFACE_CLASS} p-5 md:p-6`} aria-busy={loading || busy}>{loading ? <div className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /><span>Cargando revisión…</span></div> : error ? <div role="alert" className="space-y-3"><p className="text-sm text-red-700">{error}</p><PillButton tone="white" size="sm" className="h-10" onClick={freshRead}>Leer de nuevo</PillButton></div> : review ? <><p className="text-sm text-gray-700">Estado de revisión: <span className="font-medium">{review.status === "approved" ? "Aprobada" : review.status === "pending" ? "Pendiente" : "Cambios solicitados"}</span></p>{!canPublishReview(review) && <p className="mt-3 text-sm text-gray-600">La revisión debe estar aprobada y sin elementos pendientes antes de publicar.</p>}{status && <p className="mt-3 text-sm text-gray-700" role="status">{publicationLabel(status)}</p>}<div className="mt-5 flex flex-wrap gap-3">{(status?.outcome === "unknown_outcome" || status?.outcome === "pending") && <PillButton tone="blue" size="sm" className="h-10" disabled={busy} onClick={() => void act("reconcile")}>Reconciliar estado</PillButton>}{!status && <PillButton tone="blue" size="sm" className="h-10" disabled={busy || !canPublishReview(review)} onClick={() => void act("publish")}>{busy ? "Publicando…" : "Publicar DOCX aprobado"}</PillButton>}</div><a className="mt-5 inline-block text-sm text-blue-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600" href={`/projects/${encodeURIComponent(projectId)}/matters/${encodeURIComponent(matterId)}/drive`}>Configurar carpeta de Drive</a></> : null}</section></div></main>;
}
