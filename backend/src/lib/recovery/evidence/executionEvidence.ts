import type {
  ExecutionProvenance,
  ProviderRoute,
  WorkflowIdentity,
} from "../sharedContracts";
import { parseWorkflowExecutionPin } from "../workflows/governedWorkflowCatalog";

export const AI_EXECUTION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;

export type AiExecutionStatus = (typeof AI_EXECUTION_STATUSES)[number];
export type ExecutionEvidenceFailure = {
  ok: false;
  error_class: "invalid_execution_transition" | "invalid_execution_provenance";
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const ERROR_CLASS_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const TRANSITIONS: Record<AiExecutionStatus, readonly AiExecutionStatus[]> = {
  pending: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};
const PROVENANCE_KEYS = [
  "tenant_scope",
  "input_hashes",
  "output_hashes",
  "citation_hashes",
  "route",
  "workflow",
  "status",
] as const;
const SCOPE_KEYS = [
  "organization_id",
  "matter_id",
  "project_id",
  "chat_id",
  "document_version_id",
] as const;
const ROUTE_KEYS = ["provider", "model", "credential_ref"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function nonEmpty(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function hashes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && SHA256_RE.test(item))
  );
}

function failure(
  error_class: ExecutionEvidenceFailure["error_class"],
): ExecutionEvidenceFailure {
  return Object.freeze({ ok: false as const, error_class });
}

function freezeProvenance(value: ExecutionProvenance): ExecutionProvenance {
  return Object.freeze({
    tenant_scope: Object.freeze({ ...value.tenant_scope }),
    input_hashes: Object.freeze([...value.input_hashes]) as string[],
    output_hashes: Object.freeze([...value.output_hashes]) as string[],
    citation_hashes: Object.freeze([...value.citation_hashes]) as string[],
    route: Object.freeze({ ...value.route }),
    workflow: Object.freeze({ ...value.workflow }),
    status: value.status,
    ...(value.error_class === undefined
      ? {}
      : { error_class: value.error_class }),
  });
}

export function transitionExecutionStatus(
  from: unknown,
  to: unknown,
): { ok: true; status: AiExecutionStatus } | ExecutionEvidenceFailure {
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    !(AI_EXECUTION_STATUSES as readonly string[]).includes(from) ||
    !(AI_EXECUTION_STATUSES as readonly string[]).includes(to) ||
    !TRANSITIONS[from as AiExecutionStatus].includes(to as AiExecutionStatus)
  ) {
    return failure("invalid_execution_transition");
  }
  return Object.freeze({ ok: true as const, status: to as AiExecutionStatus });
}

export function buildExecutionProvenance(
  candidate: unknown,
): { ok: true; provenance: ExecutionProvenance } | ExecutionEvidenceFailure {
  try {
    if (!isRecord(candidate)) return failure("invalid_execution_provenance");
    const expectedKeys =
      candidate.status === "failed"
        ? [...PROVENANCE_KEYS, "error_class"]
        : PROVENANCE_KEYS;
    if (
      !hasOnlyKeys(candidate, expectedKeys) ||
      !hasExactRequiredKeys(candidate, expectedKeys)
    ) {
      return failure("invalid_execution_provenance");
    }

    const scope = candidate.tenant_scope;
    if (
      !isRecord(scope) ||
      !hasOnlyKeys(scope, SCOPE_KEYS) ||
      !hasExactRequiredKeys(scope, [
        "organization_id",
        "matter_id",
        "project_id",
        "document_version_id",
      ]) ||
      !nonEmpty(scope.organization_id) ||
      !nonEmpty(scope.matter_id) ||
      !nonEmpty(scope.project_id) ||
      !nonEmpty(scope.document_version_id) ||
      (scope.chat_id !== undefined && !nonEmpty(scope.chat_id))
    ) {
      return failure("invalid_execution_provenance");
    }

    const route = candidate.route;
    if (
      !isRecord(route) ||
      !hasOnlyKeys(route, ROUTE_KEYS) ||
      !hasExactRequiredKeys(route, ROUTE_KEYS) ||
      !nonEmpty(route.provider) ||
      !nonEmpty(route.model) ||
      !nonEmpty(route.credential_ref)
    ) {
      return failure("invalid_execution_provenance");
    }

    const workflow = parseWorkflowExecutionPin(candidate.workflow);
    if (
      !workflow.ok ||
      !hashes(candidate.input_hashes) ||
      !hashes(candidate.output_hashes) ||
      !hashes(candidate.citation_hashes)
    ) {
      return failure("invalid_execution_provenance");
    }
    if (candidate.status !== "completed" && candidate.status !== "failed") {
      return failure("invalid_execution_provenance");
    }
    if (
      (candidate.status === "completed" &&
        candidate.error_class !== undefined) ||
      (candidate.status === "failed" &&
        (typeof candidate.error_class !== "string" ||
          candidate.error_class.length > 64 ||
          !ERROR_CLASS_RE.test(candidate.error_class)))
    ) {
      return failure("invalid_execution_provenance");
    }

    const provenance: ExecutionProvenance = {
      tenant_scope: {
        organization_id: scope.organization_id,
        matter_id: scope.matter_id,
        project_id: scope.project_id,
        ...(scope.chat_id === undefined ? {} : { chat_id: scope.chat_id }),
        document_version_id: scope.document_version_id,
      },
      input_hashes: [...candidate.input_hashes],
      output_hashes: [...candidate.output_hashes],
      citation_hashes: [...candidate.citation_hashes],
      route: {
        provider: route.provider,
        model: route.model,
        credential_ref: route.credential_ref,
      } satisfies ProviderRoute,
      workflow: { ...workflow.pin } satisfies WorkflowIdentity,
      status: candidate.status,
      ...(candidate.status === "failed"
        ? { error_class: candidate.error_class as string }
        : {}),
    };
    return Object.freeze({
      ok: true as const,
      provenance: freezeProvenance(provenance),
    });
  } catch {
    return failure("invalid_execution_provenance");
  }
}
