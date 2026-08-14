/**
 * Audit trail (W1.13): append-only event recording.
 * The audit_events table rejects UPDATE/DELETE at the database level; this
 * helper is the single write path for the backend.
 */

import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type AuditEventType =
  | "user.invited"
  | "membership.revoked"
  | "document.uploaded"
  | "document.deleted"
  | "document.downloaded";

export async function recordAuditEvent(
  db: Db,
  event: {
    actorUserId: string | null;
    organizationId?: string | null;
    eventType: AuditEventType;
    eventDetail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await db.from("audit_events").insert({
      actor_user_id: event.actorUserId,
      organization_id: event.organizationId ?? null,
      event_type: event.eventType,
      event_detail: event.eventDetail ?? {},
    });
    if (error) {
      // Audit failures must never break the underlying operation; they are
      // logged and surfaced to the operator via the W1.14 daily export gap.
      console.error(`[audit] failed to record ${event.eventType}`, error.message);
    }
  } catch (err) {
    // Even a thrown exception must not break the underlying operation.
    console.error(
      `[audit] failed to record ${event.eventType}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
