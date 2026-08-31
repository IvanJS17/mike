import { describe, expect, it } from "vitest";

import {
  AUTH_TRANSPORT_KINDS,
  assertBrowserBearerUnrepresentable,
  buildAuthenticatedIdentity,
  type AuthTransport,
} from "./authStateMatrix";

/** A minimal, fully formed identity used across the matrix tests. */
function identityWith(
  transport: AuthTransport,
  overrides: Partial<{ user_id: string; mfa_satisfied: boolean }> = {},
) {
  return buildAuthenticatedIdentity({
    user_id: overrides.user_id ?? "11111111-1111-4111-8111-111111111111",
    transport,
    mfa_satisfied:
      "mfa_satisfied" in overrides ? overrides.mfa_satisfied : true,
  });
}

describe("auth transport kinds (allowed transports only)", () => {
  it("declares exactly the three ledger transports", () => {
    expect([...AUTH_TRANSPORT_KINDS].sort()).toEqual([
      "non_browser_bearer",
      "web_session",
      "word_handoff",
    ]);
  });
});

describe("auth state matrix (ledger contract: Request identity)", () => {
  it("accepts a web session strictly as a web session", () => {
    const identity = identityWith({ kind: "web_session" });
    expect(identity.transport.kind).toBe("web_session");
    expect(identity.transport).not.toHaveProperty("client_name");
    expect(identity.transport).not.toHaveProperty("handoff_session_id");
  });

  it("requires a handoff identity for the Word handoff transport", () => {
    const identity = identityWith({
      kind: "word_handoff",
      handoff_session_id: "handoff-abc",
    });
    expect(identity.transport.kind).toBe("word_handoff");
    if (identity.transport.kind === "word_handoff") {
      expect(identity.transport.handoff_session_id.length).toBeGreaterThan(0);
    }
  });

  it("accepts an explicitly named non-browser Bearer only through its kind", () => {
    const identity = identityWith({
      kind: "non_browser_bearer",
      client_name: "word-addin-loadtest",
    });
    expect(identity.transport.kind).toBe("non_browser_bearer");
    if (identity.transport.kind === "non_browser_bearer") {
      expect(identity.transport.client_name).toBe("word-addin-loadtest");
    }
  });

  it("rejects an unnamed non-browser Bearer at construction", () => {
    expect(() =>
      identityWith({ kind: "non_browser_bearer", client_name: "" }),
    ).toThrow(/client_name/);
  });
});

describe("browser Bearer fallback prohibition", () => {
  it("has no browser bearer variant among the declared kinds", () => {
    expect(AUTH_TRANSPORT_KINDS).not.toContain("browser_bearer");
    expect(AUTH_TRANSPORT_KINDS).not.toContain("bearer");
  });

  it("rejects a browser-originated bearer request as unrepresentable", () => {
    expect(() =>
      assertBrowserBearerUnrepresentable({
        bearer: true,
        browser_context: true,
      }),
    ).toThrow(/browser/i);
  });

  it("does not reject a non-browser bearer claim", () => {
    expect(() =>
      assertBrowserBearerUnrepresentable({
        bearer: true,
        browser_context: false,
      }),
    ).not.toThrow();
  });
});

describe("MFA/assurance state", () => {
  it("preserves an unsatisfied assurance state without selecting a default", () => {
    const identity = identityWith(
      { kind: "web_session" },
      {
        mfa_satisfied: false,
      },
    );
    expect(identity.mfa_satisfied).toBe(false);
  });

  it("requires a boolean assurance state (no undefined default)", () => {
    expect(() =>
      identityWith(
        { kind: "web_session" },
        {
          mfa_satisfied: undefined as unknown as boolean,
        },
      ),
    ).toThrow(/mfa_satisfied/);
  });
});
