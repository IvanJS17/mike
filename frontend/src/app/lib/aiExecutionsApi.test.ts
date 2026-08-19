import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));
vi.mock("@/app/lib/supabase", () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

import {
  createAiExecution,
  createAiExecutionReview,
  decideAiReviewItem,
  completeAiExecutionReview,
  downloadAiReviewReport,
  getAiExecution,
  getAiExecutionOutput,
  getAiExecutionReceipt,
  getAiExecutionReview,
  listAiExecutions,
} from "./mikeApi";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  getSessionMock.mockResolvedValue({
    data: { session: { access_token: "token-123" } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AI execution API client", () => {
  it("starts an execution in the private project scope with a pinned route", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "execution-1" }), { status: 201 }),
    );

    await createAiExecution("project-1", {
      matter_id: "matter-1",
      document_version_id: "version-1",
      route: {
        provider: "deepseek",
        model: "deepseek-chat",
        credential_ref: "deepseek:v1",
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/projects/project-1/ai-executions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      matter_id: "matter-1",
      document_version_id: "version-1",
      route: { credential_ref: "deepseek:v1" },
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-123",
    );
  });

  it("uses the same private project scope to read status, receipt, and output", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "execution-1" }), { status: 200 }),
      ),
    );

    await getAiExecution("project-1", "execution-1");
    await getAiExecutionReceipt("project-1", "execution-1");
    await getAiExecutionOutput("project-1", "execution-1");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/projects/project-1/ai-executions/execution-1",
      "http://localhost:3001/projects/project-1/ai-executions/execution-1/receipt",
      "http://localhost:3001/projects/project-1/ai-executions/execution-1/output",
    ]);
  });

  it("creates, reads, decides, and completes an execution review in the private scope", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "review-1" }), { status: 200 }),
      ),
    );

    await listAiExecutions("project-1");
    await createAiExecutionReview("project-1", "execution-1");
    await getAiExecutionReview("project-1", "execution-1");
    await decideAiReviewItem("project-1", "execution-1", "item-1", {
      decision: "edited",
      finding_text: "Hallazgo corregido",
      comment: "Nota breve",
    });
    await completeAiExecutionReview("project-1", "execution-1", {
      status: "changes_requested",
      comment: "Revisar el plazo.",
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/projects/project-1/ai-executions",
      "http://localhost:3001/projects/project-1/ai-executions/execution-1/review",
      "http://localhost:3001/projects/project-1/ai-executions/execution-1/review",
      "http://localhost:3001/projects/project-1/ai-executions/execution-1/review/items/item-1/decision",
      "http://localhost:3001/projects/project-1/ai-executions/execution-1/review/complete",
    ]);
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body))).toEqual({
      decision: "edited",
      finding_text: "Hallazgo corregido",
      comment: "Nota breve",
    });
    expect(JSON.parse(String((fetchMock.mock.calls[4]?.[1] as RequestInit).body))).toEqual({
      status: "changes_requested",
      comment: "Revisar el plazo.",
    });
  });

  it("generates an approved report and downloads it through the authenticated API", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "export-1",
            review_id: "review-1",
            execution_id: "execution-1",
            matter_id: "matter-1",
            project_id: "project-1",
            source_document_version_id: "source-version-1",
            document_id: "report-document-1",
            document_version_id: "report-version-1",
            report_version: 1,
            filename: "Informe de revision humana.docx",
            content_sha256: "a".repeat(64),
            actor_user_id: "reviewer-1",
            created_at: "2026-08-19T12:00:00.000Z",
            download_url:
              "/projects/project-1/ai-executions/execution-1/review/report/download",
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response("docx-bytes", {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="Informe de revision humana.docx"',
          },
        }),
      );

    const result = await downloadAiReviewReport("project-1", "execution-1");

    expect(result.filename).toBe("Informe de revision humana.docx");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/projects/project-1/ai-executions/execution-1/review/report",
      "http://localhost:3001/projects/project-1/ai-executions/execution-1/review/report/download",
    ]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBeUndefined();
  });
});
