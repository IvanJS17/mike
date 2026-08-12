import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { resolveModelRouteForUser } = vi.hoisted(() => ({
    resolveModelRouteForUser: vi.fn(),
}));

const insertPayloads: Record<string, unknown>[] = [];

function makeQuery() {
    const q: Record<string, any> = {};
    for (const method of ["select", "insert", "update", "delete", "eq"]) {
        q[method] = vi.fn((payload?: Record<string, unknown>) => {
            if (method === "insert" && payload) insertPayloads.push(payload);
            return q;
        });
    }
    q.single = vi.fn(async () => ({ data: { id: "chat-1" }, error: null }));
    q.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    return q;
}

const db = { from: vi.fn(() => makeQuery()) };

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

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => db),
}));

vi.mock("../../lib/llm/governedRoutes", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/llm/governedRoutes")>()),
    resolveModelRouteForUser: (...args: unknown[]) =>
        resolveModelRouteForUser(...args),
}));

import { app } from "../../app";

describe("POST /chat/create governed route pinning", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        insertPayloads.length = 0;
    });

    it("validates and stores the exact route before inserting the chat", async () => {
        const route = {
            provider: "deepseek",
            model: "deepseek-chat",
            credential_ref: "deepseek:v1",
        } as const;
        resolveModelRouteForUser.mockResolvedValue({
            ok: true,
            route,
            credentialSecret: "server-only-secret",
        });

        const res = await request(app)
            .post("/chat/create")
            .set("Authorization", "Bearer test")
            .send({ route });

        expect(res.status).toBe(200);
        expect(resolveModelRouteForUser).toHaveBeenCalledWith(
            "user-1",
            route,
            expect.anything(),
        );
        expect(insertPayloads[0]).toMatchObject({
            user_id: "user-1",
            model_provider: "deepseek",
            model: "deepseek-chat",
            credential_ref: "deepseek:v1",
        });
        expect(JSON.stringify(res.body)).not.toContain("server-only-secret");
    });

    it("rejects chat creation without a route before any insert", async () => {
        const res = await request(app)
            .post("/chat/create")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("route must be an object");
        expect(insertPayloads).toHaveLength(0);
        expect(resolveModelRouteForUser).not.toHaveBeenCalled();
    });
});
