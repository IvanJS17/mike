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
  MatterRole,
  OrganizationMembership,
  OrganizationRole,
} from "../tenancy/tenancyModel";

/**
 * The authorization scope at grant time. Mirrors the frozen ledger
 * `TenancyScope` shape for the fields the access decision derives and carries
 * the matter's persisted `workspace_id`, preserving the
 * organization→workspace→matter hierarchy in every granted scope.
 */
export type AuthorizationScope = {
  user_id: string;
  organization_id: string;
  workspace_id: string;
  matter_id: string;
  membership_role: OrganizationRole | MatterRole;
  authorization_epoch: number;
  requires_explicit_matter_membership: boolean;
};

/** Read decision: allow, authenticated-but-stale deny, or non-disclosure. */
export type AccessDecision =
  | { outcome: "allow"; scope: AuthorizationScope }
  | { outcome: "denied"; code: "mfa_required"; reason: string }
  | { outcome: "not_found" };

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
  if (
    !membership ||
    membership.status !== "active" ||
    membership.user_id !== input.identity.user_id
  ) {
    return { outcome: "not_found" };
  }
  const matter = input.matter;
  if (!matter) {
    return { outcome: "not_found" };
  }
  if (matter.organization_id !== membership.organization_id) {
    return { outcome: "not_found" };
  }
  const requiresExplicitMatterMembership = matter.visibility === "private";
  const matterMembership = input.matterMembership;
  if (
    requiresExplicitMatterMembership &&
    (!matterMembership ||
      matterMembership.status !== "active" ||
      matterMembership.user_id !== input.identity.user_id ||
      matterMembership.matter_id !== matter.matter_id)
  ) {
    return { outcome: "not_found" };
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
      user_id: input.identity.user_id,
      organization_id: membership.organization_id,
      workspace_id: matter.workspace_id,
      matter_id: matter.matter_id,
      membership_role: requiresExplicitMatterMembership
        ? matterMembership!.role
        : membership.role,
      authorization_epoch: membership.authorization_epoch,
      requires_explicit_matter_membership: requiresExplicitMatterMembership,
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
  /** Matter as it stands at mutation time. */
  matter: MatterRecord | null;
  /** Explicit matter membership at mutation time, when the matter is private. */
  matterMembership?: MatterMembership | null;
  requiresMfa?: boolean;
};

export type FreshRecheckResult =
  | { fresh: true }
  | {
      fresh: false;
      code:
        | "identity_mismatch"
        | "stale_authorization_epoch"
        | "membership_no_longer_active"
        | "matter_no_longer_available"
        | "matter_scope_mismatch"
        | "matter_membership_no_longer_active"
        | "matter_membership_mismatch"
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
  if (input.identity.user_id !== scope.user_id) {
    return {
      fresh: false,
      code: "identity_mismatch",
      reason: "authenticated user differs from the granted scope",
    };
  }
  if (
    !membership ||
    membership.status !== "active" ||
    membership.user_id !== scope.user_id
  ) {
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
  const matter = input.matter;
  if (!matter) {
    return {
      fresh: false,
      code: "matter_no_longer_available",
      reason: "matter is no longer available at mutation time",
    };
  }
  const currentRequiresExplicitMembership = matter.visibility === "private";
  if (
    matter.matter_id !== scope.matter_id ||
    matter.organization_id !== scope.organization_id ||
    matter.workspace_id !== scope.workspace_id ||
    currentRequiresExplicitMembership !==
      scope.requires_explicit_matter_membership
  ) {
    return {
      fresh: false,
      code: "matter_scope_mismatch",
      reason: "matter scope changed since grant",
    };
  }
  if (scope.requires_explicit_matter_membership) {
    const matterMembership = input.matterMembership;
    if (!matterMembership || matterMembership.status !== "active") {
      return {
        fresh: false,
        code: "matter_membership_no_longer_active",
        reason:
          "explicit matter membership is no longer active at mutation time",
      };
    }
    if (
      matterMembership.user_id !== scope.user_id ||
      matterMembership.matter_id !== scope.matter_id ||
      matterMembership.role !== scope.membership_role
    ) {
      return {
        fresh: false,
        code: "matter_membership_mismatch",
        reason:
          "explicit matter membership no longer matches the granted scope",
      };
    }
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
