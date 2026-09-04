import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { GovernedCredentialRecord } from "./governedProviderRoute";
import {
  executeGovernedProviderCall,
  resolveProviderEgressTarget,
} from "./providerEgress";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPL_SOURCE = readFileSync(join(HERE, "providerEgress.ts"), "utf8");

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

function portFor(rec: GovernedCredentialRecord | null) {
  return {
    getCredential: async () => rec,
  };
}

const VALID_ROUTE = {
  provider: "claude",
  model: "claude-sonnet-5",
  credential_ref: "user-key-1",
};

describe("egress allowlist", () => {
  it("allows only the exact fake host", () => {
    expect(resolveProviderEgressTarget("fake")).toEqual({
      allowed: true,
      host: "fake",
    });
  });

  it.each([
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "www.googleapis.com",
    "openrouter.ai",
    "fake.googleapis.com/upload",
    "evil-fake.example.com",
    "FAKE",
    "fake/",
    "",
  ])("blocks host %s before any sender", (host) => {
    expect(resolveProviderEgressTarget(host)).toEqual({
      allowed: false,
      host,
      reason: "real_provider_egress_blocked",
    });
  });
});

describe("fake sender gating", () => {
  it("calls the fake sender once after validation with provenance", async () => {
    const sender = vi.fn(async () => ({ text: "fake-output" }));
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route: VALID_ROUTE,
      credentialPort: portFor(record()),
      host: "fake",
      sender,
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        route: VALID_ROUTE,
        provider_api_key: "secret-key-abc",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.host).toBe("fake");
      expect(result.route).toEqual(VALID_ROUTE);
      expect(result.receipt.credential_ref).toBe("user-key-1");
      expect(result.receipt.source).toBe("user");
      expect(result.receipt.version).toBe(2);
      expect(result.receipt.provider).toBe("claude");
      expect(result.receipt.model).toBe("claude-sonnet-5");
      expect(result.senderResult).toEqual({ text: "fake-output" });
      expect(JSON.stringify(result.receipt)).not.toContain("secret-key-abc");
    }
  });

  it("redacts sender failures instead of throwing raw errors", async () => {
    const sender = vi.fn(async () => {
      throw new Error("provider exploded: secret-key-abc");
    });
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route: VALID_ROUTE,
      credentialPort: portFor(record()),
      host: "fake",
      sender,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider_sender_failed" }),
    });
    expect(JSON.stringify(result)).not.toMatch(
      /provider exploded|secret-key-abc/,
    );
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("rejects a sender that mutates the receipt with the execution secret", async () => {
    const sender = vi.fn(
      async ({
        receipt,
        provider_api_key,
      }: {
        receipt: Record<string, unknown>;
        provider_api_key: string;
      }) => {
        receipt.provider_api_key = provider_api_key;
        return { text: "fake-output" };
      },
    );
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route: VALID_ROUTE,
      credentialPort: portFor(record()),
      host: "fake",
      sender,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider_sender_failed" }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-key-abc");
  });

  it("detects reflected secrets after JSON escaping", async () => {
    const escapedSecret = 'secret"key\\line\nnext';
    const sender = vi.fn(async () => ({ reflected: escapedSecret }));
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route: VALID_ROUTE,
      credentialPort: portFor(record({ provider_api_key: escapedSecret })),
      host: "fake",
      sender,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider_sender_failed" }),
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("detects the execution secret when used as a JSON property name", async () => {
    const sender = vi.fn(
      async ({ provider_api_key }: { provider_api_key: string }) => ({
        [provider_api_key]: true,
      }),
    );
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route: VALID_ROUTE,
      credentialPort: portFor(record()),
      host: "fake",
      sender,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider_sender_failed" }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-key-abc");
  });

  it("invokes sender zero times on route drift", async () => {
    const sender = vi.fn(async () => ({ text: "nope" }));
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route: {
        provider: "claude",
        model: "gpt-5.6-sol",
        credential_ref: "user-key-1",
      },
      credentialPort: portFor(record()),
      host: "fake",
      sender,
    });
    expect(result.ok).toBe(false);
    expect(sender).not.toHaveBeenCalled();
  });

  it("invokes sender zero times on credential failure", async () => {
    const sender = vi.fn(async () => ({ text: "nope" }));
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route: VALID_ROUTE,
      credentialPort: portFor(null),
      host: "fake",
      sender,
    });
    expect(result.ok).toBe(false);
    expect(sender).not.toHaveBeenCalled();
  });

  it("invokes sender zero times on undecided router BYOK", async () => {
    const sender = vi.fn(async () => ({ text: "nope" }));
    const route = {
      provider: "vercel",
      model: "vercel/openai/gpt-5.4",
      credential_ref: "user-key-1",
    };
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route,
      credentialPort: portFor(
        record({ ref: "user-key-1", provider: "vercel" }),
      ),
      host: "fake",
      sender,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        kind: "user_router_byok_policy_undecided",
      }),
    });
    expect(sender).not.toHaveBeenCalled();
  });

  it.each([
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "openrouter.ai",
    "evil-fake.example.com",
  ])(
    "blocks real host %s before credential lookup or sender",
    async (host: string) => {
      const getCredential = vi.fn(async () => record());
      const sender = vi.fn(async () => ({ text: "nope" }));
      const result = await executeGovernedProviderCall({
        user_id: "user-1",
        route: VALID_ROUTE,
        credentialPort: { getCredential },
        host,
        sender,
      });
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          kind: "real_provider_egress_blocked",
          host,
        }),
      });
      expect(getCredential).not.toHaveBeenCalled();
      expect(sender).not.toHaveBeenCalled();
    },
  );

  it("rejects fake sender output that reflects the execution secret", async () => {
    const sender = vi.fn(
      async ({ provider_api_key }: { provider_api_key: string }) => ({
        text: "fake-output",
        reflected: provider_api_key,
      }),
    );
    const result = await executeGovernedProviderCall({
      user_id: "user-1",
      route: VALID_ROUTE,
      credentialPort: portFor(record()),
      host: "fake",
      sender,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider_sender_failed" }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-key-abc");
  });
});

describe("runtime export lock and import boundary", () => {
  it("exposes exactly the egress boundary", async () => {
    const mod = await import("./providerEgress");
    expect(Object.keys(mod).sort()).toEqual(
      ["executeGovernedProviderCall", "resolveProviderEgressTarget"].sort(),
    );
  });

  it("consumes the frozen policy with no network or SDK imports", () => {
    expect(IMPL_SOURCE).toContain("EGRESS_POLICY");
    expect(IMPL_SOURCE).toContain("governedProviderRoute");
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
