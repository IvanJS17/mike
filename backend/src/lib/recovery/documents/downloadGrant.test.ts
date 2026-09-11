import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  consumeDownloadGrant,
  DOWNLOAD_GRANT_DEPENDENCY_KIND,
  type DownloadGrantPort,
} from "./downloadGrant";

const SHA = "a".repeat(64);
const PREFIX = "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1";
const OBJECT_KEY = `${PREFIX}/versions/${SHA}.pdf`;
const NOW = new Date("2026-09-03T12:00:00.000Z");
const FUTURE = new Date("2026-09-03T13:00:00.000Z").toISOString();
const PAST = new Date("2026-09-03T11:00:00.000Z").toISOString();
const EARLIER_USE = new Date("2026-09-03T11:30:00.000Z").toISOString();

function ownershipWithGrant(grant?: {
  grant_id: string;
  expires_at: string;
  used_at?: string;
}) {
  return {
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: "project-1",
    document_id: "doc-1",
    version_hash: SHA,
    object_prefix: PREFIX,
    download_grant: grant ?? { grant_id: "grant-1", expires_at: FUTURE },
  };
}

function successPort(overrides: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const port: DownloadGrantPort = {
    async consumeOnce(input) {
      calls.push({ ...input });
      return {
        disposition: "consumed",
        grant_id: "grant-1",
        expires_at: FUTURE,
        used_at: NOW.toISOString(),
        organization_id: "org-1",
        matter_id: "matter-1",
        project_id: "project-1",
        document_id: "doc-1",
        object_key: OBJECT_KEY,
        ...overrides,
      };
    },
  };
  return { port, calls };
}

describe("grant valid/expired/used/scope/key matrices", () => {
  it("consumes a valid grant and returns the authorized key", async () => {
    const { port, calls } = successPort();
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({
      ok: true,
      grant_id: "grant-1",
      objectKey: OBJECT_KEY,
    });
    expect(calls).toHaveLength(1);
  });

  it("returns expired without storage access when the grant lapsed", async () => {
    const { port, calls } = successPort();
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant({
          grant_id: "grant-1",
          expires_at: PAST,
        }),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "expired" } });
    expect(calls).toEqual([]);
  });

  it("returns already_used without storage access when the grant is spent", async () => {
    const { port, calls } = successPort();
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant({
          grant_id: "grant-1",
          expires_at: FUTURE,
          used_at: EARLIER_USE,
        }),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "already_used" } });
    expect(calls).toEqual([]);
  });

  it("returns opaque not_found for grant-id mismatch", async () => {
    const { port, calls } = successPort();
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-2",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(calls).toEqual([]);
  });

  it("returns opaque not_found for key mismatch without storage access", async () => {
    const { port, calls } = successPort();
    const foreignKey =
      "orgs/org-2/matters/matter-1/projects/project-1/documents/doc-1/file.pdf";
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: foreignKey,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(calls).toEqual([]);
  });

  it("returns opaque not_found for tampered ownership without storage access", async () => {
    const { port, calls } = successPort();
    const tampered = {
      ...ownershipWithGrant(),
      document_id: "doc-2",
    };
    const result = await consumeDownloadGrant(
      {
        ownership: tampered,
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(calls).toEqual([]);
  });

  it("fails closed before the port for malformed prior used_at states", async () => {
    for (const used_at of [null, "", 42, true]) {
      const { port, calls } = successPort();
      const ownership = ownershipWithGrant() as Record<string, unknown>;
      ownership.download_grant = {
        grant_id: "grant-1",
        expires_at: FUTURE,
        used_at,
      };
      const result = await consumeDownloadGrant(
        {
          ownership: ownership as never,
          grantId: "grant-1",
          expectedObjectKey: OBJECT_KEY,
        },
        { port, clock: () => NOW },
      );
      expect(result).toEqual({
        ok: false,
        error: { kind: "document_storage_dependency_failed" },
      });
      expect(calls).toEqual([]);
    }
  });

  it("is governed by the injected clock, not wall time", async () => {
    const before = new Date("2026-09-03T12:30:00.000Z");
    const after = new Date("2026-09-03T13:30:00.000Z");
    const grant = { grant_id: "grant-1", expires_at: FUTURE };
    // The port stamps with the domain clock: each mock stamps its own call
    // time so the stamp is never earlier than the caller's pre-state.
    const earlyPort = successPort({ used_at: before.toISOString() });
    const early = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(grant),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port: earlyPort.port, clock: () => before },
    );
    expect(early.ok).toBe(true);
    const latePort = successPort();
    const late = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(grant),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port: latePort.port, clock: () => after },
    );
    expect(late).toEqual({ ok: false, error: { kind: "expired" } });
    expect(latePort.calls).toEqual([]);
  });
});

describe("atomic consume called exactly once only for valid grants", () => {
  it("calls consumeOnce once with exact scope, key, and unused preconditions", async () => {
    const { port, calls } = successPort();
    await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(calls).toEqual([
      {
        grant_id: "grant-1",
        organization_id: "org-1",
        matter_id: "matter-1",
        project_id: "project-1",
        document_id: "doc-1",
        object_key: OBJECT_KEY,
        expected_expires_at: FUTURE,
        expected_unused: true,
      },
    ]);
  });

  it("never calls consumeOnce for expired, used, or mismatched grants", async () => {
    const inputs = [
      ownershipWithGrant({ grant_id: "grant-1", expires_at: PAST }),
      ownershipWithGrant({
        grant_id: "grant-1",
        expires_at: FUTURE,
        used_at: EARLIER_USE,
      }),
    ];
    for (const ownership of inputs) {
      const { port, calls } = successPort();
      await consumeDownloadGrant(
        { ownership, grantId: "grant-1", expectedObjectKey: OBJECT_KEY },
        { port, clock: () => NOW },
      );
      expect(calls).toEqual([]);
    }
  });
});

describe("consume race and returned-grant revalidation", () => {
  it("maps a race loser (already-consumed row) to already_used with one call", async () => {
    const { port, calls } = successPort({
      disposition: "already_used",
      used_at: EARLIER_USE,
    });
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "already_used" } });
    expect(calls).toHaveLength(1);
  });

  it("maps a same-timestamp race loser by atomic disposition", async () => {
    const { port, calls } = successPort({
      disposition: "already_used",
      used_at: NOW.toISOString(),
    });
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "already_used" } });
    expect(calls).toHaveLength(1);
  });

  it("rejects consumed rows with impossible used_at chronology", async () => {
    for (const used_at of [
      EARLIER_USE,
      new Date("2026-09-03T12:30:00.000Z").toISOString(),
      new Date("2026-09-03T13:30:00.000Z").toISOString(),
    ]) {
      const { port, calls } = successPort({
        disposition: "consumed",
        used_at,
      });
      const result = await consumeDownloadGrant(
        {
          ownership: ownershipWithGrant(),
          grantId: "grant-1",
          expectedObjectKey: OBJECT_KEY,
        },
        { port, clock: () => NOW },
      );
      expect(result).toEqual({
        ok: false,
        error: { kind: "document_storage_dependency_failed" },
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("maps a scope-mismatched returned row to opaque not_found", async () => {
    const { port, calls } = successPort({ organization_id: "org-2" });
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(calls).toHaveLength(1);
  });

  it("maps a key-mismatched returned row to opaque not_found", async () => {
    const { port, calls } = successPort({ object_key: `${PREFIX}/other.pdf` });
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(calls).toHaveLength(1);
  });

  it("maps an expired returned row to expired", async () => {
    const { port, calls } = successPort({ expires_at: PAST });
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: { kind: "expired" } });
    expect(calls).toHaveLength(1);
  });
});

describe("malformed or throwing ports stay redacted", () => {
  it("exposes the single redacted dependency kind", () => {
    expect(DOWNLOAD_GRANT_DEPENDENCY_KIND).toBe(
      "document_storage_dependency_failed",
    );
  });

  it("maps a throwing port to the redacted dependency failure", async () => {
    const calls: unknown[] = [];
    const port: DownloadGrantPort = {
      async consumeOnce(input) {
        calls.push(input);
        throw new Error(
          "R2_ENDPOINT_URL=https://secret.internal bucket=mike boom",
        );
      },
    };
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "document_storage_dependency_failed" },
    });
    expect(calls).toHaveLength(1);
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("endpoint");
    expect(serialized).not.toContain("bucket");
    expect(serialized).not.toContain("boom");
  });

  it("maps malformed rows to the redacted dependency failure", async () => {
    const malformed: unknown[] = [
      null,
      {},
      { grant_id: "grant-1" },
      { ...successPort().port, grant_id: 42 },
      "grant-1",
    ];
    for (const row of malformed) {
      const port: DownloadGrantPort = {
        async consumeOnce() {
          return row;
        },
      };
      const result = await consumeDownloadGrant(
        {
          ownership: ownershipWithGrant(),
          grantId: "grant-1",
          expectedObjectKey: OBJECT_KEY,
        },
        { port, clock: () => NOW },
      );
      expect(result).toEqual({
        ok: false,
        error: { kind: "document_storage_dependency_failed" },
      });
    }
  });

  it("maps a malformed expiry in ownership to the redacted failure", async () => {
    const { port, calls } = successPort();
    const result = await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant({
          grant_id: "grant-1",
          expires_at: "not-a-date",
        }),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "document_storage_dependency_failed" },
    });
    expect(calls).toEqual([]);
  });

  it("never retries a throwing port", async () => {
    let attempts = 0;
    const port: DownloadGrantPort = {
      async consumeOnce() {
        attempts += 1;
        throw new Error("db unavailable");
      },
    };
    await consumeDownloadGrant(
      {
        ownership: ownershipWithGrant(),
        grantId: "grant-1",
        expectedObjectKey: OBJECT_KEY,
      },
      { port, clock: () => NOW },
    );
    expect(attempts).toBe(1);
  });
});

describe("runtime export lock and zero legacy imports", () => {
  it("exposes exactly the governed download-grant surface", async () => {
    const module = await import("./downloadGrant");
    expect(Object.keys(module).sort()).toEqual(
      [
        "DOWNLOAD_GRANT_DEPENDENCY_KIND",
        "consumeDownloadGrant",
        "isDownloadGrantPortRow",
      ].sort(),
    );
  });

  it("has no legacy storage, AWS, or logging imports", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "downloadGrant.ts"), "utf8");
    expect(source).toContain("DownloadGrantPort");
    expect(source).not.toMatch(/@aws-sdk/);
    expect(source).not.toMatch(/from\s+["']\.\.\/storage["']/);
    expect(source).not.toMatch(/documentVersions/);
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
    expect(source).not.toMatch(/R2_/);
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });
});
