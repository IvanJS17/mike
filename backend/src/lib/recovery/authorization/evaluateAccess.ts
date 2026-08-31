/**
 * Slice A1 — fail-closed access evaluation (domain only, no persistence).
 *
 * Evaluate whether one authenticated identity may act on one matter inside
 * one organization, purely from explicit inputs. Upstream invariants this
 * module must not weaken:
 *
 * - inactive/missing organization membership denies with generic
 *   non-disclosure (`not_found`) — an outsider cannot distinguish a missing
 *   tenant from a revoked membership;
 * - private matters require explicit active matter membership on top of
 *   active organization membership, and read denial for them is `not_found`;
 * - the authorization epoch invalidates outstanding authorizations: a stale
 *   epoch (or revoked membership) blocks the mutation-time fresh recheck
 *   with an authenticated-but-stale denial (`stale`), distinct from the
 *   outsider `not_found`.
 */

import type { AuthenticatedIdentity } from "../identity/authStateMatrix";
import type {
  MatterMembership,
  MatterRecord,
  OrganizationMembership,
} from "../tenancy/tenancyModel";

/**
 * The authorization scope at grant time. Mirrors the frozen ledger
 * `TenancyScope` shape for the fields the access decision derives; the
 * optional `workspace_id` stays absent here because the A1 decision surface
 * is organization + matter.
 */
export type AuthorizationScope = {
  organization_id: string;
  workspace_id?: string;
  matter_id?: string;
  membership_role: string;
  authorization_epoch: number;
};

/** Read decision: allow, authenticated-but-stale deny, or non-disclosure. */
export type AccessDecision =
  | { outcome: "allow"; scope: AuthorizationScope }
  | { outcome: "denied"; code: "mfa_required"; reason: string }
  | { outcome: "not_found"; reason: string };

/** Why an initial read evaluation did not allow. */
export type AccessDenyReason =
  | "membership_missing_or_inactive"
  | "matter_missing"
  | "matter_not_in_organization"
  | "matter_membership_missing_or_inactive"
  | "mfa_required";

/**
 * Evaluate access for one (identity, membership, matter) triple.
 * Fail-closed: every disagreement resolves to the generic outsider result.
 */
export function evaluateAccess(input: {
  identity: AuthenticatedIdentity;
  membership: OrganizationMembership | null;
  matter: MatterRecord | null;
  matterMembership: MatterMembership | null;
  requiresMfa: boolean;
}): AccessDecision {
  const membership = input.membership;
  if (!membership || membership.status !== "active") {
    return {
      outcome: "not_found",
      reason: "membership_missing_or_inactive",
    };
  }
  const matter = input.matter;
  if (!matter) {
    return {
      outcome: "not_found",
      reason: "matter_missing",
    };
  }
  if (matter.organization_id !== membership.organization_id) {
    return {
      outcome: "not_found",
      reason: "matter_not_in_organization",
    };
  }
  if (
    matter.visibility === "private" &&
    (!input.matterMembership || input.matterMembership.status !== "active")
  ) {
    return {
      outcome: "not_found",
      reason: "matter_membership_missing_or_inactive",
    };
  }
  if (input.requiresMfa && !input.identity.mfa_satisfied) {
    return {
      outcome: "denied",
      code: "mfa_required",
      reason: "mfa_required",
    };
  }
  return {
    outcome: "allow",
    scope: {
      organization_id: membership.organization_id,
      matter_id: matter.matter_id,
      membership_role: membership.role,
      authorization_epoch: membership.authorization_epoch,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fresh authorization recheck (immediately before mutation)
 * ------------------------------------------------------------------ */

export type FreshRecheckInput = {
  /** The exact scope returned by the initial (already allowed) evaluation. */
  scope: AuthorizationScope;
  identity: AuthenticatedIdentity;
  /** Membership as it stands at mutation time. */
  membership: OrganizationMembership | null;
  /** Explicit matter membership at mutation time, when the matter is private. */
  matterMembership?: MatterMembership | null;
  requiresMfa?: boolean;
};

export type FreshRecheckResult =
  | { fresh: true }
  | {
      fresh: false;
      code:
        | "stale_authorization_epoch"
        | "membership_no_longer_active"
        | "matter_membership_no_longer_active"
        | "mfa_required";
      reason: string;
    };

/**
 * Re-run authorization immediately before a mutation. The granted scope is
 * checked against the *current* membership state; any drift — epoch advance,
 * revocation, removal, lapsed assurance — yields a typed stale result and
 * the caller must abort before writing. A stale result never carries a
 * scope, so a deny can never be promoted into an allow by reuse.
 */
export function recheckFreshAuthorization(
  input: FreshRecheckInput,
): FreshRecheckResult {
  const { scope, membership } = input;
  if (!membership || membership.status !== "active") {
    return {
      fresh: false,
      code: "membership_no_longer_active",
      reason: "membership is no longer active at mutation time",
    };
  }
  if (membership.organization_id !== scope.organization_id) {
    return {
      fresh: false,
      code: "stale_authorization_epoch",
      reason: "membership organization changed since grant",
    };
  }
  if (membership.authorization_epoch !== scope.authorization_epoch) {
    return {
      fresh: false,
      code: "stale_authorization_epoch",
      reason: "authorization epoch advanced since grant",
    };
  }
  if (
    scope.matter_id &&
    input.matterMembership &&
    input.matterMembership.status !== "active"
  ) {
    return {
      fresh: false,
      code: "matter_membership_no_longer_active",
      reason: "explicit matter membership is no longer active at mutation time",
    };
  }
  if (input.requiresMfa && !input.identity.mfa_satisfied) {
    return {
      fresh: false,
      code: "mfa_required",
      reason: "assurance is no longer satisfied at mutation time",
    };
  }
  return { fresh: true };
}
