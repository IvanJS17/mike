import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeCatalogSyncInput,
  executeCatalogSyncPlan,
  type AtomicCatalogSyncPort,
  type CatalogSyncInput,
  type GovernedWorkflowSyncCandidate,
} from "./catalogSyncPlan";

const COMMIT = "a".repeat(40);
const NEXT_COMMIT = "b".repeat(40);
const HASH = "c".repeat(64);
const NEXT_HASH = "d".repeat(64);
const ASSET_HASH = "e".repeat(64);

function workflow(
  overrides: Partial<GovernedWorkflowSyncCandidate> = {},
): GovernedWorkflowSyncCandidate {
  return {
    workflow_key: "civil-commercial-mx-triage",
    version: "0.1.0",
    content_hash: HASH,
    distribution: "addon",
    type: "assistant",
    source: "docs/playbooks/PLAYBOOK_CIVIL_MERCANTIL_MX_v0.1.md",
    approval_provenance:
      "Beta read-only specification; later legal validation pending",
    reference_assets: [
      {
        filename: "authority-map.json",
        size_bytes: 123,
        file_type: "application/json",
        content_hash: ASSET_HASH,
      },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<CatalogSyncInput> = {}): CatalogSyncInput {
  return {
    source_commit: COMMIT,
    workflows: [workflow()],
    ...overrides,
  };
}

describe("catalog sync canonicalization", () => {
  it("sorts workflows and reference assets without mutating input", () => {
    const original = input({
      workflows: [
        workflow({ workflow_key: "zeta", reference_assets: [] }),
        workflow({
          workflow_key: "alpha",
          content_hash: NEXT_HASH,
          reference_assets: [
            {
              filename: "z.txt",
              size_bytes: 2,
              file_type: "text/plain",
              content_hash: "f".repeat(64),
            },
            {
              filename: "a.txt",
              size_bytes: 1,
              file_type: "text/plain",
              content_hash: ASSET_HASH,
            },
          ],
        }),
      ],
    });
    const result = canonicalizeCatalogSyncInput(original);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalog.workflows.map((item) => item.workflow_key)).toEqual(
        ["alpha", "zeta"],
      );
      expect(
        result.catalog.workflows[0].reference_assets.map(
          (asset) => asset.filename,
        ),
      ).toEqual(["a.txt", "z.txt"]);
      expect(Object.isFrozen(result.catalog)).toBe(true);
      expect(Object.isFrozen(result.catalog.workflows)).toBe(true);
    }
    expect(original.workflows[0].workflow_key).toBe("zeta");
  });

  it("uses locale-independent code-unit ordering and a pinned canonical hash", () => {
    const result = canonicalizeCatalogSyncInput(
      input({
        workflows: [
          workflow({
            reference_assets: [
              {
                filename: "ä.txt",
                size_bytes: 2,
                file_type: "text/plain",
                content_hash: "f".repeat(64),
              },
              {
                filename: "z.txt",
                size_bytes: 1,
                file_type: "text/plain",
                content_hash: ASSET_HASH,
              },
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.catalog.workflows[0].reference_assets.map(
        (asset) => asset.filename,
      ),
    ).toEqual(["z.txt", "ä.txt"]);
    expect(result.catalog_hash).toBe(
      "2c5e06a2e5221b61665aa20c91c92da3f084a75126aee8cd26f5c7dffa9dacdd",
    );
  });

  it.each([
    ["identical duplicate", [workflow(), workflow()]],
    [
      "conflicting version",
      [workflow(), workflow({ version: "0.2.0", content_hash: NEXT_HASH })],
    ],
    ["conflicting hash", [workflow(), workflow({ content_hash: NEXT_HASH })]],
  ])("rejects %s before the port", (_label, workflows) => {
    const result = canonicalizeCatalogSyncInput(input({ workflows }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([
        "duplicate_workflow_key",
        "conflicting_workflow_version",
        "conflicting_workflow_hash",
      ]).toContain(result.error.kind);
    }
  });

  it.each([
    ["unsafe filename", { filename: "../secret.txt" }],
    ["control character", { filename: "authority\u0000map.json" }],
    ["leading whitespace", { filename: " authority-map.json" }],
    ["trailing whitespace", { filename: "authority-map.json " }],
    ["nested filename", { filename: "folder/secret.txt" }],
    ["empty filename", { filename: "" }],
    ["negative size", { size_bytes: -1 }],
    ["fractional size", { size_bytes: 1.5 }],
    ["empty type", { file_type: "" }],
    ["invalid type", { file_type: "text plain" }],
    ["uppercase hash", { content_hash: ASSET_HASH.toUpperCase() }],
    ["short hash", { content_hash: ASSET_HASH.slice(1) }],
  ])("rejects malformed reference metadata: %s", (_label, override) => {
    const base = workflow().reference_assets[0];
    const result = canonicalizeCatalogSyncInput(
      input({
        workflows: [workflow({ reference_assets: [{ ...base, ...override }] })],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "malformed_reference_asset" },
    });
  });

  it("rejects duplicate reference filenames", () => {
    const asset = workflow().reference_assets[0];
    expect(
      canonicalizeCatalogSyncInput(
        input({ workflows: [workflow({ reference_assets: [asset, asset] })] }),
      ),
    ).toEqual({
      ok: false,
      error: { kind: "duplicate_reference_asset" },
    });
  });
});

describe("atomic idempotent sync", () => {
  it("returns an exact no-op without invoking the port", async () => {
    const atomicReplace = vi.fn();
    const result = await executeCatalogSyncPlan({
      current: { source_commit: COMMIT, workflows: [workflow()] },
      incoming: input(),
      port: { atomicReplace },
    });
    expect(result).toMatchObject({
      ok: true,
      status: "noop",
      source_commit: COMMIT,
      workflow_count: 1,
    });
    expect(atomicReplace).not.toHaveBeenCalled();
  });

  it("invokes one atomic replace for a changed canonical catalog", async () => {
    const canonical = canonicalizeCatalogSyncInput(
      input({ source_commit: NEXT_COMMIT }),
    );
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;

    const atomicReplace = vi.fn(async (request) => ({
      applied: true,
      source_commit: request.catalog.source_commit,
      catalog_hash: request.catalog_hash,
      workflow_count: request.catalog.workflows.length,
    }));
    const result = await executeCatalogSyncPlan({
      current: { source_commit: COMMIT, workflows: [workflow()] },
      incoming: input({ source_commit: NEXT_COMMIT }),
      port: { atomicReplace },
    });
    expect(result).toEqual({
      ok: true,
      status: "replaced",
      source_commit: NEXT_COMMIT,
      catalog_hash: canonical.catalog_hash,
      workflow_count: 1,
    });
    expect(atomicReplace).toHaveBeenCalledOnce();
    expect(atomicReplace).toHaveBeenCalledWith({
      expected_catalog_hash: expect.any(String),
      catalog_hash: canonical.catalog_hash,
      catalog: canonical.catalog,
    });
  });

  it.each([
    ["version", { version: "0.1.1" }],
    ["approval provenance", { approval_provenance: "legally validated" }],
    [
      "reference asset metadata",
      {
        reference_assets: [
          {
            ...workflow().reference_assets[0],
            size_bytes: 124,
          },
        ],
      },
    ],
  ])(
    "atomically replaces same-commit catalogs with changed %s",
    async (_label, override) => {
      const atomicReplace = vi.fn(async (request) => ({
        applied: true,
        source_commit: request.catalog.source_commit,
        catalog_hash: request.catalog_hash,
        workflow_count: request.catalog.workflows.length,
      }));
      const result = await executeCatalogSyncPlan({
        current: input(),
        incoming: input({ workflows: [workflow(override)] }),
        port: { atomicReplace },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe("replaced");
      expect(atomicReplace).toHaveBeenCalledOnce();
    },
  );

  it("treats same commit with changed content hash as changed", async () => {
    const atomicReplace = vi.fn(async (request) => ({
      applied: true,
      source_commit: request.catalog.source_commit,
      catalog_hash: request.catalog_hash,
      workflow_count: request.catalog.workflows.length,
    }));
    const result = await executeCatalogSyncPlan({
      current: { source_commit: COMMIT, workflows: [workflow()] },
      incoming: input({
        workflows: [workflow({ content_hash: NEXT_HASH })],
      }),
      port: { atomicReplace },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("replaced");
    expect(atomicReplace).toHaveBeenCalledOnce();
  });

  it("fails opaquely on throwing ports without retrying", async () => {
    const atomicReplace = vi.fn(async () => {
      throw new Error("database SECRET exploded");
    });
    const result = await executeCatalogSyncPlan({
      current: { source_commit: COMMIT, workflows: [workflow()] },
      incoming: input({ source_commit: NEXT_COMMIT }),
      port: { atomicReplace },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "catalog_sync_dependency_failed" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(atomicReplace).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { applied: false },
    {
      applied: true,
      source_commit: NEXT_COMMIT,
      catalog_hash: "0".repeat(64),
      workflow_count: 1,
    },
    {
      applied: true,
      source_commit: COMMIT,
      catalog_hash: HASH,
      workflow_count: 99,
    },
  ])("fails closed on malformed or mismatched receipt %#", async (receipt) => {
    const atomicReplace = vi.fn(
      async () => receipt,
    ) as unknown as AtomicCatalogSyncPort["atomicReplace"];
    const result = await executeCatalogSyncPlan({
      current: { source_commit: COMMIT, workflows: [workflow()] },
      incoming: input({ source_commit: NEXT_COMMIT }),
      port: { atomicReplace },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "malformed_catalog_sync_receipt" },
    });
    expect(atomicReplace).toHaveBeenCalledOnce();
  });

  it("rejects malformed incoming data before invoking the port", async () => {
    const atomicReplace = vi.fn();
    const result = await executeCatalogSyncPlan({
      current: { source_commit: COMMIT, workflows: [workflow()] },
      incoming: input({ workflows: [workflow(), workflow()] }),
      port: { atomicReplace },
    });
    expect(result.ok).toBe(false);
    expect(atomicReplace).not.toHaveBeenCalled();
  });
});

describe("runtime and import boundary", () => {
  it("exports only canonicalization and atomic plan execution", async () => {
    const mod = await import("./catalogSyncPlan");
    expect(Object.keys(mod).sort()).toEqual(
      ["canonicalizeCatalogSyncInput", "executeCatalogSyncPlan"].sort(),
    );
  });

  it("has no storage, database, route, legacy registry or network import", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "catalogSyncPlan.ts"), "utf8");
    for (const banned of [
      "systemWorkflows",
      "workflowCatalogSync",
      "workflowCatalogSource",
      "storage",
      "supabase",
      "routes/",
      "fetch(",
      "node:http",
      "undici",
    ]) {
      expect(source).not.toContain(banned);
    }
  });
});
