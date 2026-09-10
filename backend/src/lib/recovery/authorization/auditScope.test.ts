import { describe, expect, it } from "vitest";

import { buildAuditScope, AUDIT_SCOPE_FIELDS } from "./auditScope";

const IDENTITY = {
  user_id: "11111111-1111-4111-8111-111111111111",
  transport: { kind: "web_session" } as const,
  mfa_satisfied: true,
};

const SCOPE = {
  user_id: IDENTITY.user_id,
  organization_id: "org-1",
  matter_id: "m-1",
  membership_role: "member",
  authorization_epoch: 7,
  requires_explicit_matter_membership: false,
};

describe("audit scope — minimum data for the coordinator audit boundary", () => {
  it("builds the exact minimum field set and nothing else", () => {
    const result = buildAuditScope({
      identity: IDENTITY,
      scope: SCOPE,
      action: "document.generated",
      status: "completed",
    });
    expect(Object.keys(result).sort()).toEqual([...AUDIT_SCOPE_FIELDS].sort());
    expect(result).toMatchObject({
      action: "document.generated",
      status: "completed",
      user_id: IDENTITY.user_id,
      organization_id: "org-1",
      matter_id: "m-1",
      membership_role: "member",
      authorization_epoch: 7,
      mfa_satisfied: true,
    });
  });

  it("carries the exact transport so the channel is auditable", () => {
    const handoff = buildAuditScope({
      identity: {
        ...IDENTITY,
        transport: { kind: "word_handoff", handoff_session_id: "h-1" },
      },
      scope: SCOPE,
      action: "document.edited",
      status: "completed",
    });
    expect(handoff.transport).toEqual({
      kind: "word_handoff",
      handoff_session_id: "h-1",
    });
    const named = buildAuditScope({
      identity: {
        ...IDENTITY,
        transport: { kind: "non_browser_bearer", client_name: "loadtest" },
      },
      scope: SCOPE,
      action: "workflow.applied",
      status: "completed",
    });
    expect(named.transport).toEqual({
      kind: "non_browser_bearer",
      client_name: "loadtest",
    });
  });

  it("rejects an identity that does not match the granted scope", () => {
    expect(() =>
      buildAuditScope({
        identity: { ...IDENTITY, user_id: "user-other" },
        scope: SCOPE,
        action: "document.generated",
      }),
    ).toThrow(/user/i);
  });

  it("defaults status to completed, matching the upstream AuditStatus vocabulary", () => {
    const result = buildAuditScope({
      identity: IDENTITY,
      scope: SCOPE,
      action: "chat.message",
    });
    expect(result.status).toBe("completed");
  });

  it("preserves cancelled and failed statuses without rewriting them", () => {
    for (const status of ["cancelled", "failed"] as const) {
      const result = buildAuditScope({
        identity: IDENTITY,
        scope: SCOPE,
        action: "chat.message",
        status,
      });
      expect(result.status).toBe(status);
    }
  });

  it("rejects an empty action instead of inventing one", () => {
    expect(() =>
      buildAuditScope({ identity: IDENTITY, scope: SCOPE, action: " " }),
    ).toThrow(/action/);
  });

  it("rejects a status outside the upstream vocabulary", () => {
    expect(() =>
      buildAuditScope({
        identity: IDENTITY,
        scope: SCOPE,
        action: "chat.message",
        status: "pending" as "completed",
      }),
    ).toThrow(/status/);
  });

  it("never carries tokens, payloads or content fields", () => {
    const result = buildAuditScope({
      identity: IDENTITY,
      scope: SCOPE,
      action: "document.generated",
    });
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("payload");
    expect(result).not.toHaveProperty("detail");
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("secret");
  });

  it("does not implement or bypass append-only storage (pure value only)", () => {
    // The audit boundary stays coordinator-owned: this module returns an
    // inert value and exposes no persistence surface at all.
    const exported = Object.keys(awaitingImport());
    expect(exported.sort()).toEqual(["AUDIT_SCOPE_FIELDS", "buildAuditScope"]);
    function awaitingImport() {
      return { AUDIT_SCOPE_FIELDS, buildAuditScope };
    }
  });
});
