import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  GOVERNED_WORKFLOW_CONTENT_HASH_RE,
  GOVERNED_WORKFLOW_SOURCE_COMMIT_RE,
  parseGovernedWorkflowCatalogRow,
  parseWorkflowExecutionPin,
  resolveWorkflowExecutionPin,
  type GovernedWorkflowCatalogRow,
  type WorkflowCatalogReadPort,
} from "./governedWorkflowCatalog";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

function row(
  overrides: Partial<GovernedWorkflowCatalogRow> = {},
): GovernedWorkflowCatalogRow {
  return {
    workflow_key: "civil-commercial-mx-triage",
    version: "0.1.0",
    content_hash: HASH,
    source_commit: COMMIT,
    distribution: "addon",
    type: "assistant",
    active: true,
    source: "docs/playbooks/PLAYBOOK_CIVIL_MERCANTIL_MX_v0.1.md",
    approval_provenance:
      "Beta read-only specification; later legal validation pending",
    ...overrides,
  };
}

function portWith(value: unknown): WorkflowCatalogReadPort {
  return { getWorkflow: vi.fn(async () => value) };
}

describe("persisted governed workflow catalog rows", () => {
  it("accepts the exact active governed row vocabulary", () => {
    const persisted = {
      id: "catalog-row-1",
      title: "Civil/Mercantile MX",
      prompt_md: "governed content",
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z",
      ...row(),
    };
    const result = parseGovernedWorkflowCatalogRow(persisted);
    expect(result).toEqual({ ok: true, row: row() });
    if (result.ok) expect(Object.isFrozen(result.row)).toBe(true);
  });

  it.each([
    ["non-object", null],
    ["array", []],
    ["unstable key", row({ workflow_key: "Civil MX" })],
    ["empty version", row({ version: " " })],
    ["short content hash", row({ content_hash: "a".repeat(63) })],
    ["uppercase content hash", row({ content_hash: "A".repeat(64) })],
    ["short source commit", row({ source_commit: "b".repeat(39) })],
    ["uppercase source commit", row({ source_commit: "B".repeat(40) })],
    ["invalid distribution", row({ distribution: "system" as never })],
    ["invalid type", row({ type: "agent" as never })],
    ["non-boolean active", row({ active: 1 as never })],
    ["empty source", row({ source: "" })],
    ["empty approval", row({ approval_provenance: "" })],
  ])("rejects %s opaquely", (_label, value) => {
    const result = parseGovernedWorkflowCatalogRow(value);
    expect(result).toEqual({
      ok: false,
      error: { kind: "malformed_catalog_row" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("exports strict lowercase hash and commit validators", () => {
    expect(GOVERNED_WORKFLOW_CONTENT_HASH_RE.test(HASH)).toBe(true);
    expect(GOVERNED_WORKFLOW_CONTENT_HASH_RE.test(HASH.toUpperCase())).toBe(
      false,
    );
    expect(GOVERNED_WORKFLOW_SOURCE_COMMIT_RE.test(COMMIT)).toBe(true);
    expect(GOVERNED_WORKFLOW_SOURCE_COMMIT_RE.test(COMMIT.toUpperCase())).toBe(
      false,
    );
  });
});

describe("immutable execution pins", () => {
  it("loads the exact active row and builds an immutable shared identity", async () => {
    const port = portWith(row());
    const result = await resolveWorkflowExecutionPin({
      expected_identity: row(),
      port,
    });
    expect(port.getWorkflow).toHaveBeenCalledWith("civil-commercial-mx-triage");
    expect(result).toEqual({
      ok: true,
      pin: {
        workflow_key: "civil-commercial-mx-triage",
        version: "0.1.0",
        content_hash: HASH,
        source_commit: COMMIT,
        distribution: "addon",
        type: "assistant",
        source: "docs/playbooks/PLAYBOOK_CIVIL_MERCANTIL_MX_v0.1.md",
        approval_provenance:
          "Beta read-only specification; later legal validation pending",
      },
    });
    if (result.ok) expect(Object.isFrozen(result.pin)).toBe(true);
  });

  it("rejects inactive and explicit identity mismatches", async () => {
    const inactive = await resolveWorkflowExecutionPin({
      expected_identity: row(),
      port: portWith(row({ active: false })),
    });
    expect(inactive).toEqual({
      ok: false,
      error: { kind: "inactive_workflow" },
    });

    for (const changed of [
      row({ version: "0.2.0" }),
      row({ content_hash: "c".repeat(64) }),
      row({ source_commit: "d".repeat(40) }),
      row({ distribution: "default" }),
      row({ type: "tabular" }),
      row({ source: "other.md" }),
      row({ approval_provenance: "other" }),
    ]) {
      await expect(
        resolveWorkflowExecutionPin({
          expected_identity: row(),
          port: portWith(changed),
        }),
      ).resolves.toEqual({
        ok: false,
        error: { kind: "workflow_mismatch" },
      });
    }
  });

  it("does not let later catalog changes rewrite an issued pin", async () => {
    const persisted = row();
    const result = await resolveWorkflowExecutionPin({
      expected_identity: row(),
      port: portWith(persisted),
    });
    expect(result.ok).toBe(true);
    persisted.version = "9.9.9";
    persisted.content_hash = "f".repeat(64);
    if (result.ok) {
      expect(result.pin.version).toBe("0.1.0");
      expect(result.pin.content_hash).toBe(HASH);
      expect(() => {
        (result.pin as { version: string }).version = "changed";
      }).toThrow();
    }
  });

  it("fails closed on malformed persistence and dependency throws", async () => {
    const malformed = await resolveWorkflowExecutionPin({
      expected_identity: row(),
      port: portWith({ ...row(), content_hash: "SECRET malformed" }),
    });
    expect(malformed).toEqual({
      ok: false,
      error: { kind: "malformed_catalog_row" },
    });

    const port: WorkflowCatalogReadPort = {
      getWorkflow: async () => {
        throw new Error("db failure SECRET");
      },
    };
    const thrown = await resolveWorkflowExecutionPin({
      expected_identity: row(),
      port,
    });
    expect(thrown).toEqual({
      ok: false,
      error: { kind: "catalog_dependency_failed" },
    });
    expect(JSON.stringify(thrown)).not.toContain("SECRET");
  });

  it("round-trips a receipt pin through unknown runtime data", async () => {
    const loaded = await resolveWorkflowExecutionPin({
      expected_identity: row(),
      port: portWith(row()),
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const parsed = parseWorkflowExecutionPin(
      JSON.parse(JSON.stringify(loaded.pin)) as unknown,
    );
    expect(parsed).toEqual({ ok: true, pin: loaded.pin });
    if (parsed.ok) expect(Object.isFrozen(parsed.pin)).toBe(true);

    expect(parseWorkflowExecutionPin({ ...loaded.pin, active: true })).toEqual({
      ok: false,
      error: { kind: "malformed_execution_pin" },
    });
  });
});

describe("runtime export and import lock", () => {
  it("exports only the governed catalog runtime", async () => {
    const mod = await import("./governedWorkflowCatalog");
    expect(Object.keys(mod).sort()).toEqual(
      [
        "GOVERNED_WORKFLOW_CONTENT_HASH_RE",
        "GOVERNED_WORKFLOW_SOURCE_COMMIT_RE",
        "parseGovernedWorkflowCatalogRow",
        "parseWorkflowExecutionPin",
        "resolveWorkflowExecutionPin",
      ].sort(),
    );
  });

  it("uses the frozen shared identity and no legacy or I/O boundary", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "governedWorkflowCatalog.ts"),
      "utf8",
    );
    expect(source).toContain("buildWorkflowIdentity");
    expect(source).toContain("WorkflowIdentity");
    for (const banned of [
      "systemWorkflows",
      "workflowCatalogSource",
      "workflowCatalogSync",
      "../storage",
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
