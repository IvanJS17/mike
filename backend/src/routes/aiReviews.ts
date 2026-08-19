import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkMatterAccess, type MatterAccess } from "../lib/aiAccess";
import {
  applyAiReviewDecision,
  buildReviewItemSeeds,
  reviewCompletionError,
  type AiReviewDecision,
  type AiReviewItemState,
} from "../lib/aiReviews";
import { assertEpochFresh } from "../lib/tenancy";
import { recordAuditEvent } from "../lib/audit";
import { generateDocx } from "../lib/chat/tools/documentOps";
import {
  buildContentDisposition,
  deleteFile,
  downloadFile,
  uploadFile,
} from "../lib/storage";
import { contentSha256 } from "../lib/documentVersions";
import {
  prepareAiReviewReport,
  type AiReviewReportInput,
} from "../lib/aiReviewReports";
import type { AiExecutionStatus } from "../lib/aiExecutions";

export const aiReviewsRouter = Router({ mergeParams: true });

type Db = ReturnType<typeof createServerSupabase>;

type ExecutionRow = {
  id: string;
  user_id: string;
  matter_id: string | null;
  project_id: string;
  document_id: string;
  document_version_id: string;
  status: AiExecutionStatus;
  created_at?: string;
};

type ReviewStatus = "in_progress" | "approved" | "changes_requested";
type ReviewRow = {
  id: string;
  execution_id: string;
  matter_id: string;
  project_id: string;
  reviewer_user_id: string;
  status: ReviewStatus;
  created_at: string;
  completed_at: string | null;
};

type ReviewItemRow = {
  id: string;
  review_id: string;
  item_key: string;
  original_text: string;
  finding_text: string;
  citation_refs: unknown[];
  status: AiReviewItemState["status"];
  comment: string | null;
  created_at: string;
  updated_at: string;
};

type ReviewDecisionRow = {
  id: string;
  review_id: string;
  review_item_id: string | null;
  actor_user_id: string;
  decision: AiReviewDecision | "approved" | "changes_requested";
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  comment: string | null;
  created_at: string;
};

type ReviewExportRow = {
  id: string;
  review_id: string;
  execution_id: string;
  matter_id: string;
  project_id: string;
  source_document_version_id: string;
  document_id: string;
  document_version_id: string;
  report_version: number;
  content_sha256: string;
  actor_user_id: string;
  created_at: string;
  filename: string;
};

type ReviewContext = {
  db: Db;
  userId: string;
  execution: ExecutionRow;
  matterAccess: MatterAccess & { ok: true };
};

function bodyOf(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function publicItem(item: ReviewItemRow) {
  return {
    id: item.id,
    review_id: item.review_id,
    item_key: item.item_key,
    original_text: item.original_text,
    finding_text: item.finding_text,
    citation_refs: item.citation_refs,
    status: item.status,
    comment: item.comment,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function publicDecision(decision: ReviewDecisionRow) {
  return {
    id: decision.id,
    review_id: decision.review_id,
    review_item_id: decision.review_item_id,
    actor_user_id: decision.actor_user_id,
    decision: decision.decision,
    before_state: decision.before_state,
    after_state: decision.after_state,
    comment: decision.comment,
    created_at: decision.created_at,
  };
}

function publicReview(
  review: ReviewRow,
  items: ReviewItemRow[],
  decisions: ReviewDecisionRow[],
) {
  return {
    id: review.id,
    execution_id: review.execution_id,
    matter_id: review.matter_id,
    project_id: review.project_id,
    reviewer_user_id: review.reviewer_user_id,
    status: review.status,
    created_at: review.created_at,
    completed_at: review.completed_at,
    items: items.map(publicItem),
    decisions: decisions.map(publicDecision),
  };
}

async function loadReviewContext(
  req: Request,
  intent: "read" | "review",
): Promise<ReviewContext | null> {
  const userId = String(req.res?.locals.userId ?? "");
  const projectId = req.params.projectId;
  if (!userId || !projectId) return null;
  const db = createServerSupabase();
  const { data: execution } = await db
    .from("ai_executions")
    .select("*")
    .eq("id", req.params.executionId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!execution) return null;
  const row = execution as ExecutionRow;
  if (!row.matter_id) return null;

  const matterAccess = await checkMatterAccess(
    row.matter_id,
    userId,
    db,
    intent,
  );
  if (!matterAccess.ok || matterAccess.projectId !== projectId) return null;
  return { db, userId, execution: row, matterAccess };
}

async function loadReview(
  db: Db,
  executionId: string,
): Promise<ReviewRow | null> {
  const { data } = await db
    .from("ai_reviews")
    .select("*")
    .eq("execution_id", executionId)
    .maybeSingle();
  return (data as ReviewRow | null) ?? null;
}

async function loadReviewData(db: Db, reviewId: string) {
  const [{ data: itemRows }, { data: decisionRows }] = await Promise.all([
    db
      .from("ai_review_items")
      .select("*")
      .eq("review_id", reviewId)
      .order("created_at", { ascending: true }),
    db
      .from("ai_review_decisions")
      .select("*")
      .eq("review_id", reviewId)
      .order("created_at", { ascending: true }),
  ]);
  return {
    items: (itemRows ?? []) as ReviewItemRow[],
    decisions: (decisionRows ?? []) as ReviewDecisionRow[],
  };
}

async function loadOutput(db: Db, executionId: string) {
  const [{ data: output }, { data: receipt }] = await Promise.all([
    db
      .from("ai_output_versions")
      .select("output_text, citation_refs")
      .eq("execution_id", executionId)
      .maybeSingle(),
    db
      .from("ai_receipts")
      .select("id")
      .eq("execution_id", executionId)
      .maybeSingle(),
  ]);
  if (!output || !receipt) return null;
  return {
    output_text: String((output as Record<string, unknown>).output_text ?? ""),
    citation_refs: asArray((output as Record<string, unknown>).citation_refs),
  };
}

async function loadReviewReportInput(
  context: ReviewContext,
  review: ReviewRow,
): Promise<AiReviewReportInput> {
  const [{ data: receipt }] = await Promise.all([
    context.db
      .from("ai_receipts")
      .select(
        "id, execution_id, receipt_version, canonical_json, receipt_sha256",
      )
      .eq("execution_id", context.execution.id)
      .maybeSingle(),
  ]);
  const data = await loadReviewData(context.db, review.id);
  return {
    execution: context.execution,
    review,
    items: data.items.map((item) => ({
      item_key: item.item_key,
      finding_text: item.finding_text,
      status: item.status,
      citation_refs: item.citation_refs,
    })),
    receipt: (receipt as AiReviewReportInput["receipt"] | null) ?? null,
  };
}

async function loadReviewExport(
  db: Db,
  reviewId: string,
  sourceDocumentVersionId: string,
): Promise<ReviewExportRow | null> {
  const { data } = await db
    .from("ai_review_exports")
    .select("*")
    .eq("review_id", reviewId)
    .eq("source_document_version_id", sourceDocumentVersionId)
    .maybeSingle();
  return (data as ReviewExportRow | null) ?? null;
}

function reportPath(req: Request): string {
  return `${req.baseUrl}/${req.params.executionId}/review/report`;
}

function publicReviewExport(row: ReviewExportRow, req: Request) {
  return {
    id: row.id,
    review_id: row.review_id,
    execution_id: row.execution_id,
    matter_id: row.matter_id,
    project_id: row.project_id,
    source_document_version_id: row.source_document_version_id,
    document_id: row.document_id,
    document_version_id: row.document_version_id,
    report_version: row.report_version,
    filename: row.filename,
    content_sha256: row.content_sha256,
    actor_user_id: row.actor_user_id,
    created_at: row.created_at,
    download_url: `${reportPath(req)}/download`,
  };
}

function bytesToBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function bufferArrayBuffer(value: Buffer): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

async function cleanupReportArtifacts(
  db: Db,
  storagePath: string | null,
  documentId: string | null,
): Promise<void> {
  if (storagePath) await deleteFile(storagePath).catch(() => {});
  if (documentId) {
    await db.from("documents").delete().eq("id", documentId);
  }
}

function reportPreparationError(res: Response, code: string): void {
  const status = code === "scope_mismatch" ? 404 : 409;
  res.status(status).json({
    code,
    detail: "The approved AI review is not available for export",
  });
}

async function createReviewReport(req: Request, res: Response) {
  const context = await loadReviewContext(req, "review");
  if (!context) {
    return void res.status(404).json({ detail: "AI execution not found" });
  }
  const review = await loadReview(context.db, context.execution.id);
  if (!review) {
    return void res.status(404).json({ detail: "AI review not found" });
  }

  const prepared = prepareAiReviewReport(
    await loadReviewReportInput(context, review),
  );
  if (!prepared.ok) {
    reportPreparationError(res, prepared.code);
    return;
  }

  try {
    await assertEpochFresh(
      context.db,
      context.matterAccess.organizationId,
      context.matterAccess.authorizationEpoch,
    );
  } catch {
    return void res.status(403).json({
      code: "authorization_revoked",
      detail: "Matter authorization changed; report was not generated",
    });
  }

  const existing = await loadReviewExport(
    context.db,
    review.id,
    context.execution.document_version_id,
  );
  if (existing) {
    if (
      existing.execution_id !== context.execution.id ||
      existing.matter_id !== context.execution.matter_id ||
      existing.project_id !== context.execution.project_id
    ) {
      return void res
        .status(404)
        .json({ detail: "AI review report not found" });
    }
    return void res.status(200).json(publicReviewExport(existing, req));
  }

  let storagePath: string | null = null;
  let reportDocumentId: string | null = null;
  try {
    const generated = await generateDocx(
      "Informe de revisión humana",
      prepared.sections,
      context.userId,
      context.db,
      { persist: false },
    );
    if (!("bytes" in generated) || !("filename" in generated)) {
      throw new Error(
        "error" in generated
          ? String(generated.error)
          : "DOCX generation failed",
      );
    }
    const bytes = bytesToBuffer(generated.bytes);
    if (!bytes || bytes.length === 0)
      throw new Error("DOCX generation returned no bytes");
    const reportSha256 = contentSha256(bytes);
    const filename = prepared.filename;
    reportDocumentId = randomUUID();
    storagePath = `generated/ai-review-reports/${review.id}/${randomUUID()}.docx`;
    await uploadFile(
      storagePath,
      bufferArrayBuffer(bytes),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const { data: document, error: documentError } = await context.db
      .from("documents")
      .insert({
        id: reportDocumentId,
        project_id: context.execution.project_id,
        user_id: context.userId,
        status: "ready",
      })
      .select("id")
      .single();
    if (documentError || !document) {
      throw documentError ?? new Error("Failed to record report document");
    }

    const { data: version, error: versionError } = await context.db
      .from("document_versions")
      .insert({
        document_id: reportDocumentId,
        storage_path: storagePath,
        source: "ai_review_report",
        version_number: 1,
        filename,
        file_type: "docx",
        size_bytes: bytes.byteLength,
        page_count: null,
        content_sha256: reportSha256,
      })
      .select("id")
      .single();
    if (versionError || !version) {
      throw (
        versionError ?? new Error("Failed to record report document version")
      );
    }
    const reportVersionId = String((version as { id: string }).id);
    const { error: currentVersionError } = await context.db
      .from("documents")
      .update({ current_version_id: reportVersionId })
      .eq("id", reportDocumentId);
    if (currentVersionError) throw currentVersionError;

    await assertEpochFresh(
      context.db,
      context.matterAccess.organizationId,
      context.matterAccess.authorizationEpoch,
    );
    const { data: inserted, error: exportError } = await context.db
      .from("ai_review_exports")
      .insert({
        review_id: review.id,
        execution_id: context.execution.id,
        matter_id: context.execution.matter_id,
        project_id: context.execution.project_id,
        source_document_version_id: context.execution.document_version_id,
        document_id: reportDocumentId,
        document_version_id: reportVersionId,
        report_version: 1,
        content_sha256: reportSha256,
        actor_user_id: context.userId,
        filename,
      })
      .select("*")
      .single();
    if (exportError || !inserted) {
      if (exportError?.code === "23505") {
        await cleanupReportArtifacts(context.db, storagePath, reportDocumentId);
        const raced = await loadReviewExport(
          context.db,
          review.id,
          context.execution.document_version_id,
        );
        if (raced)
          return void res.status(200).json(publicReviewExport(raced, req));
      }
      throw exportError ?? new Error("Failed to record AI review export");
    }
    const exportRow = inserted as ReviewExportRow;

    await recordAuditEvent(context.db, {
      actorUserId: context.userId,
      organizationId: context.matterAccess.organizationId,
      eventType: "ai.review.report_exported",
      eventDetail: {
        export_id: exportRow.id,
        review_id: review.id,
        execution_id: context.execution.id,
        matter_id: context.execution.matter_id,
        project_id: context.execution.project_id,
        source_document_version_id: context.execution.document_version_id,
        document_id: reportDocumentId,
        document_version_id: reportVersionId,
        report_version: 1,
        content_sha256: reportSha256,
        receipt_id: prepared.receipt.id,
        receipt_sha256: prepared.receipt.receipt_sha256,
      },
    });
    return void res.status(201).json(publicReviewExport(exportRow, req));
  } catch (error) {
    await cleanupReportArtifacts(context.db, storagePath, reportDocumentId);
    console.error(
      "[ai-review-report] generation failed",
      error instanceof Error ? error.message : String(error),
    );
    return void res
      .status(500)
      .json({ detail: "Failed to generate AI review report" });
  }
}

async function downloadReviewReport(req: Request, res: Response) {
  const context = await loadReviewContext(req, "review");
  if (!context)
    return void res.status(404).json({ detail: "AI execution not found" });
  const review = await loadReview(context.db, context.execution.id);
  if (!review)
    return void res.status(404).json({ detail: "AI review not found" });
  const prepared = prepareAiReviewReport(
    await loadReviewReportInput(context, review),
  );
  if (!prepared.ok) {
    reportPreparationError(res, prepared.code);
    return;
  }
  const report = await loadReviewExport(
    context.db,
    review.id,
    context.execution.document_version_id,
  );
  if (!report)
    return void res.status(404).json({ detail: "AI review report not found" });
  if (
    report.execution_id !== context.execution.id ||
    report.matter_id !== context.execution.matter_id ||
    report.project_id !== context.execution.project_id
  ) {
    return void res.status(404).json({ detail: "AI review report not found" });
  }
  try {
    await assertEpochFresh(
      context.db,
      context.matterAccess.organizationId,
      context.matterAccess.authorizationEpoch,
    );
  } catch {
    return void res.status(403).json({
      code: "authorization_revoked",
      detail: "Matter authorization changed; report was not downloaded",
    });
  }

  const { data: version } = await context.db
    .from("document_versions")
    .select(
      "id, document_id, storage_path, filename, file_type, source, content_sha256, deleted_at",
    )
    .eq("id", report.document_version_id)
    .eq("document_id", report.document_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (
    !version ||
    version.source !== "ai_review_report" ||
    typeof version.storage_path !== "string" ||
    !version.storage_path.trim()
  ) {
    return void res.status(404).json({ detail: "AI review report not found" });
  }
  const raw = await downloadFile(String(version.storage_path));
  if (!raw)
    return void res.status(404).json({ detail: "AI review report not found" });
  const bytes = Buffer.from(raw);
  const digest = contentSha256(bytes);
  if (digest !== report.content_sha256 || digest !== version.content_sha256) {
    return void res.status(409).json({
      code: "report_integrity_failed",
      detail: "AI review report integrity check failed",
    });
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition("attachment", report.filename),
  );
  return void res.send(bytes);
}

function sendReviewMutationError(
  res: Response,
  error: { message?: string },
  operation: "item" | "completion",
): boolean {
  const message = error.message ?? "";
  if (
    /authorization changed|active matter lawyer|not authorized|organization scope/i.test(
      message,
    )
  ) {
    res.status(403).json({
      code: "authorization_revoked",
      detail:
        operation === "item"
          ? "Matter authorization changed; decision was not recorded"
          : "Matter authorization changed; review was not completed",
    });
    return true;
  }
  if (/not found/i.test(message)) {
    res.status(404).json({
      detail:
        operation === "item"
          ? "AI review item not found"
          : "AI review not found",
    });
    return true;
  }
  if (/already complete/i.test(message)) {
    res.status(409).json({
      code: "review_closed",
      detail: "The AI review is already complete",
    });
    return true;
  }
  if (/pending findings/i.test(message)) {
    res.status(409).json({
      code: "items_pending",
      detail: "The review cannot be approved yet",
    });
    return true;
  }
  if (/unverified citation/i.test(message)) {
    res.status(409).json({
      code: "unverified_citation",
      detail: "The review cannot be approved yet",
    });
    return true;
  }
  if (/unfinished execution/i.test(message)) {
    res.status(409).json({
      code: "execution_not_succeeded",
      detail: "The review cannot be approved yet",
    });
    return true;
  }
  if (/completion failed/i.test(message)) {
    res.status(409).json({
      code: "review_incomplete",
      detail: "The review could not be completed",
    });
    return true;
  }
  res.status(500).json({
    detail:
      operation === "item"
        ? "Failed to record AI review decision"
        : "Failed to record review completion",
  });
  return true;
}

async function createReview(req: Request, res: Response) {
  const context = await loadReviewContext(req, "review");
  if (!context)
    return void res.status(404).json({ detail: "AI execution not found" });
  if (context.execution.user_id === context.userId) {
    return void res.status(403).json({
      code: "reviewer_must_be_distinct",
      detail: "The execution author cannot review its own execution",
    });
  }
  if (context.execution.status !== "succeeded") {
    return void res.status(422).json({
      code: "review_unavailable",
      detail: "Only a succeeded AI execution can be reviewed",
    });
  }

  const existing = await loadReview(context.db, context.execution.id);
  if (existing) {
    if (existing.reviewer_user_id !== context.userId) {
      return void res.status(409).json({
        code: "review_assigned",
        detail: "The execution already has another reviewer",
      });
    }
    const data = await loadReviewData(context.db, existing.id);
    return void res
      .status(200)
      .json(publicReview(existing, data.items, data.decisions));
  }

  const output = await loadOutput(context.db, context.execution.id);
  if (!output) {
    return void res.status(422).json({
      code: "review_unavailable",
      detail: "The execution has no finalized output and receipt",
    });
  }

  const { data: insertedReview, error: reviewError } = await context.db
    .from("ai_reviews")
    .insert({
      execution_id: context.execution.id,
      matter_id: context.execution.matter_id,
      project_id: context.execution.project_id,
      reviewer_user_id: context.userId,
      status: "in_progress",
    })
    .select("*")
    .single();
  if (reviewError || !insertedReview) {
    return void res.status(500).json({ detail: "Failed to create AI review" });
  }

  const review = insertedReview as ReviewRow;
  const itemSeeds = buildReviewItemSeeds(output);
  const items: ReviewItemRow[] = [];
  for (const seed of itemSeeds) {
    const { data: insertedItem, error: itemError } = await context.db
      .from("ai_review_items")
      .insert({
        review_id: review.id,
        item_key: seed.item_key,
        original_text: seed.original_text,
        finding_text: seed.original_text,
        citation_refs: seed.citation_refs,
        status: "pending",
        comment: null,
      })
      .select("*")
      .single();
    if (itemError || !insertedItem) {
      return void res
        .status(500)
        .json({ detail: "Failed to create AI review items" });
    }
    items.push(insertedItem as ReviewItemRow);
  }

  await recordAuditEvent(context.db, {
    actorUserId: context.userId,
    organizationId: context.matterAccess.organizationId,
    eventType: "ai.review.created",
    eventDetail: {
      review_id: review.id,
      execution_id: review.execution_id,
      matter_id: review.matter_id,
      project_id: review.project_id,
      reviewer_user_id: context.userId,
      item_count: items.length,
    },
  });
  return void res.status(201).json(publicReview(review, items, []));
}

async function getReview(req: Request, res: Response) {
  const context = await loadReviewContext(req, "read");
  if (!context)
    return void res.status(404).json({ detail: "AI execution not found" });
  const review = await loadReview(context.db, context.execution.id);
  if (!review)
    return void res.status(404).json({ detail: "AI review not found" });
  const data = await loadReviewData(context.db, review.id);
  return void res.json(publicReview(review, data.items, data.decisions));
}

async function decideItem(req: Request, res: Response) {
  const context = await loadReviewContext(req, "review");
  if (!context)
    return void res.status(404).json({ detail: "AI execution not found" });
  const review = await loadReview(context.db, context.execution.id);
  if (!review)
    return void res.status(404).json({ detail: "AI review not found" });
  if (review.reviewer_user_id !== context.userId) {
    return void res.status(403).json({
      code: "reviewer_mismatch",
      detail: "Only the assigned reviewer can decide this review",
    });
  }
  if (review.status !== "in_progress") {
    return void res.status(409).json({
      code: "review_closed",
      detail: "The AI review is already complete",
    });
  }

  const { data: item } = await context.db
    .from("ai_review_items")
    .select("*")
    .eq("id", req.params.itemId)
    .eq("review_id", review.id)
    .maybeSingle();
  if (!item)
    return void res.status(404).json({ detail: "AI review item not found" });
  const itemRow = item as ReviewItemRow;
  const body = bodyOf(req);
  const decision = body.decision;
  if (
    decision !== "accepted" &&
    decision !== "rejected" &&
    decision !== "edited"
  ) {
    return void res.status(400).json({
      code: "invalid_decision",
      detail: "decision must be accepted, rejected, or edited",
    });
  }

  const before: AiReviewItemState = {
    status: itemRow.status,
    finding_text: itemRow.finding_text,
    comment: itemRow.comment,
  };
  let applied: ReturnType<typeof applyAiReviewDecision>;
  try {
    applied = applyAiReviewDecision(before, {
      decision,
      finding_text: body.finding_text,
      comment: body.comment,
    });
  } catch (error) {
    return void res.status(400).json({
      detail:
        error instanceof Error ? error.message : "Invalid review decision",
    });
  }

  try {
    await assertEpochFresh(
      context.db,
      context.matterAccess.organizationId,
      context.matterAccess.authorizationEpoch,
    );
  } catch {
    return void res.status(403).json({
      code: "authorization_revoked",
      detail: "Matter authorization changed; decision was not recorded",
    });
  }

  const { data: atomicResult, error: atomicError } = await context.db.rpc(
    "apply_ai_review_item_decision",
    {
      p_review_id: review.id,
      p_item_id: itemRow.id,
      p_actor_user_id: context.userId,
      p_organization_id: context.matterAccess.organizationId,
      p_authorization_epoch: context.matterAccess.authorizationEpoch,
      p_decision: applied.decision,
      p_finding_text: applied.after.finding_text,
      p_comment: applied.after.comment,
    },
  );
  if (atomicError) {
    return void sendReviewMutationError(res, atomicError, "item");
  }
  const result = atomicResult as {
    item?: ReviewItemRow;
    decision?: ReviewDecisionRow;
  } | null;
  if (!result?.item || !result.decision) {
    return void res
      .status(500)
      .json({ detail: "Failed to record AI review decision" });
  }
  const decisionRow = result.decision;
  const updatedItem = result.item;

  await recordAuditEvent(context.db, {
    actorUserId: context.userId,
    organizationId: context.matterAccess.organizationId,
    eventType: "ai.review.item_decided",
    eventDetail: {
      review_id: review.id,
      execution_id: review.execution_id,
      matter_id: review.matter_id,
      item_id: itemRow.id,
      decision: applied.decision,
    },
  });

  return void res.json({
    item: publicItem(updatedItem),
    decision: publicDecision(decisionRow),
  });
}

async function completeReview(req: Request, res: Response) {
  const context = await loadReviewContext(req, "review");
  if (!context)
    return void res.status(404).json({ detail: "AI execution not found" });
  const review = await loadReview(context.db, context.execution.id);
  if (!review)
    return void res.status(404).json({ detail: "AI review not found" });
  if (review.reviewer_user_id !== context.userId) {
    return void res.status(403).json({
      code: "reviewer_mismatch",
      detail: "Only the assigned reviewer can complete this review",
    });
  }
  if (review.status !== "in_progress") {
    return void res.status(409).json({
      code: "review_closed",
      detail: "The AI review is already complete",
    });
  }

  const body = bodyOf(req);
  const status = body.status;
  if (status !== "approved" && status !== "changes_requested") {
    return void res.status(400).json({
      code: "invalid_review_status",
      detail: "status must be approved or changes_requested",
    });
  }
  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== "string" || body.comment.trim().length > 2000) {
      return void res.status(400).json({
        code: "invalid_comment",
        detail: "comment must be at most 2000 characters",
      });
    }
    comment = body.comment.trim() || null;
  }

  const data = await loadReviewData(context.db, review.id);
  const itemStates = data.items.map((item) => ({
    status: item.status,
    finding_text: item.finding_text,
    comment: item.comment,
    citation_refs: item.citation_refs,
  }));
  if (status === "approved") {
    const completionError = reviewCompletionError({
      executionStatus: context.execution.status,
      items: itemStates,
    });
    if (completionError) {
      return void res.status(409).json({
        code: completionError,
        detail: "The review cannot be approved yet",
      });
    }
  }

  try {
    await assertEpochFresh(
      context.db,
      context.matterAccess.organizationId,
      context.matterAccess.authorizationEpoch,
    );
  } catch {
    return void res.status(403).json({
      code: "authorization_revoked",
      detail: "Matter authorization changed; review was not completed",
    });
  }

  const { data: atomicResult, error: atomicError } = await context.db.rpc(
    "complete_ai_review",
    {
      p_review_id: review.id,
      p_actor_user_id: context.userId,
      p_organization_id: context.matterAccess.organizationId,
      p_authorization_epoch: context.matterAccess.authorizationEpoch,
      p_status: status,
      p_comment: comment,
    },
  );
  if (atomicError) {
    return void sendReviewMutationError(res, atomicError, "completion");
  }
  const result = atomicResult as {
    review?: ReviewRow;
    decision?: ReviewDecisionRow;
  } | null;
  if (!result?.review || !result.decision) {
    return void res
      .status(500)
      .json({ detail: "Failed to record review completion" });
  }
  const completedReview = result.review;
  const statusDecision = result.decision;

  await recordAuditEvent(context.db, {
    actorUserId: context.userId,
    organizationId: context.matterAccess.organizationId,
    eventType: "ai.review.completed",
    eventDetail: {
      review_id: review.id,
      execution_id: review.execution_id,
      matter_id: review.matter_id,
      status,
      item_count: data.items.length,
    },
  });

  return void res.json({
    ...publicReview(completedReview, data.items, [
      ...data.decisions,
      statusDecision,
    ]),
    completed_by_user_id: context.userId,
  });
}

aiReviewsRouter.post(
  "/:executionId/review/report",
  requireAuth,
  createReviewReport,
);
aiReviewsRouter.get(
  "/:executionId/review/report/download",
  requireAuth,
  downloadReviewReport,
);

aiReviewsRouter.post("/:executionId/review", requireAuth, createReview);
aiReviewsRouter.get("/:executionId/review", requireAuth, getReview);
aiReviewsRouter.post(
  "/:executionId/review/items/:itemId/decision",
  requireAuth,
  decideItem,
);
aiReviewsRouter.post(
  "/:executionId/review/complete",
  requireAuth,
  completeReview,
);
