import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

const { runLLMStream, resolveModelRouteForUser } = vi.hoisted(() => ({
    runLLMStream: vi.fn(),
    resolveModelRouteForUser: vi.fn(),
}));

const messageWrites: Record<string, unknown>[] = [];
const pinnedChat = {
    id: "chat-1",
    title: null,
    user_id: "user-1",
    project_id: null,
    model_provider: "deepseek",
    model: "deepseek-chat",
    credential_ref: "deepseek:v1",
};

function makeQuery(table: string) {
    const result = table === "chats" ? pinnedChat : null;
    const q: Record<string, any> = {};
    for (const method of [
        "select",
        "insert",
        "update",
        "delete",
        "eq",
        "in",
        "order",
    ]) {
        q[method] = vi.fn((payload?: Record<string, unknown>) => {
            if (table === "chat_messages" && method === "insert" && payload) {
                messageWrites.push(payload);
            }
            return q;
        });
    }
    q.single = vi.fn(async () => ({ data: result, error: null }));
    q.maybeSingle = vi.fn(async () => ({ data: result, error: null }));
    q.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve({ data: result, error: null }).then(resolve, reject);
    return q;
}

const db = { from: vi.fn((table: string) => makeQuery(table)) };

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => db),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        res.locals.userEmail = "user@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/access", () => ({
    checkProjectAccess: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: vi.fn(async () => ({
        legal_research_us: false,
        title_model: "test-model",
        tabular_model: "test-model",
        api_keys: {},
    })),
}));

vi.mock("../../lib/llm/governedRoutes", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/llm/governedRoutes")>()),
    resolveModelRouteForUser: (...args: unknown[]) =>
        resolveModelRouteForUser(...args),
}));

vi.mock("../../lib/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/chat")>();
    return {
        ...actual,
        buildDocContext: vi.fn(async () => ({ docIndex: {}, docStore: new Map() })),
        enrichWithPriorEvents: vi.fn(async (messages: unknown) => messages),
        buildWorkflowStore: vi.fn(async () => new Map()),
        buildMessages: vi.fn(() => []),
        runLLMStream: (...args: unknown[]) => runLLMStream(...args),
    };
});

import { app } from "../../app";

describe("pinned routes on normal chat", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        messageWrites.length = 0;
        runLLMStream.mockResolvedValue({ fullText: "", events: [], citations: [] });
        resolveModelRouteForUser.mockResolvedValue({
            ok: true,
            route: {
                provider: "deepseek",
                model: "deepseek-chat",
                credential_ref: "deepseek:v1",
            },
            credentialSecret: "server-only-secret",
        });
    });

    it("rejects a changed model route before message writes or LLM egress", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({
                chat_id: "chat-1",
                route: {
                    provider: "deepseek",
                    model: "deepseek-reasoner",
                    credential_ref: "deepseek:v1",
                },
                messages: [{ role: "user", content: "hello" }],
            });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("chat_route_mismatch");
        expect(messageWrites).toHaveLength(0);
        expect(runLLMStream).not.toHaveBeenCalled();
    });
});
