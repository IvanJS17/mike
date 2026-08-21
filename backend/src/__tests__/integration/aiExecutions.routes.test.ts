import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { sha256Hex, buildExecutionInputHash } from "../../lib/aiReceipts";
import {
  CIVIL_MERCANTIL_MX_PLAYBOOK_ID,
  CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT,
  CIVIL_MERCANTIL_MX_PLAYBOOK_VERSION,
} from "../../lib/civilMercantilePlaybook";

const { completeText, resolveModelRouteForUser, checkProjectAccess, checkMatterAccess, loadAiDocumentVersionPages } =
  vi.hoisted(() => ({
    completeText: vi.fn(),
    resolveModelRouteForUser: vi.fn(),
    checkProjectAccess: vi.fn(),
    checkMatterAccess: vi.fn(),
    loadAiDocumentVersionPages: vi.fn(),
  }));

const pageText = "La parte compradora podrá terminar el contrato.";
const quote = pageText.slice(0, 20);
const writes: { table: string; operation: string; payload?: Record<string, unknown> }[] = [];
const rows = {
  documents: [
    {
      id: "document-1",
      user_id: "user-1",
      project_id: "project-1",
    },
  ],
  document_versions: [
    {
      id: "version-1",
      document_id: "document-1",
      version_number: 1,
      page_count: 1,
      content_sha256: "a".repeat(64),
      deleted_at: null,
    },
  ],
  organizations: [
    {
      id: "org-1",
      authorization_epoch: 1,
    },
  ],
  workflows: [
    {
      id: "workflow-custom-1",
      user_id: "user-1",
      prompt_md: "# Custom workflow\nOnly use this workflow.",
      created_at: "2026-08-20T12:00:00.000Z",
    },
    {
      id: "workflow-custom-no-version",
      user_id: "user-1",
      prompt_md: "# Legacy custom workflow",
      created_at: null,
    },
  ],
  ai_document_version_pages: [
    {
      document_id: "document-1",
      document_version_id: "version-1",
      page: 1,
      content: pageText,
      content_sha256: sha256Hex(pageText),
    },
  ],
};

function queryFor(table: string) {
  let current = [...((rows as Record<string, Record<string, unknown>[]>)[table] ?? [])];
  let inserted: Record<string, unknown> | null = null;
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => row[column] === value);
    return query;
  });
  query.is = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => (row[column] ?? null) === value);
    return query;
  });
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.insert = vi.fn((payload: Record<string, unknown>) => {
    inserted = payload;
    writes.push({ table, operation: "insert", payload });
    return query;
  });
  query.update = vi.fn((payload: Record<string, unknown>) => {
    writes.push({ table, operation: "update", payload });
    return query;
  });
  query.single = vi.fn(async () => {
    if (table === "ai_executions" && inserted) {
      return {
        data: {
          id: "execution-1",
          ...inserted,
          created_at: "2026-08-19T12:00:00.000Z",
          started_at: null,
          finished_at: null,
        },
        error: null,
      };
    }
    if (table === "ai_output_versions") {
      return { data: { id: "output-1" }, error: null };
    }
    if (table === "ai_receipts") {
      return { data: { id: "receipt-1" }, error: null };
    }
    return { data: current[0] ?? null, error: null };
  });
  query.maybeSingle = query.single;
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data: current, error: null }).then(resolve, reject);
  return query;
}

const db = {
  from: vi.fn((table: string) => queryFor(table)),
};

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => db),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.userId = "user-1";
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/access", () => ({
  checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
}));

vi.mock("../../lib/aiAccess", () => ({
  checkMatterAccess: (...args: unknown[]) => checkMatterAccess(...args),
}));

vi.mock("../../lib/aiDocumentPages", () => ({
  loadAiDocumentVersionPages: (...args: unknown[]) => loadAiDocumentVersionPages(...args),
}));

vi.mock("../../lib/llm/governedRoutes", () => ({
  resolveModelRouteForUser: (...args: unknown[]) => resolveModelRouteForUser(...args),
}));

vi.mock("../../lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/llm")>()),
  completeText: (...args: unknown[]) => completeText(...args),
}));

vi.mock("../../lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/audit")>()),
  recordAuditEvent: vi.fn(async (_db: unknown, event: { eventType: string; eventDetail: unknown }) => {
    writes.push({ table: "audit_events", operation: event.eventType, payload: event.eventDetail as Record<string, unknown> });
  }),
}));

import { app } from "../../app";

describe("AI execution routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writes.length = 0;
    rows.organizations[0].authorization_epoch = 1;
    checkProjectAccess.mockResolvedValue({ ok: true, isOwner: true });
    checkMatterAccess.mockResolvedValue({
      ok: true,
      role: "matter_owner",
      projectId: "project-1",
      organizationId: "org-1",
      authorizationEpoch: 1,
    });
    loadAiDocumentVersionPages.mockResolvedValue({
      pages: [
        {
          page: 1,
          text: pageText,
          textSha256: sha256Hex(pageText),
        },
      ],
      sourceContentSha256: "a".repeat(64),
    });
    resolveModelRouteForUser.mockResolvedValue({
      ok: true,
      route: {
        provider: "deepseek",
        model: "deepseek-chat",
        credential_ref: "deepseek:v1",
      },
      credentialSecret: "server-only-secret",
    });
    completeText.mockResolvedValue(
      `La parte compradora puede terminar el contrato.\n<CITATIONS>${JSON.stringify([
        {
          citation_id: "c1",
          document_id: "document-1",
          document_version_id: "version-1",
          page: 1,
          span: { start_char: 0, end_char: quote.length },
          quote,
          quote_sha256: sha256Hex(quote),
          finding_text: "La parte compradora puede terminar el contrato.",
        },
      ])}</CITATIONS>`,
    );
  });

  it("requires an explicit private matter scope", async () => {
    const res = await request(app)
      .post("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test")
      .send({
        document_version_id: "version-1",
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("matter_id");
    expect(checkMatterAccess).not.toHaveBeenCalled();
  });

  it("creates a pinned execution, immutable output, receipt and audit metadata", async () => {
    const res = await request(app)
      .post("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test")
      .send({
        matter_id: "matter-1",
        document_version_id: "version-1",
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "execution-1",
      project_id: "project-1",
      matter_id: "matter-1",
      document_version_id: "version-1",
      route: {
        provider: "deepseek",
        model: "deepseek-chat",
        credential_ref: "deepseek:v1",
      },
      status: "succeeded",
      output_id: "output-1",
      receipt_id: "receipt-1",
    });
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
        credentialSecret: "server-only-secret",
      }),
    );
    const providerRequest = completeText.mock.calls[0]?.[0] as {
      systemPrompt: string;
    };
    expect(providerRequest.systemPrompt).toMatch(/quote_sha256/);
    expect(providerRequest.systemPrompt).toMatch(
      /64-character lowercase hexadecimal SHA-256/i,
    );
    expect(providerRequest.systemPrompt).toMatch(/exact quote excerpt/i);
    expect(providerRequest.systemPrompt).toMatch(/finding_text/);
    expect(providerRequest.systemPrompt).toContain("R1 Partes/capacidad");
    expect(providerRequest.systemPrompt).toContain("R10 Formalidades");
    expect(providerRequest.systemPrompt).toContain("quote_sha256");
    const executionInsert = writes.find(
      (write) => write.table === "ai_executions" && write.operation === "insert",
    );
    expect(executionInsert?.payload).toMatchObject({
      workflow_id: CIVIL_MERCANTIL_MX_PLAYBOOK_ID,
      workflow_version: CIVIL_MERCANTIL_MX_PLAYBOOK_VERSION,
      playbook_sha256: sha256Hex(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT),
    });
    expect(executionInsert?.payload?.input_sha256).toBe(
      buildExecutionInputHash({
        document_version_id: "version-1",
        document_content_sha256: "a".repeat(64),
        workflow_version: CIVIL_MERCANTIL_MX_PLAYBOOK_VERSION,
        playbook_sha256: sha256Hex(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT),
      }),
    );
    const receiptInsert = writes.find(
      (write) => write.table === "ai_receipts" && write.operation === "insert",
    );
    expect(receiptInsert?.payload?.canonical_json).toMatchObject({
      input: {
        input_sha256: executionInsert?.payload?.input_sha256,
      },
      playbook: {
        workflow_id: CIVIL_MERCANTIL_MX_PLAYBOOK_ID,
        workflow_version: CIVIL_MERCANTIL_MX_PLAYBOOK_VERSION,
        playbook_sha256: sha256Hex(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT),
      },
    });
    expect(writes.filter((write) => write.table === "ai_output_versions")).toHaveLength(1);
    expect(writes.filter((write) => write.table === "ai_receipts")).toHaveLength(1);
    expect(writes.filter((write) => write.table === "audit_events").map((write) => write.operation)).toEqual([
      "ai.execution.started",
      "ai.execution.completed",
    ]);
    expect(JSON.stringify(writes)).not.toContain("server-only-secret");
    expect(JSON.stringify(writes)).not.toContain(pageText);
  });

  it("uses a custom workflow without mixing in the default playbook", async () => {
    const customPlaybook = "# Custom workflow\nOnly use this workflow.";
    const res = await request(app)
      .post("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test")
      .send({
        matter_id: "matter-1",
        document_version_id: "version-1",
        workflow_id: "workflow-custom-1",
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
      });

    expect(res.status).toBe(201);
    const providerRequest = completeText.mock.calls[0]?.[0] as {
      systemPrompt: string;
    };
    expect(providerRequest.systemPrompt).toContain(customPlaybook);
    expect(providerRequest.systemPrompt).not.toContain("R1 Partes/capacidad");
    expect(providerRequest.systemPrompt).not.toContain(
      CIVIL_MERCANTIL_MX_PLAYBOOK_ID,
    );
    const executionInsert = writes.find(
      (write) => write.table === "ai_executions" && write.operation === "insert",
    );
    expect(executionInsert?.payload).toMatchObject({
      workflow_id: "workflow-custom-1",
      workflow_version: "2026-08-20T12:00:00.000Z",
      playbook_sha256: sha256Hex(customPlaybook),
      input_sha256: buildExecutionInputHash({
        document_version_id: "version-1",
        document_content_sha256: "a".repeat(64),
        workflow_version: "2026-08-20T12:00:00.000Z",
        playbook_sha256: sha256Hex(customPlaybook),
      }),
    });
  });

  it("keeps the existing fallback version for custom workflows", async () => {
    const res = await request(app)
      .post("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test")
      .send({
        matter_id: "matter-1",
        document_version_id: "version-1",
        workflow_id: "workflow-custom-no-version",
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
      });

    expect(res.status).toBe(201);
    const executionInsert = writes.find(
      (write) => write.table === "ai_executions" && write.operation === "insert",
    );
    expect(executionInsert?.payload).toMatchObject({
      workflow_id: "workflow-custom-no-version",
      workflow_version: "1",
      playbook_sha256: sha256Hex("# Legacy custom workflow"),
    });
  });

  it("fails closed when the stored source bytes do not match the frozen document version", async () => {
    loadAiDocumentVersionPages.mockResolvedValue({
      pages: [
        {
          page: 1,
          text: pageText,
          textSha256: sha256Hex(pageText),
        },
      ],
      sourceContentSha256: "b".repeat(64),
    });

    const res = await request(app)
      .post("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test")
      .send({
        matter_id: "matter-1",
        document_version_id: "version-1",
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      id: "execution-1",
      status: "failed",
      error_class: "citation_unresolvable",
    });
    expect(completeText).not.toHaveBeenCalled();
  });

  it("fails closed on a citation from another document version and never inserts output", async () => {
    completeText.mockResolvedValue(
      `<CITATIONS>${JSON.stringify([
        {
          citation_id: "c1",
          document_id: "document-1",
          document_version_id: "version-2",
          page: 1,
          span: { start_char: 0, end_char: quote.length },
          quote,
        },
      ])}</CITATIONS>`,
    );

    const res = await request(app)
      .post("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test")
      .send({
        matter_id: "matter-1",
        document_version_id: "version-1",
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      id: "execution-1",
      status: "failed",
      error_class: "citation_unresolvable",
    });
    expect(writes.filter((write) => write.table === "ai_output_versions")).toHaveLength(0);
    expect(writes.filter((write) => write.table === "ai_receipts")).toHaveLength(1);
    expect(writes.filter((write) => write.table === "audit_events").at(-1)?.operation).toBe(
      "ai.execution.failed",
    );
  });

  it("fails closed when a citation omits its quote hash and never inserts output", async () => {
    completeText.mockResolvedValue(
      `Respuesta respaldada por el documento.\n<CITATIONS>${JSON.stringify([
        {
          citation_id: "c1",
          document_id: "document-1",
          document_version_id: "version-1",
          page: 1,
          span: { start_char: 0, end_char: quote.length },
          quote,
        },
      ])}</CITATIONS>`,
    );

    const res = await request(app)
      .post("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test")
      .send({
        matter_id: "matter-1",
        document_version_id: "version-1",
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      id: "execution-1",
      status: "failed",
      error_class: "citation_unresolvable",
    });
    expect(writes.filter((write) => write.table === "ai_output_versions")).toHaveLength(0);
  });

  it("aborts with a failure receipt when authorization is revoked during the provider call", async () => {
    completeText.mockImplementation(async () => {
      rows.organizations[0].authorization_epoch = 2;
      return `La parte compradora puede terminar el contrato.\n<CITATIONS>${JSON.stringify([
        {
          citation_id: "c1",
          document_id: "document-1",
          document_version_id: "version-1",
          page: 1,
          span: { start_char: 0, end_char: quote.length },
          quote,
          quote_sha256: sha256Hex(quote),
          finding_text: "La parte compradora puede terminar el contrato.",
        },
      ])}</CITATIONS>`;
    });

    const res = await request(app)
      .post("/projects/project-1/ai-executions")
      .set("Authorization", "Bearer test")
      .send({
        matter_id: "matter-1",
        document_version_id: "version-1",
        route: {
          provider: "deepseek",
          model: "deepseek-chat",
          credential_ref: "deepseek:v1",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      id: "execution-1",
      status: "failed",
      error_class: "authorization_revoked",
      output_id: null,
      receipt_id: "receipt-1",
    });
    expect(writes.filter((write) => write.table === "ai_output_versions")).toHaveLength(0);
    expect(writes.filter((write) => write.table === "ai_receipts")).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toContain("La parte compradora puede terminar");
    expect(writes.filter((write) => write.table === "ai_receipts")[0].payload).not.toHaveProperty(
      "output_text",
    );
    expect(writes.filter((write) => write.table === "audit_events").at(-1)?.operation).toBe(
      "ai.execution.failed",
    );
  });
});
