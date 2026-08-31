import { describe, expect, it } from "vitest";

import {
  ONBOARDING_PROVISIONING_KINDS,
  requestOnboardingProvisioning,
  type OnboardingProvisioningKind,
} from "./onboardingProvisioning";

describe("onboarding provisioning — typed blocked contract", () => {
  it("declares exactly the undecided provisioning kinds", () => {
    expect([...ONBOARDING_PROVISIONING_KINDS].sort()).toEqual([
      "default_invitation_role",
      "initial_matter",
      "initial_organization",
      "initial_workspace",
    ]);
  });

  it("returns a typed blocked result for initial organization provisioning", () => {
    const result = requestOnboardingProvisioning({
      kind: "initial_organization",
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("onboarding_tenant_defaults");
    expect(result.provisioning_kind).toBe("initial_organization");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("blocks every provisioning kind without selecting a default", () => {
    for (const kind of ONBOARDING_PROVISIONING_KINDS) {
      const result = requestOnboardingProvisioning({ kind });
      expect(result.ok).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.kind).toBe("onboarding_tenant_defaults");
      expect(result.provisioning_kind).toBe(kind);
    }
  });

  it("rejects an unknown provisioning kind instead of falling back", () => {
    expect(() =>
      requestOnboardingProvisioning({
        kind: "surprise_grant" as OnboardingProvisioningKind,
      }),
    ).toThrow(/unknown onboarding provisioning kind/);
  });

  it("never grants implicit membership through a blocked result", () => {
    const result = requestOnboardingProvisioning({
      kind: "default_invitation_role",
    });
    expect(result).not.toHaveProperty("role");
    expect(result).not.toHaveProperty("membership");
    expect(result).not.toHaveProperty("organization_id");
    expect(result).not.toHaveProperty("workspace_id");
    expect(result).not.toHaveProperty("matter_id");
    expect(result).not.toHaveProperty("decision");
  });

  it("carries no secret fields on the blocked result", () => {
    const result = requestOnboardingProvisioning({ kind: "initial_matter" });
    expect(result).not.toHaveProperty("secret");
    expect(result).not.toHaveProperty("credential");
  });
});
