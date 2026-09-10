import { describe, expect, it } from "vitest";

import type { AuthenticatedIdentity } from "../identity/authStateMatrix";
import {
  buildMatterMembership,
  buildMatterRecord,
  buildOrganizationMembership,
  type MatterMembership,
  type MatterRecord,
  type OrganizationMembership,
} from "../tenancy/tenancyModel";
import * as tenancyReadPortModule from "./tenancyReadPort";
import {
  evaluateInitialAccess,
  loadFreshRecheckState,
  recheckFreshAccessViaPort,
  type TenancyReadPort,
} from "./tenancyReadPort";

const ORG = "org-1";
const OTHER_ORG = "org-other";
const WS = "ws-1";
const MATTER = "m-1";
const USER = "user-1";

function identity(
  overrides?: Partial<AuthenticatedIdentity>,
): AuthenticatedIdentity {
  return {
    user_id: USER,
    transport: { kind: "web_session" },
    mfa_satisfied: true,
    ...overrides,
  };
}

function activeOrgMembership(): OrganizationMembership {
  return buildOrganizationMembership({
    user_id: USER,
    organization_id: ORG,
    role: "editor",
    status: "active",
    authorization_epoch: 7,
  });
}

function publicMatter(): MatterRecord {
  return buildMatterRecord({
    matter_id: MATTER,
    workspace_id: WS,
    organization_id: ORG,
    visibility: "public",
  });
}

function privateMatter(): MatterRecord {
  return buildMatterRecord({
    matter_id: MATTER,
    workspace_id: WS,
    organization_id: ORG,
    visibility: "private",
  });
}

function activeMatterMembership(): MatterMembership {
  return buildMatterMembership({
    user_id: USER,
    matter_id: MATTER,
    role: "matter_owner",
    status: "active",
  });
}

type PortCalls = {
  organizationMembership: number;
  matter: number;
  matterMembership: number;
};

function fakePort(state: {
  organizationMembership?: OrganizationMembership | null;
  matter?: MatterRecord | null;
  matterMembership?: MatterMembership | null;
}): { port: TenancyReadPort; calls: PortCalls } {
  const calls: PortCalls = {
    organizationMembership: 0,
    matter: 0,
    matterMembership: 0,
  };
  const org =
    state.organizationMembership === undefined
      ? activeOrgMembership()
      : state.organizationMembership;
  const matter = state.matter === undefined ? publicMatter() : state.matter;
  const matterMembership =
    state.matterMembership === undefined ? null : state.matterMembership;
  return {
    calls,
    port: {
      async getOrganizationMembership() {
        calls.organizationMembership += 1;
        return org;
      },
      async getMatter() {
        calls.matter += 1;
        return matter;
      },
      async getMatterMembership() {
        calls.matterMembership += 1;
        return matterMembership;
      },
    },
  };
}

function evaluate(
  portState: Parameters<typeof fakePort>[0],
  overrides?: {
    identity?: AuthenticatedIdentity;
    requiresMfa?: boolean;
  },
) {
  const { port } = fakePort(portState);
  return evaluateInitialAccess(port, {
    identity: overrides?.identity ?? identity(),
    organization_id: ORG,
    matter_id: MATTER,
    requiresMfa: overrides?.requiresMfa ?? false,
  });
}

function expectDecision(
  result: Awaited<ReturnType<typeof evaluateInitialAccess>>,
): NonNullable<Extract<typeof result, { kind: "decision" }>["decision"]> {
  if (result.kind !== "decision") {
    throw new Error(`expected a domain decision, received ${result.kind}`);
  }
  return result.decision;
}

describe("evaluateInitialAccess — fail-closed orchestration over the read port", () => {
  it("loads the organization membership first and allows an active member on a public matter without reading matter membership", async () => {
    const { port, calls } = fakePort({});
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(calls.organizationMembership).toBe(1);
    expect(calls.matter).toBe(1);
    expect(calls.matterMembership).toBe(0);
    expect(expectDecision(result)).toMatchObject({
      outcome: "allow",
      scope: {
        user_id: USER,
        organization_id: ORG,
        workspace_id: WS,
        matter_id: MATTER,
        membership_role: "editor",
        authorization_epoch: 7,
        requires_explicit_matter_membership: false,
      },
    });
  });

  it("returns opaque not_found without loading the matter when the organization membership is missing", async () => {
    const { port, calls } = fakePort({ organizationMembership: null });
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(calls.organizationMembership).toBe(1);
    expect(calls.matter).toBe(0);
    expect(expectDecision(result)).toEqual({ outcome: "not_found" });
  });

  it("returns opaque not_found without loading the matter when the membership is inactive or belongs to another user", async () => {
    for (const broken of [
      { ...activeOrgMembership(), status: "inactive" as const },
      { ...activeOrgMembership(), user_id: "user-other" },
    ]) {
      const { port, calls } = fakePort({ organizationMembership: broken });
      const result = await evaluateInitialAccess(port, {
        identity: identity(),
        organization_id: ORG,
        matter_id: MATTER,
        requiresMfa: false,
      });
      expect(calls.matter).toBe(0);
      expect(expectDecision(result)).toEqual({ outcome: "not_found" });
    }
  });

  it("returns opaque not_found without loading the matter when persisted organization state violates the closed contract", async () => {
    for (const broken of [
      { ...activeOrgMembership(), role: "admin" },
      { ...activeOrgMembership(), authorization_epoch: -1 },
    ] as OrganizationMembership[]) {
      const { port, calls } = fakePort({ organizationMembership: broken });
      const result = await evaluateInitialAccess(port, {
        identity: identity(),
        organization_id: ORG,
        matter_id: MATTER,
        requiresMfa: false,
      });
      expect(calls.matter).toBe(0);
      expect(expectDecision(result)).toEqual({ outcome: "not_found" });
    }
  });

  it("returns opaque not_found for malformed or wrong-id matter rows without reading matter membership", async () => {
    for (const broken of [
      { ...publicMatter(), workspace_id: "" },
      { ...publicMatter(), matter_id: "m-other" },
      { ...publicMatter(), visibility: "internal" },
    ] as MatterRecord[]) {
      const { port, calls } = fakePort({ matter: broken });
      const result = await evaluateInitialAccess(port, {
        identity: identity(),
        organization_id: ORG,
        matter_id: MATTER,
        requiresMfa: false,
      });
      expect(calls.matterMembership).toBe(0);
      expect(expectDecision(result)).toEqual({ outcome: "not_found" });
    }
  });

  it("returns opaque not_found when the matter does not exist, never reading matter membership", async () => {
    const { port, calls } = fakePort({ matter: null });
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(calls.matter).toBe(1);
    expect(calls.matterMembership).toBe(0);
    expect(expectDecision(result)).toEqual({ outcome: "not_found" });
  });

  it("reads matter membership only for private matters and allows only a matching active row", async () => {
    const priv = await evaluate(
      { matter: privateMatter(), matterMembership: activeMatterMembership() },
      {},
    );
    expect(priv.kind).toBe("decision");
    const privateDecision = expectDecision(priv);
    expect(privateDecision).toMatchObject({
      outcome: "allow",
      scope: { membership_role: "matter_owner" },
    });
  });

  it("stays opaque when a private matter has a missing, inactive or mismatched membership row", async () => {
    for (const row of [
      null,
      { ...activeMatterMembership(), status: "revoked" as const },
      { ...activeMatterMembership(), user_id: "user-other" },
      { ...activeMatterMembership(), matter_id: "m-other" },
    ]) {
      const { port, calls } = fakePort({
        matter: privateMatter(),
        matterMembership: row,
      });
      const result = await evaluateInitialAccess(port, {
        identity: identity(),
        organization_id: ORG,
        matter_id: MATTER,
        requiresMfa: false,
      });
      expect(calls.matterMembership).toBe(1);
      expect(expectDecision(result)).toEqual({ outcome: "not_found" });
    }
  });

  it("stays opaque for a cross-organization matter without reading matter membership", async () => {
    const crossOrg = buildMatterRecord({
      matter_id: MATTER,
      workspace_id: "ws-other",
      organization_id: OTHER_ORG,
      visibility: "public",
    });
    const { port, calls } = fakePort({ matter: crossOrg });
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(calls.matterMembership).toBe(0);
    expect(expectDecision(result)).toEqual({ outcome: "not_found" });
  });

  it("turns any read-port exception into the typed dependency failure with no raw provider detail", async () => {
    const RAW = 'relation "organization_memberships" does not exist';
    const throwingPort: TenancyReadPort = {
      async getOrganizationMembership() {
        throw new Error(RAW);
      },
      async getMatter() {
        throw new Error(RAW);
      },
      async getMatterMembership() {
        throw new Error(RAW);
      },
    };
    // Membership read throws.
    const orgFailure = await evaluateInitialAccess(throwingPort, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(orgFailure).toEqual({ kind: "authorization_dependency_failed" });

    // Matter read throws only after a healthy membership read.
    let orgReads = 0;
    const matterFailurePort: TenancyReadPort = {
      async getOrganizationMembership() {
        orgReads += 1;
        return activeOrgMembership();
      },
      async getMatter() {
        throw new Error(RAW);
      },
      async getMatterMembership() {
        throw new Error(RAW);
      },
    };
    const matterFailure = await evaluateInitialAccess(matterFailurePort, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(orgReads).toBe(1);
    expect(matterFailure).toEqual({
      kind: "authorization_dependency_failed",
    });

    // Matter-membership read throws only after a healthy matter read.
    const privateFailurePort: TenancyReadPort = {
      async getOrganizationMembership() {
        return activeOrgMembership();
      },
      async getMatter() {
        return privateMatter();
      },
      async getMatterMembership() {
        throw new Error(RAW);
      },
    };
    const membershipFailure = await evaluateInitialAccess(privateFailurePort, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(membershipFailure).toEqual({
      kind: "authorization_dependency_failed",
    });

    // The typed value never embeds the raw message.
    expect(JSON.stringify(orgFailure)).not.toContain(RAW);
    expect(JSON.stringify(matterFailure)).not.toContain(RAW);
    expect(JSON.stringify(membershipFailure)).not.toContain(RAW);
  });

  it("never converts a dependency failure into an allow or a not_found decision", async () => {
    // Membership read throws while everything downstream is healthy: the
    // only scenario where a fail-open mutation would yield an allow.
    const failOpenKiller: TenancyReadPort = {
      async getOrganizationMembership() {
        throw new Error("boom");
      },
      async getMatter() {
        return publicMatter();
      },
      async getMatterMembership() {
        return null;
      },
    };
    const result = await evaluateInitialAccess(failOpenKiller, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(result.kind).toBe("authorization_dependency_failed");
    expect(result).not.toHaveProperty("decision");

    const throwingPort: TenancyReadPort = {
      async getOrganizationMembership() {
        throw new Error("boom");
      },
      async getMatter() {
        throw new Error("boom");
      },
      async getMatterMembership() {
        throw new Error("boom");
      },
    };
    const allThrow = await evaluateInitialAccess(throwingPort, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(allThrow.kind).toBe("authorization_dependency_failed");
    expect(allThrow).not.toHaveProperty("decision");
  });

  it("propagates the MFA requirement into the decision", async () => {
    const result = await evaluate(
      {},
      {
        identity: identity({ mfa_satisfied: false }),
        requiresMfa: true,
      },
    );
    expect(expectDecision(result)).toMatchObject({
      outcome: "denied",
      code: "mfa_required",
    });
  });
});

describe("recheckFreshAccessViaPort — mutation-time fresh recheck over the read port", () => {
  async function grantedPrivateScope(epoch = 7) {
    const { port } = fakePort({
      matter: privateMatter(),
      matterMembership: activeMatterMembership(),
    });
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    const decision = expectDecision(result);
    if (decision.outcome !== "allow") {
      throw new Error("test setup: expected initial allow");
    }
    return decision.scope;
  }

  it("returns fresh when the freshly loaded state still matches the grant", async () => {
    const scope = await grantedPrivateScope();
    const { port } = fakePort({
      matter: privateMatter(),
      matterMembership: activeMatterMembership(),
    });
    const result = await recheckFreshAccessViaPort(port, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(result).toEqual({ kind: "recheck", result: { fresh: true } });
  });

  it("detects an advanced organization epoch from freshly loaded state", async () => {
    const scope = await grantedPrivateScope(7);
    const { port, calls } = fakePort({
      organizationMembership: buildOrganizationMembership({
        user_id: USER,
        organization_id: ORG,
        role: "editor",
        status: "active",
        authorization_epoch: 8,
      }),
      matter: privateMatter(),
      matterMembership: activeMatterMembership(),
    });
    const result = await recheckFreshAccessViaPort(port, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(calls.organizationMembership).toBe(1);
    expect(result).toEqual({
      kind: "recheck",
      result: {
        fresh: false,
        code: "stale_authorization_epoch",
        reason: expect.any(String),
      },
    });
  });

  it("detects removed or changed private matter membership at mutation time", async () => {
    const scope = await grantedPrivateScope();
    for (const row of [
      null,
      buildMatterMembership({
        user_id: USER,
        matter_id: MATTER,
        role: "viewer",
        status: "active",
      }),
    ]) {
      const { port } = fakePort({
        matter: privateMatter(),
        matterMembership: row,
      });
      const result = await recheckFreshAccessViaPort(port, {
        scope,
        identity: identity(),
        requiresMfa: false,
      });
      if (result.kind !== "recheck" || result.result.fresh !== false) {
        throw new Error("expected a stale recheck result");
      }
      expect([
        "matter_membership_no_longer_active",
        "matter_membership_mismatch",
      ]).toContain(result.result.code);
    }
  });

  it("loads matter membership only when the granted scope requires explicit membership", async () => {
    const scope = await grantedPrivateScope();
    const publicScope = {
      ...scope,
      requires_explicit_matter_membership: false,
      membership_role: "editor",
    };
    const { port, calls } = fakePort({
      matter: publicMatter(),
    });
    const result = await recheckFreshAccessViaPort(port, {
      scope: publicScope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(calls.matter).toBe(1);
    expect(calls.matterMembership).toBe(0);
    expect(result).toEqual({ kind: "recheck", result: { fresh: true } });
  });

  it("denies when the matter moved workspace or changed visibility after grant", async () => {
    const privateScope = await grantedPrivateScope();
    for (const changedMatter of [
      { ...privateMatter(), workspace_id: "ws-other" },
      { ...privateMatter(), visibility: "public" as const },
    ]) {
      const { port } = fakePort({
        matter: changedMatter,
        matterMembership: activeMatterMembership(),
      });
      const result = await recheckFreshAccessViaPort(port, {
        scope: privateScope,
        identity: identity(),
        requiresMfa: false,
      });
      expect(result).toMatchObject({
        kind: "recheck",
        result: { fresh: false, code: "matter_scope_mismatch" },
      });
    }
  });

  it("denies when the granted matter disappeared at mutation time", async () => {
    const scope = await grantedPrivateScope();
    const { port } = fakePort({
      matter: null,
      matterMembership: activeMatterMembership(),
    });
    const result = await recheckFreshAccessViaPort(port, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(result).toMatchObject({
      kind: "recheck",
      result: { fresh: false, code: "matter_no_longer_available" },
    });
  });

  it("keeps a fresh matter-read failure as authorization_dependency_failed", async () => {
    const scope = await grantedPrivateScope();
    const failingPort: TenancyReadPort = {
      async getOrganizationMembership() {
        return activeOrgMembership();
      },
      async getMatter() {
        throw new Error("relation matters unavailable");
      },
      async getMatterMembership() {
        return activeMatterMembership();
      },
    };
    const result = await recheckFreshAccessViaPort(failingPort, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(result).toEqual({ kind: "authorization_dependency_failed" });
  });

  it("keeps the typed dependency failure at mutation time", async () => {
    const scope = await grantedPrivateScope();
    const failingPort: TenancyReadPort = {
      async getOrganizationMembership() {
        throw new Error("down");
      },
      async getMatter() {
        return privateMatter();
      },
      async getMatterMembership() {
        return activeMatterMembership();
      },
    };
    const result = await recheckFreshAccessViaPort(failingPort, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(result).toEqual({ kind: "authorization_dependency_failed" });
  });
});

describe("read-port surface lock — no provisioning path exists", () => {
  it("exports exactly the recheck/evaluate/load functions and nothing else at runtime", () => {
    expect(Object.keys(tenancyReadPortModule).sort()).toEqual([
      "evaluateInitialAccess",
      "loadFreshRecheckState",
      "recheckFreshAccessViaPort",
    ]);
  });
});
