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
import type { AiExecutionStatus } from "../lib/aiExecutions";

export const aiReviewsRouter = Router({ mergeParams: true });

type Db = ReturnType<typeof createServerSupabase>;

type ExecutionRow = {
  id: string;
  user_id: string;
  matter_id: string | null;
  project_id: string;
  status: AiExecutionStatus;
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

async function createReview(req: Request, res: Response) {
  const context = await loadReviewContext(req, "review");
  if (!context)
    return void res.status(404).json({ detail: "AI execution not found" });
  if (context.execution.user_id === context.userId) {
    return void res
      .status(403)
      .json({
        code: "reviewer_must_be_distinct",
        detail: "The execution author cannot review its own execution",
      });
  }
  if (context.execution.status !== "succeeded") {
    return void res
      .status(422)
      .json({
        code: "review_unavailable",
        detail: "Only a succeeded AI execution can be reviewed",
      });
  }

  const existing = await loadReview(context.db, context.execution.id);
  if (existing) {
    if (existing.reviewer_user_id !== context.userId) {
      return void res
        .status(409)
        .json({
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
    return void res
      .status(422)
      .json({
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
    return void res
      .status(403)
      .json({
        code: "reviewer_mismatch",
        detail: "Only the assigned reviewer can decide this review",
      });
  }
  if (review.status !== "in_progress") {
    return void res
      .status(409)
      .json({
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
    return void res
      .status(400)
      .json({
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
    return void res
      .status(400)
      .json({
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
    return void res
      .status(403)
      .json({
        code: "authorization_revoked",
        detail: "Matter authorization changed; decision was not recorded",
      });
  }

  const { data: decisionRow, error: decisionError } = await context.db
    .from("ai_review_decisions")
    .insert({
      review_id: review.id,
      review_item_id: itemRow.id,
      actor_user_id: context.userId,
      decision: applied.decision,
      before_state: applied.before,
      after_state: applied.after,
      comment: applied.after.comment,
    })
    .select("*")
    .single();
  if (decisionError || !decisionRow) {
    return void res
      .status(500)
      .json({ detail: "Failed to record AI review decision" });
  }

  const { error: itemError } = await context.db
    .from("ai_review_items")
    .update({
      status: applied.after.status,
      finding_text: applied.after.finding_text,
      comment: applied.after.comment,
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemRow.id)
    .eq("review_id", review.id);
  if (itemError)
    return void res
      .status(500)
      .json({ detail: "Failed to update AI review item" });

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

  const updatedItem = {
    ...itemRow,
    status: applied.after.status,
    finding_text: applied.after.finding_text,
    comment: applied.after.comment,
  } as ReviewItemRow;
  return void res.json({
    item: publicItem(updatedItem),
    decision: publicDecision(decisionRow as ReviewDecisionRow),
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
    return void res
      .status(403)
      .json({
        code: "reviewer_mismatch",
        detail: "Only the assigned reviewer can complete this review",
      });
  }
  if (review.status !== "in_progress") {
    return void res
      .status(409)
      .json({
        code: "review_closed",
        detail: "The AI review is already complete",
      });
  }

  const body = bodyOf(req);
  const status = body.status;
  if (status !== "approved" && status !== "changes_requested") {
    return void res
      .status(400)
      .json({
        code: "invalid_review_status",
        detail: "status must be approved or changes_requested",
      });
  }
  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== "string" || body.comment.trim().length > 2000) {
      return void res
        .status(400)
        .json({
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
      return void res
        .status(409)
        .json({
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
    return void res
      .status(403)
      .json({
        code: "authorization_revoked",
        detail: "Matter authorization changed; review was not completed",
      });
  }

  const completedAt = new Date().toISOString();
  const { error: updateError } = await context.db
    .from("ai_reviews")
    .update({ status, completed_at: completedAt })
    .eq("id", review.id)
    .eq("execution_id", context.execution.id);
  if (updateError) {
    return void res
      .status(409)
      .json({
        code: "review_incomplete",
        detail: "The review could not be completed",
      });
  }

  const { data: statusDecision, error: statusDecisionError } = await context.db
    .from("ai_review_decisions")
    .insert({
      review_id: review.id,
      review_item_id: null,
      actor_user_id: context.userId,
      decision: status,
      before_state: { status: review.status },
      after_state: { status, comment },
      comment,
    })
    .select("*")
    .single();
  if (statusDecisionError || !statusDecision) {
    return void res
      .status(500)
      .json({ detail: "Failed to record review completion" });
  }

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

  const completedReview = {
    ...review,
    status,
    completed_at: completedAt,
  } as ReviewRow;
  return void res.json({
    ...publicReview(completedReview, data.items, [
      ...data.decisions,
      statusDecision as ReviewDecisionRow,
    ]),
    completed_by_user_id: context.userId,
  });
}

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
