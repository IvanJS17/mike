"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createAiExecution,
  getAiExecutionOutput,
  getAiExecutionReceipt,
  type AiExecution,
  type AiOutput,
  type AiReceipt,
} from "@/app/lib/mikeApi";
import { useProjectWorkspace } from "@/app/components/projects/ProjectWorkspace";
import type { Document } from "@/app/components/shared/types";
import { LIQUID_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";

const ROUTE_PROVIDERS = ["deepseek", "openai", "claude", "gemini"] as const;

export function AiExecutionPanel({ projectId }: { projectId: string }) {
  const { project, projectLoading } = useProjectWorkspace();
  const documents = useMemo<Document[]>(
    () =>
      (project?.documents ?? []).filter(
        (document: Document) => document.status === "ready" && document.current_version_id,
      ),
    [project?.documents],
  );
  const [documentId, setDocumentId] = useState("");
  const [matterId, setMatterId] = useState("");
  const [provider, setProvider] = useState<(typeof ROUTE_PROVIDERS)[number]>(
    "deepseek",
  );
  const [model, setModel] = useState("deepseek-chat");
  const [credentialRef, setCredentialRef] = useState("deepseek:v1");
  const [execution, setExecution] = useState<AiExecution | null>(null);
  const [output, setOutput] = useState<AiOutput | null>(null);
  const [receipt, setReceipt] = useState<AiReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!documentId && documents[0]) setDocumentId(documents[0].id);
  }, [documentId, documents]);

  const selectedDocument = documents.find((document: Document) => document.id === documentId) ?? null;

  async function loadArtifacts(next: AiExecution) {
    try {
      const nextReceipt = await getAiExecutionReceipt(projectId, next.id);
      setReceipt(nextReceipt);
      if (next.status === "succeeded") {
        setOutput(await getAiExecutionOutput(projectId, next.id));
      } else {
        setOutput(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo consultar el receipt");
    }
  }

  async function startExecution() {
    if (!matterId.trim()) {
      setError("Escribe el ID del matter privado antes de iniciar.");
      return;
    }
    if (!selectedDocument?.current_version_id) {
      setError("Selecciona una versión de documento lista antes de iniciar.");
      return;
    }
    setBusy(true);
    setError(null);
    setOutput(null);
    setReceipt(null);
    try {
      const next = await createAiExecution(projectId, {
        matter_id: matterId.trim(),
        document_version_id: selectedDocument.current_version_id,
        route: { provider, model, credential_ref: credentialRef.trim() },
      });
      setExecution(next);
      await loadArtifacts(next);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "No se pudo iniciar la ejecución");
    } finally {
      setBusy(false);
    }
  }

  if (projectLoading) {
    return <div className="p-6 text-sm text-gray-500">Cargando asunto…</div>;
  }

  return (
    <main className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6" data-testid="ai-execution-panel">
      <section className={`mx-auto w-full max-w-5xl rounded-2xl p-5 ${LIQUID_PANEL_SURFACE_CLASS}`}>
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400">
              Matter privado · Beta 0.1
            </p>
            <h1 className="mt-1 text-xl font-semibold text-gray-800">Ejecución IA verificable</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
              Inicia una revisión sobre una versión exacta. La ruta provider/model/credential-reference queda fijada en el servidor; ninguna API key entra en esta pantalla.
            </p>
          </div>
          <a className="text-sm font-medium text-gray-500 underline" href={`/projects/${projectId}`}>
            Volver a documentos
          </a>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-gray-600">
            Documento / versión
            <select
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
              value={documentId}
              onChange={(event) => setDocumentId(event.target.value)}
              disabled={busy || documents.length === 0}
            >
              <option value="">Selecciona un documento</option>
              {documents.map((document: Document) => (
                <option key={document.id} value={document.id}>
                  {document.filename} · V{document.active_version_number ?? "?"}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-600">
            Matter ID (asunto privado)
            <input
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
              value={matterId}
              onChange={(event) => setMatterId(event.target.value)}
              placeholder="UUID del asunto asignado"
              disabled={busy}
            />
          </label>
          <label className="text-sm text-gray-600">
            Proveedor
            <select
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
              value={provider}
              onChange={(event) => {
                const next = event.target.value as (typeof ROUTE_PROVIDERS)[number];
                setProvider(next);
                if (next !== "deepseek") setModel(next === "openai" ? "gpt-4o-mini" : `${next}-default`);
              }}
              disabled={busy}
            >
              {ROUTE_PROVIDERS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-600">
            Modelo
            <input
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="text-sm text-gray-600 md:col-span-2">
            Referencia de credencial (no es la API key)
            <input
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
              value={credentialRef}
              onChange={(event) => setCredentialRef(event.target.value)}
              disabled={busy}
            />
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void startExecution()}
            disabled={busy || !selectedDocument}
          >
            {busy ? "Ejecutando…" : "Iniciar revisión"}
          </button>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        </div>

        {!selectedDocument && (
          <p className="mt-5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Este matter aún no tiene una versión lista para revisar.
          </p>
        )}

        {execution && (
          <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1fr]" data-testid="ai-execution-result">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h2 className="font-medium text-gray-800">Estado durable</h2>
              <dl className="mt-3 space-y-2 text-sm text-gray-600">
                <div className="flex justify-between gap-4"><dt>ID</dt><dd className="font-mono text-xs">{execution.id}</dd></div>
                <div className="flex justify-between gap-4"><dt>Estado</dt><dd className="font-medium">{execution.status}</dd></div>
                <div className="flex justify-between gap-4"><dt>Versión</dt><dd className="font-mono text-xs">{execution.document_version_id}</dd></div>
                <div className="flex justify-between gap-4"><dt>Input SHA-256</dt><dd className="max-w-[18rem] truncate font-mono text-xs">{execution.input_sha256}</dd></div>
                {execution.error_class && <div className="flex justify-between gap-4"><dt>Error</dt><dd className="text-red-600">{execution.error_class}</dd></div>}
              </dl>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h2 className="font-medium text-gray-800">Receipt</h2>
              {receipt ? (
                <>
                  <p className="mt-2 break-all font-mono text-xs text-gray-500">SHA-256: {receipt.receipt_sha256}</p>
                  <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-600">{JSON.stringify(receipt.canonical_json, null, 2)}</pre>
                </>
              ) : <p className="mt-2 text-sm text-gray-500">Consultando…</p>}
            </div>
            {output && (
              <article className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-2">
                <div className="flex flex-wrap justify-between gap-2">
                  <h2 className="font-medium text-gray-800">Output inmutable</h2>
                  <span className="font-mono text-xs text-gray-500">SHA-256: {output.output_sha256}</span>
                </div>
                <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-gray-700">{output.output_text}</div>
              </article>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
