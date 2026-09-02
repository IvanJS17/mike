import { describe, expect, it } from "vitest";

import {
  provisionInitialOrganization,
  resolveExplicitInvitationRole,
  type InitialOrganizationPersistenceResult,
  type OnboardingProvisioningInput,
  type OnboardingProvisioningPort,
} from "./onboardingProvisioning";

const USER_ID = "user-1";
const ORGANIZATION_ID = "org-1";
const ORGANIZATION_NAME = "Firma Uno";

function successfulPort(): OnboardingProvisioningPort {
  return {
    async provisionInitialOrganization() {
      return {
        disposition: "created",
        organization: {
          organization_id: ORGANIZATION_ID,
          name: ORGANIZATION_NAME,
        },
        membership: {
          user_id: USER_ID,
          organization_id: ORGANIZATION_ID,
          role: "org_owner",
          status: "active",
          authorization_epoch: 0,
        },
      };
    },
  };
}

function malformedPort(result: unknown): OnboardingProvisioningPort {
  return {
    async provisionInitialOrganization() {
      return result as InitialOrganizationPersistenceResult;
    },
  };
}

describe("initial organization onboarding", () => {
  it("returns exactly one organization and its active owner membership", async () => {
    const result = await provisionInitialOrganization(
      { user_id: USER_ID, organization_name: ORGANIZATION_NAME },
      successfulPort(),
    );
    expect(result).toEqual({
      ok: true,
      disposition: "created",
      organization: {
        organization_id: ORGANIZATION_ID,
        name: ORGANIZATION_NAME,
      },
      membership: {
        user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        role: "org_owner",
        status: "active",
        authorization_epoch: 0,
      },
      workspace_provisioned: false,
      matter_provisioned: false,
    });
  });

  it("has one persistence operation and returns no workspace or matter identifier", async () => {
    const port = successfulPort();
    expect(Object.keys(port)).toEqual(["provisionInitialOrganization"]);
    const result = await provisionInitialOrganization(
      { user_id: USER_ID, organization_name: ORGANIZATION_NAME },
      port,
    );
    expect(result).not.toHaveProperty("workspace_id");
    expect(result).not.toHaveProperty("matter_id");
    expect(result.workspace_provisioned).toBe(false);
    expect(result.matter_provisioned).toBe(false);
  });

  it("removes auth transport from the shared domain and persistence input", async () => {
    let received: OnboardingProvisioningInput | undefined;
    const port: OnboardingProvisioningPort = {
      async provisionInitialOrganization(input) {
        received = input;
        return successfulPort().provisionInitialOrganization(input);
      },
    };
    await provisionInitialOrganization(
      {
        user_id: USER_ID,
        organization_name: ORGANIZATION_NAME,
        transport: "google_oauth",
      } as OnboardingProvisioningInput,
      port,
    );
    expect(received).toEqual({
      user_id: USER_ID,
      organization_name: ORGANIZATION_NAME,
    });
  });

  it("delegates retry idempotency to one deterministic atomic operation", async () => {
    let createCount = 0;
    const byUser = new Map<string, InitialOrganizationPersistenceResult>();
    const port: OnboardingProvisioningPort = {
      async provisionInitialOrganization(input) {
        const existing = byUser.get(input.user_id);
        if (existing) return { ...existing, disposition: "reused" };
        createCount += 1;
        const created =
          await successfulPort().provisionInitialOrganization(input);
        byUser.set(input.user_id, created);
        return created;
      },
    };
    const input = { user_id: USER_ID, organization_name: ORGANIZATION_NAME };
    const first = await provisionInitialOrganization(input, port);
    const retry = await provisionInitialOrganization(input, port);
    const renamedRetry = await provisionInitialOrganization(
      { ...input, organization_name: "Ignored retry name" },
      port,
    );
    expect(createCount).toBe(1);
    expect(first.ok && first.disposition).toBe("created");
    expect(retry.ok && retry.disposition).toBe("reused");
    expect(renamedRetry.ok && renamedRetry.disposition).toBe("reused");
    expect(first.ok && retry.ok && retry.organization).toEqual(
      first.ok && first.organization,
    );
    expect(first.ok && retry.ok && retry.membership).toEqual(
      first.ok && first.membership,
    );
  });

  it("rejects empty user and organization names before persistence", async () => {
    let calls = 0;
    const port: OnboardingProvisioningPort = {
      async provisionInitialOrganization() {
        calls += 1;
        return successfulPort().provisionInitialOrganization({
          user_id: USER_ID,
          organization_name: ORGANIZATION_NAME,
        });
      },
    };
    await expect(
      provisionInitialOrganization(
        { user_id: " ", organization_name: ORGANIZATION_NAME },
        port,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "invalid_input", field: "user_id" },
    });
    await expect(
      provisionInitialOrganization(
        { user_id: USER_ID, organization_name: "" },
        port,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "invalid_input", field: "organization_name" },
    });
    expect(calls).toBe(0);
  });

  it("fails closed on mismatched or malformed persistence results", async () => {
    const valid = await successfulPort().provisionInitialOrganization({
      user_id: USER_ID,
      organization_name: ORGANIZATION_NAME,
    });
    const malformed = [
      { ...valid, membership: { ...valid.membership, user_id: "other" } },
      {
        ...valid,
        membership: { ...valid.membership, organization_id: "other" },
      },
      { ...valid, membership: { ...valid.membership, role: "viewer" } },
      { ...valid, membership: { ...valid.membership, status: "inactive" } },
      { ...valid, membership: { ...valid.membership, status: "pending" } },
      {
        ...valid,
        organization: { ...valid.organization, organization_id: "" },
      },
      { ...valid, disposition: "duplicated" },
      null,
    ];
    for (const persisted of malformed) {
      await expect(
        provisionInitialOrganization(
          { user_id: USER_ID, organization_name: ORGANIZATION_NAME },
          malformedPort(persisted),
        ),
      ).resolves.toEqual({
        ok: false,
        error: {
          kind: "dependency_failure",
          message: "onboarding provisioning is unavailable",
        },
      });
    }
  });

  it("redacts thrown persistence errors into one dependency failure", async () => {
    const port: OnboardingProvisioningPort = {
      async provisionInitialOrganization() {
        throw new Error("relation organizations missing; password=secret");
      },
    };
    const result = await provisionInitialOrganization(
      { user_id: USER_ID, organization_name: ORGANIZATION_NAME },
      port,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "dependency_failure",
        message: "onboarding provisioning is unavailable",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/relation|organizations|secret/);
  });
});

describe("explicit invitation roles", () => {
  it("accepts explicit roles from each matching closed vocabulary", () => {
    expect(
      resolveExplicitInvitationRole({
        scope: "organization",
        role: "org_owner",
      }),
    ).toEqual({ ok: true, scope: "organization", role: "org_owner" });
    expect(
      resolveExplicitInvitationRole({
        scope: "workspace",
        role: "workspace_admin",
      }),
    ).toEqual({ ok: true, scope: "workspace", role: "workspace_admin" });
    expect(
      resolveExplicitInvitationRole({ scope: "matter", role: "matter_owner" }),
    ).toEqual({ ok: true, scope: "matter", role: "matter_owner" });
  });

  it("rejects missing, unknown and cross-scope roles without fallback", () => {
    const invalid = [
      { scope: "organization", role: undefined },
      { scope: "organization", role: "" },
      { scope: "organization", role: "surprise" },
      { scope: "workspace", role: "org_owner" },
      { scope: "matter", role: "workspace_admin" },
      { scope: "organization", role: "matter_owner" },
    ] as const;
    for (const input of invalid) {
      expect(resolveExplicitInvitationRole(input)).toEqual({
        ok: false,
        error: { kind: "invalid_invitation_role", scope: input.scope },
      });
    }
  });
});

describe("runtime export surface", () => {
  it("exports only the resolved domain operations and no legacy blocked API", async () => {
    const module = await import("./onboardingProvisioning");
    expect(Object.keys(module).sort()).toEqual([
      "provisionInitialOrganization",
      "resolveExplicitInvitationRole",
    ]);
    expect(module).not.toHaveProperty("requestOnboardingProvisioning");
    expect(module).not.toHaveProperty("ONBOARDING_PROVISIONING_KINDS");
  });
});
