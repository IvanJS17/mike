/**
 * Slice D — governed runtime boundary over the upstream DB-backed catalog.
 *
 * This module consumes the coordinator-owned WorkflowIdentity contract and an
 * injected read port. It performs no database, route, storage or network work.
 */

import {
  buildWorkflowIdentity,
  type WorkflowIdentity,
} from "../sharedContracts";

export const GOVERNED_WORKFLOW_CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
export const GOVERNED_WORKFLOW_SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/;
const WORKFLOW_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type GovernedWorkflowCatalogRow = WorkflowIdentity & {
  active: boolean;
};

export type WorkflowExecutionPin = Readonly<WorkflowIdentity>;

export type WorkflowCatalogReadPort = {
  getWorkflow(workflowKey: string): Promise<unknown>;
};

export type GovernedCatalogErrorKind =
  | "malformed_catalog_row"
  | "malformed_execution_pin"
  | "inactive_workflow"
  | "workflow_mismatch"
  | "catalog_dependency_failed";

type GovernedCatalogFailure = {
  ok: false;
  error: { kind: GovernedCatalogErrorKind };
};

export type GovernedCatalogRowResult =
  | { ok: true; row: Readonly<GovernedWorkflowCatalogRow> }
  | GovernedCatalogFailure;

export type WorkflowExecutionPinResult =
  | { ok: true; pin: WorkflowExecutionPin }
  | GovernedCatalogFailure;

const IDENTITY_KEYS = [
  "workflow_key",
  "version",
  "content_hash",
  "source_commit",
  "distribution",
  "type",
  "source",
  "approval_provenance",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function failure(kind: GovernedCatalogErrorKind): GovernedCatalogFailure {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ kind }),
  });
}

function identityFromUnknown(value: unknown): WorkflowIdentity | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.workflow_key !== "string" ||
    !WORKFLOW_KEY_RE.test(value.workflow_key) ||
    typeof value.version !== "string" ||
    !value.version.trim() ||
    typeof value.content_hash !== "string" ||
    !GOVERNED_WORKFLOW_CONTENT_HASH_RE.test(value.content_hash) ||
    typeof value.source_commit !== "string" ||
    !GOVERNED_WORKFLOW_SOURCE_COMMIT_RE.test(value.source_commit) ||
    (value.distribution !== "default" && value.distribution !== "addon") ||
    (value.type !== "assistant" && value.type !== "tabular") ||
    typeof value.source !== "string" ||
    !value.source.trim() ||
    typeof value.approval_provenance !== "string" ||
    !value.approval_provenance.trim()
  ) {
    return null;
  }

  try {
    return buildWorkflowIdentity({
      workflow_key: value.workflow_key,
      version: value.version,
      content_hash: value.content_hash,
      source_commit: value.source_commit,
      distribution: value.distribution,
      type: value.type,
      source: value.source,
      approval_provenance: value.approval_provenance,
    });
  } catch {
    return null;
  }
}

function freezePin(identity: WorkflowIdentity): WorkflowExecutionPin {
  return Object.freeze({
    workflow_key: identity.workflow_key,
    version: identity.version,
    content_hash: identity.content_hash,
    source_commit: identity.source_commit,
    distribution: identity.distribution,
    type: identity.type,
    source: identity.source,
    approval_provenance: identity.approval_provenance,
  });
}

export function parseGovernedWorkflowCatalogRow(
  value: unknown,
): GovernedCatalogRowResult {
  if (!isRecord(value)) {
    return failure("malformed_catalog_row");
  }
  const identity = identityFromUnknown(value);
  if (!identity || typeof value.active !== "boolean") {
    return failure("malformed_catalog_row");
  }
  return {
    ok: true,
    row: Object.freeze({ ...identity, active: value.active }),
  };
}

export function parseWorkflowExecutionPin(
  value: unknown,
): WorkflowExecutionPinResult {
  if (!isRecord(value) || !hasExactKeys(value, IDENTITY_KEYS)) {
    return failure("malformed_execution_pin");
  }
  const identity = identityFromUnknown(value);
  if (!identity) return failure("malformed_execution_pin");
  return { ok: true, pin: freezePin(identity) };
}

function sameIdentity(
  left: WorkflowIdentity,
  right: WorkflowIdentity,
): boolean {
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

export async function resolveWorkflowExecutionPin(input: {
  expected_identity: WorkflowIdentity;
  port: WorkflowCatalogReadPort;
}): Promise<WorkflowExecutionPinResult> {
  const expected = identityFromUnknown(input?.expected_identity);
  if (
    !expected ||
    !input?.port ||
    typeof input.port.getWorkflow !== "function"
  ) {
    return failure("malformed_execution_pin");
  }

  let persisted: unknown;
  try {
    persisted = await input.port.getWorkflow(expected.workflow_key);
  } catch {
    return failure("catalog_dependency_failed");
  }

  const parsed = parseGovernedWorkflowCatalogRow(persisted);
  if (!parsed.ok) return parsed;
  if (!parsed.row.active) return failure("inactive_workflow");
  if (!sameIdentity(parsed.row, expected)) return failure("workflow_mismatch");
  return { ok: true, pin: freezePin(parsed.row) };
}
