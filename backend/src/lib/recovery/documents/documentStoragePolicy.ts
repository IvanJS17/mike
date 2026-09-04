/**
 * Slice B — governed document/storage ownership boundary (domain only).
 *
 * Pure fail-closed confinement for upstream folder/upload/storage behavior
 * behind LiTT tenant/matter/document ownership. Consumes the frozen
 * `DocumentStorageOwnership` contract; never wires routes, schema, the AWS
 * client, or any storage port. Every rejection happens before any storage
 * access, and no result ever carries bucket credentials or endpoint details.
 */

import type { DocumentStorageOwnership } from "../sharedContracts";

/** Maximum length of one validated path segment (matches upstream folders). */
export const DOCUMENT_STORAGE_SEGMENT_MAX_LENGTH = 255;

/** Exactly lowercase 64-hex SHA-256. */
export const DOCUMENT_STORAGE_SHA256_RE = /^[0-9a-f]{64}$/;

export type InvalidOwnershipError = {
  kind: "invalid_ownership";
  field:
    | "organization_id"
    | "matter_id"
    | "project_id"
    | "document_id"
    | "version_hash"
    | "object_prefix";
};

export type StorageNotFoundError = {
  kind: "not_found";
};

export type CanonicalPrefixResult =
  | { ok: true; prefix: string }
  | { ok: false; error: InvalidOwnershipError };

export type AuthorizedKeyResult =
  | { ok: true; prefix: string; key: string }
  | { ok: false; error: InvalidOwnershipError | StorageNotFoundError };

/**
 * Validate one raw path segment before any normalization. Rejects empty,
 * overlong, control-character, slash/backslash, percent-encoded, `.` and
 * `..` forms.
 */
export function isSafePathSegment(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (
    value.length === 0 ||
    value.length > DOCUMENT_STORAGE_SEGMENT_MAX_LENGTH
  ) {
    return false;
  }
  if (value.trim().length === 0) return false;
  if (value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("%")) return false;
  // biome-ignore lint: explicit control-character rejection
  if (/[\x00-\x1F\x7F]/.test(value)) return false;
  return true;
}

function invalid(
  field: InvalidOwnershipError["field"],
): Extract<CanonicalPrefixResult, { ok: false }> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      kind: "invalid_ownership",
      field,
    }) as InvalidOwnershipError,
  });
}

function notFound(): Extract<AuthorizedKeyResult, { ok: false }> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ kind: "not_found" }) as StorageNotFoundError,
  });
}

/**
 * Build the single canonical prefix: organization → optional matter →
 * project → document. Validates every ownership field, including the exact
 * lowercase SHA-256 version hash, and requires `object_prefix` to equal the
 * derived prefix exactly.
 */
export function buildCanonicalPrefix(
  ownership: DocumentStorageOwnership,
): CanonicalPrefixResult {
  if (!ownership || typeof ownership !== "object") {
    return invalid("organization_id");
  }
  if (!isSafePathSegment(ownership.organization_id)) {
    return invalid("organization_id");
  }
  if (
    ownership.matter_id !== undefined &&
    !isSafePathSegment(ownership.matter_id)
  ) {
    return invalid("matter_id");
  }
  if (!isSafePathSegment(ownership.project_id)) {
    return invalid("project_id");
  }
  if (!isSafePathSegment(ownership.document_id)) {
    return invalid("document_id");
  }
  if (
    typeof ownership.version_hash !== "string" ||
    !DOCUMENT_STORAGE_SHA256_RE.test(ownership.version_hash)
  ) {
    return invalid("version_hash");
  }
  const prefix =
    ownership.matter_id === undefined
      ? `orgs/${ownership.organization_id}/projects/${ownership.project_id}/documents/${ownership.document_id}`
      : `orgs/${ownership.organization_id}/matters/${ownership.matter_id}/projects/${ownership.project_id}/documents/${ownership.document_id}`;
  if (ownership.object_prefix !== prefix) {
    return invalid("object_prefix");
  }
  return Object.freeze({ ok: true as const, prefix });
}

function hasTraversalEscape(key: string): boolean {
  return (
    key.includes("//") ||
    key.includes("/./") ||
    key.includes("/../") ||
    key.endsWith("/.") ||
    key.endsWith("/..")
  );
}

function suffixMatchesVersion(suffix: string, versionHash: string): boolean {
  const leaf = suffix.split("/").at(-1);
  if (!leaf) return false;
  const extensionIndex = leaf.lastIndexOf(".");
  if (extensionIndex === -1) return leaf === versionHash;
  const stem = leaf.slice(0, extensionIndex);
  const extension = leaf.slice(extensionIndex + 1);
  return stem === versionHash && /^[A-Za-z0-9]+$/.test(extension);
}

/**
 * Authorize one object key strictly below the exact canonical prefix.
 * Ownership problems return `invalid_ownership`; every key-shape or
 * cross-scope mismatch returns the opaque `not_found` denial.
 */
export function authorizeObjectKey(
  ownership: DocumentStorageOwnership,
  key: unknown,
): AuthorizedKeyResult {
  const prefixResult = buildCanonicalPrefix(ownership);
  if (!prefixResult.ok) return prefixResult;
  const prefix = prefixResult.prefix;
  if (typeof key !== "string" || key.length === 0) return notFound();
  if (key.startsWith("/")) return notFound();
  if (key.includes("\\")) return notFound();
  if (key.includes("%")) return notFound();
  // biome-ignore lint: explicit control-character rejection
  if (/[\x00-\x1F\x7F]/.test(key)) return notFound();
  if (hasTraversalEscape(key)) return notFound();
  if (key === prefix) return notFound();
  if (!key.startsWith(`${prefix}/`)) return notFound();
  const suffix = key.slice(prefix.length + 1);
  if (!suffix) return notFound();
  for (const segment of suffix.split("/")) {
    if (!isSafePathSegment(segment)) return notFound();
  }
  if (!suffixMatchesVersion(suffix, ownership.version_hash)) return notFound();
  return Object.freeze({ ok: true as const, prefix, key });
}

/**
 * Build one canonical object key from a validated raw suffix. The suffix is
 * validated raw before joining; no normalization or mutation is applied.
 */
export function buildObjectKey(
  ownership: DocumentStorageOwnership,
  suffix: unknown,
): AuthorizedKeyResult {
  const prefixResult = buildCanonicalPrefix(ownership);
  if (!prefixResult.ok) return prefixResult;
  const prefix = prefixResult.prefix;
  if (typeof suffix !== "string" || suffix.length === 0) return notFound();
  if (suffix.startsWith("/")) return notFound();
  if (suffix.includes("\\")) return notFound();
  if (suffix.includes("%")) return notFound();
  // biome-ignore lint: explicit control-character rejection
  if (/[\x00-\x1F\x7F]/.test(suffix)) return notFound();
  if (hasTraversalEscape(suffix)) return notFound();
  if (suffix === "." || suffix === "..") return notFound();
  for (const segment of suffix.split("/")) {
    if (!isSafePathSegment(segment)) return notFound();
  }
  if (!suffixMatchesVersion(suffix, ownership.version_hash)) return notFound();
  const key = `${prefix}/${suffix}`;
  return Object.freeze({ ok: true as const, prefix, key });
}
