import { mkdtemp, readdir, rm } from "fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "os";
import path from "path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { syncWorkflowCatalog } from "../workflowCatalogSync";
import {
  MX_CIVIL_COMMERCIAL_PLAYBOOK,
  MX_CIVIL_COMMERCIAL_SYNC_ENTRY,
} from "../recovery/workflows/mxCivilCommercialPlaybook";

const storage = vi.hoisted(() => ({
  enabled: true,
  uploadFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../storage", () => ({
  get storageEnabled() {
    return storage.enabled;
  },
  uploadFile: storage.uploadFile,
}));

const COMMIT = "b".repeat(40);

async function sourceArchive(colliding = false) {
  const zip = new JSZip();
  const archiveRoot = "mike-workflows-test";
  const root = `${archiveRoot}/assistant-workflows/proofread`;
  zip.file(
    `${root}/SKILL.md`,
    `---
name: "proofread"
description: "Proofread documents"
license: "MIT"
metadata:
  version: "1.0.0"
  author: "Open Legal Products"
  language: "English"
  mike-display-name: "Proofread"
  mike-type: "assistant"
  mike-availability: "system"
  practice: "General Transactions"
  jurisdictions: "General"
---
Proofread the document.
`,
  );
  zip.file(`${root}/assets/template.docx`, Buffer.from("template"));
  for (const [key, title] of [
    ["compare-documents", "Compare Documents"],
    ["extract-key-terms", "Extract Key Terms"],
    ["draft-from-template", "Draft From Template"],
  ] as const) {
    zip.file(
      `${archiveRoot}/assistant-workflows/${key}/SKILL.md`,
      `---
name: "${key}"
description: "Test workflow"
license: "MIT"
metadata:
  version: "1.0.0"
  author: "Open Legal Products"
  language: "English"
  mike-display-name: "${title}"
  mike-type: "assistant"
  practice: "General Transactions"
  jurisdictions: "General"
---
Run the workflow.
`,
    );
  }
  const tabularKey = "commercial-agreement-tabular-review";
  const tabularRoot = `${archiveRoot}/tabular-review-workflows/${tabularKey}`;
  zip.file(
    `${tabularRoot}/SKILL.md`,
    `---
name: "${tabularKey}"
description: "Test workflow"
license: "MIT"
metadata:
  version: "1.0.0"
  author: "Open Legal Products"
  language: "English"
  mike-display-name: "Commercial Agreement Review"
  mike-type: "tabular"
  practice: "General Transactions"
  jurisdictions: "General"
---
Run the workflow.
`,
  );
  zip.file(
    `${tabularRoot}/table-columns.yaml`,
    `columns:
  - index: 0
    name: "Issue"
    prompt: "Identify the issue"
`,
  );
  if (colliding) {
    zip.file(
      `${archiveRoot}/assistant-workflows/civil-commercial-mx-triage/SKILL.md`,
      (await zip.file(`${root}/SKILL.md`)!.async("string")).replace(
        'name: "proofread"',
        'name: "civil-commercial-mx-triage"',
      ),
    );
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("workflow catalog synchronization", () => {
  it("uploads assets, sends no temporary paths to Postgres, and cleans up", async () => {
    storage.enabled = true;
    storage.uploadFile.mockClear();
    const bytes = await sourceArchive();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value =
        url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      if (new URL(value).hostname === "api.github.com") {
        return new Response(JSON.stringify({ sha: COMMIT }), { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "catalog-sync-test-"),
    );
    try {
      await expect(
        syncWorkflowCatalog({ rpc } as never, { temporaryRoot, fetchImpl }),
      ).resolves.toEqual({
        workflows: 6,
        references: 1,
        sourceCommit: COMMIT,
      });
      expect(storage.uploadFile).toHaveBeenCalledOnce();
      expect(rpc).toHaveBeenCalledOnce();
      const [name, args] = rpc.mock.calls[0];
      expect(name).toBe("replace_mike_workflows");
      expect(args.p_source_commit).toBe(COMMIT);
      expect(args.p_workflows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workflow_key: "civil-commercial-mx-triage",
          }),
        ]),
      );
      expect(args.p_workflows).toHaveLength(6);
      const mx = args.p_workflows[5];
      expect(mx).toEqual(MX_CIVIL_COMMERCIAL_SYNC_ENTRY);
      expect(mx).toMatchObject({
        version: "0.1.0",
        source: "docs/playbooks/PLAYBOOK_CIVIL_MERCANTIL_MX_v0.1.md",
        source_commit: "d9fa8380e63837b6441cef169cf5ef80dfb55e54",
        approval_provenance:
          "Beta read-only specification; later legal validation remains pending",
        prompt_md: JSON.stringify(MX_CIVIL_COMMERCIAL_PLAYBOOK),
      });
      expect(createHash("sha256").update(mx.prompt_md, "utf8").digest("hex"))
        .toBe(mx.content_hash);
      const upstream = args.p_workflows.slice(0, 5);
      expect(upstream.map((entry: { workflow_key: string }) => entry.workflow_key))
        .toEqual([
          "compare-documents",
          "draft-from-template",
          "extract-key-terms",
          "proofread",
          "commercial-agreement-tabular-review",
        ]);
      for (const entry of upstream) {
        expect(entry.distribution).toBe("default");
        expect(entry.source).toBe(
          `https://github.com/Open-Legal-Products/mike-workflows/tree/${COMMIT}`,
        );
        expect(entry.approval_provenance).toBe(
          "Upstream catalog import; LiTT legal validation pending",
        );
        expect(entry).not.toHaveProperty("source_commit");
      }
      expect(upstream.map((entry: { default_sort_order: number }) => entry.default_sort_order))
        .toEqual([1, 3, 2, 0, 4]);
      expect(upstream.map((entry: { word_quick_action: boolean }) => entry.word_quick_action))
        .toEqual([false, true, true, true, false]);
      expect(upstream.map((entry: { quick_action_name: string | null }) => entry.quick_action_name))
        .toEqual(["Compare Documents", "Draft From Template", "Extract Key Terms", "Proofread", null]);
      expect(args.p_workflows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workflow_key: "proofread",
            reference_files: [
              expect.objectContaining({
                filename: "template.docx",
                storage_path: expect.stringContaining(
                  "mike-workflows/proofread/",
                ),
              }),
            ],
          }),
        ]),
      );
      expect(JSON.stringify(args)).not.toContain("temporary_path");
      await expect(readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails and cleans up instead of dropping reference files without storage", async () => {
    storage.enabled = false;
    storage.uploadFile.mockClear();
    const bytes = await sourceArchive();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value =
        url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      if (new URL(value).hostname === "api.github.com") {
        return new Response(JSON.stringify({ sha: COMMIT }), { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const rpc = vi.fn();
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "catalog-sync-test-"),
    );
    try {
      await expect(
        syncWorkflowCatalog({ rpc } as never, { temporaryRoot, fetchImpl }),
      ).rejects.toThrow("require configured S3-compatible storage");
      expect(rpc).not.toHaveBeenCalled();
      expect(storage.uploadFile).not.toHaveBeenCalled();
      await expect(readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      storage.enabled = true;
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects an upstream reserved-key collision before uploads or RPC and cleans up", async () => {
    storage.enabled = true;
    storage.uploadFile.mockClear();
    const bytes = await sourceArchive(true);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value =
        url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      return new URL(value).hostname === "api.github.com"
        ? new Response(JSON.stringify({ sha: COMMIT }), { status: 200 })
        : new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const rpc = vi.fn();
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "catalog-sync-test-"));
    try {
      await expect(
        syncWorkflowCatalog({ rpc } as never, { temporaryRoot, fetchImpl }),
      ).rejects.toThrow(
        "Upstream catalog collides with reserved workflow key 'civil-commercial-mx-triage'",
      );
      expect(storage.uploadFile).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      await expect(readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
