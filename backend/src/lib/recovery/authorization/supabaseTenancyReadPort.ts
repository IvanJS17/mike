/**
 * Slice A2b2 — Supabase read adapter for the reviewed `TenancyReadPort`.
 *
 * Implements exactly the three fail-closed reads the authorization domain
 * needs, against the injected server-side Supabase client (`backend/src/lib/
 * supabase.ts` pattern; dependency-injected so tests never touch env or
 * network). Read-only: no mutations, no rpc, no auth admin, no storage, no
 * `select("*")`, no cache/retry/fallback, and every user/org/matter filter is
 * applied before `maybeSingle()`.
 *
 * Fail-closed normalization: Supabase/PostgREST joined relations arrive as
 * one object or a one-element array — only those two shapes (plus a missing
 * row) are valid. Any other relation shape, a malformed row, an out-of-range
 * epoch, or any Supabase error throws one constant redacted adapter error.
 * The message carries no provider message, table, SQL, ID or raw payload and
 * the raw error is never attached as `cause`. The reviewed orchestration
 * (`tenancyReadPort.ts`) converts that throw into the typed
 * `authorization_dependency_failed` result.
 */

import type { createServerSupabase } from "../../supabase";
import {
  ORG_MEMBERSHIP_STATUSES,
  ORGANIZATION_ROLES,
  MATTER_ROLES,
  MATTER_VISIBILITIES,
  type MatterMembership,
  type MatterRecord,
  type OrganizationMembership,
} from "../tenancy/tenancyModel";
import type { TenancyReadPort } from "./tenancyReadPort";

type Db = ReturnType<typeof createServerSupabase>;

/** The single constant redacted message every adapter failure throws. */
const ADAPTER_ERROR_MESSAGE = "authorization read adapter failed";

function adapterError(): Error {
  return new Error(ADAPTER_ERROR_MESSAGE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw adapterError();
  }
  return value;
}

function requireVocabulary<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
): T {
  if (typeof value !== "string" || !vocabulary.includes(value as T)) {
    throw adapterError();
  }
  return value as T;
}

function requireEpoch(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw adapterError();
  }
  return value as number;
}

/**
 * Normalize a joined relation to its single object form: exactly a plain
 * object or a one-element array of one plain object. Anything else (missing,
 * null, empty or multiple arrays, primitives) fails closed.
 */
function requireSingleRelation(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length !== 1 || !isPlainObject(value[0])) {
      throw adapterError();
    }
    return value[0];
  }
  if (isPlainObject(value)) {
    return value;
  }
  throw adapterError();
}

/**
 * Run one read to completion and normalize the result: a Supabase error,
 * a thrown query, or a non-object success payload all throw the redacted
 * adapter error; `null` data with no error means no row.
 */
async function maybeReadRow(
  run: () => PromiseLike<unknown>,
): Promise<Record<string, unknown> | null> {
  let result: unknown;
  try {
    result = await run();
  } catch {
    throw adapterError();
  }
  if (
    !isPlainObject(result) ||
    !Object.prototype.hasOwnProperty.call(result, "data") ||
    !Object.prototype.hasOwnProperty.call(result, "error") ||
    result.error !== null
  ) {
    throw adapterError();
  }
  if (result.data === null) {
    return null;
  }
  if (!isPlainObject(result.data)) {
    throw adapterError();
  }
  return result.data;
}

export function createSupabaseTenancyReadPort(db: Db): TenancyReadPort {
  return {
    async getOrganizationMembership(
      input,
    ): Promise<OrganizationMembership | null> {
      const row = await maybeReadRow(() =>
        db
          .from("organization_memberships")
          .select(
            "user_id, organization_id, role, status, organizations!inner(authorization_epoch)",
          )
          .eq("user_id", input.user_id)
          .eq("organization_id", input.organization_id)
          .maybeSingle(),
      );
      if (!row) {
        return null;
      }
      const organization = requireSingleRelation(row.organizations);
      return {
        user_id: requireNonEmptyString(row.user_id),
        organization_id: requireNonEmptyString(row.organization_id),
        role: requireVocabulary(row.role, ORGANIZATION_ROLES),
        status: requireVocabulary(row.status, ORG_MEMBERSHIP_STATUSES),
        authorization_epoch: requireEpoch(organization.authorization_epoch),
      };
    },

    async getMatter(input): Promise<MatterRecord | null> {
      const row = await maybeReadRow(() =>
        db
          .from("matters")
          .select(
            "id, workspace_id, visibility, workspaces!inner(organization_id)",
          )
          .eq("id", input.matter_id)
          .maybeSingle(),
      );
      if (!row) {
        return null;
      }
      const workspace = requireSingleRelation(row.workspaces);
      return {
        matter_id: requireNonEmptyString(row.id),
        workspace_id: requireNonEmptyString(row.workspace_id),
        organization_id: requireNonEmptyString(workspace.organization_id),
        visibility: requireVocabulary(row.visibility, MATTER_VISIBILITIES),
      };
    },

    async getMatterMembership(input): Promise<MatterMembership | null> {
      const row = await maybeReadRow(() =>
        db
          .from("matter_memberships")
          .select("user_id, matter_id, role, status")
          .eq("user_id", input.user_id)
          .eq("matter_id", input.matter_id)
          .maybeSingle(),
      );
      if (!row) {
        return null;
      }
      return {
        user_id: requireNonEmptyString(row.user_id),
        matter_id: requireNonEmptyString(row.matter_id),
        role: requireVocabulary(row.role, MATTER_ROLES),
        status: requireVocabulary(row.status, ORG_MEMBERSHIP_STATUSES),
      };
    },
  };
}
