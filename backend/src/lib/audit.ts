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
  | "document.downloaded"
  | "ai.execution.started"
  | "ai.execution.completed"
  | "ai.execution.failed"
  | "ai.review.created"
  | "ai.review.item_decided"
  | "ai.review.completed"
  | "ai.review.report_exported"
  | "ai.review.redline_bundle_created";

export type AiAuditDetailInput = {
  executionId: string;
  projectId: string;
  matterId: string | null;
  documentVersionId: string;
  inputSha256: string;
  outputSha256: string | null;
  status: "pending" | "running" | "succeeded" | "failed";
  routeProvider: string;
  routeModel: string;
  credentialRef: string;
  errorClass: string | null;
  [key: string]: unknown;
};

/**
 * Build the metadata-only payload used for AI lifecycle audit events.
 * The allow-list is intentional: callers may pass provider response objects,
 * prompts or content for local processing, but none of those values can enter
 * the audit row.
 */
export function buildAiAuditDetail(
  input: AiAuditDetailInput,
): Record<string, unknown> {
  return {
    execution_id: input.executionId,
    project_id: input.projectId,
    matter_id: input.matterId,
    document_version_id: input.documentVersionId,
    input_sha256: input.inputSha256,
    output_sha256: input.outputSha256,
    status: input.status,
    route_provider: input.routeProvider,
    route_model: input.routeModel,
    credential_ref: input.credentialRef,
    error_class: input.errorClass,
  };
}

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
      console.error(
        `[audit] failed to record ${event.eventType}`,
        error.message,
      );
    }
  } catch (err) {
    // Even a thrown exception must not break the underlying operation.
    console.error(
      `[audit] failed to record ${event.eventType}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
