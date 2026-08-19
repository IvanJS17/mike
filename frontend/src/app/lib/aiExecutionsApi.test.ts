import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));
vi.mock("@/app/lib/supabase", () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

import {
  createAiExecution,
  getAiExecution,
  getAiExecutionOutput,
  getAiExecutionReceipt,
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
});
