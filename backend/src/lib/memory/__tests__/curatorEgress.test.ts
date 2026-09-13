/**
 * LiTT (S5b): governed curator egress invariants.
 *
 * (a) no stored credential → blocked, sender never invoked;
 * (b) allowlisted fake host → sender invoked exactly once with the
 *     versioned credential from the port;
 * (c) real host → real_provider_egress_blocked BEFORE any credential read or
 *     sender invocation.
 */
import { describe, expect, it, vi } from "vitest";
import type { CredentialReadPort } from "../../recovery/providers/governedProviderRoute";
import {
  createGovernedCuratorStream,
  MemoryCuratorEgressBlockedError,
} from "../curatorEgress";

function fakeDb(row: { credential_ref: string; enabled: boolean } | null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain } as never;
}

const credentialRecord = {
  ref: "openai:v3",
  provider: "openai",
  domain: "provider_api_key" as const,
  source: "user" as const,
  enabled: true,
  version: 3,
  user_id: "u1",
  provider_api_key: "sk-governed",
};

function fakePort(): CredentialReadPort & { calls: number } {
  const port = {
    calls: 0,
    async getCredential() {
      port.calls += 1;
      return { ...credentialRecord };
    },
  };
  return port;
}

const params = {
  model: "gpt-5.4",
  systemPrompt: "s",
  messages: [],
} as never;

describe("governed curator egress", () => {
  it("blocks when the user has no stored credential (sender never runs)", async () => {
    const sender = vi.fn();
    const stream = createGovernedCuratorStream(
      { db: fakeDb(null), userId: "u1", userEmail: null },
      { credentialPort: fakePort(), host: "fake", sender },
    );

    await expect(stream(params)).rejects.toMatchObject({
      name: "MemoryCuratorEgressBlockedError",
      kind: "credential_not_found",
    });
    expect(sender).not.toHaveBeenCalled();
  });

  it("streams through the fake host exactly once with the governed key", async () => {
    const sender = vi.fn(async (_input: unknown) => ({ fullText: "ok" }));
    const port = fakePort();
    const stream = createGovernedCuratorStream(
      {
        db: fakeDb({ credential_ref: "openai:v3", enabled: true }),
        userId: "u1",
        userEmail: null,
      },
      { credentialPort: port, host: "fake", sender },
    );

    await expect(stream(params)).resolves.toEqual({ fullText: "ok" });
    expect(sender).toHaveBeenCalledTimes(1);
    const call = sender.mock.calls[0]![0] as {
      provider_api_key: string;
      route: { credential_ref: string };
      receipt: { version: number };
    };
    expect(call.provider_api_key).toBe("sk-governed");
    expect(call.route.credential_ref).toBe("openai:v3");
    expect(call.receipt.version).toBe(3);
  });

  it("blocks a real host before any credential read or sender call", async () => {
    const sender = vi.fn();
    const port = fakePort();
    const stream = createGovernedCuratorStream(
      {
        db: fakeDb({ credential_ref: "openai:v3", enabled: true }),
        userId: "u1",
        userEmail: null,
      },
      { credentialPort: port, sender },
    );

    await expect(stream(params)).rejects.toMatchObject({
      name: "MemoryCuratorEgressBlockedError",
      kind: "real_provider_egress_blocked",
    });
    expect(port.calls).toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it("blocks a disabled credential without invoking the sender", async () => {
    const sender = vi.fn();
    const stream = createGovernedCuratorStream(
      {
        db: fakeDb({ credential_ref: "openai:v3", enabled: false }),
        userId: "u1",
        userEmail: null,
      },
      { credentialPort: fakePort(), host: "fake", sender },
    );

    await expect(stream(params)).rejects.toMatchObject({
      kind: "credential_disabled",
    });
    expect(sender).not.toHaveBeenCalled();
  });
});
