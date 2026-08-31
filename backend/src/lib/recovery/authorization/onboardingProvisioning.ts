/**
 * Slice A1 — onboarding provisioning (typed blocked state).
 *
 * Ledger section 11: "Invitation and onboarding tenant semantics: initial
 * organization/workspace/matter and default role" is a product decision that
 * implementation may not invent. Every provisioning request therefore fails
 * closed with a typed blocked result and no implicit membership grant —
 * onboarding cannot claim completion through this domain.
 */

import {
  makeBlockedOperation,
  type BlockedOperation,
} from "../sharedContracts";

/**
 * Provisioning kinds owned by the undecided onboarding product decision.
 * `default_invitation_role` covers the "default invitation/onboarding role"
 * decision; the others cover initial tenant/workspace/matter creation.
 */
export const ONBOARDING_PROVISIONING_KINDS = [
  "initial_organization",
  "initial_workspace",
  "initial_matter",
  "default_invitation_role",
] as const;

export type OnboardingProvisioningKind =
  (typeof ONBOARDING_PROVISIONING_KINDS)[number];

/** Reasons a provisioning request stays blocked until Iván decides. */
export type OnboardingBlockedReason =
  | "initial_tenant_creation_undecided"
  | "initial_workspace_creation_undecided"
  | "initial_matter_creation_undecided"
  | "default_invitation_role_undecided";

const BLOCKED_REASONS: Record<
  OnboardingProvisioningKind,
  OnboardingBlockedReason
> = {
  initial_organization: "initial_tenant_creation_undecided",
  initial_workspace: "initial_workspace_creation_undecided",
  initial_matter: "initial_matter_creation_undecided",
  default_invitation_role: "default_invitation_role_undecided",
};

const REASON_TEXT: Record<OnboardingBlockedReason, string> = {
  initial_tenant_creation_undecided:
    "initial organization provisioning is a pending product decision (ledger section 11); no membership was granted",
  initial_workspace_creation_undecided:
    "initial workspace provisioning is a pending product decision (ledger section 11); no membership was granted",
  initial_matter_creation_undecided:
    "initial matter provisioning is a pending product decision (ledger section 11); no membership was granted",
  default_invitation_role_undecided:
    "the default invitation/onboarding role is a pending product decision (ledger section 11); no role was selected",
};

/**
 * Request one onboarding provisioning step. Always returns a typed blocked
 * result carrying the shared blocked kind plus the specific provisioning
 * kind requested. There is no code path that creates a tenant, workspace or
 * matter, and none that selects a role.
 */
export function requestOnboardingProvisioning(input: {
  kind: OnboardingProvisioningKind;
}): BlockedOperation<"onboarding_tenant_defaults"> & {
  provisioning_kind: OnboardingProvisioningKind;
} {
  if (
    !(ONBOARDING_PROVISIONING_KINDS as readonly string[]).includes(input.kind)
  ) {
    // Unknown kinds fail closed: no fallback provisioning behavior exists.
    throw new Error("unknown onboarding provisioning kind");
  }
  const reason = BLOCKED_REASONS[input.kind];
  return {
    ...makeBlockedOperation(
      "onboarding_tenant_defaults",
      `${REASON_TEXT[reason]} [${reason}]`,
    ),
    provisioning_kind: input.kind,
  };
}
