import { describe, expect, it, vi } from "vitest";

import { provisionInitialOrganization } from "./onboardingProvisioning";
import { createSupabaseOnboardingProvisioningPort } from "./supabaseOnboardingProvisioningPort";

const INPUT = { user_id: "user-1", organization_name: "Firma Uno" };
const ROW = {
  disposition: "created",
  organization_id: "org-1",
  organization_name: "Firma Uno",
  membership_user_id: "user-1",
  membership_role: "org_owner",
  membership_status: "active",
  authorization_epoch: 0,
};

function fakeDb(result: unknown) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { db: { rpc }, rpc };
}

describe("Supabase onboarding provisioning adapter", () => {
  it("calls exactly the atomic RPC and maps its single row", async () => {
    const { db, rpc } = fakeDb({ data: [ROW], error: null });
    const port = createSupabaseOnboardingProvisioningPort(db as never);
    await expect(port.provisionInitialOrganization(INPUT)).resolves.toEqual({
      disposition: "created",
      organization: { organization_id: "org-1", name: "Firma Uno" },
      membership: {
        user_id: "user-1",
        organization_id: "org-1",
        role: "org_owner",
        status: "active",
        authorization_epoch: 0,
      },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("provision_initial_organization", {
      p_user_id: "user-1",
      p_organization_name: "Firma Uno",
    });
    expect(Object.keys(port)).toEqual(["provisionInitialOrganization"]);
  });

  it("maps a reused row without changing the requested operation", async () => {
    const { db } = fakeDb({
      data: [
        { ...ROW, disposition: "reused", organization_name: "Firma Original" },
      ],
      error: null,
    });
    await expect(
      createSupabaseOnboardingProvisioningPort(
        db as never,
      ).provisionInitialOrganization(INPUT),
    ).resolves.toMatchObject({
      disposition: "reused",
      organization: { name: "Firma Original" },
    });
  });

  it.each([
    { data: null, error: null },
    { data: [], error: null },
    { data: [ROW, ROW], error: null },
    { data: ROW, error: null },
    { data: [ROW], error: undefined },
    { data: [ROW], error: { message: "relation secret" } },
  ])(
    "throws one redacted error for malformed/error envelopes",
    async (result) => {
      const { db } = fakeDb(result);
      const promise = createSupabaseOnboardingProvisioningPort(
        db as never,
      ).provisionInitialOrganization(INPUT);
      await expect(promise).rejects.toThrow("onboarding write adapter failed");
      await expect(promise).rejects.not.toThrow(
        /relation|secret|organization_id/,
      );
    },
  );

  it("redacts a thrown RPC error without attaching its cause", async () => {
    const raw = new Error("password=secret table=organizations");
    const db = { rpc: vi.fn().mockRejectedValue(raw) };
    try {
      await createSupabaseOnboardingProvisioningPort(
        db as never,
      ).provisionInitialOrganization(INPUT);
      throw new Error("expected adapter failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("onboarding write adapter failed");
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toMatch(
        /password|secret|organizations/,
      );
    }
  });

  it("composes with the domain and keeps malformed rows fail-closed", async () => {
    const { db } = fakeDb({
      data: [{ ...ROW, membership_role: "viewer" }],
      error: null,
    });
    await expect(
      provisionInitialOrganization(
        INPUT,
        createSupabaseOnboardingProvisioningPort(db as never),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "dependency_failure",
        message: "onboarding provisioning is unavailable",
      },
    });
  });
});
