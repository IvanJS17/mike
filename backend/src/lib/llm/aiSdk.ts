import type { LanguageModel, ToolSet } from "ai" with {
  "resolution-mode": "import",
};
import type * as AiSdk from "ai" with { "resolution-mode": "import" };
import type {
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  Provider,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const MAX_OUTPUT_TOKENS = 16_384;

/** Ensure a proxy-closed final SSE event is still visible to SDK parsers. */
export async function aiSdkFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    return response;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const partials = new Map<number, { name: string; arguments: string }>();

  const validateToolCalls = (endedCleanly: boolean) => {
    for (const partial of partials.values()) {
      if (!partial.arguments) {
        if (!endedCleanly) {
          throw new Error(
            `LLM stream ended before any arguments arrived for tool "${partial.name}".`,
          );
        }
        continue;
      }
      try {
        JSON.parse(partial.arguments);
      } catch {
        throw new Error(
          `LLM stream ended with malformed JSON arguments for tool "${partial.name}".`,
        );
      }
    }
    partials.clear();
  };

  const inspectLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      validateToolCalls(true);
      return;
    }
    if (!data) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const choice = (
      event.choices as
        | Array<{
            delta?: { tool_calls?: Array<Record<string, unknown>> };
            finish_reason?: unknown;
          }>
        | undefined
    )?.[0];
    for (const toolCall of choice?.delta?.tool_calls ?? []) {
      const index = typeof toolCall.index === "number" ? toolCall.index : 0;
      const current = partials.get(index) ?? { name: "tool", arguments: "" };
      const fn = toolCall.function as Record<string, unknown> | undefined;
      if (typeof fn?.name === "string") current.name = fn.name;
      if (typeof fn?.arguments === "string") {
        current.arguments += fn.arguments;
      }
      partials.set(index, current);
    }
    if (choice?.finish_reason === "tool_calls") validateToolCalls(true);
  };

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          inspectLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) inspectLine(buffer);
        if (partials.size) validateToolCalls(false);
        controller.enqueue(new Uint8Array([10, 10]));
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export type AiSdkAdapterConfig = {
  provider: Provider;
  label: string;
  model: LanguageModel;
  modelId: string;
  /** Some protocol-compatible gateways reject reasoning request fields. */
  supportsReasoning?: boolean;
};

type PendingToolExecution = {
  call: NormalizedToolCall;
  resolve: (content: string) => void;
  reject: (error: unknown) => void;
};

/**
 * AI SDK executes all tool calls from a step concurrently. Collect those
 * same-tick executions so the existing provider-neutral runTools contract
 * still receives one batch per model step.
 */
class ToolExecutionBatcher {
  private pending: PendingToolExecution[] = [];
  private scheduled = false;

  constructor(
    private readonly runTools: NonNullable<StreamChatParams["runTools"]>,
  ) {}

  execute(call: NormalizedToolCall): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending.push({ call, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    this.scheduled = false;

    try {
      const results = await this.runTools(pending.map(({ call }) => call));
      const byId = new Map(
        results.map((result: NormalizedToolResult) => [
          result.tool_use_id,
          result.content,
        ]),
      );
      for (const item of pending) {
        const content = byId.get(item.call.id);
        if (content === undefined) {
          item.reject(
            new Error(
              `Tool ${item.call.name} returned no result for call ${item.call.id}.`,
            ),
          );
        } else {
          item.resolve(content);
        }
      }
    } catch (error) {
      for (const item of pending) item.reject(error);
    }
  }
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function toAiSdkTools(
  schemas: OpenAIToolSchema[],
  runTools?: StreamChatParams["runTools"],
  sdk?: Pick<typeof AiSdk, "jsonSchema" | "tool">,
): ToolSet | undefined {
  if (!schemas.length) return undefined;
  if (!sdk) throw new Error("AI SDK tool helpers are unavailable.");
  const batcher = runTools ? new ToolExecutionBatcher(runTools) : null;

  return Object.fromEntries(
    schemas.map((schema) => {
      const definition = {
        description: schema.function.description,
        inputSchema: sdk.jsonSchema<Record<string, unknown>>(
          schema.function.parameters as never,
        ),
        ...(batcher
          ? {
              execute: (
                input: Record<string, unknown>,
                { toolCallId }: { toolCallId: string },
              ) =>
                batcher.execute({
                  id: toolCallId,
                  name: schema.function.name,
                  input: normalizeToolInput(input),
                }),
            }
          : {}),
      };
      return [schema.function.name, sdk.tool(definition as never)];
    }),
  );
}

function errorMessage(error: unknown, label: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return `${label} stream failed.`;
}

export async function streamAiSdk(
  params: StreamChatParams,
  config: AiSdkAdapterConfig,
): Promise<StreamChatResult> {
  const sdk = await import("ai");
  const tools = toAiSdkTools(params.tools ?? [], params.runTools, sdk);
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: config.provider,
    model: config.modelId,
  });
  let fullText = "";
  let iteration = 0;
  const openReasoningBlocks = new Set<string>();

  try {
    const result = sdk.streamText({
      model: config.model,
      system: params.systemPrompt,
      messages: params.messages,
      tools,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stopWhen: sdk.stepCountIs(params.maxIterations ?? 10),
      abortSignal: params.abortSignal,
      reasoning:
        config.supportsReasoning === false
          ? undefined
          : // The OpenAI adapter and API support `max`, while AI SDK Core 7's
            // shared call-options type still omits it. Preserve the runtime
            // value across that temporary upstream type mismatch.
            ((params.reasoning ?? "none") as
              | "provider-default"
              | Exclude<NonNullable<StreamChatParams["reasoning"]>, "max">
              | undefined),
      include: { rawChunks: true },
    });

    for await (const part of result.stream) {
      switch (part.type) {
        case "start-step":
          iteration += 1;
          break;
        case "raw":
          logRawLlmStream({
            provider: config.provider,
            model: config.modelId,
            iteration: Math.max(0, iteration - 1),
            label: "ai_sdk_raw",
            payload: part.rawValue,
          });
          rawStreamRecorder?.record({
            iteration: Math.max(0, iteration - 1),
            label: "ai_sdk_raw",
            payload: part.rawValue,
          });
          break;
        case "text-delta":
          fullText += part.text;
          params.callbacks?.onContentDelta?.(part.text);
          break;
        case "reasoning-start":
          openReasoningBlocks.add(part.id);
          break;
        case "reasoning-delta":
          openReasoningBlocks.add(part.id);
          params.callbacks?.onReasoningDelta?.(part.text);
          break;
        case "reasoning-end":
          if (openReasoningBlocks.delete(part.id)) {
            params.callbacks?.onReasoningBlockEnd?.();
          }
          break;
        case "tool-call": {
          const call: NormalizedToolCall = {
            id: part.toolCallId,
            name: part.toolName,
            input: normalizeToolInput(part.input),
          };
          params.callbacks?.onToolCallStart?.(call);
          break;
        }
        case "tool-error":
          throw new Error(errorMessage(part.error, config.label));
        case "error":
          throw new Error(errorMessage(part.error, config.label));
        case "abort": {
          const error = new Error(part.reason || "Stream aborted.");
          error.name = "AbortError";
          throw error;
        }
      }
    }

    for (const id of openReasoningBlocks) {
      openReasoningBlocks.delete(id);
      params.callbacks?.onReasoningBlockEnd?.();
    }
    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    throw error;
  }
}

export async function completeAiSdkText(
  params: {
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
  },
  config: AiSdkAdapterConfig,
): Promise<string> {
  const { generateText } = await import("ai");
  const result = await generateText({
    model: config.model,
    system: params.systemPrompt,
    prompt: params.user,
    maxOutputTokens: params.maxTokens ?? 512,
    reasoning: config.supportsReasoning === false ? undefined : "none",
  });
  return result.text;
}
