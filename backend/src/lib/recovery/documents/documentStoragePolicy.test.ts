import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorizeObjectKey,
  buildCanonicalPrefix,
  buildObjectKey,
  DOCUMENT_STORAGE_SEGMENT_MAX_LENGTH,
  DOCUMENT_STORAGE_SHA256_RE,
} from "./documentStoragePolicy";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

function ownershipWithMatter() {
  return {
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: "project-1",
    document_id: "doc-1",
    version_hash: SHA,
    object_prefix:
      "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1",
  };
}

function ownershipWithoutMatter() {
  return {
    organization_id: "org-1",
    project_id: "project-1",
    document_id: "doc-1",
    version_hash: SHA,
    object_prefix: "orgs/org-1/projects/project-1/documents/doc-1",
  };
}

describe("canonical prefixes with/without matter", () => {
  it("builds the canonical prefix with matter", () => {
    const result = buildCanonicalPrefix(ownershipWithMatter());
    expect(result).toEqual({
      ok: true,
      prefix: "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1",
    });
  });

  it("builds the canonical prefix without matter", () => {
    const result = buildCanonicalPrefix(ownershipWithoutMatter());
    expect(result).toEqual({
      ok: true,
      prefix: "orgs/org-1/projects/project-1/documents/doc-1",
    });
  });

  it("authorizes a key strictly below the exact prefix", () => {
    const ownership = ownershipWithMatter();
    const prefix =
      "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1";
    const result = authorizeObjectKey(
      ownership,
      `${prefix}/versions/${SHA}.pdf`,
    );
    expect(result).toEqual({
      ok: true,
      prefix,
      key: `${prefix}/versions/${SHA}.pdf`,
    });
  });

  it("builds an object key from a validated suffix", () => {
    const ownership = ownershipWithoutMatter();
    const prefix = "orgs/org-1/projects/project-1/documents/doc-1";
    const result = buildObjectKey(ownership, `versions/${SHA}.pdf`);
    expect(result).toEqual({
      ok: true,
      prefix,
      key: `${prefix}/versions/${SHA}.pdf`,
    });
  });
});

describe("raw path rejection classes before port access", () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["raw backslash in organization", { organization_id: "org\\1" }],
    ["slash inside project id", { project_id: "proj/ect" }],
    ["slash inside document id", { document_id: "do/c" }],
    ["dot segment", { project_id: "." }],
    ["dotdot segment", { document_id: ".." }],
    ["empty organization", { organization_id: "" }],
    ["empty project", { project_id: "   " }],
    ["control chars", { document_id: "doc\x01x" }],
    ["absolute organization", { organization_id: "/org-1" }],
    ["backslash in matter", { matter_id: "mat\\ter" }],
    ["dotdot matter", { matter_id: ".." }],
  ];

  for (const [label, override] of cases) {
    it(`rejects ${label}`, () => {
      const ownership = { ...ownershipWithMatter(), ...override };
      const result = buildCanonicalPrefix(ownership);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid_ownership");
      }
      // Pure validation: no storage port exists on this boundary.
      expect(result).not.toHaveProperty("bucket");
      expect(result).not.toHaveProperty("endpoint");
    });
  }

  it("rejects overlong segments", () => {
    const ownership = {
      ...ownershipWithMatter(),
      project_id: "p".repeat(DOCUMENT_STORAGE_SEGMENT_MAX_LENGTH + 1),
    };
    const result = buildCanonicalPrefix(ownership);
    expect(result.ok).toBe(false);
  });

  it("rejects percent-encoded traversal in the key without disclosure", () => {
    const ownership = ownershipWithMatter();
    const prefix =
      "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1";
    for (const evil of [
      `${prefix}/..%2Fsecret.pdf`,
      `${prefix}/%2e%2e/secret.pdf`,
      `${prefix}/%2Fsecret.pdf`,
      `${prefix}/%5Csecret.pdf`,
      `${prefix}/%252Fsecret.pdf`,
    ]) {
      expect(authorizeObjectKey(ownership, evil)).toEqual({
        ok: false,
        error: { kind: "not_found" },
      });
    }
  });

  it("rejects double separators, prefix-equals-key and absolute keys", () => {
    const ownership = ownershipWithMatter();
    const prefix =
      "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1";
    expect(authorizeObjectKey(ownership, prefix)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(authorizeObjectKey(ownership, `${prefix}//file.pdf`)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(authorizeObjectKey(ownership, `${prefix}/a/../b.pdf`)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(authorizeObjectKey(ownership, `${prefix}/./b.pdf`)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(authorizeObjectKey(ownership, `/abs/${prefix}/file.pdf`)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(authorizeObjectKey(ownership, `${prefix}\\file.pdf`)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
  });

  it("rejects sibling-prefix tricks", () => {
    const ownership = ownershipWithMatter();
    const prefix =
      "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1";
    expect(authorizeObjectKey(ownership, `${prefix}-evil/file.pdf`)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
  });

  it("rejects cross-organization/matter/project/document keys opaquely", () => {
    const ownership = ownershipWithMatter();
    const cases = [
      "orgs/org-2/matters/matter-1/projects/project-1/documents/doc-1/file.pdf",
      "orgs/org-1/matters/matter-2/projects/project-1/documents/doc-1/file.pdf",
      "orgs/org-1/matters/matter-1/projects/project-2/documents/doc-1/file.pdf",
      "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-2/file.pdf",
      "orgs/org-1/projects/project-1/documents/doc-1/file.pdf",
    ];
    for (const key of cases) {
      expect(authorizeObjectKey(ownership, key)).toEqual({
        ok: false,
        error: { kind: "not_found" },
      });
    }
  });

  it("rejects unsafe suffixes when building keys", () => {
    const ownership = ownershipWithoutMatter();
    for (const suffix of [
      "",
      "/leading.pdf",
      "a//b.pdf",
      "../escape.pdf",
      "a/../../b.pdf",
      "..",
      ".",
      "a\\b.pdf",
      "a%2Fb.pdf",
    ]) {
      expect(buildObjectKey(ownership, suffix)).toEqual({
        ok: false,
        error: { kind: "not_found" },
      });
    }
  });
});

describe("SHA and ownership mismatch", () => {
  it("requires version_hash to be exactly lowercase 64-hex", () => {
    expect(DOCUMENT_STORAGE_SHA256_RE.test(SHA)).toBe(true);
    for (const bad of [
      SHA.toUpperCase(),
      SHA.slice(0, 63),
      `${SHA}00`,
      "g".repeat(64),
      "",
      "  ",
      SHA2.replace("b", "B"),
    ]) {
      const result = buildCanonicalPrefix({
        ...ownershipWithMatter(),
        version_hash: bad,
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({ kind: "invalid_ownership" });
    }
  });

  it("rejects a tampered object_prefix that is not the canonical prefix", () => {
    const ownership = {
      ...ownershipWithMatter(),
      object_prefix:
        "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-2",
    };
    const result = buildCanonicalPrefix(ownership);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_ownership");
      expect(result.error.field).toBe("object_prefix");
    }
  });

  it("rejects a key for a different version hash under the same document", () => {
    const ownership = ownershipWithMatter();
    const prefix =
      "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1";
    const foreignVersionKey = `${prefix}/versions/${SHA2}.pdf`;
    const disguisedForeignVersionKey = `${prefix}/versions/${SHA}.${SHA2}.pdf`;
    expect(authorizeObjectKey(ownership, foreignVersionKey)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(authorizeObjectKey(ownership, disguisedForeignVersionKey)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(buildObjectKey(ownership, `versions/${SHA2}.pdf`)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
  });

  it("fails closed on ownership mismatch before key authorization", () => {
    const ownership = {
      ...ownershipWithMatter(),
      object_prefix:
        "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1",
    };
    const tampered = { ...ownership, document_id: "doc-2" };
    const prefix =
      "orgs/org-1/matters/matter-1/projects/project-1/documents/doc-1";
    // tampered ownership no longer matches its own prefix: the ownership
    // itself is inconsistent, so authorization fails closed as invalid
    // ownership before any key comparison; a well-formed ownership with a
    // foreign key stays opaque not_found (covered above).
    expect(buildCanonicalPrefix(tampered).ok).toBe(false);
    expect(authorizeObjectKey(tampered, `${prefix}/file.pdf`)).toEqual({
      ok: false,
      error: { kind: "invalid_ownership", field: "object_prefix" },
    });
  });

  it("never returns bucket credentials or endpoint details", () => {
    const ok = buildCanonicalPrefix(ownershipWithMatter());
    const denied = authorizeObjectKey(
      ownershipWithMatter(),
      "orgs/org-2/matters/matter-1/projects/project-1/documents/doc-1/file.pdf",
    );
    for (const value of [ok, denied]) {
      const serialized = JSON.stringify(value).toLowerCase();
      expect(serialized).not.toContain("bucket");
      expect(serialized).not.toContain("endpoint");
      expect(serialized).not.toContain("accesskey");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("r2_");
    }
  });
});

describe("runtime export lock and zero legacy imports", () => {
  it("exposes exactly the governed storage-policy surface", async () => {
    const module = await import("./documentStoragePolicy");
    expect(Object.keys(module).sort()).toEqual(
      [
        "DOCUMENT_STORAGE_SEGMENT_MAX_LENGTH",
        "DOCUMENT_STORAGE_SHA256_RE",
        "authorizeObjectKey",
        "buildCanonicalPrefix",
        "buildObjectKey",
        "isSafePathSegment",
      ].sort(),
    );
  });

  it("imports DocumentStorageOwnership without legacy storage or AWS clients", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "documentStoragePolicy.ts"), "utf8");
    expect(source).toContain("DocumentStorageOwnership");
    expect(source).not.toMatch(/@aws-sdk/);
    expect(source).not.toMatch(/from\s+["']\.\.\/storage["']/);
    expect(source).not.toMatch(/from\s+["']\.\.\/\.\.\/storage["']/);
    expect(source).not.toMatch(/documentVersions/);
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
    expect(source).not.toMatch(/R2_/);
    expect(source).not.toMatch(/BUCKET/);
  });
});
