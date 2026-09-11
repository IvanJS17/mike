/**
 * Slice D — pure, atomic and idempotent governed catalog synchronization plan.
 *
 * Incoming metadata is validated and canonicalized before the single injected
 * compare/replace operation. This module never reads or uploads asset bytes.
 */

import { createHash } from "node:crypto";

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const WORKFLOW_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;

export type GovernedReferenceAsset = {
  filename: string;
  size_bytes: number;
  file_type: string;
  content_hash: string;
};

export type GovernedWorkflowSyncCandidate = {
  workflow_key: string;
  version: string;
  content_hash: string;
  distribution: "default" | "addon";
  type: "assistant" | "tabular";
  source: string;
  approval_provenance: string;
  reference_assets: GovernedReferenceAsset[];
};

export type CatalogSyncInput = {
  source_commit: string;
  workflows: GovernedWorkflowSyncCandidate[];
};

type CanonicalWorkflow = Readonly<
  Omit<GovernedWorkflowSyncCandidate, "reference_assets"> & {
    reference_assets: readonly Readonly<GovernedReferenceAsset>[];
  }
>;

export type CanonicalCatalogSyncInput = Readonly<{
  source_commit: string;
  workflows: readonly CanonicalWorkflow[];
}>;

export type AtomicCatalogSyncRequest = {
  expected_catalog_hash: string;
  catalog_hash: string;
  catalog: CanonicalCatalogSyncInput;
};

export type AtomicCatalogSyncPort = {
  atomicReplace(request: AtomicCatalogSyncRequest): Promise<unknown>;
};

export type CatalogSyncErrorKind =
  | "malformed_catalog_input"
  | "duplicate_workflow_key"
  | "conflicting_workflow_version"
  | "conflicting_workflow_hash"
  | "malformed_reference_asset"
  | "duplicate_reference_asset"
  | "catalog_sync_dependency_failed"
  | "malformed_catalog_sync_receipt";

type CatalogSyncFailure = {
  ok: false;
  error: { kind: CatalogSyncErrorKind };
};

export type CanonicalCatalogSyncResult =
  | {
      ok: true;
      catalog: CanonicalCatalogSyncInput;
      catalog_hash: string;
    }
  | CatalogSyncFailure;

export type CatalogSyncPlanResult =
  | {
      ok: true;
      status: "noop" | "replaced";
      source_commit: string;
      catalog_hash: string;
      workflow_count: number;
    }
  | CatalogSyncFailure;

const INPUT_KEYS = ["source_commit", "workflows"] as const;
const WORKFLOW_KEYS = [
  "workflow_key",
  "version",
  "content_hash",
  "distribution",
  "type",
  "source",
  "approval_provenance",
  "reference_assets",
] as const;
const REFERENCE_KEYS = [
  "filename",
  "size_bytes",
  "file_type",
  "content_hash",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function fail(kind: CatalogSyncErrorKind): CatalogSyncFailure {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ kind }),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalReference(
  value: unknown,
): Readonly<GovernedReferenceAsset> | CatalogSyncFailure {
  if (!isRecord(value) || !hasExactKeys(value, REFERENCE_KEYS)) {
    return fail("malformed_reference_asset");
  }
  if (
    typeof value.filename !== "string" ||
    !value.filename ||
    value.filename !== value.filename.trim() ||
    /[\u0000-\u001f\u007f]/.test(value.filename) ||
    value.filename.length > 255 ||
    value.filename.startsWith(".") ||
    value.filename.includes("/") ||
    value.filename.includes("\\") ||
    typeof value.size_bytes !== "number" ||
    !Number.isInteger(value.size_bytes) ||
    value.size_bytes < 0 ||
    value.size_bytes > MAX_REFERENCE_BYTES ||
    typeof value.file_type !== "string" ||
    !MEDIA_TYPE_RE.test(value.file_type) ||
    typeof value.content_hash !== "string" ||
    !SHA256_RE.test(value.content_hash)
  ) {
    return fail("malformed_reference_asset");
  }
  return Object.freeze({
    filename: value.filename,
    size_bytes: value.size_bytes,
    file_type: value.file_type,
    content_hash: value.content_hash,
  });
}

function canonicalWorkflow(
  value: unknown,
): CanonicalWorkflow | CatalogSyncFailure {
  if (!isRecord(value) || !hasExactKeys(value, WORKFLOW_KEYS)) {
    return fail("malformed_catalog_input");
  }
  if (
    typeof value.workflow_key !== "string" ||
    !WORKFLOW_KEY_RE.test(value.workflow_key) ||
    typeof value.version !== "string" ||
    !value.version.trim() ||
    typeof value.content_hash !== "string" ||
    !SHA256_RE.test(value.content_hash) ||
    (value.distribution !== "default" && value.distribution !== "addon") ||
    (value.type !== "assistant" && value.type !== "tabular") ||
    typeof value.source !== "string" ||
    !value.source.trim() ||
    typeof value.approval_provenance !== "string" ||
    !value.approval_provenance.trim() ||
    !Array.isArray(value.reference_assets)
  ) {
    return fail("malformed_catalog_input");
  }

  const references: Readonly<GovernedReferenceAsset>[] = [];
  const filenames = new Set<string>();
  for (const item of value.reference_assets) {
    const reference = canonicalReference(item);
    if ("ok" in reference) return reference;
    if (filenames.has(reference.filename)) {
      return fail("duplicate_reference_asset");
    }
    filenames.add(reference.filename);
    references.push(reference);
  }
  references.sort((left, right) =>
    compareCanonicalText(left.filename, right.filename),
  );

  return Object.freeze({
    workflow_key: value.workflow_key,
    version: value.version,
    content_hash: value.content_hash,
    distribution: value.distribution,
    type: value.type,
    source: value.source,
    approval_provenance: value.approval_provenance,
    reference_assets: Object.freeze(references),
  });
}

export function canonicalizeCatalogSyncInput(
  value: unknown,
): CanonicalCatalogSyncResult {
  if (!isRecord(value) || !hasExactKeys(value, INPUT_KEYS)) {
    return fail("malformed_catalog_input");
  }
  if (
    typeof value.source_commit !== "string" ||
    !COMMIT_RE.test(value.source_commit) ||
    !Array.isArray(value.workflows) ||
    value.workflows.length === 0
  ) {
    return fail("malformed_catalog_input");
  }

  const workflows: CanonicalWorkflow[] = [];
  const byKey = new Map<string, CanonicalWorkflow>();
  for (const item of value.workflows) {
    const workflow = canonicalWorkflow(item);
    if ("ok" in workflow) return workflow;
    const previous = byKey.get(workflow.workflow_key);
    if (previous) {
      if (previous.version !== workflow.version) {
        return fail("conflicting_workflow_version");
      }
      if (previous.content_hash !== workflow.content_hash) {
        return fail("conflicting_workflow_hash");
      }
      return fail("duplicate_workflow_key");
    }
    byKey.set(workflow.workflow_key, workflow);
    workflows.push(workflow);
  }
  workflows.sort((left, right) =>
    compareCanonicalText(left.workflow_key, right.workflow_key),
  );

  const catalog: CanonicalCatalogSyncInput = Object.freeze({
    source_commit: value.source_commit,
    workflows: Object.freeze(workflows),
  });
  return {
    ok: true,
    catalog,
    catalog_hash: sha256(JSON.stringify(catalog)),
  };
}

function validReceipt(
  value: unknown,
  expected: {
    source_commit: string;
    catalog_hash: string;
    workflow_count: number;
  },
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "applied",
      "source_commit",
      "catalog_hash",
      "workflow_count",
    ]) &&
    value.applied === true &&
    value.source_commit === expected.source_commit &&
    value.catalog_hash === expected.catalog_hash &&
    value.workflow_count === expected.workflow_count
  );
}

export async function executeCatalogSyncPlan(input: {
  current: CatalogSyncInput;
  incoming: CatalogSyncInput;
  port: AtomicCatalogSyncPort;
}): Promise<CatalogSyncPlanResult> {
  const current = canonicalizeCatalogSyncInput(input?.current);
  if (!current.ok) return current;
  const incoming = canonicalizeCatalogSyncInput(input?.incoming);
  if (!incoming.ok) return incoming;
  if (!input?.port || typeof input.port.atomicReplace !== "function") {
    return fail("malformed_catalog_input");
  }

  const outcome = {
    source_commit: incoming.catalog.source_commit,
    catalog_hash: incoming.catalog_hash,
    workflow_count: incoming.catalog.workflows.length,
  };
  if (current.catalog_hash === incoming.catalog_hash) {
    return { ok: true, status: "noop", ...outcome };
  }

  let receipt: unknown;
  try {
    receipt = await input.port.atomicReplace({
      expected_catalog_hash: current.catalog_hash,
      catalog_hash: incoming.catalog_hash,
      catalog: incoming.catalog,
    });
  } catch {
    return fail("catalog_sync_dependency_failed");
  }
  if (!validReceipt(receipt, outcome)) {
    return fail("malformed_catalog_sync_receipt");
  }
  return { ok: true, status: "replaced", ...outcome };
}
