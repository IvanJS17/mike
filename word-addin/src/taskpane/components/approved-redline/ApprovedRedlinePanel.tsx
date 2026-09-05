import React, { useEffect, useRef, useState } from "react";
import { GlassCardUI } from "@mike/glass-card-ui";
import { PillButtonUI } from "@mike/pill-button-ui";
import { PageTitle } from "../primitives/PageTitle";
import { Spinner } from "../../../shared/ui/spinner";
import {
  listProjects, listAiExecutions, getAiReviewScope, getApprovedRedlineBundle,
  type AiExecutionSummary, type AiReviewScope,
} from "../../api/mikeApi";
import type { Project } from "../../types";
import {
  prepareApprovedRedline, canonicalApprovedRedlineJson,
  ApprovedRedlineValidationError, type PreparedApprovedRedlineAction,
} from "../../lib/approvedRedline";
import {
  readApprovedRedlineDocumentSnapshot, applyApprovedRedlineAction,
} from "../../hooks/useWordDoc";

const canonical = canonicalApprovedRedlineJson;
const fail = (code: ConstructorParameters<typeof ApprovedRedlineValidationError>[0]): never => {
  throw new ApprovedRedlineValidationError(code);
};

// Read host state synchronously: the shell's mounted identity cannot detect Save As.
// Missing URL evidence is insufficient for this bounded write flow.
function liveIdentity(shellId: string): string {
  try {
    const document = Office.context.document;
    const id: unknown = document.settings.get("mike.word.documentId.v1");
    const stored: unknown = document.settings.get("mike.word.documentUrl.v1");
    const url = document.url;
    if (id !== shellId || typeof stored !== "string" || !stored.trim() ||
        typeof url !== "string" || !url.trim()) return fail("document-identity");
    const normalize = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase();
    if (normalize(stored) !== normalize(url)) return fail("document-identity");
    return canonical({ id, stored, url });
  } catch {
    return fail("document-identity");
  }
}

function checkScope(scope: AiReviewScope, execution: AiExecutionSummary, project: string): void {
  if (execution.status !== "succeeded" || execution.project_id !== project ||
      scope.project_id !== project || scope.execution_id !== execution.id ||
      scope.matter_id !== execution.matter_id || scope.document_id !== execution.document_id ||
      scope.document_version_id !== execution.document_version_id ||
      scope.document_content_sha256 !== execution.document_content_sha256) fail("scope-mismatch");
  if (scope.status !== "approved") fail("superseded");
}

function safeMessage(error: unknown): string {
  if (error instanceof ApprovedRedlineValidationError) {
    switch (error.code) {
      case "document-identity": return "Cannot apply: Word document identity changed or is unavailable. Reopen the original saved document and reload the approved review.";
      case "superseded": return "Cannot apply: the review or bundle is no longer the approved revision. Obtain the current approved review and reload.";
      case "scope-mismatch": return "Cannot apply: project, matter, execution, or document scope does not match. Select the correct project and review.";
      case "source-mismatch": return "Cannot apply: the document version or file hash does not match. Open the reviewed source document and reload.";
      case "tampered": return "Cannot apply: the approved bundle failed its integrity check. Obtain a fresh approved bundle and reload.";
      default: return "Cannot apply: redline targets are missing, ambiguous, overlapping, or invalid. Request a new review of the current document.";
    }
  }
  return "Could not verify or apply approved redlines. Check access and the saved Word document, then reopen the panel to load a fresh review.";
}

type Loaded = {
  scope: AiReviewScope;
  execution: AiExecutionSummary;
  identity: string;
  rawCanonical: string;
  actions: readonly PreparedApprovedRedlineAction[];
};
const selectClass = "liquid-glass-subtle rounded-lg p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ApprovedRedlinePanel({ wordDocumentId }: { wordDocumentId: string }): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [executions, setExecutions] = useState<AiExecutionSummary[]>([]);
  const [executionId, setExecutionId] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [completed, setCompleted] = useState(0);
  const [busy, setBusy] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Invalidates async reads on selection changes and unmount. The ref lock also
  // prevents two clicks entering apply before React renders its disabled state.
  const generation = useRef(0);
  const applyLock = useRef(false);

  useEffect(() => {
    const ticket = ++generation.current;
    void listProjects().then((items) => {
      if (ticket !== generation.current) return;
      if (!Array.isArray(items) || items.some((item) => !item || typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string") ||
          new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Invalid projects");
      setProjects(items);
    }).catch((reason: unknown) => {
      if (ticket === generation.current) setError(safeMessage(reason));
    }).finally(() => {
      if (ticket === generation.current) setBusy(false);
    });
    return () => { generation.current += 1; };
  }, []);

  async function selectProject(id: string): Promise<void> {
    if (applyLock.current) return;
    const ticket = ++generation.current;
    setProject(id); setExecutionId(""); setExecutions([]); setLoaded(null);
    setError(null); setCompleted(0); setBusy(!!id);
    if (!id) return;
    try {
      const items = await listAiExecutions(id);
      if (ticket !== generation.current) return;
      if (new Set(items.map((item) => item.id)).size !== items.length) fail("scope-mismatch");
      setExecutions(items.filter((item) => item.status === "succeeded"));
    } catch (reason) {
      if (ticket === generation.current) setError(safeMessage(reason));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }

  async function selectExecution(id: string): Promise<void> {
    if (applyLock.current) return;
    const ticket = ++generation.current;
    setExecutionId(id); setLoaded(null); setError(null); setCompleted(0); setBusy(!!id);
    if (!id) return;
    try {
      const execution = executions.find((item) => item.id === id);
      if (!execution) return fail("scope-mismatch");
      const identity = liveIdentity(wordDocumentId);
      const [scope, raw] = await Promise.all([
        getAiReviewScope(project, id), getApprovedRedlineBundle(project, id, 1),
      ]);
      if (ticket !== generation.current) return;
      checkScope(scope, execution, project);
      if (liveIdentity(wordDocumentId) !== identity) fail("document-identity");
      const snapshot = await readApprovedRedlineDocumentSnapshot();
      if (ticket !== generation.current) return;
      const currentIdentity = liveIdentity(wordDocumentId);
      const prepared = await prepareApprovedRedline({
        bundle: raw,
        expected: {
          organization_id: scope.organization_id, matter_id: scope.matter_id,
          project_id: scope.project_id, execution_id: execution.id,
          review_id: scope.review_id, review_revision: scope.revision,
          document_id: execution.document_id, document_version_id: execution.document_version_id,
          source_document_sha256: execution.document_content_sha256, document_identity: identity,
        },
        current: {
          document_identity: currentIdentity, text: snapshot.text,
          document_sha256: snapshot.contentSha256,
          document_id: execution.document_id, document_version_id: execution.document_version_id,
        },
      });
      if (ticket !== generation.current) return;
      if (liveIdentity(wordDocumentId) !== identity) fail("document-identity");
      if (prepared.bundle.revision !== 1) fail("superseded");
      if (prepared.actions.some((action) => action.document_id !== execution.document_id ||
          action.document_version_id !== execution.document_version_id)) fail("source-mismatch");
      const actions = [...prepared.actions].sort((a, b) => b.start - a.start ||
        (a.action_id < b.action_id ? -1 : a.action_id > b.action_id ? 1 : 0));
      setLoaded({ scope, execution, identity, rawCanonical: canonical(raw), actions });
    } catch (reason) {
      if (ticket === generation.current) setError(safeMessage(reason));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }

  async function apply(index: number): Promise<void> {
    if (!loaded || error || busy || applyLock.current || index !== completed) return;
    const action = loaded.actions[index];
    if (!action) return;
    applyLock.current = true; setApplying(true);
    const ticket = generation.current;
    try {
      if (liveIdentity(wordDocumentId) !== loaded.identity) fail("document-identity");
      const [scope, raw] = await Promise.all([
        getAiReviewScope(project, loaded.execution.id),
        getApprovedRedlineBundle(project, loaded.execution.id, 1),
      ]);
      if (ticket !== generation.current) return;
      checkScope(scope, loaded.execution, project);
      if (canonical(scope) !== canonical(loaded.scope) || canonical(raw) !== loaded.rawCanonical) fail("superseded");
      if (liveIdentity(wordDocumentId) !== loaded.identity) fail("document-identity");
      // The frozen primitive owns live span/hash/unique-match/revision checks.
      await applyApprovedRedlineAction(action);
      if (ticket === generation.current) setCompleted(index + 1);
    } catch (reason) {
      if (ticket === generation.current) setError(`${safeMessage(reason)} Apply stopped; prior Word revisions remain reviewable. No retries are available in this session.`);
    } finally {
      applyLock.current = false;
      if (ticket === generation.current) setApplying(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <PageTitle>Approved redlines</PageTitle>
      <p className="text-sm text-muted-foreground">Select a project and succeeded execution. Each approved action creates a reviewable Word revision.</p>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="approved-redline-project">Project</label>
        <select id="approved-redline-project" className={selectClass} value={project} disabled={applying || (!!loaded && !!error)} onChange={(event) => void selectProject(event.target.value)}>
          <option value="">Select project</option>
          {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="approved-redline-execution">Execution</label>
        <select id="approved-redline-execution" className={selectClass} value={executionId} disabled={!project || applying || (!!loaded && !!error) || executions.length === 0} onChange={(event) => void selectExecution(event.target.value)}>
          <option value="">Select succeeded execution</option>
          {executions.map((item) => <option key={item.id} value={item.id}>{item.id} — {item.created_at}</option>)}
        </select>
      </div>
      {busy && <Spinner label="Checking approved redlines…" />}
      {!busy && project && !executions.length && !error && <p className="text-sm">No succeeded executions available.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loaded?.actions.map((action, index) => (
        <article key={action.action_id} aria-label={`Redline ${action.action_id}`}>
          <GlassCardUI>
            <div className="flex flex-col gap-2 p-3">
              <p className="text-xs text-muted-foreground">Page {action.page} · {action.action_id}</p>
              <p className="text-xs">Original</p>
              <p className="whitespace-pre-wrap break-words font-serif">{action.original}</p>
              <p className="text-xs">Replacement</p>
              <p className="whitespace-pre-wrap break-words font-serif">{action.replacement}</p>
              <p role="status" className="text-sm">{index < completed ? "Applied" : error ? "Halted" : applying && index === completed ? "Applying…" : index === completed ? "Ready" : "Pending — apply the preceding action first"}</p>
              {!error && index >= completed && <PillButtonUI tone="black" type="button" disabled={applying || index !== completed} onClick={() => void apply(index)}>Apply {action.action_id}</PillButtonUI>}
            </div>
          </GlassCardUI>
        </article>
      ))}
    </div>
  );
}
