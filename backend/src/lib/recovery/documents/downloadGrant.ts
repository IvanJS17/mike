/**
 * Slice B — expiring single-use download grants (domain only).
 *
 * Pure fail-closed grant consumption over a small injected atomic port.
 * The domain never touches storage, never retries, never marks consumption
 * locally, and never logs or returns provider, bucket, or error details.
 * Time comes exclusively from the injected clock; there are no sleeps.
 */

import type { DocumentStorageOwnership } from "../sharedContracts";
import {
  authorizeObjectKey,
  buildCanonicalPrefix,
} from "./documentStoragePolicy";

/** Single redacted dependency-failure kind for every port/row problem. */
export const DOWNLOAD_GRANT_DEPENDENCY_KIND =
  "document_storage_dependency_failed" as const;

export type DownloadGrantDependencyKind = typeof DOWNLOAD_GRANT_DEPENDENCY_KIND;

/**
 * Minimal atomic port. The coordinator owns the real persistence; this
 * contract requires exactly one operation that atomically marks the grant
 * consumed and returns the updated row plus an explicit atomic disposition.
 * Every ownership/key/expiry/unused discriminator is part of that one call, so
 * a foreign or stale grant cannot be consumed before validation.
 */
export interface DownloadGrantPort {
  consumeOnce(input: {
    grant_id: string;
    organization_id: string;
    matter_id: string | null;
    project_id: string;
    document_id: string;
    object_key: string;
    expected_expires_at: string;
    expected_unused: true;
  }): Promise<unknown>;
}

/** Injected clock. Tests supply a fixed time; production supplies wall time. */
export type DownloadGrantClock = () => Date;

export type DownloadGrantPortRow = {
  disposition: "consumed" | "already_used";
  grant_id: string;
  expires_at: string;
  used_at?: string | null;
  organization_id: string;
  matter_id?: string | null;
  project_id: string;
  document_id: string;
  object_key: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural guard for a port-returned grant row. Checks shapes only, never
 * secrets or timestamps semantics; semantic checks live in the consumer.
 */
export function isDownloadGrantPortRow(
  value: unknown,
): value is DownloadGrantPortRow {
  if (!isRecord(value)) return false;
  if (
    value.disposition !== "consumed" &&
    value.disposition !== "already_used"
  ) {
    return false;
  }
  if (typeof value.grant_id !== "string" || !value.grant_id) return false;
  if (typeof value.expires_at !== "string" || !value.expires_at) return false;
  if (typeof value.organization_id !== "string" || !value.organization_id) {
    return false;
  }
  if (typeof value.project_id !== "string" || !value.project_id) return false;
  if (typeof value.document_id !== "string" || !value.document_id) return false;
  if (typeof value.object_key !== "string" || !value.object_key) return false;
  if (
    value.matter_id !== undefined &&
    value.matter_id !== null &&
    typeof value.matter_id !== "string"
  ) {
    return false;
  }
  if (
    value.used_at !== undefined &&
    value.used_at !== null &&
    typeof value.used_at !== "string"
  ) {
    return false;
  }
  return true;
}

export type ConsumeDownloadGrantResult =
  | { ok: true; grant_id: string; objectKey: string }
  | { ok: false; error: { kind: "not_found" } }
  | { ok: false; error: { kind: "expired" } }
  | { ok: false; error: { kind: "already_used" } }
  | { ok: false; error: { kind: DownloadGrantDependencyKind } };

function notFound(): Extract<ConsumeDownloadGrantResult, { ok: false }> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ kind: "not_found" }) as { kind: "not_found" },
  });
}

function dependencyFailed(): Extract<
  ConsumeDownloadGrantResult,
  { ok: false }
> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ kind: DOWNLOAD_GRANT_DEPENDENCY_KIND }) as {
      kind: DownloadGrantDependencyKind;
    },
  });
}

function parseDate(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Consume one download grant exactly once. Pre-state mismatches (scope, key,
 * id) are opaque `not_found`; lapsed grants are `expired` and spent grants
 * are `already_used` — all without a port call. Otherwise exactly one atomic
 * `consumeOnce` runs, its returned row is revalidated (scope, key, expiry,
 * race stamp), and port throws or malformed rows become the single redacted
 * dependency failure. Never retries.
 */
export async function consumeDownloadGrant(
  input: {
    ownership: DocumentStorageOwnership;
    grantId: string;
    expectedObjectKey: string;
  },
  deps: { port: DownloadGrantPort; clock: DownloadGrantClock },
): Promise<ConsumeDownloadGrantResult> {
  const port = deps?.port;
  const clock = deps?.clock;
  if (!port || typeof port.consumeOnce !== "function")
    return dependencyFailed();
  if (!clock || typeof clock !== "function") return dependencyFailed();
  if (!input || typeof input !== "object") return notFound();
  if (typeof input.grantId !== "string" || !input.grantId) return notFound();
  if (typeof input.expectedObjectKey !== "string" || !input.expectedObjectKey) {
    return notFound();
  }

  // Ownership confinement first: any inconsistency is an opaque denial at
  // this boundary (no disclosure, no port call).
  if (!buildCanonicalPrefix(input.ownership).ok) return notFound();
  const grant = input.ownership.download_grant;
  if (!isRecord(grant)) return notFound();
  if (grant.grant_id !== input.grantId) return notFound();
  if (typeof grant.expires_at !== "string" || !grant.expires_at) {
    return dependencyFailed();
  }
  if (
    authorizeObjectKey(input.ownership, input.expectedObjectKey).ok === false
  ) {
    return notFound();
  }
  if (grant.used_at !== undefined) {
    if (
      typeof grant.used_at !== "string" ||
      !grant.used_at ||
      parseDate(grant.used_at) === undefined
    ) {
      return dependencyFailed();
    }
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ kind: "already_used" }) as {
        kind: "already_used";
      },
    });
  }
  let now: number;
  try {
    now = clock().getTime();
  } catch {
    return dependencyFailed();
  }
  if (!Number.isFinite(now)) return dependencyFailed();
  const expiresAt = parseDate(grant.expires_at);
  if (expiresAt === undefined) return dependencyFailed();
  if (now >= expiresAt) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ kind: "expired" }) as { kind: "expired" },
    });
  }

  // Exactly one atomic consume; never retried, never marked locally.
  let returned: unknown;
  try {
    returned = await port.consumeOnce({
      grant_id: input.grantId,
      organization_id: input.ownership.organization_id,
      matter_id: input.ownership.matter_id ?? null,
      project_id: input.ownership.project_id,
      document_id: input.ownership.document_id,
      object_key: input.expectedObjectKey,
      expected_expires_at: grant.expires_at,
      expected_unused: true,
    });
  } catch {
    return dependencyFailed();
  }
  if (!isDownloadGrantPortRow(returned)) return dependencyFailed();
  if (returned.grant_id !== input.grantId) return notFound();
  if (returned.organization_id !== input.ownership.organization_id) {
    return notFound();
  }
  const returnedMatter = returned.matter_id ?? null;
  const ownedMatter = input.ownership.matter_id ?? null;
  if (returnedMatter !== ownedMatter) return notFound();
  if (returned.project_id !== input.ownership.project_id) return notFound();
  if (returned.document_id !== input.ownership.document_id) return notFound();
  if (returned.object_key !== input.expectedObjectKey) return notFound();
  const returnedExpiry = parseDate(returned.expires_at);
  if (returnedExpiry === undefined) return dependencyFailed();
  if (now >= returnedExpiry) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ kind: "expired" }) as { kind: "expired" },
    });
  }
  if (returned.expires_at !== grant.expires_at) return dependencyFailed();
  if (typeof returned.used_at !== "string" || !returned.used_at) {
    return dependencyFailed();
  }
  const usedAt = parseDate(returned.used_at);
  if (usedAt === undefined) return dependencyFailed();
  if (returned.disposition === "already_used") {
    if (usedAt > now || usedAt >= returnedExpiry) return dependencyFailed();
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ kind: "already_used" }) as {
        kind: "already_used";
      },
    });
  }
  if (usedAt !== now) return dependencyFailed();
  return Object.freeze({
    ok: true as const,
    grant_id: input.grantId,
    objectKey: input.expectedObjectKey,
  });
}
