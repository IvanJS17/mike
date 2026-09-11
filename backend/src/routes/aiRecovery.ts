import { Router } from "express";
import { createHash } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { sendInternalError } from "../lib/httpError";
import { createSupabaseTenancyReadPort } from "../lib/recovery/authorization/supabaseTenancyReadPort";
import {
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
} from "../lib/recovery/authorization/tenancyReadPort";
import type { AuthenticatedIdentity } from "../lib/recovery/identity/authStateMatrix";
import {
  createSupabaseAiReadRepository,
  createBoundEvidenceResourceScopePort,
} from "../lib/recovery/persistence/supabaseAiReadRepository";
import { createSupabaseAiPersistencePorts } from "../lib/recovery/persistence/supabaseAiPersistencePorts";
import {
  completeHumanReview,
  decideHumanReviewItem,
  createHumanReview,
  recheckHumanReviewResourceScope,
  type HumanReview,
  type HumanReviewExecution,
} from "../lib/recovery/review/humanReview";
import { produceApprovedRedlineBundle } from "../lib/recovery/review/approvedRedlineBundle";
import { produceApprovedReviewReport } from "../lib/recovery/review/approvedReviewReport";
import { approvedDocxRenderer } from "../lib/recovery/review/approvedDocxRenderer";
import {
  createApprovedArtifactPersistence,
  type ApprovedArtifactPersistenceClient,
  type ApprovedArtifactReadExpectation,
} from "../lib/recovery/persistence/approvedArtifactPersistence";
import {
  createDrivePublicationPersistence,
  type DrivePublicationIntentDto,
} from "../lib/recovery/persistence/drivePublicationPersistence";
import {
  createApprovedArtifactPublicationService,
  type ApprovedArtifactDriveTransport,
} from "../lib/recovery/drive/approvedArtifactPublication";
import type { EvidenceResourceScopePort } from "../lib/recovery/evidence/appendOnlyEvidence";
import { uploadFileIfAbsent, downloadFileStrict } from "../lib/storage";

export const aiRecoveryRouter = Router({ mergeParams: true });

const EXECUTION_COLUMNS =
  "id, project_id, evidence_version, organization_id, matter_id, document_id, document_version_id, document_content_sha256, status, error_class, created_at, started_at, finished_at";

const EXECUTION_STATUSES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
]);

const REDLINE_BUNDLE_COLUMNS =
  "id, bundle_version, revision, review_id, review_revision, execution_id, organization_id, matter_id, project_id, document_id, document_version_id, source_document_sha256, evidence_receipt_version, evidence_receipt_sha256, reviewer_user_id, actions, canonical_json, bundle_sha256";
const REDLINE_BUNDLE_KEYS = [
  "bundle_version",
  "revision",
  "review_id",
  "review_revision",
  "execution_id",
  "organization_id",
  "matter_id",
  "project_id",
  "document_id",
  "document_version_id",
  "source_document_sha256",
  "evidence_receipt_version",
  "evidence_receipt_sha256",
  "reviewer_user_id",
  "actions",
  "canonical_json",
  "bundle_sha256",
] as const;
const REDLINE_ACTION_KEYS = [
  "action_id",
  "review_item_id",
  "citation_id",
  "document_id",
  "document_version_id",
  "page",
  "start",
  "end",
  "page_content_sha256",
  "before_text_sha256",
  "replacement_text_sha256",
] as const;
const REDLINE_FULL_ACTION_KEYS = [
  ...REDLINE_ACTION_KEYS,
  "replacement_text",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isPostgresUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isValidActionIdentity(action: Record<string, unknown>): boolean {
  return (
    [
      "action_id",
      "review_item_id",
      "citation_id",
      "document_id",
      "document_version_id",
    ].every((key) => isNonEmptyString(action[key])) &&
    Number.isSafeInteger(action.page) &&
    (action.page as number) >= 1 &&
    Number.isSafeInteger(action.start) &&
    (action.start as number) >= 0 &&
    Number.isSafeInteger(action.end) &&
    (action.end as number) > (action.start as number) &&
    isSha256(action.page_content_sha256) &&
    isSha256(action.before_text_sha256) &&
    isSha256(action.replacement_text_sha256)
  );
}

function isIntegrityValid(
  row: Record<string, unknown>,
  projectId: string,
  executionId: string,
  requestedRevision: number,
): boolean {
  if (
    !hasExactKeys(row, ["id", ...REDLINE_BUNDLE_KEYS]) ||
    !isNonEmptyString(row.id)
  )
    return false;
  if (
    row.bundle_version !== "approved-redline-v1" ||
    row.execution_id !== executionId ||
    row.project_id !== projectId ||
    row.revision !== requestedRevision ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    !Number.isSafeInteger(row.review_revision) ||
    (row.review_revision as number) < 1 ||
    row.evidence_receipt_version !== "evidence-v1" ||
    ![
      "review_id",
      "organization_id",
      "matter_id",
      "document_id",
      "document_version_id",
      "reviewer_user_id",
    ].every((key) => isNonEmptyString(row[key])) ||
    !isSha256(row.source_document_sha256) ||
    !isSha256(row.evidence_receipt_sha256) ||
    !isSha256(row.bundle_sha256) ||
    typeof row.canonical_json !== "string" ||
    !Array.isArray(row.actions)
  )
    return false;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.canonical_json);
    if (!isRecord(parsed)) return false;
    body = parsed;
  } catch {
    return false;
  }
  if (
    !hasExactKeys(
      body,
      REDLINE_BUNDLE_KEYS.filter(
        (key) => key !== "canonical_json" && key !== "bundle_sha256",
      ),
    ) ||
    canonical(body) !== row.canonical_json ||
    sha256(row.canonical_json) !== row.bundle_sha256
  )
    return false;
  for (const key of REDLINE_BUNDLE_KEYS.filter(
    (item) =>
      item !== "actions" &&
      item !== "canonical_json" &&
      item !== "bundle_sha256",
  )) {
    if (row[key] !== body[key]) return false;
  }
  if (
    !Array.isArray(body.actions) ||
    body.actions.length !== row.actions.length ||
    body.actions.length === 0
  )
    return false;
  const canonicalById = new Map<string, Record<string, unknown>>();
  for (const action of body.actions) {
    if (
      !isRecord(action) ||
      !hasExactKeys(action, REDLINE_ACTION_KEYS) ||
      !isValidActionIdentity(action) ||
      canonicalById.has(action.action_id as string)
    )
      return false;
    canonicalById.set(action.action_id as string, action);
  }
  const seen = new Set<string>();
  for (const action of row.actions) {
    if (
      !isRecord(action) ||
      !hasExactKeys(action, REDLINE_FULL_ACTION_KEYS) ||
      !isValidActionIdentity(action) ||
      seen.has(action.action_id as string)
    )
      return false;
    const identity = canonicalById.get(action.action_id as string);
    if (
      !identity ||
      REDLINE_ACTION_KEYS.some((key) => action[key] !== identity[key]) ||
      typeof action.replacement_text !== "string" ||
      !isSha256(action.replacement_text_sha256) ||
      sha256(action.replacement_text) !== action.replacement_text_sha256
    )
      return false;
    seen.add(action.action_id as string);
  }
  return seen.size === canonicalById.size;
}

function publicRedlineBundle(row: Record<string, unknown>) {
  return {
    bundle_version: row.bundle_version,
    revision: row.revision,
    review_id: row.review_id,
    review_revision: row.review_revision,
    execution_id: row.execution_id,
    organization_id: row.organization_id,
    matter_id: row.matter_id,
    project_id: row.project_id,
    document_id: row.document_id,
    document_version_id: row.document_version_id,
    source_document_sha256: row.source_document_sha256,
    evidence_receipt_version: row.evidence_receipt_version,
    evidence_receipt_sha256: row.evidence_receipt_sha256,
    reviewer_user_id: row.reviewer_user_id,
    actions: row.actions,
    canonical_json: row.canonical_json,
    bundle_sha256: row.bundle_sha256,
  };
}

function opaqueNotFound(res: import("express").Response) {
  return res.status(404).json({ code: "not_found", detail: "Not found." });
}

function publicDrivePublication(intent: DrivePublicationIntentDto) {
  return {
    publication_id: intent.publication_id,
    export_id: intent.export_id,
    execution_id: intent.execution_id,
    review_revision: intent.review_revision,
    revision: intent.revision,
    outcome: intent.outcome,
    attempts: intent.attempts,
    approved_artifact_sha256: intent.approved_artifact_sha256,
    provider_file_id: intent.provider_file_id ?? null,
    failure_code: intent.failure_code,
  };
}

const APPROVED_ARTIFACT_EXPORT_COLUMNS =
  "id,idempotency_key,review_id,review_revision,execution_id,organization_id,matter_id,project_id,source_document_id,source_document_version_id,artifact_document_id,artifact_document_version_id,source_document_sha256,evidence_receipt_sha256,filename,mime_type,artifact_sha256,storage_path,size_bytes";
const APPROVED_ARTIFACT_EXPORT_KEYS =
  APPROVED_ARTIFACT_EXPORT_COLUMNS.split(",");
const DRIVE_PUBLICATION_OUTCOMES = [
  "pending",
  "uploaded",
  "unknown_outcome",
  "reconciled",
  "failed",
] as const;
const DRIVE_PUBLICATION_DISPOSITIONS = [
  "uploaded",
  "replayed",
  "reconciled",
  "failed",
  "unknown_outcome",
] as const;

function isFakeDriveTransport(
  value: unknown,
): value is ApprovedArtifactDriveTransport {
  return (
    isRecord(value) &&
    value.kind === "fake" &&
    value.host === "fake" &&
    typeof value.upload === "function" &&
    typeof value.find === "function"
  );
}

function isApprovedArtifactExportRow(
  value: unknown,
  input: {
    export_id: string;
    project_id: string;
    execution_id: string;
    review_revision: number;
    execution: HumanReviewExecution;
  },
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, APPROVED_ARTIFACT_EXPORT_KEYS))
    return false;
  return (
    value.id === input.export_id &&
    value.project_id === input.project_id &&
    value.execution_id === input.execution_id &&
    value.review_revision === input.review_revision &&
    value.organization_id === input.execution.organization_id &&
    value.matter_id === input.execution.matter_id &&
    value.source_document_id === input.execution.document_id &&
    value.source_document_version_id === input.execution.document_version_id &&
    value.source_document_sha256 === input.execution.document_content_sha256 &&
    value.evidence_receipt_sha256 === input.execution.evidence_receipt_sha256 &&
    isPostgresUuid(value.id) &&
    isPostgresUuid(value.review_id) &&
    isPostgresUuid(value.execution_id) &&
    isPostgresUuid(value.organization_id) &&
    isPostgresUuid(value.matter_id) &&
    isPostgresUuid(value.project_id) &&
    isPostgresUuid(value.source_document_id) &&
    isPostgresUuid(value.source_document_version_id) &&
    isPostgresUuid(value.artifact_document_id) &&
    isPostgresUuid(value.artifact_document_version_id) &&
    isSha256(value.source_document_sha256) &&
    isSha256(value.evidence_receipt_sha256) &&
    isSha256(value.artifact_sha256) &&
    isNonEmptyString(value.idempotency_key) &&
    isNonEmptyString(value.filename) &&
    isNonEmptyString(value.mime_type) &&
    isNonEmptyString(value.storage_path) &&
    Number.isSafeInteger(value.review_revision) &&
    (value.review_revision as number) >= 1 &&
    Number.isSafeInteger(value.size_bytes) &&
    (value.size_bytes as number) > 0 &&
    value.storage_path ===
      `orgs/${value.organization_id}/matters/${value.matter_id}/projects/${value.project_id}/documents/${value.artifact_document_id}/${value.artifact_sha256}.docx`
  );
}

function publicationIntentMatchesAuthorizedContext(
  value: unknown,
  input: {
    publication_id?: string;
    export_id?: string;
    review_revision?: number;
    project_id: string;
    execution: HumanReviewExecution;
    identity: AuthenticatedIdentity;
    authorization_epoch: number;
  },
): value is DrivePublicationIntentDto {
  if (!isRecord(value)) return false;
  return (
    (input.publication_id === undefined ||
      value.publication_id === input.publication_id) &&
    (input.export_id === undefined || value.export_id === input.export_id) &&
    (input.review_revision === undefined ||
      value.review_revision === input.review_revision) &&
    value.execution_id === input.execution.execution_id &&
    value.project_id === input.project_id &&
    value.organization_id === input.execution.organization_id &&
    value.matter_id === input.execution.matter_id &&
    value.actor_user_id === input.identity.user_id &&
    value.authorization_epoch === input.authorization_epoch &&
    isPostgresUuid(value.publication_id) &&
    isPostgresUuid(value.export_id) &&
    isPostgresUuid(value.review_id) &&
    isPostgresUuid(value.execution_id) &&
    isPostgresUuid(value.matter_id) &&
    isPostgresUuid(value.project_id) &&
    isPostgresUuid(value.organization_id) &&
    isPostgresUuid(value.actor_user_id) &&
    isPostgresUuid(value.artifact_document_id) &&
    isPostgresUuid(value.artifact_document_version_id) &&
    isPostgresUuid(value.source_document_id) &&
    isPostgresUuid(value.source_document_version_id) &&
    value.source_document_id === input.execution.document_id &&
    value.source_document_version_id === input.execution.document_version_id &&
    Number.isSafeInteger(value.authorization_epoch) &&
    (value.authorization_epoch as number) >= 0 &&
    Number.isSafeInteger(value.review_revision) &&
    (value.review_revision as number) >= 1 &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    Number.isSafeInteger(value.attempts) &&
    (value.attempts as number) >= 1 &&
    (value.attempts as number) <= 3 &&
    typeof value.outcome === "string" &&
    (DRIVE_PUBLICATION_OUTCOMES as readonly unknown[]).includes(
      value.outcome,
    ) &&
    isSha256(value.approved_artifact_sha256) &&
    isNonEmptyString(value.artifact_storage_path) &&
    value.artifact_storage_path ===
      `orgs/${value.organization_id}/matters/${value.matter_id}/projects/${value.project_id}/documents/${value.artifact_document_id}/${value.approved_artifact_sha256}.docx` &&
    isNonEmptyString(value.matter_folder_id) &&
    isNonEmptyString(value.idempotency_key) &&
    Number.isSafeInteger(value.artifact_size_bytes) &&
    (value.artifact_size_bytes as number) > 0
  );
}

function isApprovedArtifactPublicationResult(
  value: unknown,
  input: Parameters<typeof publicationIntentMatchesAuthorizedContext>[1],
): value is {
  disposition: (typeof DRIVE_PUBLICATION_DISPOSITIONS)[number];
  outcome: (typeof DRIVE_PUBLICATION_OUTCOMES)[number];
  intent: DrivePublicationIntentDto;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["disposition", "outcome", "intent"])
  )
    return false;
  return (
    (DRIVE_PUBLICATION_DISPOSITIONS as readonly unknown[]).includes(
      value.disposition,
    ) &&
    (DRIVE_PUBLICATION_OUTCOMES as readonly unknown[]).includes(
      value.outcome,
    ) &&
    value.outcome ===
      (isRecord(value.intent) ? value.intent.outcome : undefined) &&
    publicationIntentMatchesAuthorizedContext(value.intent, input)
  );
}

function publicationScopeMatchesExecution(
  scope: {
    user_id: string;
    organization_id: string;
    matter_id: string;
    project_id?: string;
  },
  identity: AuthenticatedIdentity,
  execution: HumanReviewExecution,
  projectId: string,
): boolean {
  return (
    scope.user_id === identity.user_id &&
    scope.organization_id === execution.organization_id &&
    scope.matter_id === execution.matter_id &&
    execution.project_id === projectId &&
    (scope.project_id === undefined || scope.project_id === projectId)
  );
}

function createDriveWriteRevalidator(input: {
  context: Parameters<typeof publicationIntentMatchesAuthorizedContext>[1];
  scope: Parameters<typeof recheckFreshAccessViaPort>[1]["scope"];
  tenancy: ReturnType<typeof createSupabaseTenancyReadPort>;
  repository: ReturnType<typeof createSupabaseAiReadRepository>;
  resources: EvidenceResourceScopePort;
}) {
  return async ({
    intent,
  }: {
    phase: "before_upload" | "before_record_outcome";
    intent: DrivePublicationIntentDto;
  }): Promise<boolean> => {
    try {
      if (!publicationIntentMatchesAuthorizedContext(intent, input.context))
        return false;
      const current = await input.repository.loadExecutionEvidence({
        project_id: input.context.project_id,
        execution_id: input.context.execution.execution_id,
      });
      if (!current) return false;
      for (const key of [
        "execution_id",
        "organization_id",
        "matter_id",
        "project_id",
        "document_id",
        "document_version_id",
        "document_content_sha256",
        "evidence_receipt_sha256",
      ] as const) {
        if (current.execution[key] !== input.context.execution[key])
          return false;
      }
      if (!(await drivePublicationResourceMatches(input.resources, intent)))
        return false;
      // This is the last awaited read: revocation during resource I/O must win.
      const fresh = await recheckFreshAccessViaPort(input.tenancy, {
        scope: input.scope,
        identity: input.context.identity,
        requiresMfa: true,
      });
      return (
        fresh.kind !== "authorization_dependency_failed" && fresh.result.fresh
      );
    } catch {
      return false;
    }
  };
}

function drivePublicationUnavailable(res: import("express").Response) {
  return res.status(503).json({
    code: "drive_publication_unavailable",
    detail: "Drive publication unavailable.",
  });
}

async function drivePublicationResourceMatches(
  port: EvidenceResourceScopePort,
  intent: DrivePublicationIntentDto,
): Promise<boolean> {
  const resource = await port.getEvidenceResourceScope({
    document_version_id: intent.artifact_document_version_id,
  });
  return (
    isRecord(resource) &&
    resource.organization_id === intent.organization_id &&
    resource.matter_id === intent.matter_id &&
    resource.project_id === intent.project_id &&
    resource.document_id === intent.artifact_document_id &&
    resource.document_version_id === intent.artifact_document_version_id &&
    resource.document_content_sha256 === intent.approved_artifact_sha256
  );
}

function isValidExecutionRow(
  row: unknown,
  projectId: string,
): row is {
  id: string;
  project_id: string;
  organization_id: string;
  matter_id: string;
  document_id: string;
  document_version_id: string;
  document_content_sha256: string;
  status: string;
  error_class: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
} {
  if (!isRecord(row)) return false;
  return (
    isNonEmptyString(row.id) &&
    row.project_id === projectId &&
    row.evidence_version === "evidence-v1" &&
    isNonEmptyString(row.organization_id) &&
    isNonEmptyString(row.matter_id) &&
    isNonEmptyString(row.document_id) &&
    isNonEmptyString(row.document_version_id) &&
    isSha256(row.document_content_sha256) &&
    typeof row.status === "string" &&
    EXECUTION_STATUSES.has(row.status) &&
    isNullableString(row.error_class) &&
    isNonEmptyString(row.created_at) &&
    isNullableString(row.started_at) &&
    isNullableString(row.finished_at)
  );
}

function toSummary(row: {
  id: string;
  project_id: string;
  matter_id: string;
  document_id: string;
  document_version_id: string;
  document_content_sha256: string;
  status: string;
  error_class: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}) {
  return {
    id: row.id,
    project_id: row.project_id,
    matter_id: row.matter_id,
    document_id: row.document_id,
    document_version_id: row.document_version_id,
    document_content_sha256: row.document_content_sha256,
    status: row.status,
    error_class: row.error_class,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

aiRecoveryRouter.get("/", requireAuth, async (req, res) => {
  const projectId = req.params.projectId;
  const identity = res.locals.authenticatedIdentity as
    | AuthenticatedIdentity
    | undefined;

  try {
    if (!isNonEmptyString(projectId) || !identity) {
      throw new Error("invalid authenticated request");
    }

    const db = createServerSupabase();
    const { data, error } = await db
      .from("ai_executions")
      .select(EXECUTION_COLUMNS)
      .eq("project_id", projectId)
      .eq("evidence_version", "evidence-v1")
      .order("created_at", { ascending: false });

    if (error || !Array.isArray(data)) {
      throw new Error("AI execution listing query failed");
    }

    const tenancyReadPort = createSupabaseTenancyReadPort(db);
    const executions = [];
    for (const candidate of data) {
      if (!isValidExecutionRow(candidate, projectId)) continue;

      const access = await evaluateInitialAccess(tenancyReadPort, {
        identity,
        organization_id: candidate.organization_id,
        matter_id: candidate.matter_id,
        requiresMfa: false,
      });

      if (access.kind === "authorization_dependency_failed") {
        throw new Error("AI execution authorization failed");
      }
      if (access.decision.outcome !== "allow") continue;
      executions.push(toSummary(candidate));
    }

    return res.json(executions);
  } catch (error) {
    return sendInternalError(res, error);
  }
});

aiRecoveryRouter.get("/:executionId/review", requireAuth, async (req, res) => {
  const projectId = req.params.projectId;
  const executionId = req.params.executionId;
  const identity = res.locals.authenticatedIdentity as
    | AuthenticatedIdentity
    | undefined;
  try {
    if (
      !isNonEmptyString(projectId) ||
      !isNonEmptyString(executionId) ||
      !identity
    )
      throw new Error("invalid authenticated request");
    const db = createServerSupabase();
    const repository = createSupabaseAiReadRepository(db);
    const evidence = await repository.loadExecutionEvidence({
      project_id: projectId,
      execution_id: executionId,
    });
    if (!evidence) return opaqueNotFound(res);
    const tenancyReadPort = createSupabaseTenancyReadPort(db);
    const access = await evaluateInitialAccess(tenancyReadPort, {
      identity,
      organization_id: evidence.execution.organization_id,
      matter_id: evidence.execution.matter_id,
      requiresMfa: false,
    });
    if (access.kind === "authorization_dependency_failed")
      throw new Error("AI review authorization failed");
    if (access.decision.outcome !== "allow") return opaqueNotFound(res);
    const review = await repository.loadReview({
      project_id: projectId,
      execution_id: executionId,
    });
    if (!review) return opaqueNotFound(res);
    return res.json(review);
  } catch (error) {
    return sendInternalError(res, error);
  }
});

aiRecoveryRouter.get(
  "/:executionId/review/drive-publications/:publicationId",
  requireAuth,
  async (req, res) => {
    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const publicationId = req.params.publicationId;
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    if (
      !isPostgresUuid(projectId) ||
      !isPostgresUuid(executionId) ||
      !isPostgresUuid(publicationId) ||
      !identity
    )
      return res.status(400).json({
        code: "invalid_drive_publication",
        detail: "Invalid Drive publication.",
      });

    try {
      const db = createServerSupabase();
      const repository = createSupabaseAiReadRepository(db);
      const evidence = await repository.loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      });
      if (!evidence) return opaqueNotFound(res);

      const tenancyPort = createSupabaseTenancyReadPort(db);
      const access = await evaluateInitialAccess(tenancyPort, {
        identity,
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        requiresMfa: true,
      });
      if (access.kind === "authorization_dependency_failed")
        throw new Error("AI Drive publication authorization failed");
      if (access.decision.outcome === "denied") {
        if (access.decision.code === "mfa_required")
          return res
            .status(403)
            .json({ code: "mfa_required", detail: "MFA required." });
        return opaqueNotFound(res);
      }
      if (access.decision.outcome !== "allow") return opaqueNotFound(res);

      const grantedScope = access.decision.scope;
      const persistence = createDrivePublicationPersistence({
        client: db,
        context: {
          actor_user_id: identity.user_id,
          organization_id: grantedScope.organization_id,
          authorization_epoch: grantedScope.authorization_epoch,
        },
      });
      const result = await persistence.read(publicationId);
      if (!result) return opaqueNotFound(res);
      if ("disposition" in result) return opaqueNotFound(res);

      const intent = result;
      if (
        intent.publication_id !== publicationId ||
        intent.execution_id !== executionId ||
        intent.execution_id !== evidence.execution.execution_id ||
        intent.project_id !== projectId ||
        intent.project_id !== evidence.execution.project_id ||
        intent.organization_id !== evidence.execution.organization_id ||
        intent.matter_id !== evidence.execution.matter_id
      )
        return opaqueNotFound(res);

      const resourceScopePort = createBoundEvidenceResourceScopePort(db, {
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        project_id: projectId,
      });
      if (!(await drivePublicationResourceMatches(resourceScopePort, intent)))
        return opaqueNotFound(res);
      const fresh = await recheckFreshAccessViaPort(tenancyPort, {
        scope: grantedScope,
        identity,
        requiresMfa: true,
      });
      if (fresh.kind === "authorization_dependency_failed")
        throw new Error("AI Drive publication fresh authorization failed");
      if (!fresh.result.fresh) return opaqueNotFound(res);

      return res.json(publicDrivePublication(intent));
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

aiRecoveryRouter.post(
  "/:executionId/review/drive-publications",
  requireAuth,
  async (req, res) => {
    const received = req.body;
    const body = isRecord(received) ? { ...received } : received;
    if (
      !isRecord(body) ||
      !hasExactKeys(body, ["export_id", "expected_review_revision"]) ||
      !isPostgresUuid(body.export_id) ||
      !Number.isSafeInteger(body.expected_review_revision) ||
      (body.expected_review_revision as number) < 1
    )
      return res.status(400).json({
        code: "invalid_drive_publication",
        detail: "Invalid Drive publication.",
      });

    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const exportId = body.export_id as string;
    const expectedReviewRevision = body.expected_review_revision as number;
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    if (!isPostgresUuid(projectId) || !isPostgresUuid(executionId) || !identity)
      return res.status(400).json({
        code: "invalid_drive_publication",
        detail: "Invalid Drive publication.",
      });

    try {
      const db = createServerSupabase();
      const repository = createSupabaseAiReadRepository(db);
      const evidence = await repository.loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      });
      if (!evidence || evidence.execution.execution_id !== executionId)
        return opaqueNotFound(res);

      const tenancyPort = createSupabaseTenancyReadPort(db);
      const access = await evaluateInitialAccess(tenancyPort, {
        identity,
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        requiresMfa: true,
      });
      if (access.kind === "authorization_dependency_failed")
        throw new Error("AI Drive publication authorization failed");
      if (access.decision.outcome === "not_found") return opaqueNotFound(res);
      if (access.decision.outcome === "denied") {
        if (access.decision.code === "mfa_required")
          return res
            .status(403)
            .json({ code: "mfa_required", detail: "MFA required." });
        return res.status(403).json({
          code: "authorization_revoked",
          detail: "Authorization revoked.",
        });
      }
      const grantedScope = access.decision.scope;
      if (
        !publicationScopeMatchesExecution(
          grantedScope,
          identity,
          evidence.execution,
          projectId,
        )
      )
        return opaqueNotFound(res);

      const exportResult = await db
        .from("ai_review_exports")
        .select(APPROVED_ARTIFACT_EXPORT_COLUMNS)
        .eq("id", exportId)
        .eq("project_id", projectId)
        .eq("execution_id", executionId)
        .maybeSingle();
      if (exportResult.error)
        throw new Error("AI approved artifact query failed");
      const receivedExport = exportResult.data;
      const exportRow = isRecord(receivedExport)
        ? { ...receivedExport }
        : receivedExport;
      if (
        !isApprovedArtifactExportRow(exportRow, {
          export_id: exportId,
          project_id: projectId,
          execution_id: executionId,
          review_revision: expectedReviewRevision,
          execution: evidence.execution,
        })
      )
        return opaqueNotFound(res);

      const transport = req.app.locals.recoveryDriveTransport;
      if (!isFakeDriveTransport(transport))
        return drivePublicationUnavailable(res);

      const resourceScopePort = createBoundEvidenceResourceScopePort(db, {
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        project_id: projectId,
      });
      const revalidateAuthorization = createDriveWriteRevalidator({
        context: {
          export_id: exportId,
          review_revision: expectedReviewRevision,
          project_id: projectId,
          execution: evidence.execution,
          identity,
          authorization_epoch: grantedScope.authorization_epoch,
        },
        scope: grantedScope,
        tenancy: tenancyPort,
        repository,
        resources: resourceScopePort,
      });
      const persistence = createDrivePublicationPersistence({
        client: db,
        context: {
          actor_user_id: identity.user_id,
          organization_id: grantedScope.organization_id,
          authorization_epoch: grantedScope.authorization_epoch,
        },
      });
      const service = createApprovedArtifactPublicationService({
        persistence,
        storage: { getStrict: (key: string) => downloadFileStrict(key) },
        transport,
        revalidateAuthorization,
      });
      const result = await service.publish({
        export_id: exportId,
        review_revision: expectedReviewRevision,
      });
      if (
        !isApprovedArtifactPublicationResult(result, {
          export_id: exportId,
          review_revision: expectedReviewRevision,
          project_id: projectId,
          execution: evidence.execution,
          identity,
          authorization_epoch: grantedScope.authorization_epoch,
        })
      )
        throw new Error("AI Drive publication result mismatch");
      if (
        !(await revalidateAuthorization({
          phase: "before_record_outcome",
          intent: result.intent,
        }))
      )
        return res.status(403).json({
          code: "authorization_revoked",
          detail: "Authorization revoked.",
        });
      return res.status(result.disposition === "uploaded" ? 201 : 200).json({
        outcome: result.outcome,
        disposition: result.disposition,
        publication: publicDrivePublication(result.intent),
      });
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

aiRecoveryRouter.post(
  "/:executionId/review/drive-publications/:publicationId/reconcile",
  requireAuth,
  async (req, res) => {
    const received = req.body;
    const body = isRecord(received) ? { ...received } : received;
    if (!isRecord(body) || !hasExactKeys(body, []))
      return res.status(400).json({
        code: "invalid_drive_publication",
        detail: "Invalid Drive publication.",
      });

    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const publicationId = req.params.publicationId;
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    if (
      !isPostgresUuid(projectId) ||
      !isPostgresUuid(executionId) ||
      !isPostgresUuid(publicationId) ||
      !identity
    )
      return res.status(400).json({
        code: "invalid_drive_publication",
        detail: "Invalid Drive publication.",
      });

    try {
      const db = createServerSupabase();
      const repository = createSupabaseAiReadRepository(db);
      const evidence = await repository.loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      });
      if (!evidence || evidence.execution.execution_id !== executionId)
        return opaqueNotFound(res);
      const tenancyPort = createSupabaseTenancyReadPort(db);
      const access = await evaluateInitialAccess(tenancyPort, {
        identity,
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        requiresMfa: true,
      });
      if (access.kind === "authorization_dependency_failed")
        throw new Error("AI Drive publication authorization failed");
      if (access.decision.outcome === "not_found") return opaqueNotFound(res);
      if (access.decision.outcome === "denied") {
        if (access.decision.code === "mfa_required")
          return res
            .status(403)
            .json({ code: "mfa_required", detail: "MFA required." });
        return res.status(403).json({
          code: "authorization_revoked",
          detail: "Authorization revoked.",
        });
      }
      const grantedScope = access.decision.scope;
      if (
        !publicationScopeMatchesExecution(
          grantedScope,
          identity,
          evidence.execution,
          projectId,
        )
      )
        return opaqueNotFound(res);

      const persistence = createDrivePublicationPersistence({
        client: db,
        context: {
          actor_user_id: identity.user_id,
          organization_id: grantedScope.organization_id,
          authorization_epoch: grantedScope.authorization_epoch,
        },
      });
      const readback = await persistence.read(publicationId);
      if (
        !publicationIntentMatchesAuthorizedContext(readback, {
          publication_id: publicationId,
          project_id: projectId,
          execution: evidence.execution,
          identity,
          authorization_epoch: grantedScope.authorization_epoch,
        })
      )
        return opaqueNotFound(res);

      const resourceScopePort = createBoundEvidenceResourceScopePort(db, {
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        project_id: projectId,
      });
      if (!(await drivePublicationResourceMatches(resourceScopePort, readback)))
        return opaqueNotFound(res);
      const transport = req.app.locals.recoveryDriveTransport;
      if (!isFakeDriveTransport(transport))
        return drivePublicationUnavailable(res);

      const revalidateAuthorization = createDriveWriteRevalidator({
        context: {
          publication_id: publicationId,
          project_id: projectId,
          execution: evidence.execution,
          identity,
          authorization_epoch: grantedScope.authorization_epoch,
        },
        scope: grantedScope,
        tenancy: tenancyPort,
        repository,
        resources: resourceScopePort,
      });
      const service = createApprovedArtifactPublicationService({
        persistence,
        storage: { getStrict: (key: string) => downloadFileStrict(key) },
        transport,
        revalidateAuthorization,
      });
      const result = await service.reconcile({ publication_id: publicationId });
      if (
        !isApprovedArtifactPublicationResult(result, {
          publication_id: publicationId,
          project_id: projectId,
          execution: evidence.execution,
          identity,
          authorization_epoch: grantedScope.authorization_epoch,
        })
      )
        throw new Error("AI Drive publication result mismatch");
      if (
        !(await revalidateAuthorization({
          phase: "before_record_outcome",
          intent: result.intent,
        }))
      )
        return res.status(403).json({
          code: "authorization_revoked",
          detail: "Authorization revoked.",
        });
      return res.status(200).json({
        outcome: result.outcome,
        disposition: result.disposition,
        publication: publicDrivePublication(result.intent),
      });
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

aiRecoveryRouter.post("/:executionId/review", requireAuth, async (req, res) => {
  const body = req.body;
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["idempotency_key", "review_id"]) ||
    !isNonEmptyString(body.idempotency_key) ||
    !isNonEmptyString(body.review_id)
  )
    return res
      .status(400)
      .json({ code: "invalid_review", detail: "Invalid review." });

  const projectId = req.params.projectId;
  const executionId = req.params.executionId;
  const identity = res.locals.authenticatedIdentity as
    | AuthenticatedIdentity
    | undefined;
  try {
    if (
      !isNonEmptyString(projectId) ||
      !isNonEmptyString(executionId) ||
      !identity
    )
      throw new Error("invalid authenticated request");
    const db = createServerSupabase();
    const repository = createSupabaseAiReadRepository(db);
    const evidence = await repository.loadExecutionEvidence({
      project_id: projectId,
      execution_id: executionId,
    });
    if (!evidence) return opaqueNotFound(res);
    const tenancyReadPort = createSupabaseTenancyReadPort(db);
    const access = await evaluateInitialAccess(tenancyReadPort, {
      identity,
      organization_id: evidence.execution.organization_id,
      matter_id: evidence.execution.matter_id,
      requiresMfa: true,
    });
    if (access.kind === "authorization_dependency_failed")
      throw new Error("AI review authorization failed");
    if (access.decision.outcome === "not_found") return opaqueNotFound(res);
    if (access.decision.outcome === "denied") {
      if (access.decision.code === "mfa_required")
        return res
          .status(403)
          .json({ code: "mfa_required", detail: "MFA required." });
      return res.status(403).json({
        code: "authorization_revoked",
        detail: "Authorization revoked.",
      });
    }
    const resourceScopePort = createBoundEvidenceResourceScopePort(db, {
      organization_id: evidence.execution.organization_id,
      matter_id: evidence.execution.matter_id,
      project_id: projectId,
    });
    const mutationPort = createSupabaseAiPersistencePorts(db, {
      actor_user_id: identity.user_id,
      organization_id: access.decision.scope.organization_id,
      authorization_epoch: access.decision.scope.authorization_epoch,
    }).review;
    const result = await createHumanReview({
      identity,
      granted_scope: access.decision.scope,
      tenancy_port: tenancyReadPort,
      resource_scope_port: resourceScopePort,
      requires_mfa: true,
      idempotency_key: body.idempotency_key,
      review_id: body.review_id,
      execution: evidence.execution,
      evidence_receipt: evidence.evidence_receipt,
      mutation_port: mutationPort,
    });
    if (!result.ok) {
      if (result.error_class === "invalid_review")
        return res
          .status(400)
          .json({ code: "invalid_review", detail: "Invalid review." });
      if (result.error_class === "review_authorization_failed")
        return res.status(403).json({
          code: "authorization_revoked",
          detail: "Authorization revoked.",
        });
      throw new Error("AI review operation failed");
    }
    return res
      .status(result.receipt.disposition === "applied" ? 201 : 200)
      .json({
        review: result.review,
        receipt: result.receipt,
      });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

const DECISION_KEYS = [
  "idempotency_key",
  "decision",
  "finding_text",
  "comment",
] as const;
const TERMINAL_STATE_KEYS = ["idempotency_key", "terminal_state"] as const;

function mutationFailure(res: import("express").Response, errorClass: string) {
  if (errorClass === "invalid_review")
    return res
      .status(400)
      .json({ code: "invalid_review", detail: "Invalid review." });
  if (errorClass === "review_authorization_failed")
    return res.status(403).json({
      code: "authorization_revoked",
      detail: "Authorization revoked.",
    });
  throw new Error("AI review operation failed");
}

async function loadReviewMutationContext(input: {
  project_id: string;
  execution_id: string;
  identity: AuthenticatedIdentity;
}) {
  const db = createServerSupabase();
  const repository = createSupabaseAiReadRepository(db);
  const evidence = await repository.loadExecutionEvidence({
    project_id: input.project_id,
    execution_id: input.execution_id,
  });
  if (!evidence) return { kind: "not_found" as const };

  const tenancyReadPort = createSupabaseTenancyReadPort(db);
  const access = await evaluateInitialAccess(tenancyReadPort, {
    identity: input.identity,
    organization_id: evidence.execution.organization_id,
    matter_id: evidence.execution.matter_id,
    requiresMfa: true,
  });
  if (access.kind === "authorization_dependency_failed")
    throw new Error("AI review authorization failed");
  if (access.decision.outcome === "not_found")
    return { kind: "not_found" as const };
  if (access.decision.outcome === "denied") {
    if (access.decision.code === "mfa_required")
      return { kind: "mfa_required" as const };
    return { kind: "denied" as const };
  }

  const review = await repository.loadReview({
    project_id: input.project_id,
    execution_id: input.execution_id,
  });
  if (!review) return { kind: "not_found" as const };
  if (review.reviewer_user_id !== input.identity.user_id)
    return { kind: "denied" as const };

  const resourceScopePort = createBoundEvidenceResourceScopePort(db, {
    organization_id: evidence.execution.organization_id,
    matter_id: evidence.execution.matter_id,
    project_id: input.project_id,
  });
  const mutationPort = createSupabaseAiPersistencePorts(db, {
    actor_user_id: input.identity.user_id,
    organization_id: access.decision.scope.organization_id,
    authorization_epoch: access.decision.scope.authorization_epoch,
  }).review;
  return {
    kind: "ready" as const,
    identity: input.identity,
    granted_scope: access.decision.scope,
    tenancy_port: tenancyReadPort,
    resource_scope_port: resourceScopePort,
    mutation_port: mutationPort,
    review,
    execution: evidence.execution,
  };
}

function respondToMutationContext(
  res: import("express").Response,
  context: Awaited<ReturnType<typeof loadReviewMutationContext>>,
) {
  if (context.kind === "not_found") return opaqueNotFound(res);
  if (context.kind === "mfa_required")
    return res
      .status(403)
      .json({ code: "mfa_required", detail: "MFA required." });
  if (context.kind === "denied")
    return res.status(403).json({
      code: "authorization_revoked",
      detail: "Authorization revoked.",
    });
  return null;
}

aiRecoveryRouter.post(
  "/:executionId/review/items/:itemId/decision",
  requireAuth,
  async (req, res) => {
    const body = req.body;
    if (
      !isRecord(body) ||
      !hasExactKeys(
        body,
        DECISION_KEYS.filter((key) => body[key] !== undefined),
      ) ||
      !isNonEmptyString(body.idempotency_key) ||
      !isNonEmptyString(body.decision) ||
      !(
        "accepted" === body.decision ||
        "rejected" === body.decision ||
        "edited" === body.decision
      )
    )
      return res
        .status(400)
        .json({ code: "invalid_review", detail: "Invalid review." });

    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const itemId = req.params.itemId;
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    try {
      if (
        !isNonEmptyString(projectId) ||
        !isNonEmptyString(executionId) ||
        !isNonEmptyString(itemId) ||
        !identity
      )
        throw new Error("invalid authenticated request");
      const context = await loadReviewMutationContext({
        project_id: projectId,
        execution_id: executionId,
        identity,
      });
      const early = respondToMutationContext(res, context);
      if (early) return early;
      if (context.kind !== "ready") throw new Error("invalid review context");
      const result = await decideHumanReviewItem({
        identity: context.identity,
        granted_scope: context.granted_scope,
        tenancy_port: context.tenancy_port,
        resource_scope_port: context.resource_scope_port,
        requires_mfa: true,
        idempotency_key: body.idempotency_key,
        review: context.review,
        item_id: itemId,
        decision: body.decision,
        ...(body.finding_text === undefined
          ? {}
          : { finding_text: body.finding_text }),
        ...(body.comment === undefined ? {} : { comment: body.comment }),
        mutation_port: context.mutation_port,
      });
      if (!result.ok) return mutationFailure(res, result.error_class);
      return res.status(200).json({
        review: result.review,
        transition: result.transition,
        receipt: result.receipt,
      });
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

aiRecoveryRouter.post(
  "/:executionId/review/complete",
  requireAuth,
  async (req, res) => {
    const body = req.body;
    if (
      !isRecord(body) ||
      !hasExactKeys(body, TERMINAL_STATE_KEYS) ||
      !isNonEmptyString(body.idempotency_key) ||
      (body.terminal_state !== "approved" &&
        body.terminal_state !== "changes_requested")
    )
      return res
        .status(400)
        .json({ code: "invalid_review", detail: "Invalid review." });

    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    try {
      if (
        !isNonEmptyString(projectId) ||
        !isNonEmptyString(executionId) ||
        !identity
      )
        throw new Error("invalid authenticated request");
      const context = await loadReviewMutationContext({
        project_id: projectId,
        execution_id: executionId,
        identity,
      });
      const early = respondToMutationContext(res, context);
      if (early) return early;
      if (context.kind !== "ready") throw new Error("invalid review context");
      const result = await completeHumanReview({
        identity: context.identity,
        granted_scope: context.granted_scope,
        tenancy_port: context.tenancy_port,
        resource_scope_port: context.resource_scope_port,
        requires_mfa: true,
        idempotency_key: body.idempotency_key,
        review: context.review,
        execution: context.execution,
        terminal_state: body.terminal_state,
        mutation_port: context.mutation_port,
      });
      if (!result.ok) return mutationFailure(res, result.error_class);
      return res
        .status(200)
        .json({ review: result.review, receipt: result.receipt });
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

aiRecoveryRouter.get(
  "/:executionId/review/redline-bundle",
  requireAuth,
  async (req, res) => {
    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const rawRevision = req.query.revision;
    const revision = rawRevision === undefined ? 1 : Number(rawRevision);
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      (typeof rawRevision !== "undefined" &&
        (Array.isArray(rawRevision) ||
          String(rawRevision) !== String(revision)))
    ) {
      return res
        .status(400)
        .json({ code: "invalid_revision", detail: "Invalid revision." });
    }
    try {
      if (
        !isNonEmptyString(projectId) ||
        !isNonEmptyString(executionId) ||
        !identity
      )
        throw new Error("invalid authenticated request");
      const db = createServerSupabase();
      const result = await db
        .from("ai_redline_bundles")
        .select(REDLINE_BUNDLE_COLUMNS)
        .eq("project_id", projectId)
        .eq("execution_id", executionId)
        .eq("revision", revision)
        .eq("bundle_version", "approved-redline-v1")
        .maybeSingle();
      if (result.error) throw new Error("AI redline bundle query failed");
      if (
        !isRecord(result.data) ||
        !isNonEmptyString(result.data.organization_id) ||
        !isNonEmptyString(result.data.matter_id)
      )
        return opaqueNotFound(res);

      const tenancyReadPort = createSupabaseTenancyReadPort(db);
      const access = await evaluateInitialAccess(tenancyReadPort, {
        identity,
        organization_id: result.data.organization_id,
        matter_id: result.data.matter_id,
        requiresMfa: false,
      });
      if (access.kind === "authorization_dependency_failed")
        throw new Error("AI redline authorization failed");
      if (access.decision.outcome !== "allow") return opaqueNotFound(res);

      let rpcResult: { data: unknown; error: unknown };
      try {
        rpcResult = await db.rpc("assert_ai_redline_bundle_access", {
          p_bundle_id: result.data.id,
          p_actor_user_id: identity.user_id,
          p_organization_id: result.data.organization_id,
          p_authorization_epoch: access.decision.scope.authorization_epoch,
          p_intent: "read",
        });
      } catch {
        throw new Error("AI redline authorization RPC failed");
      }
      if (
        rpcResult.error &&
        isRecord(rpcResult.error) &&
        rpcResult.error.code === "42501"
      )
        return res.status(403).json({
          code: "authorization_revoked",
          detail: "Authorization revoked.",
        });
      if (rpcResult.error || rpcResult.data !== true)
        throw new Error("AI redline authorization RPC failed");
      if (!isIntegrityValid(result.data, projectId, executionId, revision))
        return res.status(409).json({
          code: "redline_bundle_integrity_failed",
          detail: "Redline bundle integrity failed.",
        });

      return res.json(publicRedlineBundle(result.data));
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

aiRecoveryRouter.post(
  "/:executionId/review/redline-bundle",
  requireAuth,
  async (req, res) => {
    const body = req.body;
    if (
      !isRecord(body) ||
      !hasExactKeys(body, [
        "idempotency_key",
        "revision",
        "expected_review_revision",
      ]) ||
      !isNonEmptyString(body.idempotency_key) ||
      !Number.isSafeInteger(body.revision) ||
      (body.revision as number) < 1 ||
      !Number.isSafeInteger(body.expected_review_revision) ||
      (body.expected_review_revision as number) < 1
    )
      return res.status(400).json({
        code: "invalid_approved_redline",
        detail: "Invalid approved redline.",
      });

    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    try {
      if (
        !isNonEmptyString(projectId) ||
        !isNonEmptyString(executionId) ||
        !identity
      )
        throw new Error("invalid authenticated request");

      const db = createServerSupabase();
      const repository = createSupabaseAiReadRepository(db);
      const evidence = await repository.loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      });
      if (!evidence) return opaqueNotFound(res);

      const tenancyReadPort = createSupabaseTenancyReadPort(db);
      const access = await evaluateInitialAccess(tenancyReadPort, {
        identity,
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        requiresMfa: true,
      });
      if (access.kind === "authorization_dependency_failed")
        throw new Error("AI approved redline authorization failed");
      if (access.decision.outcome === "not_found") return opaqueNotFound(res);
      if (access.decision.outcome === "denied") {
        if (access.decision.code === "mfa_required")
          return res
            .status(403)
            .json({ code: "mfa_required", detail: "MFA required." });
        return res.status(403).json({
          code: "authorization_revoked",
          detail: "Authorization revoked.",
        });
      }

      const review = await repository.loadReview({
        project_id: projectId,
        execution_id: executionId,
      });
      if (!review) return opaqueNotFound(res);
      const sourceVersion = await repository.loadSourceVersion({
        document_version_id: evidence.execution.document_version_id,
      });
      if (!sourceVersion) return opaqueNotFound(res);
      const pages = await repository.loadPages({
        document_version_id: evidence.execution.document_version_id,
      });
      const resourceScopePort = createBoundEvidenceResourceScopePort(db, {
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        project_id: projectId,
      });
      const mutationPort = createSupabaseAiPersistencePorts(db, {
        actor_user_id: identity.user_id,
        organization_id: access.decision.scope.organization_id,
        authorization_epoch: access.decision.scope.authorization_epoch,
      }).redline;
      const result = await produceApprovedRedlineBundle({
        identity,
        granted_scope: access.decision.scope,
        tenancy_port: tenancyReadPort,
        resource_scope_port: resourceScopePort,
        requires_mfa: true,
        idempotency_key: body.idempotency_key,
        revision: body.revision as number,
        expected_review_revision: body.expected_review_revision as number,
        review,
        execution: evidence.execution,
        evidence_receipt: evidence.evidence_receipt,
        source_version: sourceVersion,
        pages,
        append_port: mutationPort,
      });
      if (!result.ok) {
        if (result.error_class === "invalid_approved_redline")
          return res.status(409).json({
            code: "invalid_approved_redline",
            detail: "Invalid approved redline.",
          });
        if (result.error_class === "approved_redline_authorization_failed")
          return res.status(403).json({
            code: "authorization_revoked",
            detail: "Authorization revoked.",
          });
        throw new Error("AI approved redline operation failed");
      }
      return res
        .status(result.receipt.disposition === "applied" ? 201 : 200)
        .json({ bundle: result.bundle, receipt: result.receipt });
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

const APPROVED_REPORT_IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function reportExpectation(
  review: HumanReview,
  execution: HumanReviewExecution,
  idempotencyKey?: string,
): ApprovedArtifactReadExpectation {
  return {
    ...(idempotencyKey === undefined
      ? {}
      : { idempotency_key: idempotencyKey }),
    review_id: review.review_id,
    review_revision: review.revision,
    execution_id: execution.execution_id,
    organization_id: review.organization_id,
    matter_id: review.matter_id,
    project_id: review.project_id,
    source_document_id: review.document_id,
    source_document_version_id: review.document_version_id,
    source_document_sha256: review.document_content_sha256,
    evidence_receipt_sha256: review.evidence_receipt_sha256,
    filename: "Informe de revision humana.docx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

function sameReportAuthority(
  expected: {
    review_id: string;
    revision: number;
    status: string;
    execution_id: string;
    organization_id: string;
    matter_id: string;
    project_id: string;
    document_id: string;
    document_version_id: string;
    document_content_sha256: string;
    evidence_receipt_sha256: string;
  },
  current: typeof expected,
): boolean {
  return (
    current.review_id === expected.review_id &&
    current.revision === expected.revision &&
    current.status === "approved" &&
    expected.status === "approved" &&
    current.execution_id === expected.execution_id &&
    current.organization_id === expected.organization_id &&
    current.matter_id === expected.matter_id &&
    current.project_id === expected.project_id &&
    current.document_id === expected.document_id &&
    current.document_version_id === expected.document_version_id &&
    current.document_content_sha256 === expected.document_content_sha256 &&
    current.evidence_receipt_sha256 === expected.evidence_receipt_sha256
  );
}

aiRecoveryRouter.post(
  "/:executionId/review/approved-report",
  requireAuth,
  async (req, res) => {
    const body = req.body;
    if (
      !isRecord(body) ||
      !hasExactKeys(body, ["expected_review_revision", "idempotency_key"]) ||
      !isNonEmptyString(body.idempotency_key) ||
      !APPROVED_REPORT_IDEMPOTENCY_RE.test(body.idempotency_key) ||
      !Number.isSafeInteger(body.expected_review_revision) ||
      (body.expected_review_revision as number) < 1
    )
      return res.status(400).json({
        code: "invalid_approved_report",
        detail: "Invalid approved report.",
      });

    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    if (!isUuid(projectId) || !isUuid(executionId) || !identity)
      return res.status(400).json({
        code: "invalid_approved_report",
        detail: "Invalid approved report.",
      });
    const idempotencyKey = body.idempotency_key as string;
    try {
      const db = createServerSupabase();
      const repository = createSupabaseAiReadRepository(db);
      const evidence = await repository.loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      });
      if (!evidence) return opaqueNotFound(res);
      const tenancyPort = createSupabaseTenancyReadPort(db);
      const access = await evaluateInitialAccess(tenancyPort, {
        identity,
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        requiresMfa: true,
      });
      if (access.kind === "authorization_dependency_failed")
        throw new Error("AI approved report authorization failed");
      if (access.decision.outcome === "not_found") return opaqueNotFound(res);
      if (access.decision.outcome === "denied")
        return res.status(403).json({
          code:
            access.decision.code === "mfa_required"
              ? "mfa_required"
              : "authorization_revoked",
          detail:
            access.decision.code === "mfa_required"
              ? "MFA required."
              : "Authorization revoked.",
        });
      const grantedScope = access.decision.scope;
      const review = await repository.loadReview({
        project_id: projectId,
        execution_id: executionId,
      });
      if (!review) return opaqueNotFound(res);
      if (
        review.status !== "approved" ||
        review.revision !== body.expected_review_revision
      )
        return res.status(409).json({
          code: "invalid_approved_report",
          detail: "Invalid approved report.",
        });
      const resourceScopePort = createBoundEvidenceResourceScopePort(db, {
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        project_id: projectId,
      });
      const storage = {
        putIfAbsent: (key: string, bytes: Uint8Array, mimeType: string) =>
          uploadFileIfAbsent(key, bytes, mimeType),
        getStrict: (key: string) => downloadFileStrict(key),
      };
      const revalidateCurrent = async () => {
        const currentEvidence = await repository.loadExecutionEvidence({
          project_id: projectId,
          execution_id: executionId,
        });
        const currentReview = await repository.loadReview({
          project_id: projectId,
          execution_id: executionId,
        });
        if (
          !currentEvidence ||
          !currentReview ||
          !sameReportAuthority(review, currentReview) ||
          currentEvidence.execution.execution_id !==
            evidence.execution.execution_id ||
          currentEvidence.execution.organization_id !==
            evidence.execution.organization_id ||
          currentEvidence.execution.matter_id !==
            evidence.execution.matter_id ||
          currentEvidence.execution.project_id !==
            evidence.execution.project_id ||
          currentEvidence.execution.document_id !==
            evidence.execution.document_id ||
          currentEvidence.execution.document_version_id !==
            evidence.execution.document_version_id ||
          currentEvidence.execution.document_content_sha256 !==
            evidence.execution.document_content_sha256 ||
          currentEvidence.execution.evidence_receipt_sha256 !==
            evidence.execution.evidence_receipt_sha256
        )
          return false;
        if (
          (await recheckHumanReviewResourceScope(
            resourceScopePort,
            currentReview,
          )) !== "match"
        )
          return false;
        const fresh = await recheckFreshAccessViaPort(tenancyPort, {
          scope: grantedScope,
          identity,
          requiresMfa: true,
        });
        if (
          fresh.kind === "authorization_dependency_failed" ||
          !fresh.result.fresh
        )
          return false;
        return true;
      };
      const persistence = createApprovedArtifactPersistence({
        client: db as unknown as ApprovedArtifactPersistenceClient,
        context: {
          actor_user_id: identity.user_id,
          organization_id: grantedScope.organization_id,
          authorization_epoch: grantedScope.authorization_epoch,
        },
        storage,
        revalidateBeforeUpload: revalidateCurrent,
      });
      const expected = reportExpectation(
        review,
        evidence.execution,
        idempotencyKey,
      );
      const replayAwareRenderer = {
        render: async (
          plan: Parameters<typeof approvedDocxRenderer.render>[0],
        ) => {
          if (!(await revalidateCurrent()))
            throw new Error("report superseded");
          const existing = await persistence.read({
            idempotency_key: idempotencyKey,
            expected,
          });
          return existing ?? approvedDocxRenderer.render(plan);
        },
      };
      const result = await produceApprovedReviewReport({
        identity,
        granted_scope: grantedScope,
        tenancy_port: tenancyPort,
        resource_scope_port: resourceScopePort,
        requires_mfa: true,
        idempotency_key: idempotencyKey,
        expected_review_revision: body.expected_review_revision as number,
        review,
        execution: evidence.execution,
        evidence_receipt: evidence.evidence_receipt,
        renderer: replayAwareRenderer,
        append_port: persistence,
      });
      if (!result.ok) {
        if (result.error_class === "invalid_approved_report")
          return res.status(409).json({
            code: "invalid_approved_report",
            detail: "Invalid approved report.",
          });
        if (result.error_class === "approved_report_authorization_failed")
          return res.status(403).json({
            code: "authorization_revoked",
            detail: "Authorization revoked.",
          });
        throw new Error("AI approved report operation failed");
      }
      const committedResult = await db
        .from("ai_review_exports")
        .select(
          "id,idempotency_key,review_id,review_revision,execution_id,organization_id,matter_id,project_id,source_document_id,source_document_version_id,source_document_sha256,evidence_receipt_sha256,artifact_document_id,artifact_document_version_id,artifact_sha256,storage_path,size_bytes,filename,mime_type",
        )
        .eq("idempotency_key", idempotencyKey)
        .eq("project_id", projectId)
        .eq("execution_id", executionId)
        .maybeSingle();
      if (committedResult.error)
        throw new Error("approved report receipt read failed");
      const rawCommitted = committedResult.data;
      const committed = isRecord(rawCommitted) ? { ...rawCommitted } : null;
      if (
        !committed ||
        !isPostgresUuid(committed.id) ||
        !isApprovedArtifactExportRow(committed, {
          export_id: committed.id,
          project_id: projectId,
          execution_id: executionId,
          review_revision: review.revision,
          execution: evidence.execution,
        }) ||
        committed.idempotency_key !== idempotencyKey ||
        committed.review_id !== review.review_id ||
        committed.artifact_sha256 !== result.artifact.artifact_sha256 ||
        committed.source_document_sha256 !== expected.source_document_sha256 ||
        committed.evidence_receipt_sha256 !==
          expected.evidence_receipt_sha256 ||
        committed.filename !== result.artifact.filename ||
        committed.mime_type !== result.artifact.mime_type
      )
        throw new Error("approved report receipt mismatch");
      if (!(await revalidateCurrent()))
        return res.status(403).json({
          code: "authorization_revoked",
          detail: "Authorization revoked.",
        });
      return res
        .status(result.receipt.disposition === "applied" ? 201 : 200)
        .json({
          export_id: committed.id,
          artifact: result.artifact,
          receipt: result.receipt,
        });
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

aiRecoveryRouter.get(
  "/:executionId/review/approved-report",
  requireAuth,
  async (req, res) => {
    const projectId = req.params.projectId;
    const executionId = req.params.executionId;
    const rawRevision = req.query.revision;
    const revision =
      rawRevision === undefined || Array.isArray(rawRevision)
        ? undefined
        : Number(rawRevision);
    const identity = res.locals.authenticatedIdentity as
      | AuthenticatedIdentity
      | undefined;
    if (
      Object.keys(req.query).some((key) => key !== "revision") ||
      !isUuid(projectId) ||
      !isUuid(executionId) ||
      !identity ||
      (revision !== undefined &&
        (!Number.isSafeInteger(revision) ||
          revision < 1 ||
          !/^[1-9][0-9]*$/.test(rawRevision as string)))
    )
      return res.status(400).json({
        code: "invalid_approved_report",
        detail: "Invalid approved report.",
      });
    try {
      const db = createServerSupabase();
      const repository = createSupabaseAiReadRepository(db);
      const evidence = await repository.loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      });
      if (!evidence) return opaqueNotFound(res);
      const tenancyPort = createSupabaseTenancyReadPort(db);
      const access = await evaluateInitialAccess(tenancyPort, {
        identity,
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        requiresMfa: true,
      });
      if (access.kind === "authorization_dependency_failed")
        throw new Error("AI approved report authorization failed");
      if (access.decision.outcome !== "allow") return opaqueNotFound(res);
      const grantedScope = access.decision.scope;
      const review = await repository.loadReview({
        project_id: projectId,
        execution_id: executionId,
      });
      if (
        !review ||
        review.status !== "approved" ||
        (revision !== undefined && review.revision !== revision)
      )
        return opaqueNotFound(res);
      const resourceScopePort = createBoundEvidenceResourceScopePort(db, {
        organization_id: evidence.execution.organization_id,
        matter_id: evidence.execution.matter_id,
        project_id: projectId,
      });
      const revalidateCurrent = async () => {
        const fresh = await recheckFreshAccessViaPort(tenancyPort, {
          scope: grantedScope,
          identity,
          requiresMfa: true,
        });
        if (
          fresh.kind === "authorization_dependency_failed" ||
          !fresh.result.fresh
        )
          return false;
        const currentEvidence = await repository.loadExecutionEvidence({
          project_id: projectId,
          execution_id: executionId,
        });
        const currentReview = await repository.loadReview({
          project_id: projectId,
          execution_id: executionId,
        });
        return (
          !!currentEvidence &&
          !!currentReview &&
          sameReportAuthority(review, currentReview) &&
          currentEvidence.execution.execution_id ===
            evidence.execution.execution_id &&
          currentEvidence.execution.document_content_sha256 ===
            evidence.execution.document_content_sha256 &&
          currentEvidence.execution.evidence_receipt_sha256 ===
            evidence.execution.evidence_receipt_sha256 &&
          (await recheckHumanReviewResourceScope(
            resourceScopePort,
            currentReview,
          )) === "match"
        );
      };
      const storage = {
        putIfAbsent: (key: string, bytes: Uint8Array, mimeType: string) =>
          uploadFileIfAbsent(key, bytes, mimeType),
        getStrict: (key: string) => downloadFileStrict(key),
      };
      const persistence = createApprovedArtifactPersistence({
        client: db as unknown as ApprovedArtifactPersistenceClient,
        context: {
          actor_user_id: identity.user_id,
          organization_id: access.decision.scope.organization_id,
          authorization_epoch: access.decision.scope.authorization_epoch,
        },
        storage,
        revalidateBeforeUpload: revalidateCurrent,
      });
      const bytes = await persistence.read({
        project_id: projectId,
        execution_id: executionId,
        ...(revision === undefined ? {} : { review_revision: revision }),
        expected: reportExpectation(review, evidence.execution),
        revalidateAfterRead: revalidateCurrent,
      });
      if (!bytes) return opaqueNotFound(res);
      return res
        .type(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        .set(
          "Content-Disposition",
          'attachment; filename="Informe de revision humana.docx"',
        )
        .send(Buffer.from(bytes));
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);
