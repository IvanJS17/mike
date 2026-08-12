import { describe, expect, it, vi } from "vitest";
import request from "supertest";

const { buildModelCatalog, listUserLlmCredentials } = vi.hoisted(() => ({
    buildModelCatalog: vi.fn(),
    listUserLlmCredentials: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/llm/catalog", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/llm/catalog")>()),
    buildModelCatalog: (...args: unknown[]) => buildModelCatalog(...args),
}));

vi.mock("../../lib/userApiKeys", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/userApiKeys")>()),
    listUserLlmCredentials: (...args: unknown[]) =>
        listUserLlmCredentials(...args),
}));

import { app } from "../../app";

describe("GET /models/catalog", () => {
    it("returns only non-secret catalog routes for the authenticated user", async () => {
        const secret = "sk-user-only";
        listUserLlmCredentials.mockResolvedValue([
            {
                provider: "deepseek",
                credential_ref: "deepseek:v2",
                secret,
            },
        ]);
        buildModelCatalog.mockResolvedValue({
            routes: [
                {
                    provider: "deepseek",
                    model: "deepseek-chat",
                    credential_ref: "deepseek:v2",
                    source: "curated",
                    availability: "catalog",
                    catalog_available: true,
                },
            ],
            catalogs: [
                {
                    provider: "deepseek",
                    credential_ref: "deepseek:v2",
                    source: "curated",
                    catalog_available: false,
                },
            ],
        });

        const res = await request(app)
            .get("/models/catalog")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(200);
        expect(res.body.routes).toHaveLength(1);
        expect(res.body.routes[0]).toMatchObject({
            provider: "deepseek",
            model: "deepseek-chat",
            credential_ref: "deepseek:v2",
            source: "curated",
            availability: "catalog",
        });
        expect(JSON.stringify(res.body)).not.toContain(secret);
    });
});
