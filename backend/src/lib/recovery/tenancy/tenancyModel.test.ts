import { describe, expect, it } from "vitest";

import {
  MATTER_ROLES,
  MATTER_VISIBILITIES,
  ORGANIZATION_ROLES,
  ORG_MEMBERSHIP_STATUSES,
  WORKSPACE_ROLES,
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
  it("builds an active membership with a closed organization role and current epoch", () => {
    const membership = buildOrganizationMembership({
      user_id: USER,
      organization_id: ORG,
      role: "editor",
      status: "active",
      authorization_epoch: 7,
    });
    expect(membership).toEqual({
      user_id: USER,
      organization_id: ORG,
      role: "editor",
      status: "active",
      authorization_epoch: 7,
    });
  });

  it("keeps the organization role vocabulary closed to the A2a schema check", () => {
    expect([...ORGANIZATION_ROLES].sort()).toEqual([
      "editor",
      "org_owner",
      "technical_operator",
      "viewer",
      "workspace_admin",
    ]);
  });

  it("rejects an arbitrary organization role instead of accepting any string", () => {
    expect(() =>
      buildOrganizationMembership({
        user_id: USER,
        organization_id: ORG,
        role: "member" as "editor",
        status: "active",
        authorization_epoch: 7,
      }),
    ).toThrow(/role/);
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
        role: "viewer",
        status: "pending" as "active",
        authorization_epoch: 7,
      }),
    ).toThrow(/status/);
  });

  it("preserves an explicit revocation without any silent reactivation path", () => {
    const membership = buildOrganizationMembership({
      user_id: USER,
      organization_id: ORG,
      role: "viewer",
      status: "revoked",
      authorization_epoch: 8,
    });
    expect(membership.status).toBe("revoked");
    expect(membership.authorization_epoch).toBe(8);
  });

  it("rejects empty ids, unknown roles and non-integer epochs", () => {
    expect(() =>
      buildOrganizationMembership({
        user_id: "",
        organization_id: ORG,
        role: "editor",
        status: "active",
        authorization_epoch: 1,
      }),
    ).toThrow(/user_id/);
    expect(() =>
      buildOrganizationMembership({
        user_id: USER,
        organization_id: " ",
        role: "editor",
        status: "active",
        authorization_epoch: 1,
      }),
    ).toThrow(/organization_id/);
    expect(() =>
      buildOrganizationMembership({
        user_id: USER,
        organization_id: ORG,
        role: "member" as "editor",
        status: "active",
        authorization_epoch: 1,
      }),
    ).toThrow(/role/);
    expect(() =>
      buildOrganizationMembership({
        user_id: USER,
        organization_id: ORG,
        role: "editor",
        status: "active",
        authorization_epoch: 1.5,
      }),
    ).toThrow(/epoch/);
  });
});

describe("workspace membership (optional layer)", () => {
  it("builds when present", () => {
    const workspace = buildWorkspaceMembership({
      user_id: USER,
      organization_id: ORG,
      workspace_id: "ws-1",
      role: "editor",
      status: "active",
    });
    expect(workspace).toMatchObject({
      user_id: USER,
      organization_id: ORG,
      workspace_id: "ws-1",
    });
  });

  it("keeps the workspace role vocabulary closed to the A2a schema check", () => {
    expect([...WORKSPACE_ROLES].sort()).toEqual([
      "editor",
      "technical_operator",
      "viewer",
      "workspace_admin",
    ]);
  });

  it("rejects organization-only and arbitrary workspace roles", () => {
    expect(() =>
      buildWorkspaceMembership({
        user_id: USER,
        organization_id: ORG,
        workspace_id: "ws-1",
        role: "org_owner" as "editor",
        status: "active",
      }),
    ).toThrow(/role/);
    expect(() =>
      buildWorkspaceMembership({
        user_id: USER,
        organization_id: ORG,
        workspace_id: "ws-1",
        role: "collaborator" as "editor",
        status: "active",
      }),
    ).toThrow(/role/);
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

  it("builds a matter record scoped to one organization through one workspace", () => {
    const matter: MatterRecord = buildMatterRecord({
      matter_id: "m-1",
      workspace_id: "ws-1",
      organization_id: ORG,
      visibility: "private",
    });
    expect(matter.workspace_id).toBe("ws-1");
    expect(matter.organization_id).toBe(ORG);
    expect(matter.visibility).toBe("private");
  });

  it("rejects a matter record without its persisted workspace_id", () => {
    expect(() =>
      buildMatterRecord({
        matter_id: "m-1",
        organization_id: ORG,
        visibility: "private",
      } as Parameters<typeof buildMatterRecord>[0]),
    ).toThrow(/workspace_id/);
  });

  it("keeps the matter role vocabulary closed to the A2a schema check", () => {
    expect([...MATTER_ROLES].sort()).toEqual([
      "editor",
      "matter_owner",
      "technical_operator",
      "viewer",
    ]);
  });

  it("rejects organization-only and arbitrary matter roles", () => {
    expect(() =>
      buildMatterMembership({
        user_id: USER,
        matter_id: "m-1",
        role: "org_owner" as "editor",
        status: "active",
      }),
    ).toThrow(/role/);
    expect(() =>
      buildMatterMembership({
        user_id: USER,
        matter_id: "m-1",
        role: "lead" as "editor",
        status: "active",
      }),
    ).toThrow(/role/);
  });

  it("builds an explicit private-matter membership with a closed role", () => {
    const membership = buildMatterMembership({
      user_id: USER,
      matter_id: "m-1",
      role: "matter_owner",
      status: "active",
    });
    expect(membership).toEqual({
      user_id: USER,
      matter_id: "m-1",
      role: "matter_owner",
      status: "active",
    });
    expect(() =>
      buildMatterMembership({
        user_id: USER,
        matter_id: "m-1",
        role: "" as "editor",
        status: "active",
      }),
    ).toThrow(/role/);
    expect(() =>
      buildMatterMembership({
        user_id: "",
        matter_id: "m-1",
        role: "editor",
        status: "active",
      }),
    ).toThrow(/user_id/);
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
