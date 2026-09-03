/**
 * Slice C — governed explicit route resolution + versioned credential boundary.
 *
 * Non-shared writer slice. Consumes frozen shared vocabulary
 * (`ProviderRoute`, `buildProviderRoute`, `CredentialDomain`) and existing
 * pure model helpers. No SDK, network, chat, schema or key-storage imports.
 * No environment fallback. Fail-closed typed results only. No logging.
 */

import {
  buildProviderRoute,
  isCredentialDomain,
  type CredentialDomain,
  type ProviderRoute,
} from "../sharedContracts";
import {
  isSupportedOpenCodeGoModel,
  LEGACY_MODEL_IDS,
  providerForModel,
  resolveModel,
} from "../../llm/models";

/** Where a credential record was declared. Matches existing env/user wording. */
export type CredentialSource = "user" | "env";

/** Versioned credential record with separated secret domains. */
export type GovernedCredentialRecord = {
  ref: string;
  provider: string;
  domain: CredentialDomain;
  source: CredentialSource;
  enabled: boolean;
  version: number;
  user_id: string;
  provider_api_key?: string | null;
  membership_identity?: string | null;
  oauth_access_token?: string | null;
  oauth_refresh_token?: string | null;
};

/** Injected read port keyed by authenticated user + exact credential_ref. */
export type CredentialReadPort = {
  getCredential(input: {
    user_id: string;
    ref: string;
  }): Promise<GovernedCredentialRecord | null>;
};

/** Receipt/provenance projection. Never carries key/token/secret material. */
export type GovernedCredentialReceipt = {
  credential_ref: string;
  source: CredentialSource;
  version: number;
  provider: string;
  model: string;
  user_id: string;
  route: ProviderRoute;
};

export type ExplicitRouteErrorKind =
  | "invalid_explicit_route"
  | "provider_model_mismatch"
  | "unknown_model"
  | "retired_model"
  | "unsupported_model";

export type ExplicitRouteResult =
  | {
      ok: true;
      route: ProviderRoute;
      actual_provider: string;
      actual_model: string;
    }
  | {
      ok: false;
      error: { kind: ExplicitRouteErrorKind; message: string };
    };

export type SavedPreferenceResult =
  | {
      ok: true;
      route: ProviderRoute;
      actual_provider: string;
      actual_model: string;
    }
  | {
      ok: false;
      error: { kind: "stale_saved_preference"; message: string };
    };

export type CredentialErrorKind =
  | "credential_not_found"
  | "credential_disabled"
  | "credential_rotated"
  | "credential_wrong_user"
  | "credential_wrong_domain"
  | "credential_wrong_provider"
  | "credential_invalid_version"
  | "credential_malformed"
  | "credential_dependency_failed"
  | "user_router_byok_policy_undecided";

export type GovernedCredentialResult =
  | {
      ok: true;
      execution: { provider_api_key: string };
      receipt: GovernedCredentialReceipt;
      route: ProviderRoute;
      actual_provider: string;
      actual_model: string;
    }
  | {
      ok: false;
      error: { kind: CredentialErrorKind; message: string };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failRoute(
  kind: ExplicitRouteErrorKind,
  message: string,
): ExplicitRouteResult {
  return { ok: false, error: { kind, message } };
}

function actualProviderFor(model: string): string | null {
  try {
    return providerForModel(model);
  } catch {
    return null;
  }
}

function resolveExplicitInternal(input: unknown): ExplicitRouteResult {
  if (!isRecord(input)) {
    return failRoute(
      "invalid_explicit_route",
      "explicit route requires provider, model and credential_ref",
    );
  }
  let built: ProviderRoute;
  try {
    built = buildProviderRoute(input as ProviderRoute);
  } catch {
    return failRoute(
      "invalid_explicit_route",
      "explicit route requires provider, model and credential_ref",
    );
  }
  const { provider, model, credential_ref } = built;
  if (Object.prototype.hasOwnProperty.call(LEGACY_MODEL_IDS, model)) {
    return failRoute("retired_model", `model "${model}" is retired`);
  }
  const actual = actualProviderFor(model);
  if (!actual || resolveModel(model, "") === "") {
    return failRoute("unknown_model", `model "${model}" is unknown`);
  }
  if (model.startsWith("opencode-go/") && !isSupportedOpenCodeGoModel(model)) {
    return failRoute("unsupported_model", `model "${model}" is not supported`);
  }
  if (provider !== actual) {
    return failRoute(
      "provider_model_mismatch",
      `provider "${provider}" does not match model "${model}"`,
    );
  }
  const route: ProviderRoute = { provider, model, credential_ref };
  return { ok: true, route, actual_provider: actual, actual_model: model };
}

/**
 * Explicit/pinned request-path resolution. Never falls back, never returns
 * stale_saved_preference.
 */
export function resolveExplicitProviderRoute(
  input: unknown,
): ExplicitRouteResult {
  return resolveExplicitInternal(input);
}

/**
 * Stored-preference resolution. Any invalid route collapses to the distinct
 * stale_saved_preference decision so the coordinator can normalize visibly.
 * Never used for explicit/pinned input.
 */
export function resolveSavedProviderPreference(
  input: unknown,
): SavedPreferenceResult {
  const resolved = resolveExplicitInternal(input);
  if (resolved.ok) return resolved;
  return {
    ok: false,
    error: {
      kind: "stale_saved_preference",
      message: "saved provider preference is stale",
    },
  };
}

function failCredential(
  kind: CredentialErrorKind,
  message: string,
): GovernedCredentialResult {
  return { ok: false, error: { kind, message } };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Versioned credential resolution through the injected port. No default, env
 * or alternate-user substitution. Secrets stay in the execution holder only.
 */
export async function resolveGovernedCredential(input: {
  user_id: string;
  route: ProviderRoute;
  port: CredentialReadPort;
  expected_credential_version?: number;
}): Promise<GovernedCredentialResult> {
  const userId = (input as { user_id?: unknown }).user_id;
  const route = (input as { route?: unknown }).route as
    | ProviderRoute
    | undefined;
  const port = (input as { port?: unknown }).port as
    | CredentialReadPort
    | undefined;
  const expected = (input as { expected_credential_version?: unknown })
    .expected_credential_version;

  if (typeof userId !== "string" || !userId.trim()) {
    return failCredential(
      "credential_malformed",
      "credential request is malformed",
    );
  }
  if (
    !isRecord(route) ||
    typeof route.provider !== "string" ||
    !route.provider ||
    typeof route.model !== "string" ||
    !route.model ||
    typeof route.credential_ref !== "string" ||
    !route.credential_ref
  ) {
    return failCredential(
      "credential_malformed",
      "credential request is malformed",
    );
  }
  if (!isRecord(port) || typeof port.getCredential !== "function") {
    return failCredential(
      "credential_malformed",
      "credential request is malformed",
    );
  }
  if (expected !== undefined && !isPositiveInt(expected)) {
    return failCredential(
      "credential_malformed",
      "credential request is malformed",
    );
  }

  const validRoute: ProviderRoute = {
    provider: route.provider,
    model: route.model,
    credential_ref: route.credential_ref,
  };

  let record: GovernedCredentialRecord | null;
  try {
    record = await port.getCredential({
      user_id: userId,
      ref: validRoute.credential_ref,
    });
  } catch {
    return failCredential(
      "credential_dependency_failed",
      "credential lookup is unavailable",
    );
  }

  if (record === null || record === undefined) {
    return failCredential("credential_not_found", "credential was not found");
  }
  if (!isRecord(record)) {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  const rec = record as Record<string, unknown>;

  if (typeof rec.ref !== "string" || !rec.ref) {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  if (typeof rec.provider !== "string" || !rec.provider) {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  if (typeof rec.user_id !== "string" || !rec.user_id) {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  if (rec.ref !== validRoute.credential_ref) {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  if (rec.user_id !== userId) {
    return failCredential(
      "credential_wrong_user",
      "credential belongs to another user",
    );
  }
  if (typeof rec.domain !== "string") {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  if (!isCredentialDomain(rec.domain)) {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  const domain = rec.domain as CredentialDomain;
  if (domain !== "provider_api_key") {
    return failCredential(
      "credential_wrong_domain",
      "credential domain cannot dispatch models",
    );
  }
  if (
    typeof rec.source !== "string" ||
    (rec.source !== "user" && rec.source !== "env")
  ) {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  const source = rec.source as CredentialSource;
  if (typeof rec.enabled !== "boolean") {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }
  if (rec.enabled === false) {
    return failCredential("credential_disabled", "credential is disabled");
  }
  if (!isPositiveInt(rec.version)) {
    return failCredential(
      "credential_invalid_version",
      "credential version is invalid",
    );
  }
  const version = rec.version as number;
  if (expected !== undefined && version !== expected) {
    return failCredential(
      "credential_rotated",
      "credential version was rotated",
    );
  }
  if ((rec.provider as string) !== validRoute.provider) {
    return failCredential(
      "credential_wrong_provider",
      "credential provider does not match route",
    );
  }
  if (
    (source === "user" && rec.provider === "vercel") ||
    (source === "user" && rec.provider === "opencode-go")
  ) {
    return failCredential(
      "user_router_byok_policy_undecided",
      "user router credential policy is undecided",
    );
  }
  if (
    typeof rec.provider_api_key !== "string" ||
    !rec.provider_api_key.trim()
  ) {
    return failCredential(
      "credential_malformed",
      "credential record is malformed",
    );
  }

  const secret = (rec.provider_api_key as string).trim();
  const receipt: GovernedCredentialReceipt = {
    credential_ref: validRoute.credential_ref,
    source,
    version,
    provider: rec.provider as string,
    model: validRoute.model,
    user_id: userId,
    route: { ...validRoute },
  };
  return {
    ok: true,
    execution: { provider_api_key: secret },
    receipt,
    route: { ...validRoute },
    actual_provider: validRoute.provider,
    actual_model: validRoute.model,
  };
}
