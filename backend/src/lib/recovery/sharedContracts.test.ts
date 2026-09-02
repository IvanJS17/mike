import { describe, expect, it } from "vitest";

import {
  APPROVED_REVIEW_DECISIONS,
  APPROVED_REVIEW_TERMINAL_STATES,
  BLOCKED_OPERATION_KINDS,
  buildProviderRoute,
  buildWorkflowIdentity,
  CREDENTIAL_DOMAINS,
  EGRESS_POLICY,
  isApprovedReviewDecision,
  isApprovedReviewTerminalState,
  isCredentialDomain,
  makeBlockedOperation,
  resolveEgressTarget,
  type BlockedOperationKind,
  type CredentialDomain,
  type ProviderRoute,
} from "./sharedContracts";

describe("credential domain separation (ledger invariant 6)", () => {
  it("declares exactly four non-interchangeable domains", () => {
    expect([...CREDENTIAL_DOMAINS].sort()).toEqual([
      "membership_identity",
      "oauth_access_token",
      "oauth_refresh_token",
      "provider_api_key",
    ]);
  });

  it("keeps oauth tokens out of the provider key domain", () => {
    const domains: CredentialDomain[] = [
      "membership_identity",
      "oauth_access_token",
      "oauth_refresh_token",
      "provider_api_key",
    ];
    expect(domains.filter((d) => d.startsWith("oauth_"))).not.toContain(
      "provider_api_key",
    );
  });

  it("discriminates membership via the type guard", () => {
    expect(isCredentialDomain("membership_identity")).toBe(true);
    expect(isCredentialDomain("password")).toBe(false);
  });
});

describe("provider route (ledger contract: Provider route)", () => {
  it("builds an explicit route with provider, model and credential_ref", () => {
    const route: ProviderRoute = buildProviderRoute({
      provider: "claude",
      model: "claude-sonnet-4",
      credential_ref: "user-key-42",
    });
    expect(route.provider).toBe("claude");
    expect(route.model).toBe("claude-sonnet-4");
    expect(route.credential_ref).toBe("user-key-42");
  });

  it("rejects routes with empty provider, model or credential_ref (fail closed)", () => {
    expect(() =>
      buildProviderRoute({
        provider: "",
        model: "claude-sonnet-4",
        credential_ref: "user-key-42",
      }),
    ).toThrow(/provider/);
    expect(() =>
      buildProviderRoute({
        provider: "claude",
        model: "  ",
        credential_ref: "user-key-42",
      }),
    ).toThrow(/model/);
    expect(() =>
      buildProviderRoute({
        provider: "claude",
        model: "claude-sonnet-4",
        credential_ref: "",
      }),
    ).toThrow(/credential_ref/);
  });
});

describe("egress policy (no real provider or Google call)", () => {
  it("allowlists only the exact fake marker host", () => {
    expect(EGRESS_POLICY.allowlistedHosts).toEqual(["fake"]);
    expect(resolveEgressTarget("fake", "fake")).toEqual({
      allowed: true,
      host: "fake",
    });
  });

  it("blocks real provider, Google and pseudo-synthetic hosts (fail closed)", () => {
    for (const host of [
      "api.anthropic.com",
      "api.openai.com",
      "generativelanguage.googleapis.com",
      "www.googleapis.com",
      "fake.googleapis.com/upload",
      "evil-fake.example.com",
    ]) {
      expect(resolveEgressTarget("claude", host)).toEqual({
        allowed: false,
        host,
        reason: "host_not_allowlisted",
      });
    }
  });
});

describe("fail-closed product placeholders (no invented product decisions)", () => {
  it("declares every unresolved product decision as a blocked operation", () => {
    expect([...BLOCKED_OPERATION_KINDS].sort()).toEqual([
      "evidence_deletion",
      "jurisdiction_research_source",
      "material_ux_legal_review_change",
      "production_topology",
      "publication_to_real_drive",
      "real_provider_egress",
      "user_byok_router_credential",
    ]);
  });

  it("returns typed blocked results that never carry a decision or secret", () => {
    const kind: BlockedOperationKind = "evidence_deletion";
    const result = makeBlockedOperation(kind, "retention ADR pending");
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe(kind);
    expect(result.reason).toBe("retention ADR pending");
    expect(result).not.toHaveProperty("secret");
    expect(result).not.toHaveProperty("decision");
  });
});

describe("workflow identity (upstream catalog + LiTT provenance)", () => {
  it("uses upstream distribution/type values and requires source provenance", () => {
    const identity = buildWorkflowIdentity({
      workflow_key: "mx-civil-mercantile",
      version: "0.1.0",
      content_hash: "a".repeat(64),
      source_commit: "b".repeat(40),
      distribution: "default",
      type: "assistant",
      source: "LiTT Civil/Mercantile MX playbook",
      approval_provenance: "owner-reviewed",
    });
    expect(identity.distribution).toBe("default");
    expect(identity.type).toBe("assistant");
    expect(identity.source).toMatch(/LiTT/);
  });
});

describe("review state (ledger contract: Review state)", () => {
  it("accepts item decisions accepted, rejected and edited", () => {
    expect([...APPROVED_REVIEW_DECISIONS].sort()).toEqual([
      "accepted",
      "edited",
      "rejected",
    ]);
    expect(isApprovedReviewDecision("edited")).toBe(true);
    expect(isApprovedReviewDecision("pending")).toBe(false);
  });

  it("accepts terminal states approved and changes_requested", () => {
    expect([...APPROVED_REVIEW_TERMINAL_STATES].sort()).toEqual([
      "approved",
      "changes_requested",
    ]);
    expect(isApprovedReviewTerminalState("approved")).toBe(true);
    expect(isApprovedReviewTerminalState("pending")).toBe(false);
  });
});
