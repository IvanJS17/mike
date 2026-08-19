export const AI_EXECUTION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;

export type AiExecutionStatus = (typeof AI_EXECUTION_STATUSES)[number];

const TRANSITIONS: Record<AiExecutionStatus, readonly AiExecutionStatus[]> = {
  pending: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function assertAiExecutionTransition(
  from: AiExecutionStatus,
  to: AiExecutionStatus,
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(
      `Invalid AI execution status transition: ${from} -> ${to}`,
    );
  }
}

export type MatterRole =
  | "matter_owner"
  | "editor"
  | "viewer"
  | "technical_operator"
  | null;

export function canStartAiExecution(role: MatterRole): boolean {
  return role === "matter_owner" || role === "editor" || role === "technical_operator";
}

export function canReadAiExecution(role: MatterRole): boolean {
  return role !== null;
}

export function canReviewAiExecution(role: MatterRole): boolean {
  return role === "matter_owner" || role === "editor";
}
