import { createHash } from "node:crypto";

export type ReceiptStatus = "pending" | "running" | "succeeded" | "failed";

export type CanonicalReceipt = Record<string, unknown>;

export type ExecutionInputSnapshot = {
  document_version_id: string;
  document_content_sha256: string;
  workflow_version: string;
  playbook_sha256: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

/** JSON serialization used for hashes and receipt verification. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "null";
}

export function sha256Hex(value: string | Uint8Array | ArrayBuffer): string {
  const input =
    typeof value === "string"
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value;
  return createHash("sha256").update(input).digest("hex");
}

export function buildExecutionInputHash(
  snapshot: ExecutionInputSnapshot,
): string {
  return sha256Hex(canonicalJson(snapshot));
}

function assertReceiptSafe(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertReceiptSafe(item);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    const isHashField = normalizedKey.endsWith("_sha256");
    const forbidden =
      !isHashField
      && (
        normalizedKey.includes("secret")
        || normalizedKey.includes("api_key")
        || normalizedKey.includes("password")
        || normalizedKey.includes("prompt")
        || normalizedKey === "content"
        || normalizedKey === "output_text"
        || normalizedKey === "encrypted_key"
        || normalizedKey === "auth_tag"
        || normalizedKey === "iv"
      );
    if (forbidden) throw new Error(`Receipt contains a forbidden field: ${key}`);
    assertReceiptSafe(nested);
  }
}

export function buildReceipt(value: CanonicalReceipt): {
  canonical_json: string;
  receipt_sha256: string;
} {
  assertReceiptSafe(value);
  const canonical_json = canonicalJson(value);
  return {
    canonical_json,
    receipt_sha256: sha256Hex(canonical_json),
  };
}

export function sortReceiptCitations<T extends { citation_id: string }>(
  citations: T[],
): T[] {
  return [...citations].sort((left, right) =>
    left.citation_id.localeCompare(right.citation_id),
  );
}
