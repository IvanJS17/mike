import {
  MATTER_ROLES,
  ORGANIZATION_ROLES,
  WORKSPACE_ROLES,
  buildOrganizationMembership,
  type MatterRole,
  type OrganizationMembership,
  type OrganizationRole,
  type WorkspaceRole,
} from "../tenancy/tenancyModel";

export type OnboardingProvisioningInput = {
  user_id: string;
  organization_name: string;
};

export type InitialOrganizationPersistenceResult = {
  disposition: "created" | "reused";
  organization: {
    organization_id: string;
    name: string;
  };
  membership: OrganizationMembership;
};

export interface OnboardingProvisioningPort {
  provisionInitialOrganization(
    input: OnboardingProvisioningInput,
  ): Promise<InitialOrganizationPersistenceResult>;
}

type OnboardingSuccess = {
  ok: true;
  disposition: "created" | "reused";
  organization: InitialOrganizationPersistenceResult["organization"];
  membership: OrganizationMembership & {
    role: "org_owner";
    status: "active";
  };
  workspace_provisioned: false;
  matter_provisioned: false;
};

type InvalidOnboardingInput = {
  ok: false;
  error: {
    kind: "invalid_input";
    field: "user_id" | "organization_name";
  };
};

type OnboardingDependencyFailure = {
  ok: false;
  error: {
    kind: "dependency_failure";
    message: "onboarding provisioning is unavailable";
  };
};

export type OnboardingProvisioningResult =
  | OnboardingSuccess
  | InvalidOnboardingInput
  | OnboardingDependencyFailure;

function dependencyFailure(): OnboardingDependencyFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      kind: "dependency_failure",
      message: "onboarding provisioning is unavailable",
    }),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function validatePersistenceResult(
  value: unknown,
  input: OnboardingProvisioningInput,
): InitialOrganizationPersistenceResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!hasExactKeys(value, ["disposition", "membership", "organization"])) {
    return undefined;
  }
  const persisted = value as Partial<InitialOrganizationPersistenceResult>;
  if (
    persisted.disposition !== "created" &&
    persisted.disposition !== "reused"
  ) {
    return undefined;
  }
  if (!persisted.organization || !persisted.membership) return undefined;
  const organization = persisted.organization;
  if (
    !hasExactKeys(organization, ["name", "organization_id"]) ||
    !hasExactKeys(persisted.membership, [
      "authorization_epoch",
      "organization_id",
      "role",
      "status",
      "user_id",
    ]) ||
    !isNonEmptyString(organization.organization_id) ||
    !isNonEmptyString(organization.name) ||
    (persisted.disposition === "created" &&
      organization.name !== input.organization_name)
  ) {
    return undefined;
  }
  try {
    const membership = buildOrganizationMembership(persisted.membership);
    if (
      membership.user_id !== input.user_id ||
      membership.organization_id !== organization.organization_id ||
      membership.role !== "org_owner" ||
      membership.status !== "active"
    ) {
      return undefined;
    }
    return {
      disposition: persisted.disposition,
      organization: {
        organization_id: organization.organization_id,
        name: organization.name,
      },
      membership: {
        user_id: membership.user_id,
        organization_id: membership.organization_id,
        role: membership.role,
        status: membership.status,
        authorization_epoch: membership.authorization_epoch,
      },
    };
  } catch {
    return undefined;
  }
}

export async function provisionInitialOrganization(
  input: OnboardingProvisioningInput,
  port: OnboardingProvisioningPort,
): Promise<OnboardingProvisioningResult> {
  if (!isNonEmptyString(input.user_id)) {
    return { ok: false, error: { kind: "invalid_input", field: "user_id" } };
  }
  if (!isNonEmptyString(input.organization_name)) {
    return {
      ok: false,
      error: { kind: "invalid_input", field: "organization_name" },
    };
  }

  try {
    const persistenceInput = {
      user_id: input.user_id,
      organization_name: input.organization_name,
    };
    const persisted = validatePersistenceResult(
      await port.provisionInitialOrganization(persistenceInput),
      persistenceInput,
    );
    if (!persisted) return dependencyFailure();
    return {
      ok: true,
      ...persisted,
      membership: {
        ...persisted.membership,
        role: "org_owner",
        status: "active",
      },
      workspace_provisioned: false,
      matter_provisioned: false,
    };
  } catch {
    return dependencyFailure();
  }
}

export type InvitationScope = "organization" | "workspace" | "matter";

export type ExplicitInvitationRoleInput = {
  scope: InvitationScope;
  role?: string | null;
};

export type InvitationRoleResolutionResult =
  | { ok: true; scope: "organization"; role: OrganizationRole }
  | { ok: true; scope: "workspace"; role: WorkspaceRole }
  | { ok: true; scope: "matter"; role: MatterRole }
  | {
      ok: false;
      error: { kind: "invalid_invitation_role"; scope: InvitationScope };
    }
  | {
      ok: false;
      error: { kind: "invalid_invitation_scope" };
    };

export function resolveExplicitInvitationRole(
  input: ExplicitInvitationRoleInput,
): InvitationRoleResolutionResult {
  const vocabularies = {
    organization: ORGANIZATION_ROLES,
    workspace: WORKSPACE_ROLES,
    matter: MATTER_ROLES,
  } as const;
  if (!Object.prototype.hasOwnProperty.call(vocabularies, input.scope)) {
    return { ok: false, error: { kind: "invalid_invitation_scope" } };
  }
  const vocabulary = vocabularies[input.scope] as readonly string[];
  if (!input.role || !vocabulary.includes(input.role)) {
    return {
      ok: false,
      error: { kind: "invalid_invitation_role", scope: input.scope },
    };
  }
  if (input.scope === "organization") {
    return {
      ok: true,
      scope: input.scope,
      role: input.role as OrganizationRole,
    };
  }
  if (input.scope === "workspace") {
    return { ok: true, scope: input.scope, role: input.role as WorkspaceRole };
  }
  return { ok: true, scope: input.scope, role: input.role as MatterRole };
}
