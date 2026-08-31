/**
 * Slice A1 — tenancy model (domain only, no persistence).
 *
 * Ledger contract: Tenancy scope. Represents active organization membership,
 * optional workspace membership, explicit private-matter membership and the
 * authorization epoch used to invalidate outstanding authorizations after a
 * membership change. Pure records and builders: no DB access, no RLS, no
 * route wiring — the coordinator owns schema, migrations and middleware.
 */

/** Closed membership status vocabulary: unknown statuses fail closed. */
export const ORG_MEMBERSHIP_STATUSES = [
  "active",
  "inactive",
  "revoked",
] as const;

export type OrgMembershipStatus = (typeof ORG_MEMBERSHIP_STATUSES)[number];

/** Closed matter visibility vocabulary. */
export const MATTER_VISIBILITIES = ["public", "private"] as const;

export type MatterVisibility = (typeof MATTER_VISIBILITIES)[number];

/** Active organization membership (ledger: organization membership). */
export type OrganizationMembership = {
  user_id: string;
  organization_id: string;
  role: string;
  status: OrgMembershipStatus;
  authorization_epoch: number;
};

/** Optional workspace membership inside one organization. */
export type WorkspaceMembership = {
  user_id: string;
  organization_id: string;
  workspace_id: string;
  role: string;
  status: OrgMembershipStatus;
};

/** Explicit per-matter membership (required for private matters). */
export type MatterMembership = {
  user_id: string;
  matter_id: string;
  role: string;
  status: OrgMembershipStatus;
};

/** A matter record scoped to exactly one organization. */
export type MatterRecord = {
  matter_id: string;
  organization_id: string;
  visibility: MatterVisibility;
};

function assertNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new Error(`tenancy record requires a non-empty ${label}`);
  }
}

function assertStatus(status: OrgMembershipStatus): void {
  if (!(ORG_MEMBERSHIP_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `organization membership has an invalid status: ${String(status)}`,
    );
  }
}

function assertEpoch(epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(
      "tenancy record requires a non-negative integer authorization epoch",
    );
  }
}

export function buildOrganizationMembership(
  input: OrganizationMembership,
): OrganizationMembership {
  assertNonEmpty(input.user_id, "user_id");
  assertNonEmpty(input.organization_id, "organization_id");
  assertNonEmpty(input.role, "role");
  assertStatus(input.status);
  assertEpoch(input.authorization_epoch);
  return { ...input };
}

export function buildWorkspaceMembership(
  input: WorkspaceMembership,
): WorkspaceMembership {
  assertNonEmpty(input.user_id, "user_id");
  assertNonEmpty(input.organization_id, "organization_id");
  assertNonEmpty(input.workspace_id, "workspace_id");
  assertNonEmpty(input.role, "role");
  assertStatus(input.status);
  return { ...input };
}

export function buildMatterMembership(
  input: MatterMembership,
): MatterMembership {
  assertNonEmpty(input.user_id, "user_id");
  assertNonEmpty(input.matter_id, "matter_id");
  assertNonEmpty(input.role, "role");
  assertStatus(input.status);
  return { ...input };
}

export function buildMatterRecord(input: MatterRecord): MatterRecord {
  assertNonEmpty(input.matter_id, "matter_id");
  assertNonEmpty(input.organization_id, "organization_id");
  if (!(MATTER_VISIBILITIES as readonly string[]).includes(input.visibility)) {
    throw new Error(
      `matter record has an invalid visibility: ${String(input.visibility)}`,
    );
  }
  return { ...input };
}

/**
 * Advance the authorization epoch by exactly one after a membership change.
 * Callers use the new epoch to invalidate outstanding authorizations.
 */
export function advanceEpoch(current: number): number {
  assertEpoch(current);
  return current + 1;
}
