import {
    isSupportedModelRoute,
    type GovernedLlmProvider,
    type ModelRoute,
} from "./routes";
import {
    CLAUDE_MAIN_MODELS,
    GEMINI_MAIN_MODELS,
    OPENAI_MAIN_MODELS,
} from "./models";

type CatalogEndpoint = {
    url: string;
    headers: Record<string, string>;
};

export type CatalogSource = "live" | "curated";

export type CatalogRoute = ModelRoute & {
    source: CatalogSource;
    availability: "catalog";
    catalog_available: true;
};

export type CatalogCredential = {
    provider: GovernedLlmProvider;
    credential_ref: string;
    secret: string;
};

export type ModelCatalog = {
    routes: CatalogRoute[];
    catalogs: {
        provider: GovernedLlmProvider;
        credential_ref: string;
        source: CatalogSource;
        catalog_available: boolean;
    }[];
};

const CURATED_MODELS: Record<GovernedLlmProvider, string[]> = {
    openai: [...OPENAI_MAIN_MODELS],
    claude: [...CLAUDE_MAIN_MODELS],
    gemini: [...GEMINI_MAIN_MODELS],
    openrouter: [
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "google/gemini-3-flash-preview",
    ],
    deepseek: ["deepseek-chat", "deepseek-reasoner"],
    "opencode-zen": [
        "deepseek-v4-flash",
        "kimi-k2.5",
        "glm-5",
        "big-pickle",
    ],
    "opencode-go": [
        "deepseek-v4-flash",
        "kimi-k2.6",
        "glm-5.1",
        "grok-4.5",
    ],
};

function liveCatalogEndpoint(
    provider: GovernedLlmProvider,
    secret: string,
): CatalogEndpoint | null {
    switch (provider) {
        case "openai":
            return {
                url: "https://api.openai.com/v1/models",
                headers: { Authorization: `Bearer ${secret}` },
            };
        case "gemini":
            return {
                url: "https://generativelanguage.googleapis.com/v1beta/models",
                headers: { "x-goog-api-key": secret },
            };
        case "openrouter":
            return {
                url: "https://openrouter.ai/api/v1/models",
                headers: { Authorization: `Bearer ${secret}` },
            };
        case "deepseek":
            return {
                url: "https://api.deepseek.com/models",
                headers: { Authorization: `Bearer ${secret}` },
            };
        case "opencode-zen":
            return {
                url: "https://opencode.ai/zen/v1/models",
                headers: { Authorization: `Bearer ${secret}` },
            };
        case "opencode-go":
            return {
                url: "https://opencode.ai/zen/go/v1/models",
                headers: { Authorization: `Bearer ${secret}` },
            };
        case "claude":
            return null;
    }
}

function modelIds(payload: unknown): string[] {
    if (!payload || typeof payload !== "object") return [];
    const record = payload as { data?: unknown; models?: unknown };
    const data = Array.isArray(record.data) ? record.data : record.models;
    if (!Array.isArray(data)) return [];
    return data.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (!item || typeof item !== "object") return [];
        const record = item as { id?: unknown; name?: unknown };
        const id = typeof record.id === "string" ? record.id : record.name;
        if (typeof id !== "string" || !id.trim()) return [];
        return [id.replace(/^models\//, "").trim()];
    });
}

export async function fetchLiveModelIds(
    provider: GovernedLlmProvider,
    secret: string,
    fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
    const endpoint = liveCatalogEndpoint(provider, secret);
    if (!endpoint) return null;
    try {
        const response = await fetchImpl(endpoint.url, {
            headers: endpoint.headers,
        });
        if (!response.ok) return null;
        return modelIds(await response.json());
    } catch {
        return null;
    }
}

export async function buildModelCatalog(
    credentials: CatalogCredential[],
    fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog> {
    const perCredential = await Promise.all(
        credentials.map(async (credential) => {
            const liveModels = await fetchLiveModelIds(
                credential.provider,
                credential.secret,
                fetchImpl,
            );
            const result = catalogRoutesWithFallback({
                provider: credential.provider,
                credential_ref: credential.credential_ref,
                liveModels,
                curatedModels: CURATED_MODELS[credential.provider],
            });
            return {
                routes: result.routes,
                catalog: {
                    provider: credential.provider,
                    credential_ref: credential.credential_ref,
                    source: result.source,
                    catalog_available: result.catalog_available,
                },
            };
        }),
    );

    return {
        routes: perCredential.flatMap((item) => item.routes),
        catalogs: perCredential.map((item) => item.catalog),
    };
}

export function catalogRoutesForModels(args: {
    provider: GovernedLlmProvider;
    credential_ref: string;
    models: string[];
    source: CatalogSource;
}): CatalogRoute[] {
    const seen = new Set<string>();
    const routes: CatalogRoute[] = [];
    for (const rawModel of args.models) {
        const model = rawModel.trim();
        if (!model || seen.has(model)) continue;
        const route: ModelRoute = {
            provider: args.provider,
            model,
            credential_ref: args.credential_ref,
        };
        if (!isSupportedModelRoute(route)) continue;
        seen.add(model);
        routes.push({
            ...route,
            source: args.source,
            availability: "catalog",
            catalog_available: true,
        });
    }
    return routes;
}

export function catalogRoutesWithFallback(args: {
    provider: GovernedLlmProvider;
    credential_ref: string;
    liveModels: string[] | null;
    curatedModels: string[];
}): {
    routes: CatalogRoute[];
    source: CatalogSource;
    catalog_available: boolean;
} {
    const liveSucceeded = args.liveModels !== null;
    const source: CatalogSource = liveSucceeded ? "live" : "curated";
    const models = args.liveModels === null ? args.curatedModels : args.liveModels;
    return {
        routes: catalogRoutesForModels({
            provider: args.provider,
            credential_ref: args.credential_ref,
            models,
            source,
        }),
        source,
        catalog_available: liveSucceeded,
    };
}
