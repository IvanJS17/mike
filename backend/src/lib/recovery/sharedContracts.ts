/**
 * Coordinator-owned shared contracts materialized from the frozen ledger
 * (`docs/UPSTREAM_COMPATIBILITY_LEDGER.md` section 5) of the exact LiTT control
 * baseline `d9fa8380e63837b6441cef169cf5ef80dfb55e54` /
 * `b64978101faaed63bd11bed44777d1b3e557d6a0` (ledger SHA-256
 * `1161dd7510538bf34cbc9a957253591c8296910ef7a1fa28838e79bd57da9079`).
 *
 * These are typed fail-closed placeholders ONLY. They intentionally do not
 * implement Slice A behavior (tenancy model, provider adapters, workflow
 * catalog, evidence UI, Word UI, or Drive publication). Where a contract
 * boundary reaches a product decision listed in ledger section 11 (retention/
 * erasure, onboarding defaults, BYOK precedence, real egress, Shared Drive,
 * residency, jurisdiction sources, material UX), the scaffold fails closed with
 * a typed result instead of selecting behavior.
 */

import type { WorkflowCatalogRow } from "../workflowCatalog";

/** Credential domains that must remain semantically separate. */
export const CREDENTIAL_DOMAINS = [
  "membership_identity",
  "provider_api_key",
  "oauth_access_token",
  "oauth_refresh_token",
] as const;

export type CredentialDomain = (typeof CREDENTIAL_DOMAINS)[number];

export function isCredentialDomain(value: string): value is CredentialDomain {
  return (CREDENTIAL_DOMAINS as readonly string[]).includes(value);
}

/** Explicitly selected governed provider/model/credential route. */
export type ProviderRoute = {
  provider: string;
  model: string;
  credential_ref: string;
};

/**
 * Build an explicit route. Explicit and pinned routes must never silently
 * fall back, so an incomplete route is a construction error, not a default.
 */
export function buildProviderRoute(input: ProviderRoute): ProviderRoute {
  if (!input.provider || !input.provider.trim()) {
    throw new Error("provider route requires a non-empty provider");
  }
  if (!input.model || !input.model.trim()) {
    throw new Error("provider route requires a non-empty model");
  }
  if (!input.credential_ref || !input.credential_ref.trim()) {
    throw new Error("provider route requires a non-empty credential_ref");
  }
  return {
    provider: input.provider,
    model: input.model,
    credential_ref: input.credential_ref,
  };
}

/**
 * Egress choke point contract: default CI, local E2E and recovery tests make
 * zero real provider or Google calls. Only fake interception is allowlisted;
 * any real egress support is a separately authorized G6 decision that has not
 * been made, so every real host fails closed.
 */
export const EGRESS_POLICY = {
  allowlistedHosts: ["fake"],
} as const;

export type EgressDecision =
  | { allowed: true; host: string }
  | {
      allowed: false;
      host: string;
      reason: "host_not_allowlisted";
    };

/**
 * Decide whether one host may receive requests for one provider. Real
 * provider and Google hosts are rejected by default; callers must abort
 * before any SDK network request.
 */
export function resolveEgressTarget(
  _provider: string,
  host: string,
): EgressDecision {
  if ((EGRESS_POLICY.allowlistedHosts as readonly string[]).includes(host)) {
    return { allowed: true, host };
  }
  return { allowed: false, host, reason: "host_not_allowlisted" };
}

/**
 * Product boundaries that fail closed because the owning decision has not been
 * made (ledger section 11). No scaffold path may silently select behavior for
 * any of these kinds.
 */
export const BLOCKED_OPERATION_KINDS = [
  "evidence_deletion",
  "onboarding_tenant_defaults",
  "user_byok_router_credential",
  "real_provider_egress",
  "publication_to_real_drive",
  "production_topology",
  "jurisdiction_research_source",
  "material_ux_legal_review_change",
] as const;

export type BlockedOperationKind = (typeof BLOCKED_OPERATION_KINDS)[number];

export type BlockedOperation<
  K extends BlockedOperationKind = BlockedOperationKind,
> = {
  ok: false;
  blocked: true;
  kind: K;
  reason: string;
};

/**
 * Typed fail-closed result for one blocked product boundary. The result never
 * carries a decision, a secret or a fallback behavior: it only reports the
 * blocked kind and why.
 */
export function makeBlockedOperation<K extends BlockedOperationKind>(
  kind: K,
  reason: string,
): BlockedOperation<K> {
  return { ok: false, blocked: true, kind, reason };
}

/** Per-item human review decisions (ledger contract: Review state). */
export const APPROVED_REVIEW_DECISIONS = [
  "accepted",
  "rejected",
  "edited",
] as const;

export type ApprovedReviewDecision = (typeof APPROVED_REVIEW_DECISIONS)[number];

/** Terminal human review states (ledger contract: Review state). */
export const APPROVED_REVIEW_TERMINAL_STATES = [
  "approved",
  "changes_requested",
] as const;

export type ApprovedReviewTerminalState =
  (typeof APPROVED_REVIEW_TERMINAL_STATES)[number];

export function isApprovedReviewDecision(
  value: string,
): value is ApprovedReviewDecision {
  return (APPROVED_REVIEW_DECISIONS as readonly string[]).includes(value);
}

export function isApprovedReviewTerminalState(
  value: string,
): value is ApprovedReviewTerminalState {
  return (APPROVED_REVIEW_TERMINAL_STATES as readonly string[]).includes(value);
}

/*
 * Type-only contracts from ledger section 5. Exact exported names below are
 * frozen by this coordinator snapshot; slice writers consume them as written
 * and must stop `blocked` with an interface request instead of redefining a
 * shape. These declarations carry no runtime behavior: implementing the
 * domains behind them belongs to the ordered slices, never to this scaffold.
 */

/**
 * Ledger contract: Request identity. Transport is exactly one of the three
 * allowed kinds; untrusted cookie mutation origin is rejected (403) by the
 * auth boundary and browser Bearer fallback is prohibited, so neither case is
 * representable here.
 */
export type RequestIdentity = {
  user_id: string;
  transport:
    | { kind: "web_session" }
    | { kind: "word_handoff"; handoff_session_id: string }
    | { kind: "non_browser_bearer"; client_name: string };
  mfa_satisfied: boolean;
};

/**
 * Ledger contract: Tenancy scope. Private matters additionally require
 * explicit matter membership on top of active organization membership; a
 * stale `authorization_epoch` blocks mutation at the access boundary.
 */
export type TenancyScope = {
  organization_id: string;
  workspace_id?: string;
  matter_id?: string;
  membership_role: string;
  authorization_epoch: number;
};

/**
 * Ledger contract: Workflow identity. Executed receipts pin exactly the
 * active `content_hash`; later catalog edits never rewrite a prior receipt.
 */
export type WorkflowIdentity = {
  workflow_key: string;
  version: string;
  content_hash: string;
  source_commit: string;
  distribution: WorkflowCatalogRow["distribution"];
  type: WorkflowCatalogRow["type"];
  source: string;
  approval_provenance: string;
};

/**
 * Build the executed workflow identity from upstream catalog vocabulary plus
 * LiTT source/approval provenance. Invalid or incomplete evidence fails closed.
 */
export function buildWorkflowIdentity(
  input: WorkflowIdentity,
): WorkflowIdentity {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.workflow_key)) {
    throw new Error("workflow identity requires a valid workflow_key");
  }
  if (!input.version.trim()) {
    throw new Error("workflow identity requires a version");
  }
  if (!/^[0-9a-f]{64}$/.test(input.content_hash)) {
    throw new Error("workflow identity requires a SHA-256 content_hash");
  }
  if (!/^[0-9a-f]{40}$/.test(input.source_commit)) {
    throw new Error("workflow identity requires a full source_commit");
  }
  if (input.distribution !== "default" && input.distribution !== "addon") {
    throw new Error("workflow identity has an invalid distribution");
  }
  if (input.type !== "assistant" && input.type !== "tabular") {
    throw new Error("workflow identity has an invalid type");
  }
  if (!input.source.trim() || !input.approval_provenance.trim()) {
    throw new Error(
      "workflow identity requires source and approval provenance",
    );
  }
  return { ...input };
}

/**
 * Ledger contract: Execution provenance. The route and workflow recorded are
 * the actual executed ones, never the intended ones; sanitizer responsibilities
 * (rejecting secrets/prompts/content fields except hashes) live with the
 * evidence slice, not in this scaffold.
 */
export type ExecutionProvenance = {
  tenant_scope: {
    organization_id: string;
    matter_id?: string;
    project_id?: string;
    chat_id?: string;
    document_version_id?: string;
  };
  input_hashes: string[];
  output_hashes: string[];
  citation_hashes: string[];
  route: ProviderRoute;
  workflow: WorkflowIdentity;
  status: "completed" | "failed";
  error_class?: string;
};

/**
 * Ledger contract: Approved redline bundle. Every write revalidates bundle
 * identity, source document/version/SHA and action spans freshly; ambiguity,
 * overlap, supersession, Save-As or document drift must produce no partial
 * write (enforced by the Word slice against this frozen shape).
 */
export type ApprovedRedlineBundle = {
  bundle_id: string;
  bundle_sha256: string;
  review_id: string;
  review_revision: number;
  source_document_id: string;
  source_document_version_id: string;
  source_document_version_sha256: string;
  actions: Array<{
    span: { start: number; end: number };
    before_hash: string;
    after_hash: string;
  }>;
};

/**
 * Ledger contract: Document/storage ownership. Object operations must stay
 * confined to `object_prefix`; download grants are single-use and expiring;
 * deletion that implicates evidence waits for the retention ADR.
 */
export type DocumentStorageOwnership = {
  organization_id: string;
  matter_id?: string;
  project_id: string;
  document_id: string;
  version_hash: string;
  object_prefix: string;
  download_grant?: {
    grant_id: string;
    expires_at: string;
    used_at?: string;
  };
};

/**
 * Ledger contract: Publication intent. Fresh authorization is required before
 * upload and before the DB state update; an unknown outcome is reconciled
 * before any retry; default tests never touch real Drive.
 */
export type PublicationIntent = {
  matter_folder_id: string;
  approved_artifact_sha256: string;
  idempotency_key: string;
  attempts: number;
  outcome: "pending" | "uploaded" | "unknown_outcome" | "reconciled" | "failed";
  provider_file_id?: string;
};

/**
 * Ledger contract: Resource cleanup. Cleanup never adopts foreign resources,
 * never masks the primary failure behind cleanup errors, and never deletes
 * append-only evidence row by row.
 */
export type ResourceCleanupReceipt = {
  owner_labels: Record<string, string>;
  primary_error?: string;
  cleanup_errors: string[];
  zero_residue_verified: boolean;
};
