import { describe, expect, it } from "vitest";

import type { AuthenticatedIdentity } from "../identity/authStateMatrix";
import {
  buildMatterMembership,
  buildMatterRecord,
  buildOrganizationMembership,
  advanceEpoch,
  type MatterMembership,
  type MatterRecord,
  type OrganizationMembership,
} from "../tenancy/tenancyModel";
import { evaluateAccess, recheckFreshAuthorization } from "./evaluateAccess";

const ORG = "org-1";
const USER = "user-1";

function activeIdentity(): AuthenticatedIdentity {
  return {
    user_id: USER,
    transport: { kind: "web_session" },
    mfa_satisfied: true,
  };
}

function activeMembership(epoch = 7): OrganizationMembership {
  return buildOrganizationMembership({
    user_id: USER,
    organization_id: ORG,
    role: "member",
    status: "active",
    authorization_epoch: epoch,
  });
}

function publicMatter(): MatterRecord {
  return buildMatterRecord({
    matter_id: "m-1",
    organization_id: ORG,
    visibility: "public",
  });
}

function privateMatter(): MatterRecord {
  return buildMatterRecord({
    matter_id: "m-1",
    organization_id: ORG,
    visibility: "private",
  });
}

function matterMembership(
  status: "active" | "revoked" = "active",
): MatterMembership {
  return buildMatterMembership({ matter_id: "m-1", role: "lead", status });
}

function evaluate(overrides: {
  identity?: AuthenticatedIdentity;
  membership?: OrganizationMembership | null;
  matter?: MatterRecord | null;
  matterMembership?: MatterMembership | null;
  requiresMfa?: boolean;
}) {
  return evaluateAccess({
    identity: overrides.identity ?? activeIdentity(),
    membership:
      overrides.membership === undefined
        ? activeMembership()
        : overrides.membership,
    matter: overrides.matter === undefined ? publicMatter() : overrides.matter,
    matterMembership:
      overrides.matterMembership === undefined
        ? null
        : overrides.matterMembership,
    requiresMfa: overrides.requiresMfa ?? false,
  });
}

describe("evaluateAccess — adversarial tenancy matrix", () => {
  it("allows an active org member on a public matter with the current epoch", () => {
    const decision = evaluate({});
    expect(decision).toMatchObject({
      outcome: "allow",
      scope: {
        organization_id: ORG,
        matter_id: "m-1",
        membership_role: "member",
        authorization_epoch: 7,
      },
    });
  });

  it("returns generic non-disclosure for a missing org membership", () => {
    const decision = evaluate({ membership: null });
    expect(decision).toMatchObject({ outcome: "not_found" });
    if (decision.outcome === "not_found") {
      // The reason must not leak tenant, workspace or matter existence.
      expect(decision.reason).not.toMatch(/org|matter|tenant|workspace/i);
    }
  });

  it("returns generic non-disclosure for an inactive org membership", () => {
    const decision = evaluate({
      membership: { ...activeMembership(), status: "inactive" },
    });
    expect(decision).toMatchObject({ outcome: "not_found" });
  });

  it("returns generic non-disclosure for a revoked org membership", () => {
    const decision = evaluate({
      membership: { ...activeMembership(), status: "revoked" },
    });
    expect(decision).toMatchObject({ outcome: "not_found" });
  });

  it("returns not_found for a private matter without explicit matter membership", () => {
    const decision = evaluate({
      matter: privateMatter(),
      matterMembership: null,
    });
    expect(decision).toMatchObject({ outcome: "not_found" });
  });

  it("returns not_found for a private matter with an inactive matter membership", () => {
    const decision = evaluate({
      matter: privateMatter(),
      matterMembership: matterMembership("revoked"),
    });
    expect(decision).toMatchObject({ outcome: "not_found" });
  });

  it("allows a private matter with explicit active membership, carrying the role", () => {
    const decision = evaluate({
      matter: privateMatter(),
      matterMembership: matterMembership("active"),
    });
    expect(decision).toMatchObject({
      outcome: "allow",
      scope: { matter_id: "m-1", membership_role: "member" },
    });
  });

  it("returns not_found when the matter belongs to another organization", () => {
    const crossTenant = buildMatterRecord({
      matter_id: "m-2",
      organization_id: "org-other",
      visibility: "public",
    });
    const decision = evaluate({ matter: crossTenant });
    expect(decision).toMatchObject({ outcome: "not_found" });
  });

  it("returns not_found when the matter does not exist", () => {
    const decision = evaluate({ matter: null });
    expect(decision).toMatchObject({ outcome: "not_found" });
  });

  it("denies an MFA-required operation with unsatisfied assurance", () => {
    const decision = evaluate({
      identity: { ...activeIdentity(), mfa_satisfied: false },
      requiresMfa: true,
    });
    expect(decision).toMatchObject({
      outcome: "denied",
      code: "mfa_required",
    });
  });

  it("never trades non-disclosure for an MFA message (outsider stays not_found)", () => {
    const decision = evaluate({
      identity: { ...activeIdentity(), mfa_satisfied: false },
      membership: null,
      requiresMfa: true,
    });
    expect(decision).toMatchObject({ outcome: "not_found" });
  });
});

describe("recheckFreshAuthorization — mutation-time fresh authorization", () => {
  function scopeFor(epoch = 7, matterId?: string) {
    const decision = evaluateAccess({
      identity: activeIdentity(),
      membership: activeMembership(epoch),
      matter: buildMatterRecord({
        matter_id: matterId ?? "m-1",
        organization_id: ORG,
        visibility: "public",
      }),
      matterMembership: null,
      requiresMfa: false,
    });
    if (decision.outcome !== "allow") {
      throw new Error("test setup: expected initial allow");
    }
    return decision.scope;
  }

  it("passes when nothing changed since the initial grant", () => {
    const result = recheckFreshAuthorization({
      scope: scopeFor(),
      identity: activeIdentity(),
      membership: activeMembership(7),
    });
    expect(result).toMatchObject({ fresh: true });
  });

  it("denies when the epoch advanced between check and mutation recheck", () => {
    const result = recheckFreshAuthorization({
      scope: scopeFor(7),
      identity: activeIdentity(),
      membership: activeMembership(advanceEpoch(7)),
    });
    expect(result).toMatchObject({
      fresh: false,
      code: "stale_authorization_epoch",
    });
  });

  it("denies when membership was revoked between check and recheck", () => {
    const result = recheckFreshAuthorization({
      scope: scopeFor(7),
      identity: activeIdentity(),
      membership: { ...activeMembership(7), status: "revoked" },
    });
    expect(result).toMatchObject({
      fresh: false,
      code: "membership_no_longer_active",
    });
  });

  it("denies when the membership record disappeared before the mutation", () => {
    const result = recheckFreshAuthorization({
      scope: scopeFor(7),
      identity: activeIdentity(),
      membership: null,
    });
    expect(result).toMatchObject({
      fresh: false,
      code: "membership_no_longer_active",
    });
  });

  it("denies when explicit private-matter membership was revoked before mutation", () => {
    const privateDecision = evaluateAccess({
      identity: activeIdentity(),
      membership: activeMembership(7),
      matter: privateMatter(),
      matterMembership: matterMembership("active"),
      requiresMfa: false,
    });
    if (privateDecision.outcome !== "allow") {
      throw new Error("test setup: expected initial allow");
    }
    const result = recheckFreshAuthorization({
      scope: privateDecision.scope,
      identity: activeIdentity(),
      membership: activeMembership(7),
      matterMembership: matterMembership("revoked"),
    });
    expect(result).toMatchObject({
      fresh: false,
      code: "matter_membership_no_longer_active",
    });
  });

  it("denies an MFA-required mutation whose assurance lapsed after the initial check", () => {
    const result = recheckFreshAuthorization({
      scope: scopeFor(),
      identity: { ...activeIdentity(), mfa_satisfied: false },
      membership: activeMembership(7),
      requiresMfa: true,
    });
    expect(result).toMatchObject({ fresh: false, code: "mfa_required" });
  });

  it("is a deny contract: a stale recheck result never claims allow", () => {
    const result = recheckFreshAuthorization({
      scope: scopeFor(7),
      identity: activeIdentity(),
      membership: activeMembership(advanceEpoch(7)),
    });
    expect(result).not.toHaveProperty("scope");
  });
});
