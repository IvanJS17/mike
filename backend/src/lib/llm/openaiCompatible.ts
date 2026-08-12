import type {
    NormalizedToolCall,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";
import {
    isSupportedModelRoute,
    type GovernedLlmProvider,
    type ModelRoute,
} from "./routes";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const MAX_OUTPUT_TOKENS = 16384;

type ChatCompletionMessage =
    | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: unknown[] }
    | { role: "tool"; tool_call_id: string; content: string };

type ToolAccumulator = {
    id: string;
    name: string;
    arguments: string;
    raw: Record<string, unknown>;
};

function endpointForProvider(provider: GovernedLlmProvider): string {
    switch (provider) {
        case "openrouter":
            return "https://openrouter.ai/api/v1/chat/completions";
        case "deepseek":
            return "https://api.deepseek.com/chat/completions";
        case "opencode-zen":
            return "https://opencode.ai/zen/v1/chat/completions";
        case "opencode-go":
            return "https://opencode.ai/zen/go/v1/chat/completions";
        default:
            throw new Error(`Provider ${provider} is not OpenAI-compatible`);
    }
}

export function openAICompatibleEndpoint(route: ModelRoute): string {
    if (!isSupportedModelRoute(route)) {
        throw new Error(
            `Model ${route.model} cannot be executed through provider ${route.provider}`,
        );
    }
    return endpointForProvider(route.provider);
}

function abortError(): Error {
    const error = new Error("Stream aborted.");
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
}

function routeForParams(params: StreamChatParams): ModelRoute {
    if (!params.route) {
        throw new Error("An exact model route is required for this adapter");
    }
    if (params.route.model !== params.model) {
        throw new Error("Route model does not match the requested model");
    }
    return params.route;
}

function responseError(status: number, text: string): Error & { status: number } {
    const detail = text.trim().slice(0, 500);
    const error = new Error(
        `OpenAI-compatible request failed (${status}): ${detail || "upstream error"}`,
    ) as Error & { status: number };
    error.status = status;
    return error;
}

function baseMessages(params: StreamChatParams): ChatCompletionMessage[] {
    return [
        ...(params.systemPrompt
            ? [{ role: "system" as const, content: params.systemPrompt }]
            : []),
        ...params.messages.map((message) => ({
            role: message.role,
            content: message.content,
        })),
    ];
}

function parseToolArguments(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

async function readStreamingResponse(
    response: Response,
    params: StreamChatParams,
    iteration: number,
): Promise<{
    text: string;
    toolCalls: NormalizedToolCall[];
    rawToolCalls: Record<string, unknown>[];
}> {
    if (!response.body) throw new Error("OpenAI-compatible response had no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let sawReasoning = false;
    const tools = new Map<number, ToolAccumulator>();

    const handlePayload = (payload: unknown) => {
        logRawLlmStream({
            provider: params.route?.provider ?? "openai-compatible",
            model: params.model,
            iteration,
            label: "sse_event",
            payload,
        });
        if (!payload || typeof payload !== "object") return;
        const choice = (
            payload as {
                choices?: {
                    delta?: {
                        content?: unknown;
                        reasoning?: unknown;
                        reasoning_content?: unknown;
                        tool_calls?: unknown;
                    };
                }[];
            }
        ).choices?.[0];
        const delta = choice?.delta;
        if (!delta) return;
        if (typeof delta.content === "string") {
            text += delta.content;
            params.callbacks?.onContentDelta?.(delta.content);
        }
        const reasoning =
            typeof delta.reasoning === "string"
                ? delta.reasoning
                : typeof delta.reasoning_content === "string"
                  ? delta.reasoning_content
                  : "";
        if (reasoning) {
            sawReasoning = true;
            params.callbacks?.onReasoningDelta?.(reasoning);
        }
        if (!Array.isArray(delta.tool_calls)) return;
        for (const raw of delta.tool_calls) {
            if (!raw || typeof raw !== "object") continue;
            const call = raw as {
                index?: unknown;
                id?: unknown;
                function?: { name?: unknown; arguments?: unknown };
            };
            const index =
                typeof call.index === "number" && Number.isInteger(call.index)
                    ? call.index
                    : tools.size;
            const current = tools.get(index) ?? {
                id: typeof call.id === "string" ? call.id : `tool-${index}`,
                name: "",
                arguments: "",
                raw: {},
            };
            if (typeof call.id === "string" && call.id) current.id = call.id;
            if (typeof call.function?.name === "string") {
                current.name += call.function.name;
            }
            if (typeof call.function?.arguments === "string") {
                current.arguments += call.function.arguments;
            }
            tools.set(index, current);
        }
    };

    try {
        while (true) {
            throwIfAborted(params.abortSignal);
            const { done, value } = await reader.read();
            if (done) break;
            const decoded = decoder.decode(value, { stream: true });
            logRawLlmStream({
                provider: params.route?.provider ?? "openai-compatible",
                model: params.model,
                iteration,
                label: "sse_chunk",
                payload: decoded,
            });
            buffer += decoded;
            const chunks = buffer.split(/\r?\n\r?\n/);
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
                const data = chunk
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trim())
                    .join("");
                if (!data || data === "[DONE]") continue;
                try {
                    handlePayload(JSON.parse(data));
                } catch {
                    // A malformed provider event is ignored; the provider's
                    // next valid event still completes the turn.
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
    if (sawReasoning) params.callbacks?.onReasoningBlockEnd?.();

    const toolCalls: NormalizedToolCall[] = [];
    const rawToolCalls: Record<string, unknown>[] = [];
    for (const current of tools.values()) {
        const normalized: NormalizedToolCall = {
            id: current.id,
            name: current.name,
            input: parseToolArguments(current.arguments),
        };
        toolCalls.push(normalized);
        rawToolCalls.push({
            id: current.id,
            type: "function",
            function: {
                name: current.name,
                arguments: current.arguments || "{}",
            },
        });
    }
    return { text, toolCalls, rawToolCalls };
}

export async function streamOpenAICompatible(
    params: StreamChatParams,
    fetchImpl: typeof fetch = fetch,
): Promise<StreamChatResult> {
    const route = routeForParams(params);
    const url = openAICompatibleEndpoint(route);
    const secret = params.credentialSecret?.trim();
    if (!secret) throw new Error(`Credential ${route.credential_ref} is unavailable`);

    const messages = baseMessages(params);
    const tools = params.tools ?? [];
    let fullText = "";
    const maxIterations = params.maxIterations ?? 10;
    const recorder = createRawLlmStreamRecorder({
        provider: route.provider,
        model: route.model,
    });

    try {
        for (let iteration = 0; iteration < maxIterations; iteration++) {
            throwIfAborted(params.abortSignal);
            const response = await fetchImpl(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${secret}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: route.model,
                    messages,
                    tools: tools.length ? tools : undefined,
                    stream: true,
                    max_tokens: MAX_OUTPUT_TOKENS,
                }),
                signal: params.abortSignal,
            });
            if (!response.ok) {
                throw responseError(
                    response.status,
                    await response.text().catch(() => ""),
                );
            }

            const turn = await readStreamingResponse(response, params, iteration);
            fullText += turn.text;
            if (!turn.toolCalls.length || !params.runTools) break;
            for (const call of turn.toolCalls) {
                params.callbacks?.onToolCallStart?.(call);
            }
            const results = await params.runTools(turn.toolCalls);
            throwIfAborted(params.abortSignal);
            messages.push({
                role: "assistant",
                content: turn.text || null,
                tool_calls: turn.rawToolCalls,
            });
            for (const result of results) {
                messages.push({
                    role: "tool",
                    tool_call_id: result.tool_use_id,
                    content: result.content,
                });
            }
        }
        await recorder?.flush("completed");
        return { fullText };
    } catch (error) {
        await recorder?.flush("error", error);
        throw error;
    }
}

export async function completeOpenAICompatibleText(params: {
    route: ModelRoute;
    credentialSecret: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    fetchImpl?: typeof fetch;
}): Promise<string> {
    const url = openAICompatibleEndpoint(params.route);
    const response = await (params.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${params.credentialSecret}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: params.route.model,
            messages: [
                ...(params.systemPrompt
                    ? [{ role: "system", content: params.systemPrompt }]
                    : []),
                { role: "user", content: params.user },
            ],
            max_tokens: params.maxTokens ?? 512,
            stream: false,
        }),
    });
    if (!response.ok) {
        throw responseError(
            response.status,
            await response.text().catch(() => ""),
        );
    }
    const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
    };
    return typeof payload.choices?.[0]?.message?.content === "string"
        ? payload.choices[0].message.content
        : "";
}

export type { OpenAIToolSchema };
