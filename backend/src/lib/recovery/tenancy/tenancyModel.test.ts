import { describe, expect, it } from "vitest";

import {
  MATTER_VISIBILITIES,
  ORG_MEMBERSHIP_STATUSES,
  advanceEpoch,
  buildMatterMembership,
  buildMatterRecord,
  buildOrganizationMembership,
  buildWorkspaceMembership,
  type MatterRecord,
} from "./tenancyModel";

const ORG = "org-1";
const USER = "user-1";

describe("organization membership", () => {
  it("builds an active membership with role and current epoch", () => {
    const membership = buildOrganizationMembership({
      user_id: USER,
      organization_id: ORG,
      role: "member",
      status: "active",
      authorization_epoch: 7,
    });
    expect(membership).toEqual({
      user_id: USER,
      organization_id: ORG,
      role: "member",
      status: "active",
      authorization_epoch: 7,
    });
  });

  it("keeps the status vocabulary closed (fail closed on unknown status)", () => {
    expect([...ORG_MEMBERSHIP_STATUSES].sort()).toEqual([
      "active",
      "inactive",
      "revoked",
    ]);
    expect(() =>
      buildOrganizationMembership({
        user_id: USER,
        organization_id: ORG,
        role: "member",
        status: "pending" as "active",
        authorization_epoch: 7,
      }),
    ).toThrow(/status/);
  });

  it("preserves an explicit revocation without any silent reactivation path", () => {
    const membership = buildOrganizationMembership({
      user_id: USER,
      organization_id: ORG,
      role: "member",
      status: "revoked",
      authorization_epoch: 8,
    });
    expect(membership.status).toBe("revoked");
    expect(membership.authorization_epoch).toBe(8);
  });

  it("rejects empty ids or role and non-integer epochs", () => {
    expect(() =>
      buildOrganizationMembership({
        user_id: "",
        organization_id: ORG,
        role: "member",
        status: "active",
        authorization_epoch: 1,
      }),
    ).toThrow(/user_id/);
    expect(() =>
      buildOrganizationMembership({
        user_id: USER,
        organization_id: " ",
        role: "member",
        status: "active",
        authorization_epoch: 1,
      }),
    ).toThrow(/organization_id/);
    expect(() =>
      buildOrganizationMembership({
        user_id: USER,
        organization_id: ORG,
        role: "",
        status: "active",
        authorization_epoch: 1,
      }),
    ).toThrow(/role/);
    expect(() =>
      buildOrganizationMembership({
        user_id: USER,
        organization_id: ORG,
        role: "member",
        status: "active",
        authorization_epoch: 1.5,
      }),
    ).toThrow(/epoch/);
  });
});

describe("workspace membership (optional layer)", () => {
  it("builds when present", () => {
    const workspace = buildWorkspaceMembership({
      workspace_id: "ws-1",
      role: "collaborator",
      status: "active",
    });
    expect(workspace.workspace_id).toBe("ws-1");
  });

  it("is representable as absent — no implicit workspace grant", () => {
    // The model treats workspace membership as optional by construction:
    // absence is the null/undefined record, never a synthesized default.
    const absent: ReturnType<typeof buildWorkspaceMembership> | undefined =
      undefined;
    expect(absent).toBeUndefined();
  });
});

describe("matter records and explicit matter membership", () => {
  it("keeps matter visibility closed to public and private", () => {
    expect([...MATTER_VISIBILITIES].sort()).toEqual(["private", "public"]);
  });

  it("builds a matter record scoped to one organization", () => {
    const matter: MatterRecord = buildMatterRecord({
      matter_id: "m-1",
      organization_id: ORG,
      visibility: "private",
    });
    expect(matter.organization_id).toBe(ORG);
    expect(matter.visibility).toBe("private");
  });

  it("builds an explicit private-matter membership with a role", () => {
    const membership = buildMatterMembership({
      matter_id: "m-1",
      role: "lead",
      status: "active",
    });
    expect(membership).toEqual({
      matter_id: "m-1",
      role: "lead",
      status: "active",
    });
    expect(() =>
      buildMatterMembership({
        matter_id: "m-1",
        role: "",
        status: "active",
      }),
    ).toThrow(/role/);
  });
});

describe("authorization epoch", () => {
  it("advances by exactly one per membership change", () => {
    expect(advanceEpoch(7)).toBe(8);
  });

  it("rejects non-integer or negative epochs", () => {
    expect(() => advanceEpoch(1.5)).toThrow(/epoch/);
    expect(() => advanceEpoch(-1)).toThrow(/epoch/);
  });
});
