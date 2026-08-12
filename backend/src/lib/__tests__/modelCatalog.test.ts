import { describe, expect, it, vi } from "vitest";
import {
    catalogRoutesForModels,
    catalogRoutesWithFallback,
    buildModelCatalog,
    fetchLiveModelIds,
} from "../llm/catalog";

describe("governed model catalog", () => {
    it("filters unsupported OpenCode modes and reports live versus curated availability", () => {
        const live = catalogRoutesForModels({
            provider: "opencode-zen",
            credential_ref: "opencode-zen:v1",
            models: ["deepseek-v4-flash", "gpt-5.5"],
            source: "live",
        });

        expect(live).toEqual([
            {
                provider: "opencode-zen",
                model: "deepseek-v4-flash",
                credential_ref: "opencode-zen:v1",
                source: "live",
                availability: "catalog",
                catalog_available: true,
            },
        ]);

        expect(
            catalogRoutesForModels({
                provider: "deepseek",
                credential_ref: "deepseek:v2",
                models: ["deepseek-chat"],
                source: "curated",
            })[0],
        ).toMatchObject({
            source: "curated",
            availability: "catalog",
            catalog_available: true,
        });
    });

    it("uses curated models only when the live listing fails and reports that status", () => {
        expect(
            catalogRoutesWithFallback({
                provider: "opencode-go",
                credential_ref: "opencode-go:v1",
                liveModels: null,
                curatedModels: ["deepseek-v4-flash"],
            }),
        ).toEqual({
            routes: [
                expect.objectContaining({
                    provider: "opencode-go",
                    model: "deepseek-v4-flash",
                    source: "curated",
                    availability: "catalog",
                    catalog_available: true,
                }),
            ],
            source: "curated",
            catalog_available: false,
        });
    });

    it("uses an authenticated live listing without returning the credential", async () => {
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            expect(init?.headers).toMatchObject({
                Authorization: "Bearer live-secret",
            });
            return {
                ok: true,
                json: async () => ({ data: [{ id: "deepseek/deepseek-chat" }] }),
            } as Response;
        });

        await expect(
            fetchLiveModelIds("openrouter", "live-secret", fetchImpl),
        ).resolves.toEqual(["deepseek/deepseek-chat"]);
        expect(fetchImpl.mock.calls[0]?.[0]).toBe(
            "https://openrouter.ai/api/v1/models",
        );
    });

    it("reads Gemini model listings from the models field", async () => {
        const fetchImpl = vi.fn(async () =>
            ({
                ok: true,
                json: async () => ({
                    models: [{ name: "models/gemini-2.5-flash" }],
                }),
            }) as Response,
        );

        await expect(
            fetchLiveModelIds("gemini", "live-secret", fetchImpl),
        ).resolves.toEqual(["gemini-2.5-flash"]);
    });

    it("keeps catalog routes scoped to each available credential reference", async () => {
        const firstSecret = "sk-openrouter-first";
        const secondSecret = "sk-openrouter-second";
        const fetchImpl = vi.fn(async (_url: string) =>
            ({
                ok: true,
                json: async () => ({ data: [{ id: "openai/gpt-5.4" }] }),
            }) as Response,
        );

        const catalog = await buildModelCatalog(
            [
                {
                    provider: "openrouter",
                    credential_ref: "openrouter:v1",
                    secret: firstSecret,
                },
                {
                    provider: "openrouter",
                    credential_ref: "openrouter:v2",
                    secret: secondSecret,
                },
            ],
            fetchImpl,
        );

        expect(catalog.routes).toHaveLength(2);
        expect(new Set(catalog.routes.map((route) => route.credential_ref))).toEqual(
            new Set(["openrouter:v1", "openrouter:v2"]),
        );
        expect(JSON.stringify(catalog)).not.toContain(firstSecret);
        expect(JSON.stringify(catalog)).not.toContain(secondSecret);
    });
});
