import { describe, expect, it } from "vitest";
import { parseModelRoute, validateModelRoute } from "../llm/routes";

describe("normalized governed model routes", () => {
    it("normalizes the exact provider, model, and credential reference", () => {
        expect(
            parseModelRoute({
                provider: "deepseek",
                model: "deepseek-chat",
                credential_ref: "deepseek:v3",
            }),
        ).toEqual({
            ok: true,
            value: {
                provider: "deepseek",
                model: "deepseek-chat",
                credential_ref: "deepseek:v3",
            },
        });
    });

    it("rejects a model that belongs to another provider or an unsupported OpenCode mode", () => {
        expect(
            validateModelRoute({
                provider: "deepseek",
                model: "gpt-5.4",
                credential_ref: "deepseek:v1",
            }),
        ).toEqual({ ok: false, detail: expect.stringContaining("deepseek") });

        expect(
            validateModelRoute({
                provider: "opencode-zen",
                model: "gpt-5.5",
                credential_ref: "opencode-zen:v1",
            }).ok,
        ).toBe(false);
    });
});
