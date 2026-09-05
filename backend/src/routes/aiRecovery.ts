import { Router } from "express";
import { createHash } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { sendInternalError } from "../lib/httpError";
import { createSupabaseTenancyReadPort } from "../lib/recovery/authorization/supabaseTenancyReadPort";
import { evaluateInitialAccess } from "../lib/recovery/authorization/tenancyReadPort";
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
} from "../lib/recovery/review/humanReview";
import { produceApprovedRedlineBundle } from "../lib/recovery/review/approvedRedlineBundle";

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
