export const GOVERNED_LLM_PROVIDERS = [
    "openai",
    "claude",
    "gemini",
    "openrouter",
    "deepseek",
    "opencode-zen",
    "opencode-go",
] as const;

export type GovernedLlmProvider = (typeof GOVERNED_LLM_PROVIDERS)[number];

export type ModelRoute = {
    provider: GovernedLlmProvider;
    model: string;
    credential_ref: string;
};

type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isGovernedLlmProvider(value: string): value is GovernedLlmProvider {
    return (GOVERNED_LLM_PROVIDERS as readonly string[]).includes(value);
}

export function parseModelRoute(
    value: unknown,
): ValidationResult<ModelRoute> {
    if (!isRecord(value)) {
        return { ok: false, detail: "route must be an object" };
    }

    const provider = nonEmptyString(value.provider);
    if (!provider || !isGovernedLlmProvider(provider)) {
        return { ok: false, detail: "route.provider is unsupported" };
    }
    const model = nonEmptyString(value.model);
    if (!model) return { ok: false, detail: "route.model must be a non-empty string" };
    const credentialRef = nonEmptyString(value.credential_ref);
    if (!credentialRef) {
        return {
            ok: false,
            detail: "route.credential_ref must be a non-empty string",
        };
    }

    return {
        ok: true,
        value: { provider, model, credential_ref: credentialRef },
    };
}

const OPEN_CODE_ZEN_CHAT_MODELS = new Set([
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "kimi-k3",
    "big-pickle",
    "mimo-v2.5-free",
    "hy3-free",
    "laguna-s-2.1-free",
    "ling-3.0-tiny-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "deepseek-v4-flash-free",
]);

const OPEN_CODE_GO_CHAT_MODELS = new Set([
    "grok-4.5",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "hy3",
]);

export function isSupportedModelRoute(route: ModelRoute): boolean {
    switch (route.provider) {
        case "openai":
            return route.model.startsWith("gpt-");
        case "claude":
            return route.model.startsWith("claude-");
        case "gemini":
            return route.model.startsWith("gemini-");
        case "openrouter":
            return route.model.length > 0;
        case "deepseek":
            return route.model.startsWith("deepseek-");
        case "opencode-zen":
            return OPEN_CODE_ZEN_CHAT_MODELS.has(route.model);
        case "opencode-go":
            return OPEN_CODE_GO_CHAT_MODELS.has(route.model);
    }
}

export function modelRouteValidationError(route: ModelRoute): string | null {
    return isSupportedModelRoute(route)
        ? null
        : `Model ${route.model} cannot be executed through provider ${route.provider}`;
}

export function validateModelRoute(
    route: ModelRoute,
): ValidationResult<ModelRoute> {
    const detail = modelRouteValidationError(route);
    return detail ? { ok: false, detail } : { ok: true, value: route };
}

export function routesEqual(left: ModelRoute, right: ModelRoute): boolean {
    return (
        left.provider === right.provider &&
        left.model === right.model &&
        left.credential_ref === right.credential_ref
    );
}

export const CURATED_OPEN_CODE_MODELS = {
    "opencode-zen": Array.from(OPEN_CODE_ZEN_CHAT_MODELS),
    "opencode-go": Array.from(OPEN_CODE_GO_CHAT_MODELS),
} as const;
