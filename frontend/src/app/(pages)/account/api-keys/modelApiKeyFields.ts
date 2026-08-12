import type { ApiKeyProvider } from "@/app/lib/mikeApi";

export interface ModelApiKeyField {
    provider: Exclude<ApiKeyProvider, "courtlistener">;
    label: string;
    placeholder: string;
}

export const MODEL_API_KEY_FIELDS: ModelApiKeyField[] = [
    {
        provider: "claude",
        label: "Anthropic (Claude) API Key",
        placeholder: "sk-ant-...",
    },
    {
        provider: "gemini",
        label: "Google (Gemini) API Key",
        placeholder: "AI...",
    },
    {
        provider: "openai",
        label: "OpenAI API Key",
        placeholder: "sk-...",
    },
    {
        provider: "openrouter",
        label: "OpenRouter API Key",
        placeholder: "sk-or-...",
    },
    {
        provider: "deepseek",
        label: "DeepSeek API Key",
        placeholder: "sk-...",
    },
    {
        provider: "opencode-zen",
        label: "OpenCode Zen API Key",
        placeholder: "sk-...",
    },
    {
        provider: "opencode-go",
        label: "OpenCode Go API Key",
        placeholder: "sk-...",
    },
];
