import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodePageCursor as decodePageCursorWithMac,
  encodePageCursor as encodePageCursorWithMac,
  FOLDER_CONFLICT_RESOLUTIONS,
  MAX_PAGE_CURSOR_OFFSET,
  MAX_UPLOAD_BATCH_ITEMS,
  MAX_UPLOAD_CONCURRENCY,
  normalizeFolderConflictResolution,
  planUploadBatch,
  resolveFolderConflict,
} from "./uploadPlanning";

const SCOPE = {
  organization_id: "org-1",
  matter_id: "matter-1",
  project_id: "project-1",
};
const SCOPE_NO_MATTER = { organization_id: "org-1", project_id: "project-1" };
const CURSOR_MAC_KEY = "synthetic-cursor-mac-key-32-bytes-minimum";

function encodePageCursor(
  input: Parameters<typeof encodePageCursorWithMac>[0],
): string {
  return encodePageCursorWithMac(input, CURSOR_MAC_KEY);
}

function decodePageCursor(
  cursor: unknown,
  scope: Parameters<typeof decodePageCursorWithMac>[1],
) {
  return decodePageCursorWithMac(cursor, scope, CURSOR_MAC_KEY);
}

function folder(
  name: string,
  scope: typeof SCOPE = SCOPE,
  id = `folder-${name}`,
) {
  return {
    id,
    name,
    organization_id: scope.organization_id,
    matter_id: "matter_id" in scope ? (scope.matter_id ?? null) : null,
    project_id: scope.project_id,
  };
}

describe("upstream conflict vocabulary error | reuse | rename", () => {
  it("declares exactly the upstream vocabulary and defaults to error", () => {
    expect([...FOLDER_CONFLICT_RESOLUTIONS].sort()).toEqual(
      ["error", "rename", "reuse"].sort(),
    );
    expect(normalizeFolderConflictResolution(undefined)).toBe("error");
    expect(normalizeFolderConflictResolution(null)).toBe("error");
    expect(normalizeFolderConflictResolution("bogus")).toBe("error");
    expect(normalizeFolderConflictResolution("overwrite")).toBe("error");
    expect(normalizeFolderConflictResolution("reuse")).toBe("reuse");
    expect(normalizeFolderConflictResolution("rename")).toBe("rename");
  });

  it("error returns a typed conflict when the same-scope folder exists", () => {
    const result = resolveFolderConflict({
      requestedName: "Contracts",
      existingFolders: [folder("Contracts")],
      scope: SCOPE,
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "folder_conflict", folderName: "Contracts" },
    });
  });

  it("error creates when no same-scope folder exists", () => {
    const result = resolveFolderConflict({
      requestedName: "Contracts",
      conflictResolution: "error",
      existingFolders: [],
      scope: SCOPE,
    });
    expect(result).toEqual({
      ok: true,
      disposition: "created",
      folderName: "Contracts",
    });
  });

  it("reuse selects only an exact same-scope folder", () => {
    const same = folder("Contracts", SCOPE, "folder-same");
    const result = resolveFolderConflict({
      requestedName: "Contracts",
      conflictResolution: "reuse",
      existingFolders: [same],
      scope: SCOPE,
    });
    expect(result).toEqual({
      ok: true,
      disposition: "reused",
      folderId: "folder-same",
      folderName: "Contracts",
    });
  });

  it("reuse denies cross-scope reuse opaquely", () => {
    const foreign = folder(
      "Contracts",
      {
        organization_id: "org-2",
        matter_id: "matter-1",
        project_id: "project-1",
      },
      "folder-foreign",
    );
    const result = resolveFolderConflict({
      requestedName: "Contracts",
      conflictResolution: "reuse",
      existingFolders: [foreign],
      scope: SCOPE,
    });
    expect(result).toEqual({ ok: false, error: { kind: "not_found" } });
  });

  it("fails closed when the existing-folder catalog contains malformed rows", () => {
    const result = resolveFolderConflict({
      requestedName: "Contracts",
      conflictResolution: "reuse",
      existingFolders: [
        {
          id: "folder-1",
          name: "Other",
          organization_id: "org/foreign",
          matter_id: "matter-1",
          project_id: "project-1",
        },
      ],
      scope: SCOPE,
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "invalid_folder_request" },
    });
  });

  it("rename returns a validated suggested name without mutating state", () => {
    const before = [folder("Contracts")];
    const snapshot = JSON.stringify(before);
    const result = resolveFolderConflict({
      requestedName: "Contracts",
      conflictResolution: "rename",
      existingFolders: before,
      scope: SCOPE,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.disposition === "renamed") {
      expect(result.suggestedName).not.toBe("Contracts");
      expect(result.suggestedName.length).toBeGreaterThan(0);
      expect(result.suggestedName.length).toBeLessThanOrEqual(255);
      expect(result.suggestedName).not.toContain("/");
      expect(result.suggestedName).not.toContain("\\");
    } else {
      expect.unreachable("rename with a conflict must suggest a new name");
    }
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("rename creates directly when there is no conflict", () => {
    const result = resolveFolderConflict({
      requestedName: "Fresh",
      conflictResolution: "rename",
      existingFolders: [],
      scope: SCOPE,
    });
    expect(result).toEqual({
      ok: true,
      disposition: "created",
      folderName: "Fresh",
    });
  });

  it("rejects unsafe folder names without overwrite or delete behavior", () => {
    for (const name of ["", "   ", ".", "..", "a/b", "a\\b", "x".repeat(256)]) {
      const result = resolveFolderConflict({
        requestedName: name,
        conflictResolution: "error",
        existingFolders: [],
        scope: SCOPE,
      });
      expect(result.ok).toBe(false);
    }
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "uploadPlanning.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/overwrite/i);
    expect(source).not.toMatch(/deleteFile|deleteObject/i);
    expect(source).not.toMatch(/retention/i);
  });
});

describe("bounded batch planning preserves order", () => {
  it("plans a multi-file batch in input order with an explicit limit", () => {
    const result = planUploadBatch({
      items: [
        { clientItemId: "c-1", filename: "a.pdf" },
        { clientItemId: "c-2", filename: "b.pdf" },
        { clientItemId: "c-3", filename: "c.pdf" },
      ],
      concurrencyLimit: 2,
      scope: SCOPE,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.concurrencyLimit).toBe(2);
      expect(result.items.map((item) => item.clientItemId)).toEqual([
        "c-1",
        "c-2",
        "c-3",
      ]);
      expect(result.items.map((item) => item.index)).toEqual([0, 1, 2]);
      expect(result).not.toHaveProperty("total");
    }
  });

  it("is synchronous planning: no promises are spawned", () => {
    const result = planUploadBatch({
      items: [{ clientItemId: "c-1", filename: "a.pdf" }],
      concurrencyLimit: 1,
      scope: SCOPE,
    });
    expect(result instanceof Promise).toBe(false);
  });

  it("rejects zero, negative, and non-integer concurrency limits", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, "2", null, undefined]) {
      const result = planUploadBatch({
        items: [{ clientItemId: "c-1", filename: "a.pdf" }],
        concurrencyLimit: limit as number,
        scope: SCOPE,
      });
      expect(result).toEqual({
        ok: false,
        error: { kind: "invalid_concurrency_limit" },
      });
    }
  });

  it("rejects concurrency above the documented bound", () => {
    const result = planUploadBatch({
      items: [{ clientItemId: "c-1", filename: "a.pdf" }],
      concurrencyLimit: MAX_UPLOAD_CONCURRENCY + 1,
      scope: SCOPE,
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "invalid_concurrency_limit" },
    });
  });

  it("rejects duplicate client item ids", () => {
    const result = planUploadBatch({
      items: [
        { clientItemId: "dup", filename: "a.pdf" },
        { clientItemId: "dup", filename: "b.pdf" },
      ],
      concurrencyLimit: 1,
      scope: SCOPE,
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "duplicate_client_item_id", clientItemId: "dup" },
    });
  });

  it("rejects empty and oversized batches", () => {
    expect(
      planUploadBatch({ items: [], concurrencyLimit: 1, scope: SCOPE }),
    ).toEqual({ ok: false, error: { kind: "empty_batch" } });
    const oversized = Array.from(
      { length: MAX_UPLOAD_BATCH_ITEMS + 1 },
      (_, i) => ({
        clientItemId: `c-${i}`,
        filename: "a.pdf",
      }),
    );
    expect(
      planUploadBatch({ items: oversized, concurrencyLimit: 1, scope: SCOPE }),
    ).toEqual({
      ok: false,
      error: { kind: "batch_too_large", max: MAX_UPLOAD_BATCH_ITEMS },
    });
  });

  it("rejects invalid items and scopes", () => {
    expect(
      planUploadBatch({
        items: [{ clientItemId: "", filename: "a.pdf" }],
        concurrencyLimit: 1,
        scope: SCOPE,
      }).ok,
    ).toBe(false);
    expect(
      planUploadBatch({
        items: [{ clientItemId: "c-1", filename: "../evil.pdf" }],
        concurrencyLimit: 1,
        scope: SCOPE,
      }).ok,
    ).toBe(false);
    expect(
      planUploadBatch({
        items: [{ clientItemId: "c-1", filename: "a.pdf" }],
        concurrencyLimit: 1,
        scope: { organization_id: "org/../x", project_id: "project-1" },
      }).ok,
    ).toBe(false);
  });
});

describe("opaque bounded scope-bound cursors", () => {
  it("round-trips an offset through an opaque cursor", () => {
    const cursor = encodePageCursor({ scope: SCOPE, offset: 40 });
    expect(typeof cursor).toBe("string");
    expect(cursor).not.toBe("40");
    expect(cursor).not.toContain("org-1");
    expect(decodePageCursor(cursor, SCOPE)).toEqual({ ok: true, offset: 40 });
  });

  it("binds the cursor to its scope", () => {
    const cursor = encodePageCursor({ scope: SCOPE, offset: 0 });
    expect(decodePageCursor(cursor, SCOPE_NO_MATTER)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(
      decodePageCursor(cursor, {
        organization_id: "org-2",
        matter_id: "matter-1",
        project_id: "project-1",
      }),
    ).toEqual({ ok: false, error: { kind: "not_found" } });
  });

  it("requires an injected MAC key and rejects a different key", () => {
    const cursor = encodePageCursor({ scope: SCOPE, offset: 7 });
    expect(
      decodePageCursorWithMac(
        cursor,
        SCOPE,
        "different-synthetic-mac-key-32-bytes-minimum",
      ),
    ).toEqual({ ok: false, error: { kind: "invalid_cursor" } });
    expect(() =>
      encodePageCursorWithMac({ scope: SCOPE, offset: 7 }, "too-short"),
    ).toThrow();
    expect(decodePageCursorWithMac(cursor, SCOPE, "too-short")).toEqual({
      ok: false,
      error: { kind: "invalid_cursor" },
    });
  });

  it("rejects malformed and unbounded cursors", () => {
    expect(decodePageCursor("not-a-cursor!!", SCOPE)).toEqual({
      ok: false,
      error: { kind: "invalid_cursor" },
    });
    expect(decodePageCursor("", SCOPE)).toEqual({
      ok: false,
      error: { kind: "invalid_cursor" },
    });
    expect(() => encodePageCursor({ scope: SCOPE, offset: -1 })).toThrow();
    expect(() =>
      encodePageCursor({ scope: SCOPE, offset: MAX_PAGE_CURSOR_OFFSET + 1 }),
    ).toThrow();
    expect(() => encodePageCursor({ scope: SCOPE, offset: 1.5 })).toThrow();
  });

  it("rejects non-canonical base64url aliases and tampered payloads", () => {
    const cursor = encodePageCursor({ scope: SCOPE, offset: 40 });
    for (const alias of [`${cursor}=`, `${cursor}!!`]) {
      expect(decodePageCursor(alias, SCOPE)).toEqual({
        ok: false,
        error: { kind: "invalid_cursor" },
      });
    }

    const payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    payload.o = 41;
    const tampered = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    expect(decodePageCursor(tampered, SCOPE)).toEqual({
      ok: false,
      error: { kind: "invalid_cursor" },
    });

    const forgedPayload: Record<string, unknown> = {
      ...payload,
      o: 42,
    };
    forgedPayload.i = createHash("sha256")
      .update(
        JSON.stringify({
          v: forgedPayload.v,
          o: forgedPayload.o,
          s: forgedPayload.s,
        }),
        "utf8",
      )
      .digest("hex");
    const forged = Buffer.from(JSON.stringify(forgedPayload), "utf8").toString(
      "base64url",
    );
    expect(decodePageCursor(forged, SCOPE)).toEqual({
      ok: false,
      error: { kind: "invalid_cursor" },
    });
  });

  it("invents no total counts", () => {
    const cursor = encodePageCursor({ scope: SCOPE, offset: 0 });
    const decoded = decodePageCursor(cursor, SCOPE);
    expect(decoded).not.toHaveProperty("total");
    expect(JSON.stringify(decoded)).not.toContain("total");
    expect(JSON.stringify(cursor)).not.toContain("total");
  });
});

describe("runtime export lock and zero legacy imports", () => {
  it("exposes exactly the governed upload-planning surface", async () => {
    const module = await import("./uploadPlanning");
    expect(Object.keys(module).sort()).toEqual(
      [
        "FOLDER_CONFLICT_RESOLUTIONS",
        "MAX_PAGE_CURSOR_OFFSET",
        "MAX_UPLOAD_BATCH_ITEMS",
        "MAX_UPLOAD_CONCURRENCY",
        "decodePageCursor",
        "encodePageCursor",
        "normalizeFolderConflictResolution",
        "planUploadBatch",
        "resolveFolderConflict",
      ].sort(),
    );
  });

  it("has no legacy storage, AWS, network, or logging imports", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "uploadPlanning.ts"), "utf8");
    expect(source).not.toMatch(/@aws-sdk/);
    expect(source).not.toMatch(/from\s+["']\.\.\/storage["']/);
    expect(source).not.toMatch(/documentVersions/);
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
    expect(source).not.toMatch(/fetch\(|axios|Promise\.all/);
  });
});
