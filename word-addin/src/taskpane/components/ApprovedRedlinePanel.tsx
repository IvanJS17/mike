import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, FileCheck2 } from "lucide-react";
import {
  getApprovedRedlineBundle,
  listAiExecutions,
  listProjects,
} from "../api/mikeApi";
import type { AiExecutionSummary } from "../api/mikeApi";
import type { Project } from "@mike/core";
import {
  prepareApprovedRedlineBundle,
  sha256Hex,
  RedlineBundleValidationError,
} from "../lib/redline";
import type { PreparedRedlineAction } from "../lib/redline";
import { useWordDoc } from "../hooks/useWordDoc";
import { Label } from "@mike/shared/ui/label";
import { Select } from "@mike/shared/ui/select";
import { Spinner } from "@mike/shared/ui/spinner";
import { PillButton } from "./assistant/PillButton";
import { EditCard } from "./assistant/EditCard";
import { EditCardsSection } from "./assistant/EditCardsSection";
import { RESPONSE_GLASS_SURFACE } from "./assistant/messageStyles";

type ActionState = "pending" | "applying" | "applied" | "omitted" | "failed";

type PreparedBundle = Awaited<
  ReturnType<typeof prepareApprovedRedlineBundle>
>;

function safeErrorMessage(error: unknown): string {
  if (error instanceof RedlineBundleValidationError) return error.message;
  if (error instanceof Error) return error.message;
  return "Mike could not open the approved redline bundle.";
}

function statusForCard(
  state: ActionState | undefined
): "pending" | "applied" | "skipped" | "failed" {
  if (state === "applied") return "applied";
  if (state === "omitted") return "skipped";
  if (state === "failed") return "failed";
  return "pending";
}

export function ApprovedRedlinePanel(): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [executions, setExecutions] = useState<AiExecutionSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [pickerLoading, setPickerLoading] = useState(false);
  const [openLoading, setOpenLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedBundle | null>(null);
  const [actionStates, setActionStates] = useState<Record<string, ActionState>>(
    {}
  );
  const [summary, setSummary] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const { readDocumentText, getDocxBlob, applyTrackedRedline } = useWordDoc();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadExecutions = async (projectId: string): Promise<void> => {
    setPickerLoading(true);
    setPickerError(null);
    setExecutions([]);
    setSelectedExecutionId("");
    try {
      const data = await listAiExecutions(projectId);
      const available = data.filter(
        (execution) =>
          execution.status === "succeeded" &&
          !!execution.matter_id &&
          !!execution.document_version_id &&
          !!execution.document_content_sha256
      );
      if (!mountedRef.current) return;
      setExecutions(available);
      if (available.length > 0) setSelectedExecutionId(available[0].id);
      if (available.length === 0) {
        setPickerError("No succeeded matter executions are available.");
      }
    } catch (error) {
      if (mountedRef.current) {
        setPickerError(safeErrorMessage(error));
      }
    } finally {
      if (mountedRef.current) setPickerLoading(false);
    }
  };

  const handleLoadPicker = async (): Promise<void> => {
    setPickerLoading(true);
    setPickerError(null);
    setOpenError(null);
    setSummary(null);
    try {
      const data = await listProjects();
      if (!mountedRef.current) return;
      setProjects(data);
      const projectId = data[0]?.id ?? "";
      setSelectedProjectId(projectId);
      if (!projectId) {
        setExecutions([]);
        setPickerError("No projects are available for approved redlines.");
        return;
      }
      await loadExecutions(projectId);
    } catch (error) {
      if (mountedRef.current) setPickerError(safeErrorMessage(error));
    } finally {
      if (mountedRef.current) setPickerLoading(false);
    }
  };

  const handleProjectChange = (projectId: string): void => {
    setSelectedProjectId(projectId);
    setPrepared(null);
    setActionStates({});
    setSummary(null);
    void loadExecutions(projectId);
  };

  const handleOpenBundle = async (): Promise<void> => {
    const execution = executions.find((item) => item.id === selectedExecutionId);
    if (!execution || !selectedProjectId) return;

    setOpenLoading(true);
    setOpenError(null);
    setSummary(null);
    setPrepared(null);
    setActionStates({});
    try {
      const [bundle, documentBlob, documentText] = await Promise.all([
        getApprovedRedlineBundle(selectedProjectId, execution.id),
        getDocxBlob(),
        readDocumentText(),
      ]);
      const documentSha256 = await sha256Hex(await documentBlob.arrayBuffer());
      const verified = await prepareApprovedRedlineBundle({
        bundle,
        execution,
        documentText,
        documentSha256,
      });
      if (!mountedRef.current) return;
      setPrepared(verified);
      setActionStates(
        Object.fromEntries(
          verified.actions.map((action) => [action.action_id, "pending"])
        )
      );
    } catch (error) {
      if (mountedRef.current) setOpenError(safeErrorMessage(error));
    } finally {
      if (mountedRef.current) setOpenLoading(false);
    }
  };

  const handleCancel = (): void => {
    setPrepared(null);
    setActionStates({});
    setBusyActionId(null);
    setOpenError(null);
    setSummary("Bundle cancelled; no pending changes were applied.");
  };

  const handleOmit = (actionId: string): void => {
    if (actionStates[actionId] !== "pending") return;
    setActionStates((current) => ({ ...current, [actionId]: "omitted" }));
  };

  const handleApply = async (action: PreparedRedlineAction): Promise<void> => {
    if (actionStates[action.action_id] !== "pending" || busyActionId !== null) return;
    setBusyActionId(action.action_id);
    setActionStates((current) => ({
      ...current,
      [action.action_id]: "applying",
    }));
    try {
      await applyTrackedRedline(action);
      if (!mountedRef.current) return;
      setActionStates((current) => ({
        ...current,
        [action.action_id]: "applied",
      }));
    } catch {
      // The Word error may contain the selected document text. Keep it out of
      // logs and the UI; the card only records that this action failed.
      if (mountedRef.current) {
        setActionStates((current) => ({
          ...current,
          [action.action_id]: "failed",
        }));
      }
    } finally {
      if (mountedRef.current) setBusyActionId(null);
    }
  };

  const actionSummary = useMemo(() => {
    if (!prepared) return null;
    let applied = 0;
    let omitted = 0;
    let failed = 0;
    let pending = 0;
    for (const action of prepared.actions) {
      const state = actionStates[action.action_id] ?? "pending";
      if (state === "applied") applied++;
      else if (state === "omitted") omitted++;
      else if (state === "failed") failed++;
      else pending++;
    }
    return `Applied ${applied}, omitted ${omitted}, failed ${failed}, pending ${pending}.`;
  }, [actionStates, prepared]);

  return (
    <section className={`flex flex-col gap-3 p-3 @sm:p-4 ${RESPONSE_GLASS_SURFACE}`}>
      <div className="flex items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gray-100/80 text-gray-500">
          <FileCheck2 className="size-4" />
        </div>
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold text-gray-900">Approved redlines</h2>
          <p className="text-xs leading-snug text-gray-500">
            Open a reviewed bundle, verify the current document, then apply each
            change one at a time.
          </p>
        </div>
      </div>

      {!projects.length && !prepared && (
        <PillButton
          tone="white"
          size="normal"
          className="w-full"
          onClick={() => void handleLoadPicker()}
          disabled={pickerLoading}
        >
          {pickerLoading ? "Loading approved redlines…" : "Load approved redlines"}
        </PillButton>
      )}

      {projects.length > 0 && !prepared && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="redline-project">Project</Label>
            <Select
              id="redline-project"
              value={selectedProjectId}
              onChange={(event) => handleProjectChange(event.target.value)}
              disabled={pickerLoading || openLoading}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approved-execution">Approved execution</Label>
            <Select
              id="approved-execution"
              value={selectedExecutionId}
              onChange={(event) => setSelectedExecutionId(event.target.value)}
              disabled={pickerLoading || openLoading || executions.length === 0}
            >
              {executions.map((execution) => (
                <option key={execution.id} value={execution.id}>
                  {execution.document_version_id} · {execution.created_at}
                </option>
              ))}
            </Select>
          </div>
          <PillButton
            tone="black"
            size="normal"
            className="w-full"
            onClick={() => void handleOpenBundle()}
            disabled={openLoading || !selectedExecutionId}
          >
            {openLoading ? "Verifying bundle…" : "Open approved bundle"}
          </PillButton>
        </>
      )}

      {prepared && (
        <EditCardsSection
          summary={`${prepared.actions.length} approved redline ${prepared.actions.length === 1 ? "action" : "actions"}`}
          status={
            <div className="flex flex-col gap-2">
              <p
                role="status"
                aria-label="Redline bundle status"
                className="text-xs font-serif text-gray-500"
              >
                {actionSummary}
              </p>
              <PillButton tone="white" onClick={handleCancel} disabled={!!busyActionId}>
                Cancel bundle
              </PillButton>
            </div>
          }
        >
          {prepared.actions.map((action, index) => {
            const state = actionStates[action.action_id] ?? "pending";
            const cardActions =
              state === "pending" || state === "applying" ? (
                <>
                  <PillButton
                    tone="black"
                    onClick={() => void handleApply(action)}
                    disabled={state === "applying" || !!busyActionId}
                  >
                    {state === "applying" ? "Applying…" : `Apply change ${index + 1}`}
                  </PillButton>
                  <PillButton
                    tone="white"
                    onClick={() => handleOmit(action.action_id)}
                    disabled={state === "applying" || !!busyActionId}
                  >
                    Omit change {index + 1}
                  </PillButton>
                </>
              ) : state === "applied" ? (
                <PillButton tone="black" disabled>
                  Apply change {index + 1}
                </PillButton>
              ) : null;
            return (
              <EditCard
                key={action.action_id}
                changeNumber={index + 1}
                edit={{
                  original: action.original,
                  replacement: action.replacement,
                }}
                status={statusForCard(state)}
                actions={cardActions}
              />
            );
          })}
        </EditCardsSection>
      )}

      {(pickerError || openError) && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{pickerError ?? openError}</span>
        </p>
      )}
      {!prepared && pickerLoading && <Spinner label="Loading approved redlines…" />}
      {!prepared && summary && (
        <p role="status" className="text-xs text-gray-500">
          {summary}
        </p>
      )}
    </section>
  );
}
