import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

let currentUserId = "user-2";
const writes: {
  table: string;
  operation: string;
  payload?: Record<string, unknown>;
}[] = [];
const rows: Record<string, Record<string, unknown>[]> = {
  projects: [{ id: "project-1", user_id: "user-1" }],
  organizations: [{ id: "org-1", authorization_epoch: 1 }],
  ai_executions: [
    {
      id: "execution-1",
      user_id: "user-1",
      matter_id: "matter-1",
      project_id: "project-1",
      document_id: "document-1",
      document_version_id: "version-1",
      status: "succeeded",
      input_sha256: "a".repeat(64),
      document_content_sha256: "b".repeat(64),
      created_at: "2026-08-19T12:00:00.000Z",
      started_at: "2026-08-19T12:00:01.000Z",
      finished_at: "2026-08-19T12:00:02.000Z",
      route_provider: "deepseek",
      route_model: "deepseek-chat",
      credential_ref: "deepseek:v1",
      workflow_id: "workflow-1",
      workflow_version: "1",
      playbook_sha256: "c".repeat(64),
      chat_id: null,
      error_class: null,
    },
    {
      id: "execution-failed",
      user_id: "user-1",
      matter_id: "matter-1",
      project_id: "project-1",
      document_id: "document-1",
      document_version_id: "version-1",
      status: "failed",
      input_sha256: "d".repeat(64),
      document_content_sha256: "e".repeat(64),
      created_at: "2026-08-19T12:00:00.000Z",
      started_at: "2026-08-19T12:00:01.000Z",
      finished_at: "2026-08-19T12:00:02.000Z",
      route_provider: "deepseek",
      route_model: "deepseek-chat",
      credential_ref: "deepseek:v1",
      workflow_id: "workflow-1",
      workflow_version: "1",
      playbook_sha256: "c".repeat(64),
      chat_id: null,
      error_class: "provider_error",
    },
  ],
  ai_output_versions: [
    {
      id: "output-1",
      execution_id: "execution-1",
      output_format: "markdown",
      output_text: "Resultado de la revisión.",
      output_sha256: "f".repeat(64),
      citation_refs: [
        {
          citation_id: "c1",
          finding_text: "La cláusula permite terminar el contrato.",
          verified: true,
          page: 1,
        },
        {
          citation_id: "c2",
          finding_text: "El aviso debe darse con treinta días.",
          verified: true,
          page: 2,
        },
      ],
    },
  ],
  ai_receipts: [{ id: "receipt-1", execution_id: "execution-1" }],
  ai_reviews: [],
  ai_review_items: [],
  ai_review_decisions: [],
};

function nextId(table: string): string {
  const prefix =
    table === "ai_reviews"
      ? "review"
      : table === "ai_review_items"
        ? "item"
        : "decision";
  return `${prefix}-${rows[table].length + 1}`;
}

function queryFor(table: string) {
  let current = [...(rows[table] ?? [])];
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => row[column] === value);
    return query;
  });
  query.neq = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => row[column] !== value);
    return query;
  });
  query.in = vi.fn((column: string, values: unknown[]) => {
    current = current.filter((row) => values.includes(row[column]));
    return query;
  });
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.insert = vi.fn(
    (payload: Record<string, unknown> | Record<string, unknown>[]) => {
      const values = Array.isArray(payload) ? payload : [payload];
      const inserted = values.map((value) => ({ id: nextId(table), ...value }));
      rows[table].push(...inserted);
      current = inserted;
      writes.push(
        ...inserted.map((value) => ({
          table,
          operation: "insert",
          payload: value,
        })),
      );
      return query;
    },
  );
  query.update = vi.fn((payload: Record<string, unknown>) => {
    for (const row of rows[table]) {
      if (current.includes(row)) Object.assign(row, payload);
    }
    writes.push({ table, operation: "update", payload });
    return query;
  });
  query.single = vi.fn(async () => ({ data: current[0] ?? null, error: null }));
  query.maybeSingle = query.single;
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data: current, error: null }).then(resolve, reject);
  return query;
}

const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === "apply_ai_review_item_decision") {
    const item = rows.ai_review_items.find(
      (row) => row.id === args.p_item_id && row.review_id === args.p_review_id,
    );
    if (!item) return { data: null, error: { message: "item not found" } };
    const decision = {
      id: nextId("ai_review_decisions"),
      review_id: args.p_review_id,
      review_item_id: args.p_item_id,
      actor_user_id: args.p_actor_user_id,
      decision: args.p_decision,
      before_state: {
        status: item.status,
        finding_text: item.finding_text,
        comment: item.comment,
      },
      after_state: {
        status: args.p_decision,
        finding_text:
          args.p_decision === "edited"
            ? args.p_finding_text
            : item.finding_text,
        comment: args.p_comment ?? null,
      },
      comment: args.p_comment ?? null,
      created_at: "2026-08-19T12:00:03.000Z",
    };
    const updatedItem = {
      ...item,
      status: args.p_decision,
      finding_text:
        args.p_decision === "edited" ? args.p_finding_text : item.finding_text,
      comment: args.p_comment ?? null,
      updated_at: "2026-08-19T12:00:03.000Z",
    };
    Object.assign(item, updatedItem);
    rows.ai_review_decisions.push(decision);
    writes.push(
      { table: "ai_review_decisions", operation: "insert", payload: decision },
      { table: "ai_review_items", operation: "update", payload: updatedItem },
    );
    return { data: { item: updatedItem, decision }, error: null };
  }

  if (name === "complete_ai_review") {
    const review = rows.ai_reviews.find((row) => row.id === args.p_review_id);
    if (!review) return { data: null, error: { message: "review not found" } };
    const completedAt = "2026-08-19T12:00:04.000Z";
    const decision = {
      id: nextId("ai_review_decisions"),
      review_id: args.p_review_id,
      review_item_id: null,
      actor_user_id: args.p_actor_user_id,
      decision: args.p_status,
      before_state: { status: review.status },
      after_state: { status: args.p_status, comment: args.p_comment ?? null },
      comment: args.p_comment ?? null,
      created_at: completedAt,
    };
    Object.assign(review, {
      status: args.p_status,
      completed_at: completedAt,
    });
    rows.ai_review_decisions.push(decision);
    writes.push(
      {
        table: "ai_reviews",
        operation: "update",
        payload: { status: args.p_status, completed_at: completedAt },
      },
      { table: "ai_review_decisions", operation: "insert", payload: decision },
    );
    return { data: { review, decision }, error: null };
  }

  return { data: null, error: { message: `unexpected RPC ${name}` } };
});
const db = { from: vi.fn((table: string) => queryFor(table)), rpc };
const {
  checkProjectAccess,
  checkMatterAccess,
  assertEpochFresh,
  recordAuditEvent,
} = vi.hoisted(() => ({
  checkProjectAccess: vi.fn(),
  checkMatterAccess: vi.fn(),
  assertEpochFresh: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => db),
}));
vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = currentUserId;
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../lib/access", () => ({
  checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
}));
vi.mock("../../lib/aiAccess", () => ({
  checkMatterAccess: (...args: unknown[]) => checkMatterAccess(...args),
}));
vi.mock("../../lib/tenancy", () => ({
  assertEpochFresh: (...args: unknown[]) => assertEpochFresh(...args),
}));
vi.mock("../../lib/audit", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
  buildAiAuditDetail: vi.fn((input: Record<string, unknown>) => input),
}));

import { app } from "../../app";

describe("AI human review routes", () => {
  beforeEach(() => {
    currentUserId = "user-2";
    writes.length = 0;
    rows.ai_reviews.length = 0;
    rows.ai_review_items.length = 0;
    rows.ai_review_decisions.length = 0;
    vi.clearAllMocks();
    checkProjectAccess.mockResolvedValue({ ok: true, isOwner: false });
    checkMatterAccess.mockResolvedValue({
      ok: true,
      role: "editor",
      projectId: "project-1",
      organizationId: "org-1",
      authorizationEpoch: 1,
    });
    assertEpochFresh.mockResolvedValue(undefined);
  });

  it("uses one atomic RPC for item decision and projection", async () => {
    await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});

    const res = await request(app)
      .post(
        "/projects/project-1/ai-executions/execution-1/review/items/item-1/decision",
      )
      .set("Authorization", "Bearer test")
      .send({ decision: "accepted" });

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "apply_ai_review_item_decision",
      expect.objectContaining({
        p_review_id: "review-1",
        p_item_id: "item-1",
        p_actor_user_id: "user-2",
        p_organization_id: "org-1",
        p_authorization_epoch: 1,
        p_decision: "accepted",
      }),
    );
    expect(
      writes.filter((write) => write.table === "ai_review_decisions"),
    ).toHaveLength(1);
  });

  it("uses one atomic RPC for review status and terminal decision", async () => {
    await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});

    for (const itemId of ["item-1", "item-2"]) {
      await request(app)
        .post(
          `/projects/project-1/ai-executions/execution-1/review/items/${itemId}/decision`,
        )
        .set("Authorization", "Bearer test")
        .send({ decision: "accepted" });
    }

    const res = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review/complete")
      .set("Authorization", "Bearer test")
      .send({ status: "approved", comment: "Revisión completa." });

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "complete_ai_review",
      expect.objectContaining({
        p_review_id: "review-1",
        p_actor_user_id: "user-2",
        p_organization_id: "org-1",
        p_authorization_epoch: 1,
        p_status: "approved",
        p_comment: "Revisión completa.",
      }),
    );
    expect(
      writes.filter(
        (write) =>
          write.table === "ai_review_decisions" &&
          write.payload?.review_item_id === null,
      ),
    ).toHaveLength(1);
  });

  it("lists executions visible through the matter for a second lawyer", async () => {
    const res = await request(app)
      .get("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test");

    expect(res.status).toBe(200);
    expect(res.body.map((execution: { id: string }) => execution.id)).toEqual([
      "execution-1",
      "execution-failed",
    ]);
  });

  it("assigns one review to a different matter editor and materializes findings", async () => {
    const res = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "review-1",
      execution_id: "execution-1",
      matter_id: "matter-1",
      reviewer_user_id: "user-2",
      status: "in_progress",
    });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      item_key: "c1",
      original_text: "La cláusula permite terminar el contrato.",
      status: "pending",
      citation_refs: [{ citation_id: "c1", verified: true }],
    });
  });

  it("lets a matter editor review without owning the legacy project", async () => {
    checkProjectAccess.mockResolvedValue({ ok: false });

    const res = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.reviewer_user_id).toBe("user-2");
  });

  it("records an edited decision with actor and before/after state", async () => {
    await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});

    const res = await request(app)
      .post(
        "/projects/project-1/ai-executions/execution-1/review/items/item-1/decision",
      )
      .set("Authorization", "Bearer test")
      .send({
        decision: "edited",
        finding_text: "La cláusula permite terminar anticipadamente.",
        comment: "Precisar que aplica solo a terminación anticipada.",
      });

    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: "item-1",
      status: "edited",
      finding_text: "La cláusula permite terminar anticipadamente.",
    });
    expect(res.body.decision).toMatchObject({
      decision: "edited",
      actor_user_id: "user-2",
      before_state: {
        status: "pending",
        finding_text: "La cláusula permite terminar el contrato.",
      },
      after_state: {
        status: "edited",
        finding_text: "La cláusula permite terminar anticipadamente.",
      },
    });
    expect(
      writes.filter((write) => write.table === "ai_review_decisions"),
    ).toHaveLength(1);
  });

  it("requires every finding resolved before approval and preserves the final status", async () => {
    await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});

    const incomplete = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review/complete")
      .set("Authorization", "Bearer test")
      .send({ status: "approved" });
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.code).toBe("items_pending");

    for (const itemId of ["item-1", "item-2"]) {
      const decision = await request(app)
        .post(
          `/projects/project-1/ai-executions/execution-1/review/items/${itemId}/decision`,
        )
        .set("Authorization", "Bearer test")
        .send({ decision: "accepted" });
      expect(decision.status).toBe(200);
    }

    const complete = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review/complete")
      .set("Authorization", "Bearer test")
      .send({ status: "approved", comment: "Revisión completa." });

    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({ status: "approved" });
    expect(complete.body.completed_by_user_id).toBe("user-2");
  });

  it("blocks approval when a citation is no longer verified", async () => {
    await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});
    rows.ai_review_items[0].citation_refs = [{ verified: false }];

    for (const itemId of ["item-1", "item-2"]) {
      const decision = await request(app)
        .post(
          `/projects/project-1/ai-executions/execution-1/review/items/${itemId}/decision`,
        )
        .set("Authorization", "Bearer test")
        .send({ decision: "accepted" });
      expect(decision.status).toBe(200);
    }

    const complete = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review/complete")
      .set("Authorization", "Bearer test")
      .send({ status: "approved" });

    expect(complete.status).toBe(409);
    expect(complete.body.code).toBe("unverified_citation");
  });

  it("blocks completion when the matter authorization epoch changed", async () => {
    await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});
    for (const itemId of ["item-1", "item-2"]) {
      await request(app)
        .post(
          `/projects/project-1/ai-executions/execution-1/review/items/${itemId}/decision`,
        )
        .set("Authorization", "Bearer test")
        .send({ decision: "accepted" });
    }
    assertEpochFresh.mockRejectedValueOnce(new Error("authorization revoked"));

    const complete = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review/complete")
      .set("Authorization", "Bearer test")
      .send({ status: "approved" });

    expect(complete.status).toBe(403);
    expect(complete.body.code).toBe("authorization_revoked");
    expect(rows.ai_reviews[0].status).toBe("in_progress");
  });

  it("blocks an item decision when the matter authorization epoch changed", async () => {
    await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});
    assertEpochFresh.mockRejectedValueOnce(new Error("authorization revoked"));

    const decision = await request(app)
      .post(
        "/projects/project-1/ai-executions/execution-1/review/items/item-1/decision",
      )
      .set("Authorization", "Bearer test")
      .send({ decision: "accepted" });

    expect(decision.status).toBe(403);
    expect(decision.body.code).toBe("authorization_revoked");
    expect(rows.ai_review_decisions).toHaveLength(0);
    expect(rows.ai_review_items[0]).toMatchObject({
      status: "pending",
      finding_text: "La cláusula permite terminar el contrato.",
    });
  });

  it("does not let the original execution author create or mutate the assigned review", async () => {
    currentUserId = "user-1";
    const create = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});
    expect(create.status).toBe(403);

    currentUserId = "user-2";
    await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});
    currentUserId = "user-1";
    const decision = await request(app)
      .post(
        "/projects/project-1/ai-executions/execution-1/review/items/item-1/decision",
      )
      .set("Authorization", "Bearer test")
      .send({ decision: "accepted" });
    expect(decision.status).toBe(403);
  });

  it("does not create a review for a failed execution or a crossed matter", async () => {
    const failed = await request(app)
      .post("/projects/project-1/ai-executions/execution-failed/review")
      .set("Authorization", "Bearer test")
      .send({});
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe("review_unavailable");

    checkMatterAccess.mockResolvedValueOnce({
      ok: true,
      role: "editor",
      projectId: "project-other",
      organizationId: "org-1",
      authorizationEpoch: 1,
    });
    const crossed = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});
    expect(crossed.status).toBe(404);
  });

  it("does not let a viewer claim a review", async () => {
    checkMatterAccess.mockResolvedValue({ ok: false });

    const res = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});

    expect(res.status).toBe(404);
    expect(rows.ai_reviews).toHaveLength(0);
  });

  it("does not create a review when a citation has no linked finding text", async () => {
    rows.ai_output_versions[0].citation_refs = [
      {
        citation_id: "c1",
        verified: true,
      },
      {
        citation_id: "c2",
        verified: true,
      },
    ];

    const res = await request(app)
      .post("/projects/project-1/ai-executions/execution-1/review")
      .set("Authorization", "Bearer test")
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "review_unavailable" });
    expect(rows.ai_reviews).toHaveLength(0);
    expect(rows.ai_review_items).toHaveLength(0);
  });
});
