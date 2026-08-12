import { describe, expect, it, vi } from "vitest";
import { adapterForRoute, streamOpenAICompatible } from "../llm";

describe("governed LLM adapter routing", () => {
    it("uses one chat-completions adapter for compatible indirect providers", () => {
        expect(
            adapterForRoute({
                provider: "openrouter",
                model: "openai/gpt-5.4",
                credential_ref: "openrouter:v1",
            }),
        ).toBe("openai-compatible");
        expect(
            adapterForRoute({
                provider: "deepseek",
                model: "deepseek-chat",
                credential_ref: "deepseek:v1",
            }),
        ).toBe("openai-compatible");
        expect(
            adapterForRoute({
                provider: "opencode-go",
                model: "deepseek-v4-flash",
                credential_ref: "opencode-go:v1",
            }),
        ).toBe("openai-compatible");
    });

    it("executes an OpenCode route through chat completions only", async () => {
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
            expect(init?.headers).toMatchObject({
                Authorization: "Bearer opencode-secret",
            });
            expect(JSON.parse(String(init?.body))).toMatchObject({
                model: "deepseek-v4-flash",
                stream: true,
            });
            return new Response(
                'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
                { status: 200 },
            );
        });

        const result = await streamOpenAICompatible(
            {
                route: {
                    provider: "opencode-go",
                    model: "deepseek-v4-flash",
                    credential_ref: "opencode-go:v1",
                },
                model: "deepseek-v4-flash",
                systemPrompt: "system",
                messages: [{ role: "user", content: "hi" }],
                credentialSecret: "opencode-secret",
            },
            fetchMock,
        );

        expect(result.fullText).toBe("hello");
    });
});
