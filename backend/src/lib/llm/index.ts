import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import {
    streamOpenAICompatible,
    completeOpenAICompatibleText,
} from "./openaiCompatible";
import { streamOllama, completeOllamaText } from "./ollama";
import { providerForModel } from "./models";
import { isSupportedModelRoute, type ModelRoute } from "./routes";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";
export * from "./routes";
export * from "./catalog";
export * from "./openaiCompatible";

export type LlmAdapterKind =
    | "native-openai"
    | "native-claude"
    | "native-gemini"
    | "openai-compatible";

export function adapterForRoute(route: ModelRoute): LlmAdapterKind {
    if (!isSupportedModelRoute(route)) {
        throw new Error(
            `Model ${route.model} cannot be executed through provider ${route.provider}`,
        );
    }
    if (
        route.provider === "openrouter" ||
        route.provider === "deepseek" ||
        route.provider === "opencode-zen" ||
        route.provider === "opencode-go"
    ) {
        return "openai-compatible";
    }
    if (route.provider === "openai") return "native-openai";
    if (route.provider === "claude") return "native-claude";
    return "native-gemini";
}

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    if (params.route) {
        const route = params.route;
        const routedParams = {
            ...params,
            model: route.model,
            apiKeys: params.credentialSecret
                ? {
                      ...params.apiKeys,
                      [route.provider]: params.credentialSecret,
                  }
                : params.apiKeys,
        };
        const adapter = adapterForRoute(route);
        if (adapter === "openai-compatible") {
            return streamOpenAICompatible(routedParams);
        }
        if (adapter === "native-openai") return streamOpenAI(routedParams);
        if (adapter === "native-claude") return streamClaude(routedParams);
        return streamGemini(routedParams);
    }
    const provider = providerForModel(params.model);
    if (provider === "claude") return streamClaude(params);
    if (provider === "openai") return streamOpenAI(params);
    if (provider === "ollama") return streamOllama(params);
    return streamGemini(params);
}

export async function completeText(params: {
    model: string;
    route?: ModelRoute;
    credentialSecret?: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    if (params.route) {
        const route = params.route;
        const apiKeys = params.credentialSecret
            ? {
                  ...params.apiKeys,
                  [route.provider]: params.credentialSecret,
              }
            : params.apiKeys;
        const adapter = adapterForRoute(route);
        if (adapter === "openai-compatible") {
            return completeOpenAICompatibleText({
                route,
                credentialSecret: params.credentialSecret ?? "",
                systemPrompt: params.systemPrompt,
                user: params.user,
                maxTokens: params.maxTokens,
            });
        }
        const nativeParams = { ...params, model: route.model, apiKeys };
        if (adapter === "native-openai") return completeOpenAIText(nativeParams);
        if (adapter === "native-claude") return completeClaudeText(nativeParams);
        return completeGeminiText(nativeParams);
    }
    const provider = providerForModel(params.model);
    if (provider === "claude") return completeClaudeText(params);
    if (provider === "openai") return completeOpenAIText(params);
    if (provider === "ollama") return completeOllamaText(params);
    return completeGeminiText(params);
}
