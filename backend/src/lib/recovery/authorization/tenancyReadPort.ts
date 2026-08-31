/**
 * Slice A2b1 — fail-closed tenancy read port (interface + orchestrator).
 *
 * The port abstracts exactly the three reads the authorization domain needs
 * from persistence: the caller's organization membership, the matter record
 * and, only for private matters, the explicit matter membership. The next
 * slice implements this interface against Supabase; nothing here may depend
 * on a database client.
 *
 * Fail-closed guarantees orchestrated here:
 * - organization membership is loaded first; missing/inactive/mismatched
 *   membership short-circuits to an opaque `not_found` before the matter is
 *   read at all;
 * - the matter is only looked up after an active matching membership, and a
 *   cross-organization matter is the same opaque `not_found`;
 * - public matters never trigger a matter-membership read; private matters
 *   do, and any disagreement on that row stays opaque;
 * - a read-port throw is a typed `authorization_dependency_failed` result —
 *   never an allow, never a raw DB error, table name or existence leak.
 */

import type { AuthenticatedIdentity } from "../identity/authStateMatrix";
import {
  buildMatterMembership,
  buildMatterRecord,
  buildOrganizationMembership,
  type MatterMembership,
  type MatterRecord,
  type OrganizationMembership,
} from "../tenancy/tenancyModel";
import {
  evaluateAccess,
  recheckFreshAuthorization,
  type AccessDecision,
  type AuthorizationScope,
  type FreshRecheckResult,
} from "./evaluateAccess";

/** Persistence reads required by the authorization domain (injected). */
export interface TenancyReadPort {
  getOrganizationMembership(input: {
    user_id: string;
    organization_id: string;
  }): Promise<OrganizationMembership | null>;
  getMatter(input: { matter_id: string }): Promise<MatterRecord | null>;
  getMatterMembership(input: {
    user_id: string;
    matter_id: string;
  }): Promise<MatterMembership | null>;
}

/**
 * Result of a port-backed evaluation. Exactly one of:
 * - a domain decision (`allow` / `denied` / `not_found`); or
 * - a typed internal dependency failure carrying no provider detail.
 */
export type PortBackedAccessResult =
  | { kind: "decision"; decision: AccessDecision }
  | { kind: "authorization_dependency_failed" };

/** Build the single typed value returned when the read port throws. */
function dependencyFailed(): PortBackedAccessResult {
  return { kind: "authorization_dependency_failed" };
}

/**
 * Evaluate initial access for one identity against one organization and one
 * matter, loading state through the injected port in fail-closed order:
 * organization membership → matter → (private only) matter membership.
 */
export async function evaluateInitialAccess(
  port: TenancyReadPort,
  input: {
    identity: AuthenticatedIdentity;
    organization_id: string;
    matter_id: string;
    requiresMfa: boolean;
  },
): Promise<PortBackedAccessResult> {
  let membership: OrganizationMembership | null;
  try {
    membership = await port.getOrganizationMembership({
      user_id: input.identity.user_id,
      organization_id: input.organization_id,
    });
  } catch {
    return dependencyFailed();
  }
  if (membership) {
    try {
      membership = buildOrganizationMembership(membership);
    } catch {
      return { kind: "decision", decision: { outcome: "not_found" } };
    }
  }
  if (
    !membership ||
    membership.status !== "active" ||
    membership.user_id !== input.identity.user_id ||
    membership.organization_id !== input.organization_id
  ) {
    return { kind: "decision", decision: { outcome: "not_found" } };
  }

  let matter: MatterRecord | null;
  try {
    matter = await port.getMatter({ matter_id: input.matter_id });
  } catch {
    return dependencyFailed();
  }
  if (matter) {
    try {
      matter = buildMatterRecord(matter);
    } catch {
      return { kind: "decision", decision: { outcome: "not_found" } };
    }
  }
  if (
    !matter ||
    matter.matter_id !== input.matter_id ||
    matter.organization_id !== membership.organization_id
  ) {
    return { kind: "decision", decision: { outcome: "not_found" } };
  }

  let matterMembership: MatterMembership | null = null;
  if (matter.visibility === "private") {
    try {
      matterMembership = await port.getMatterMembership({
        user_id: input.identity.user_id,
        matter_id: input.matter_id,
      });
    } catch {
      return dependencyFailed();
    }
    if (matterMembership) {
      try {
        matterMembership = buildMatterMembership(matterMembership);
      } catch {
        // An out-of-vocabulary persisted row must not crash the boundary;
        // it fails closed below like any other disagreement.
        return { kind: "decision", decision: { outcome: "not_found" } };
      }
    }
  }

  const decision = evaluateAccess({
    identity: input.identity,
    membership,
    matter,
    matterMembership,
    requiresMfa: input.requiresMfa,
  });
  return { kind: "decision", decision };
}

/**
 * Load the fresh tenancy state a mutation-time recheck needs for an already
 * granted scope: the current organization membership and matter always, plus
 * the current explicit matter membership only when the unchanged scope still
 * requires it (private matter). Port throws surface as the typed dependency
 * failure; persisted rows that no longer satisfy their closed vocabularies
 * fail closed to `null` rather than crashing the recheck.
 */
export async function loadFreshRecheckState(
  port: TenancyReadPort,
  scope: AuthorizationScope,
): Promise<
  | {
      kind: "state";
      membership: OrganizationMembership | null;
      matter: MatterRecord | null;
      matterMembership: MatterMembership | null;
    }
  | { kind: "authorization_dependency_failed" }
> {
  let membership: OrganizationMembership | null;
  try {
    membership = await port.getOrganizationMembership({
      user_id: scope.user_id,
      organization_id: scope.organization_id,
    });
  } catch {
    return { kind: "authorization_dependency_failed" };
  }
  if (membership) {
    try {
      membership = buildOrganizationMembership(membership);
    } catch {
      membership = null;
    }
  }

  let matter: MatterRecord | null = null;
  const canLoadMatter =
    membership !== null &&
    membership.status === "active" &&
    membership.user_id === scope.user_id &&
    membership.organization_id === scope.organization_id;
  if (canLoadMatter) {
    try {
      const loaded = await port.getMatter({ matter_id: scope.matter_id });
      if (loaded) {
        try {
          matter = buildMatterRecord(loaded);
        } catch {
          matter = null;
        }
      }
    } catch {
      return { kind: "authorization_dependency_failed" };
    }
  }

  const matterMatchesScope =
    matter !== null &&
    matter.matter_id === scope.matter_id &&
    matter.organization_id === scope.organization_id &&
    matter.workspace_id === scope.workspace_id &&
    (matter.visibility === "private") ===
      scope.requires_explicit_matter_membership;

  let matterMembership: MatterMembership | null = null;
  if (scope.requires_explicit_matter_membership && matterMatchesScope) {
    try {
      const loaded = await port.getMatterMembership({
        user_id: scope.user_id,
        matter_id: scope.matter_id,
      });
      if (loaded) {
        try {
          matterMembership = buildMatterMembership(loaded);
        } catch {
          matterMembership = null;
        }
      }
    } catch {
      return { kind: "authorization_dependency_failed" };
    }
  }

  return { kind: "state", membership, matter, matterMembership };
}

/**
 * Mutation-time fresh recheck for an already granted `AuthorizationScope`.
 * Loads the current state through the port (organization membership and matter
 * always; explicit matter membership only when the unchanged scope requires
 * it) and delegates to the domain `recheckFreshAuthorization`. A stale result
 * stays stale, the typed dependency failure stays typed, and no port throw can
 * ever be promoted into a fresh authorization.
 */
export async function recheckFreshAccessViaPort(
  port: TenancyReadPort,
  input: {
    scope: AuthorizationScope;
    identity: AuthenticatedIdentity;
    requiresMfa: boolean;
  },
): Promise<
  | { kind: "recheck"; result: FreshRecheckResult }
  | { kind: "authorization_dependency_failed" }
> {
  const loaded = await loadFreshRecheckState(port, input.scope);
  if (loaded.kind === "authorization_dependency_failed") {
    return { kind: "authorization_dependency_failed" };
  }
  return {
    kind: "recheck",
    result: recheckFreshAuthorization({
      scope: input.scope,
      identity: input.identity,
      membership: loaded.membership,
      matter: loaded.matter,
      matterMembership: loaded.matterMembership,
      requiresMfa: input.requiresMfa,
    }),
  };
}
