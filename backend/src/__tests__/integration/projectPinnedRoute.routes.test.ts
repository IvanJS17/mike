import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

const { runLLMStream, checkProjectAccess, resolveModelRouteForUser } =
    vi.hoisted(() => ({
        runLLMStream: vi.fn(),
        checkProjectAccess: vi.fn(),
        resolveModelRouteForUser: vi.fn(),
    }));

const writes: Record<string, unknown>[] = [];
const pinnedChat = {
    id: "chat-1",
    title: null,
    user_id: "user-1",
    project_id: "project-1",
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
                writes.push(payload);
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
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
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
        buildProjectDocContext: vi.fn(async () => ({
            docIndex: {},
            docStore: new Map(),
            folderPaths: new Map(),
        })),
        enrichWithPriorEvents: vi.fn(async (messages: unknown) => messages),
        buildWorkflowStore: vi.fn(async () => new Map()),
        buildMessages: vi.fn(() => []),
        runLLMStream: (...args: unknown[]) => runLLMStream(...args),
    };
});

import { app } from "../../app";

describe("pinned routes on project chat", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        writes.length = 0;
        checkProjectAccess.mockResolvedValue({ ok: true });
        resolveModelRouteForUser.mockResolvedValue({
            ok: true,
            route: {
                provider: "deepseek",
                model: "deepseek-chat",
                credential_ref: "deepseek:v1",
            },
            credentialSecret: "server-only-secret",
        });
        runLLMStream.mockResolvedValue({ fullText: "", events: [], citations: [] });
    });

    it("rejects a changed project-chat route before writes or egress", async () => {
        const res = await request(app)
            .post("/projects/project-1/chat")
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
        expect(writes).toHaveLength(0);
        expect(runLLMStream).not.toHaveBeenCalled();
    });
});
