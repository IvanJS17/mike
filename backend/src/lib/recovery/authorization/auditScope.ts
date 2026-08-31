/**
 * Slice A1 — audit scope (minimum data for the coordinator audit boundary).
 *
 * Exposes exactly the fields the coordinator-owned audit boundary needs to
 * record one governed action against the tenancy/auth domain: who (user),
 * through which transport, acting on which organization/matter with which
 * role and epoch, doing what, with what outcome. This module implements no
 * storage, reads or writes nothing, and never bypasses the append-only audit
 * policy — it produces an inert typed value only.
 */

import type { AuthenticatedIdentity } from "../identity/authStateMatrix";
import type { AuthorizationScope } from "./evaluateAccess";

/** Status vocabulary matching the upstream `AuditStatus`. */
export const AUDIT_STATUSES = ["completed", "cancelled", "failed"] as const;

export type AuditScopeStatus = (typeof AUDIT_STATUSES)[number];

/** The exact minimum field set of an audit scope value. */
export const AUDIT_SCOPE_FIELDS = [
  "action",
  "status",
  "user_id",
  "transport",
  "mfa_satisfied",
  "organization_id",
  "matter_id",
  "membership_role",
  "authorization_epoch",
] as const;

export type AuditScope = {
  action: string;
  status: AuditScopeStatus;
  user_id: string;
  transport: AuthenticatedIdentity["transport"];
  mfa_satisfied: boolean;
  organization_id: string;
  matter_id?: string;
  membership_role: string;
  authorization_epoch: number;
};

/**
 * Build one audit scope value. Rejects an empty action or an unknown status
 * instead of defaulting them; carries no payloads, tokens or content.
 */
export function buildAuditScope(input: {
  identity: AuthenticatedIdentity;
  scope: AuthorizationScope;
  action: string;
  status?: AuditScopeStatus;
}): AuditScope {
  if (!input.action || !input.action.trim()) {
    throw new Error("audit scope requires a non-empty action");
  }
  const status = input.status ?? "completed";
  if (!(AUDIT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`audit scope has an invalid status: ${String(status)}`);
  }
  return {
    action: input.action,
    status,
    user_id: input.identity.user_id,
    transport: input.identity.transport,
    mfa_satisfied: input.identity.mfa_satisfied,
    organization_id: input.scope.organization_id,
    matter_id: input.scope.matter_id,
    membership_role: input.scope.membership_role,
    authorization_epoch: input.scope.authorization_epoch,
  };
}
