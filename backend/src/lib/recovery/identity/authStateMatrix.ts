/**
 * Slice A1 — auth state matrix (domain only, no transport wiring).
 *
 * Models the ledger contract "Request identity": transport is exactly one of
 * three allowed kinds. The upstream auth middleware remains coordinator-owned;
 * this module only makes the authenticated-state domain explicit so the
 * coordinator can map requests onto it without re-deciding semantics.
 *
 * Browser Bearer fallback is prohibited upstream (browser clients authenticate
 * with HttpOnly cookies), so a browser-originated Bearer transport is NOT
 * representable here: there is no variant for it and the guard rejects it.
 */

/** The three ledger transports, verbatim vocabulary. */
export const AUTH_TRANSPORT_KINDS = [
  "web_session",
  "word_handoff",
  "non_browser_bearer",
] as const;

export type AuthTransportKind = (typeof AUTH_TRANSPORT_KINDS)[number];

/** Exactly one transport per identity; browser Bearer has no variant. */
export type AuthTransport =
  | { kind: "web_session" }
  | { kind: "word_handoff"; handoff_session_id: string }
  | { kind: "non_browser_bearer"; client_name: string };

/**
 * Authenticated request identity. Mirrors the frozen ledger shape with
 * validation moved to construction: an identity that skips a required field
 * is a construction error, not a silent default.
 */
export type AuthenticatedIdentity = {
  user_id: string;
  transport: AuthTransport;
  mfa_satisfied: boolean;
};

function assertNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new Error(`auth transport requires a non-empty ${label}`);
  }
}

/**
 * Validate one transport. Unknown kinds are rejected so a transport can never
 * silently degrade into an allowed one.
 */
export function buildAuthTransport(transport: AuthTransport): AuthTransport {
  switch (transport.kind) {
    case "web_session":
      return { kind: "web_session" };
    case "word_handoff":
      assertNonEmpty(transport.handoff_session_id, "handoff_session_id");
      return {
        kind: "word_handoff",
        handoff_session_id: transport.handoff_session_id,
      };
    case "non_browser_bearer":
      assertNonEmpty(transport.client_name, "client_name");
      return { kind: "non_browser_bearer", client_name: transport.client_name };
    default: {
      const kind = (transport as { kind?: unknown }).kind;
      throw new Error(
        `auth transport kind ${String(kind)} is not representable (browser Bearer fallback is prohibited)`,
      );
    }
  }
}

/**
 * Build a validated identity. `mfa_satisfied` must be stated explicitly —
 * assurance is never defaulted, preserving the upstream MFA posture.
 */
export function buildAuthenticatedIdentity(
  input: AuthenticatedIdentity,
): AuthenticatedIdentity {
  if (!input.user_id || !input.user_id.trim()) {
    throw new Error("authenticated identity requires a user_id");
  }
  if (typeof input.mfa_satisfied !== "boolean") {
    throw new Error(
      "authenticated identity requires an explicit mfa_satisfied boolean",
    );
  }
  return {
    user_id: input.user_id,
    transport: buildAuthTransport(input.transport),
    mfa_satisfied: input.mfa_satisfied,
  };
}

/** True only when the transport is exactly the given kind. */
export function transportIs(
  identity: AuthenticatedIdentity,
  kind: AuthTransportKind,
): boolean {
  return identity.transport.kind === kind;
}

/**
 * Fail-closed guard making the browser Bearer prohibition executable: a
 * Bearer credential presented from a browser context is rejected. The word
 * handoff remains the only supported surface-bridge.
 */
export function assertBrowserBearerUnrepresentable(claim: {
  bearer: boolean;
  browser_context: boolean;
}): void {
  if (claim.bearer && claim.browser_context) {
    throw new Error(
      "browser Bearer fallback is prohibited: browser clients must use the web session transport",
    );
  }
}
