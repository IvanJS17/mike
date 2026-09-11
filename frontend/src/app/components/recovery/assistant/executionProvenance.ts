export type ExecutionProvenancePresentation = Readonly<{
  tenant_scope: Readonly<{
    organization_id: string;
    matter_id?: string;
    project_id?: string;
    chat_id?: string;
    document_version_id?: string;
  }>;
  input_hashes: readonly string[];
  output_hashes: readonly string[];
  citation_hashes: readonly string[];
  route: Readonly<{
    provider: string;
    model: string;
    credential_ref: string;
  }>;
  workflow: Readonly<{
    workflow_key: string;
    version: string;
    content_hash: string;
    source_commit: string;
    distribution: "default" | "addon";
    type: "assistant" | "tabular";
    source: string;
    approval_provenance: string;
  }>;
  status: "completed" | "failed";
  error_class?: string;
}>;

type RecordValue = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const WORKFLOW_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ERROR_CLASS = /^[a-z][a-z0-9_.-]*$/;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHashList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => SHA256.test(item));
}

export function parseExecutionProvenance(
  input: unknown,
): ExecutionProvenancePresentation | null {
  if (
    !isRecord(input) ||
    !hasExactKeys(
      input,
      [
        "tenant_scope",
        "input_hashes",
        "output_hashes",
        "citation_hashes",
        "route",
        "workflow",
        "status",
      ],
      ["error_class"],
    )
  ) {
    return null;
  }

  const tenantScopeInput = input.tenant_scope;
  const routeInput = input.route;
  const workflowInput = input.workflow;
  if (
    !isRecord(tenantScopeInput) ||
    !hasExactKeys(
      tenantScopeInput,
      ["organization_id"],
      ["matter_id", "project_id", "chat_id", "document_version_id"],
    ) ||
    !isNonEmptyString(tenantScopeInput.organization_id) ||
    !["matter_id", "project_id", "chat_id", "document_version_id"].every(
      (key) =>
        tenantScopeInput[key] === undefined ||
        isNonEmptyString(tenantScopeInput[key]),
    ) ||
    !isHashList(input.input_hashes) ||
    !isHashList(input.output_hashes) ||
    !isHashList(input.citation_hashes) ||
    !isRecord(routeInput) ||
    !hasExactKeys(routeInput, ["provider", "model", "credential_ref"]) ||
    !isNonEmptyString(routeInput.provider) ||
    !isNonEmptyString(routeInput.model) ||
    !isNonEmptyString(routeInput.credential_ref) ||
    !isRecord(workflowInput) ||
    !hasExactKeys(workflowInput, [
      "workflow_key",
      "version",
      "content_hash",
      "source_commit",
      "distribution",
      "type",
      "source",
      "approval_provenance",
    ]) ||
    typeof workflowInput.workflow_key !== "string" ||
    !WORKFLOW_KEY.test(workflowInput.workflow_key) ||
    !isNonEmptyString(workflowInput.version) ||
    typeof workflowInput.content_hash !== "string" ||
    !SHA256.test(workflowInput.content_hash) ||
    typeof workflowInput.source_commit !== "string" ||
    !SOURCE_COMMIT.test(workflowInput.source_commit) ||
    (workflowInput.distribution !== "default" &&
      workflowInput.distribution !== "addon") ||
    (workflowInput.type !== "assistant" && workflowInput.type !== "tabular") ||
    !isNonEmptyString(workflowInput.source) ||
    !isNonEmptyString(workflowInput.approval_provenance) ||
    (input.status !== "completed" && input.status !== "failed") ||
    (input.status === "completed" && input.error_class !== undefined) ||
    (input.status === "failed" &&
      input.error_class !== undefined &&
      (typeof input.error_class !== "string" ||
        !ERROR_CLASS.test(input.error_class)))
  ) {
    return null;
  }

  const tenantScope = Object.freeze({ ...tenantScopeInput });
  const route = Object.freeze({ ...routeInput });
  const workflow = Object.freeze({ ...workflowInput });
  return Object.freeze({
    tenant_scope: tenantScope,
    input_hashes: Object.freeze([...input.input_hashes]),
    output_hashes: Object.freeze([...input.output_hashes]),
    citation_hashes: Object.freeze([...input.citation_hashes]),
    route,
    workflow,
    status: input.status,
    ...(input.error_class === undefined
      ? {}
      : { error_class: input.error_class }),
  }) as ExecutionProvenancePresentation;
}
