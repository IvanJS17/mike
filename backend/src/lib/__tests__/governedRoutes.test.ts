import { describe, expect, it, vi } from "vitest";
import { resolveModelRouteForUser } from "../llm/governedRoutes";

describe("server-side governed route resolution", () => {
    it("fails closed when the pinned credential reference is unavailable", async () => {
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        const db = { from: vi.fn(() => query) } as never;

        await expect(
            resolveModelRouteForUser(
                "user-1",
                {
                    provider: "deepseek",
                    model: "deepseek-chat",
                    credential_ref: "deepseek:v1",
                },
                db,
            ),
        ).resolves.toEqual({
            ok: false,
            code: "credential_unavailable",
            detail: "The pinned model credential is unavailable",
        });
    });
});
