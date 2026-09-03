/**
 * Slice C — governed provider egress choke point with fake interception.
 *
 * Consumes the frozen EGRESS_POLICY allowlist and the governed route +
 * credential boundary. The injected sender runs only for the allowlisted
 * fake host after route and credential validation. No SDK or network imports.
 */

import {
  EGRESS_POLICY,
  resolveEgressTarget,
  type ProviderRoute,
} from "../sharedContracts";
import {
  resolveExplicitProviderRoute,
  resolveGovernedCredential,
  type CredentialErrorKind,
  type CredentialReadPort,
  type ExplicitRouteErrorKind,
  type GovernedCredentialReceipt,
} from "./governedProviderRoute";

/** Injected fake sender. Runs only after validation for the fake host. */
export type FakeProviderSender = (input: {
  route: ProviderRoute;
  provider_api_key: string;
  receipt: GovernedCredentialReceipt;
}) => Promise<unknown> | unknown;

export type ProviderEgressErrorKind =
  | ExplicitRouteErrorKind
  | CredentialErrorKind
  | "real_provider_egress_blocked"
  | "stale_saved_preference";

export type GovernedEgressResult =
  | {
      ok: true;
      host: "fake";
      route: ProviderRoute;
      receipt: GovernedCredentialReceipt;
      senderResult: unknown;
    }
  | {
      ok: false;
      error: { kind: ProviderEgressErrorKind; message: string; host?: string };
    };

/**
 * Host gate against the frozen allowlist. Only the exact fake marker passes;
 * every real or unexpected host fails closed before any sender executes.
 */
export function resolveProviderEgressTarget(
  host: unknown,
):
  | { allowed: true; host: "fake" }
  | { allowed: false; host: string; reason: "real_provider_egress_blocked" } {
  const candidate = typeof host === "string" ? host : "";
  const allowlisted = (
    EGRESS_POLICY.allowlistedHosts as readonly string[]
  ).includes(candidate);
  if (allowlisted && candidate === "fake") {
    const decision = resolveEgressTarget("egress", candidate);
    if (decision.allowed) return { allowed: true, host: "fake" };
  }
  return {
    allowed: false,
    host: candidate,
    reason: "real_provider_egress_blocked",
  };
}

/**
 * Validate route, resolve the versioned credential, gate egress, then invoke
 * the fake sender exactly once. Any failure invokes the sender zero times.
 */
export async function executeGovernedProviderCall(input: {
  user_id: string;
  route: ProviderRoute;
  credentialPort: CredentialReadPort;
  host: string;
  sender: FakeProviderSender;
  expected_credential_version?: number;
}): Promise<GovernedEgressResult> {
  const routeResult = resolveExplicitProviderRoute(input.route);
  if (!routeResult.ok) {
    return { ok: false, error: { ...routeResult.error } };
  }

  const credentialResult = await resolveGovernedCredential({
    user_id: input.user_id,
    route: routeResult.route,
    port: input.credentialPort,
    expected_credential_version: input.expected_credential_version,
  });
  if (!credentialResult.ok) {
    return { ok: false, error: { ...credentialResult.error } };
  }

  const egress = resolveProviderEgressTarget(input.host);
  if (!egress.allowed) {
    return {
      ok: false,
      error: {
        kind: "real_provider_egress_blocked",
        message: `real provider egress is blocked for host "${egress.host}"`,
        host: egress.host,
      },
    };
  }

  const senderResult = await input.sender({
    route: { ...routeResult.route },
    provider_api_key: credentialResult.execution.provider_api_key,
    receipt: credentialResult.receipt,
  });
  return {
    ok: true,
    host: "fake",
    route: { ...routeResult.route },
    receipt: credentialResult.receipt,
    senderResult,
  };
}
