import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  resolveExplicitProviderRoute,
  resolveGovernedCredential,
  resolveSavedProviderPreference,
  type CredentialReadPort,
  type GovernedCredentialRecord,
} from "./governedProviderRoute";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPL_SOURCE = readFileSync(
  join(HERE, "governedProviderRoute.ts"),
  "utf8",
);

function record(
  overrides: Partial<GovernedCredentialRecord> = {},
): GovernedCredentialRecord {
  return {
    ref: "user-key-1",
    provider: "claude",
    domain: "provider_api_key",
    source: "user",
    enabled: true,
    version: 2,
    user_id: "user-1",
    provider_api_key: "secret-key-abc",
    ...overrides,
  };
}

function portWith(
  rec: GovernedCredentialRecord | null,
  opts: { capture?: { user_id?: string; ref?: string }; throws?: unknown } = {},
): CredentialReadPort {
  return {
    getCredential: async (input: { user_id: string; ref: string }) => {
      opts.capture!.user_id = input.user_id;
      opts.capture!.ref = input.ref;
      if (opts.throws !== undefined) throw opts.throws;
      return rec;
    },
  };
}

function capturingPort(rec: GovernedCredentialRecord | null): {
  port: CredentialReadPort;
  seen: { user_id?: string; ref?: string };
} {
  const seen: { user_id?: string; ref?: string } = {};
  return { port: portWith(rec, { capture: seen }), seen };
}

describe("valid explicit routes", () => {
  it.each([
    ["claude", "claude-sonnet-5"],
    ["gemini", "gemini-3.7-flash"],
    ["openai", "gpt-5.6-sol"],
    ["ollama", "ollama/llama3.2"],
    ["openrouter", "openrouter/anthropic/claude-sonnet-4.5"],
    ["vercel", "vercel/openai/gpt-5.4"],
    ["opencode-go", "opencode-go/glm-5"],
    ["opencode-go", "opencode-go/minimax-m3"],
  ])("accepts %s route %s", (provider, model) => {
    const result = resolveExplicitProviderRoute({
      provider,
      model,
      credential_ref: "user-key-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route).toEqual({
        provider,
        model,
        credential_ref: "user-key-1",
      });
      expect(result.actual_provider).toBe(provider);
      expect(result.actual_model).toBe(model);
    }
  });
});

describe("explicit route failure without fallback", () => {
  it("rejects provider/model mismatch", () => {
    const result = resolveExplicitProviderRoute({
      provider: "claude",
      model: "gpt-5.6-sol",
      credential_ref: "user-key-1",
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider_model_mismatch" }),
    });
  });

  it("rejects unknown models", () => {
    for (const model of [
      "not-a-model",
      "openrouter/onlyone",
      "claude-nope-xyz",
    ]) {
      const result = resolveExplicitProviderRoute({
        provider: "claude",
        model,
        credential_ref: "user-key-1",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("unknown_model");
    }
  });

  it("rejects retired models without mapping to a fallback", () => {
    for (const model of ["gpt-5.4-lite", "gemini-3.1-flash-lite-preview"]) {
      const result = resolveExplicitProviderRoute({
        provider: model.startsWith("gpt-") ? "openai" : "gemini",
        model,
        credential_ref: "user-key-1",
      });
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({ kind: "retired_model" }),
      });
      expect(JSON.stringify(result)).not.toContain("gpt-5.4-mini");
      expect(JSON.stringify(result)).not.toContain("gemini-3.5-flash-lite");
    }
  });

  it("rejects unsupported opencode-go models", () => {
    const result = resolveExplicitProviderRoute({
      provider: "opencode-go",
      model: "opencode-go/unsupported-xyz-1",
      credential_ref: "user-key-1",
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "unsupported_model" }),
    });
  });

  it("rejects incomplete routes and never returns stale_saved_preference", () => {
    for (const bad of [
      { provider: "", model: "gpt-5.6-sol", credential_ref: "r" },
      { provider: "openai", model: "", credential_ref: "r" },
      { provider: "openai", model: "gpt-5.6-sol", credential_ref: "" },
      null,
      "x",
    ]) {
      const result = resolveExplicitProviderRoute(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid_explicit_route");
        expect(result.error.kind).not.toBe("stale_saved_preference");
      }
    }
  });
});

describe("saved preference stale path", () => {
  it("accepts a still-valid saved route", () => {
    const result = resolveSavedProviderPreference({
      provider: "openai",
      model: "gpt-5.6-sol",
      credential_ref: "user-key-1",
    });
    expect(result.ok).toBe(true);
  });

  it("collapses retired/unknown/mismatch to stale_saved_preference", () => {
    expect(
      resolveSavedProviderPreference({
        provider: "openai",
        model: "gpt-5.4-lite",
        credential_ref: "r",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "stale_saved_preference" }),
    });
    expect(
      resolveSavedProviderPreference({
        provider: "claude",
        model: "nope-unknown",
        credential_ref: "r",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "stale_saved_preference" }),
    });
    expect(
      resolveSavedProviderPreference({
        provider: "claude",
        model: "gpt-5.6-sol",
        credential_ref: "r",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "stale_saved_preference" }),
    });
  });
});

describe("credential exact lookup and failures", () => {
  const route = {
    provider: "claude",
    model: "claude-sonnet-5",
    credential_ref: "user-key-1",
  };

  it("resolves with exact user+ref and separates execution secret from receipt", async () => {
    const { port, seen } = capturingPort(record());
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(seen).toEqual({ user_id: "user-1", ref: "user-key-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.execution.provider_api_key).toBe("secret-key-abc");
      expect(result.receipt).toEqual({
        credential_ref: "user-key-1",
        source: "user",
        version: 2,
        provider: "claude",
        model: "claude-sonnet-5",
        user_id: "user-1",
        route,
      });
      expect(result.route).toEqual(route);
      expect(result.actual_provider).toBe("claude");
      expect(result.actual_model).toBe("claude-sonnet-5");
      expect(JSON.stringify(result)).not.toContain("secret-key-abc");
    }
  });

  it("rejects an invalid direct route before credential lookup", async () => {
    const getCredential = vi.fn(async () => record());
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route: {
        provider: "claude",
        model: "gpt-5.6-sol",
        credential_ref: "user-key-1",
      },
      port: { getCredential },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider_model_mismatch" }),
    });
    expect(getCredential).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null, "credential_not_found"],
    ["disabled", record({ enabled: false }), "credential_disabled"],
    ["rotated", record({ version: 3 }), "credential_rotated"],
    ["wrong-user", record({ user_id: "user-2" }), "credential_wrong_user"],
    [
      "wrong-provider",
      record({ provider: "openai" }),
      "credential_wrong_provider",
    ],
    ["bad-version-zero", record({ version: 0 }), "credential_invalid_version"],
    [
      "bad-version-float",
      record({ version: 1.5 }),
      "credential_invalid_version",
    ],
    ["malformed-empty-ref", record({ ref: "" }), "credential_malformed"],
    [
      "malformed-bad-source",
      record({ source: "other" as never }),
      "credential_malformed",
    ],
    [
      "malformed-missing-key",
      record({ provider_api_key: "" }),
      "credential_malformed",
    ],
    [
      "malformed-wrong-ref",
      record({ ref: "other-ref" }),
      "credential_malformed",
    ],
  ])("%s maps to %s", async (_label, rec, kind) => {
    const { port } = capturingPort(rec as GovernedCredentialRecord | null);
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
      ...(kind === "credential_rotated"
        ? { expected_credential_version: 2 }
        : {}),
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind }),
    });
  });

  it("maps throwing reads without leaking raw errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const port: CredentialReadPort = {
      getCredential: async () => {
        throw new Error("db exploded: secret-key-abc");
      },
    };
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "credential_dependency_failed" }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-key-abc");
    expect(JSON.stringify(result)).not.toContain("db exploded");
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
    log.mockRestore();
  });

  it("performs no env substitution", async () => {
    const { port } = capturingPort(null);
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("credential_not_found");
  });
});

describe("token domain separation", () => {
  const route = {
    provider: "claude",
    model: "claude-sonnet-5",
    credential_ref: "user-key-1",
  };

  it.each([
    ["membership_identity"],
    ["oauth_access_token"],
    ["oauth_refresh_token"],
  ])("rejects domain %s", async (domain) => {
    const { port } = capturingPort(
      record({ domain: domain as never, provider_api_key: "secret-key-abc" }),
    );
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "credential_wrong_domain" }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-key-abc");
  });
});

describe("router BYOK policy", () => {
  it("allows governed openrouter user keys", async () => {
    const route = {
      provider: "openrouter",
      model: "openrouter/anthropic/claude-sonnet-4.5",
      credential_ref: "user-key-1",
    };
    const { port } = capturingPort(
      record({ provider: "openrouter", source: "user" }),
    );
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["vercel", "vercel/openai/gpt-5.4"],
    ["opencode-go", "opencode-go/glm-5"],
  ])("defers user %s credential as undecided", async (provider, model) => {
    const route = { provider, model, credential_ref: "user-key-1" };
    const { port } = capturingPort(record({ provider, source: "user" }));
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        kind: "user_router_byok_policy_undecided",
      }),
    });
  });

  it.each([
    ["vercel", "vercel/openai/gpt-5.4"],
    ["opencode-go", "opencode-go/glm-5"],
  ])("resolves environment %s records explicitly", async (provider, model) => {
    const route = { provider, model, credential_ref: "env-key-1" };
    const { port } = capturingPort(
      record({ ref: "env-key-1", provider, source: "env" }),
    );
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(result.ok).toBe(true);
  });
});

describe("secret hygiene and provenance", () => {
  it("rejects a record that mixes provider keys with other credential domains", async () => {
    const route = {
      provider: "claude",
      model: "claude-sonnet-5",
      credential_ref: "user-key-1",
    };
    const { port } = capturingPort(
      record({
        oauth_access_token: "oauth-secret",
        oauth_refresh_token: "refresh-secret",
        membership_identity: "member-secret",
      }),
    );
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "credential_wrong_domain" }),
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret-key-abc|oauth-secret|refresh-secret|member-secret/,
    );
  });

  it("keeps a single-domain secret out of receipts and serialized results", async () => {
    const route = {
      provider: "claude",
      model: "claude-sonnet-5",
      credential_ref: "user-key-1",
    };
    const { port } = capturingPort(
      record({ provider_api_key: "super-secret-xyz" }),
    );
    const result = await resolveGovernedCredential({
      user_id: "user-1",
      route,
      port,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result)).not.toContain("super-secret-xyz");
      expect(result.receipt).not.toHaveProperty("provider_api_key");
      expect(result.receipt).not.toHaveProperty("secret");
      expect(result.receipt.route).toEqual(route);
      expect(Object.isFrozen(result.receipt)).toBe(true);
      expect(Object.isFrozen(result.receipt.route)).toBe(true);
    }
  });
});

describe("runtime export lock and import boundary", () => {
  it("exposes exactly the governed boundary", async () => {
    const mod = await import("./governedProviderRoute");
    expect(Object.keys(mod).sort()).toEqual(
      [
        "resolveExplicitProviderRoute",
        "resolveGovernedCredential",
        "resolveSavedProviderPreference",
      ].sort(),
    );
  });

  it("imports shared vocabulary and pure model helpers only", () => {
    expect(IMPL_SOURCE).toContain("sharedContracts");
    expect(IMPL_SOURCE).toContain("llm/models");
    for (const banned of [
      "@ai-sdk",
      "llm/providers",
      "chat/streaming",
      "userApiKeys",
      "supabase",
      "undici",
      "node:http",
      "process.env",
    ]) {
      expect(IMPL_SOURCE).not.toContain(banned);
    }
    expect(IMPL_SOURCE).not.toMatch(/\bfetch\s*\(/);
  });
});
