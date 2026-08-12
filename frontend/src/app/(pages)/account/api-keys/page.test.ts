import { describe, expect, it } from "vitest";
import { MODEL_API_KEY_FIELDS } from "./modelApiKeyFields";

describe("governed model API key fields", () => {
    it("offers every supported governed LLM provider exactly once", () => {
        const providers = MODEL_API_KEY_FIELDS.map((field) => field.provider);
        expect(providers).toEqual([
            "claude",
            "gemini",
            "openai",
            "openrouter",
            "deepseek",
            "opencode-zen",
            "opencode-go",
        ]);
        expect(new Set(providers).size).toBe(providers.length);
    });
});
