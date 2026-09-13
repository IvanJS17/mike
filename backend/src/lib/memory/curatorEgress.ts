/**
 * LiTT (S5b): governed curator egress.
 *
 * The upstream curator streamed straight through `streamChatWithTools`, which
 * resolves provider keys from env/user storage without a governed route, a
 * versioned credential or any receipt. This module replaces that default with
 * the recovery-series choke point: route resolution -> host gate -> versioned
 * credential -> single sender invocation, all fail-closed.
 *
 * Today `EGRESS_POLICY` allowlists only the fake host, so every real provider
 * fails closed before any credential read or network call — the intended
 * state until a future authorized decision extends the policy. Senders for
 * real hosts do not exist yet; the transport bridge below is reachable only
 * once a host is allowlisted.
 */
import { providerForModel } from "../llm/models";
import type {
  UserApiKeys,
  StreamChatParams,
  StreamChatResult,
} from "../llm/types";
import { streamChatWithTools } from "../llm";
import type { Db } from "../dbq/types";
import { buildProviderRoute } from "../recovery/sharedContracts";
import {
  resolveSavedProviderPreference,
  type CredentialReadPort,
  type GovernedCredentialRecord,
} from "../recovery/providers/governedProviderRoute";
import {
  executeGovernedProviderCall,
  type FakeProviderSender,
} from "../recovery/providers/providerEgress";
import { getGovernedUserApiKeyRecord } from "../userApiKeys";

/** Typed, secret-free signal for a governance block on curator egress. */
export class MemoryCuratorEgressBlockedError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "MemoryCuratorEgressBlockedError";
    this.kind = kind;
  }
}

export type CuratorEgressDependencies = {
  /** Credential read port override (tests inject fixtures). */
  credentialPort?: CredentialReadPort;
  /** Egress host override; defaults to the provider name (never allowlisted). */
  host?: string;
  /** Sender override for allowlisted hosts (fake interception in tests). */
  sender?: FakeProviderSender;
};

/**
 * Credential port over `user_api_keys`: exact (user, credential_ref) read with
 * the decrypted key. Null when the row does not exist; dependency failures
 * surface as governed blocks, never raw adapter errors.
 */
export function createUserApiKeysCredentialPort(db: Db): CredentialReadPort {
  return {
    async getCredential(input: {
      user_id: string;
      ref: string;
    }): Promise<GovernedCredentialRecord | null> {
      let record: Awaited<ReturnType<typeof getGovernedUserApiKeyRecord>>;
      try {
        record = await getGovernedUserApiKeyRecord(input.user_id, input.ref, db);
      } catch {
        throw new MemoryCuratorEgressBlockedError(
          "credential_dependency_failed",
          "credential store is unavailable",
        );
      }
      if (!record) return null;
      return {
        ref: record.credential_ref,
        provider: record.provider,
        domain: "provider_api_key",
        source: "user",
        enabled: record.enabled,
        version: record.version,
        user_id: input.user_id,
        provider_api_key: record.provider_api_key,
      };
    },
  };
}

/**
 * Builds the per-run curator stream. The returned function matches the
 * `CuratorScopeServices["stream"]` contract; every failure surfaces as
 * `MemoryCuratorEgressBlockedError` with a safe message (no prompt, key or
 * transcript material).
 */
export function createGovernedCuratorStream(
  context: { db: Db; userId: string; userEmail: string | null },
  dependencies: CuratorEgressDependencies = {},
): (params: StreamChatParams) => Promise<StreamChatResult> {
  const port =
    dependencies.credentialPort ?? createUserApiKeysCredentialPort(context.db);

  return async (params: StreamChatParams): Promise<StreamChatResult> => {
    const provider = providerForModel(params.model);

    // Discover the user's exact credential_ref for this provider. The
    // versioned key material itself is only read (and decrypted) by the
    // governed port, after the host gate has passed.
    let credentialRef: string;
    try {
      const { data, error } = await context.db
        .from("user_api_keys")
        .select("credential_ref, enabled")
        .eq("user_id", context.userId)
        .eq("provider", provider)
        .maybeSingle();
      if (error) {
        throw new MemoryCuratorEgressBlockedError(
          "credential_dependency_failed",
          "credential store is unavailable",
        );
      }
      if (!data) {
        throw new MemoryCuratorEgressBlockedError(
          "credential_not_found",
          `no stored credential for provider "${provider}"`,
        );
      }
      if (!(data as { enabled?: boolean }).enabled) {
        throw new MemoryCuratorEgressBlockedError(
          "credential_disabled",
          `stored credential for provider "${provider}" is disabled`,
        );
      }
      credentialRef = (data as { credential_ref: string }).credential_ref;
    } catch (error) {
      if (error instanceof MemoryCuratorEgressBlockedError) throw error;
      throw new MemoryCuratorEgressBlockedError(
        "credential_dependency_failed",
        "credential store is unavailable",
      );
    }

    const routeResult = resolveSavedProviderPreference(
      buildProviderRoute({
        provider,
        model: params.model,
        credential_ref: credentialRef,
      }),
    );
    if (!routeResult.ok) {
      throw new MemoryCuratorEgressBlockedError(
        routeResult.error.kind,
        routeResult.error.message,
      );
    }

    // Post-G6 transport bridge: performs the actual provider stream using the
    // governed-resolved key. Only reachable for allowlisted hosts.
    const transportSender: FakeProviderSender = (input) => {
      const apiKeys: UserApiKeys = {
        [input.route.provider]: input.provider_api_key,
      };
      return streamChatWithTools({ ...params, apiKeys, requireTools: true });
    };

    const result = await executeGovernedProviderCall({
      user_id: context.userId,
      route: routeResult.route,
      credentialPort: port,
      host: dependencies.host ?? provider,
      sender: dependencies.sender ?? transportSender,
    });
    if (!result.ok) {
      throw new MemoryCuratorEgressBlockedError(
        result.error.kind,
        result.error.message,
      );
    }
    return result.senderResult as StreamChatResult;
  };
}
