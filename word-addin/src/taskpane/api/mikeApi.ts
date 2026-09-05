/// <reference types="office-js" />
/**
 * Configured API barrel for the Word add-in — the single place the typed client
 * is wired to the add-in's backend-managed cookie session. Mirrors
 * frontend/src/app/lib/mikeApi.ts, with auth state synchronized by
 * ../auth/session.
 *
 * Components import API functions FROM THIS MODULE (not from the base client
 * directly) so that importing any of them runs the side-effecting
 * configureMikeApiClient() below before the first request leaves.
 */
import { configureMikeApiClient } from "./client";
import type { Chat, Document, Message, WordDocumentEdit } from "../types";
import { refreshSession } from "../auth/session";
import {
  assistantContentFromEvents,
  normalizeStoredAssistantEvents,
} from "../lib/wordChatEvents";
import type { PersistedWordEditPatch } from "../lib/wordChatTypes";

// EnvironmentPlugin substitutes this exact expression at bundle time. Do NOT
// guard it with `typeof process`: the browser has no `process` global, so the
// guard is false at runtime and silently selects the fallback below — which is
// plain HTTP, and Word's HTTPS pane blocks it as mixed content ("Load failed").
// Node tooling that imports this outside webpack has a real `process` anyway.
const BASE_URL: string = process.env.REACT_APP_API_BASE_URL || "/api";

async function getAuthHeaders(): Promise<Record<string, string>> {
  return {};
}

// The backend refreshes HttpOnly sessions before API handlers run. A 401 means
// the session can no longer be refreshed; synchronize the login gate and leave
// the original response intact for the caller.
const fetchWithRefresh: typeof fetch = async (input, init) => {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (res.status !== 401) return res;
  await refreshSession().catch(() => null);
  return res;
};

configureMikeApiClient({
  baseUrl: BASE_URL,
  getAuthHeaders,
  fetchImpl: fetchWithRefresh,
});

export {
  createQuickAction,
  createWorkflow,
  deleteWorkflow,
  deleteWorkflowReferenceFile,
  getApiKeyStatus,
  getLibrary,
  getLibraryFolderChildren,
  getProjectDirectoryLevel,
  getUserProfile,
  getWorkflowReferenceUrl,
  listProjects,
  listQuickActions,
  listWorkflowReferenceFiles,
  listWorkflows,
  postWordChatToolResult,
  readSSE,
  replaceWorkflowReferenceFile,
  streamWordChat,
  updateLastSelectedChatModel,
  updateLastSelectedReasoningLevel,
  updateWorkflow,
  updateQuickAction,
  uploadWorkflowReferenceFile,
  uploadStandaloneDocument,
} from "./client";
export type { ApiKeyStatus } from "./client";

export type AiExecutionSummary = {
  id: string;
  project_id: string;
  matter_id: string;
  document_id: string;
  document_version_id: string;
  document_content_sha256: string;
  status: "pending" | "running" | "succeeded" | "failed";
  error_class: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export class WordAddinApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(args: { message: string; status: number; code?: string | null }) {
    super(args.message);
    this.name = "WordAddinApiError";
    this.status = args.status;
    this.code = args.code ?? null;
  }
}

const AI_EXECUTION_SUMMARY_KEYS = [
  "id",
  "project_id",
  "matter_id",
  "document_id",
  "document_version_id",
  "document_content_sha256",
  "status",
  "error_class",
  "created_at",
  "started_at",
  "finished_at",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim() !== "");
}

function isCanonicalId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function isAiExecutionSummary(
  value: unknown,
  projectId: string,
): value is AiExecutionSummary {
  if (!isRecord(value) || !hasExactKeys(value, AI_EXECUTION_SUMMARY_KEYS)) {
    return false;
  }
  return (
    isCanonicalId(value.id) &&
    value.project_id === projectId &&
    isCanonicalId(value.matter_id) &&
    isCanonicalId(value.document_id) &&
    isCanonicalId(value.document_version_id) &&
    typeof value.document_content_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.document_content_sha256) &&
    (value.status === "pending" ||
      value.status === "running" ||
      value.status === "succeeded" ||
      value.status === "failed") &&
    isNullableString(value.error_class) &&
    typeof value.created_at === "string" &&
    value.created_at.trim() !== "" &&
    isNullableString(value.started_at) &&
    isNullableString(value.finished_at)
  );
}

function requireNonBlankId(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new WordAddinApiError({
      status: 400,
      code: "invalid_request",
      message: `${name} is required.`,
    });
  }
}

async function throwAiApiError(response: Response): Promise<never> {
  let code: string | null = null;
  let detail: string | null = null;
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      code = typeof body.code === "string" ? body.code : null;
      detail = typeof body.detail === "string" ? body.detail : null;
    }
  } catch {
    // Non-JSON responses are intentionally reduced to the generic error.
  }
  throw new WordAddinApiError({
    status: response.status,
    code,
    message: detail || `API error: ${response.status}`,
  });
}

export async function listAiExecutions(
  projectId: string,
): Promise<AiExecutionSummary[]> {
  requireNonBlankId(projectId, "projectId");
  const response = await fetchWithRefresh(
    `${BASE_URL}/projects/${encodeURIComponent(projectId)}/ai-executions`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...(await getAuthHeaders()) },
    },
  );
  if (!response.ok) await throwAiApiError(response);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WordAddinApiError({
      status: 502,
      code: "invalid_response",
      message: "Invalid API response.",
    });
  }
  if (
    !Array.isArray(body) ||
    !body.every((item) => isAiExecutionSummary(item, projectId))
  ) {
    throw new WordAddinApiError({
      status: 502,
      code: "invalid_response",
      message: "Invalid API response.",
    });
  }
  return body;
}

export async function getApprovedRedlineBundle(
  projectId: string,
  executionId: string,
  revision = 1,
): Promise<unknown> {
  requireNonBlankId(projectId, "projectId");
  requireNonBlankId(executionId, "executionId");
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new WordAddinApiError({
      status: 400,
      code: "invalid_request",
      message: "revision must be a positive safe integer.",
    });
  }
  const response = await fetchWithRefresh(
    `${BASE_URL}/projects/${encodeURIComponent(projectId)}/ai-executions/${encodeURIComponent(executionId)}/review/redline-bundle?revision=${revision}`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...(await getAuthHeaders()) },
    },
  );
  if (!response.ok) await throwAiApiError(response);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new WordAddinApiError({
      status: 502,
      code: "invalid_response",
      message: "Invalid API response.",
    });
  }
}

/**
 * List a project's documents (GET /projects/:id/documents). The base client
 * exposes no wrapper for this endpoint (the web app reads project.documents off
 * GET /projects/:id instead), so this thin helper reuses the SAME configured
 * auth + 401-refresh transport as the rest of the client rather than
 * re-declaring a bespoke HTTP layer — and keeps the add-in on the exact same
 * endpoint it has always called.
 */
export async function listProjectDocuments(
  projectId: string,
): Promise<Document[]> {
  const res = await fetchWithRefresh(
    `${BASE_URL}/projects/${projectId}/documents`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...(await getAuthHeaders()) },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET /projects/${projectId}/documents failed (${res.status}): ${body}`,
    );
  }
  return res.json() as Promise<Document[]>;
}

interface OllamaModelOption {
  id: string;
  label: string;
  group: "Local";
}

/** Dynamic local-model list used by the add-in's frontend-style model toggle. */
export async function getOllamaModels(): Promise<OllamaModelOption[]> {
  const res = await fetchWithRefresh(`${BASE_URL}/models/ollama`, {
    cache: "no-store",
    headers: { Accept: "application/json", ...(await getAuthHeaders()) },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { models?: OllamaModelOption[] };
  return body.models ?? [];
}

interface WordChatServerMessage {
  id: string;
  role: "user" | "assistant";
  content: string | unknown[] | null;
  files?: { filename: string; document_id?: string }[] | null;
  workflow?: { id: string; title: string } | null;
  citations?: unknown;
  edits?: unknown;
}

function normalizeWordCitations(value: unknown): Message["citations"] {
  if (!Array.isArray(value)) return undefined;
  const citations = value.filter(
    (candidate): candidate is NonNullable<Message["citations"]>[number] =>
      !!candidate && typeof candidate === "object" && !Array.isArray(candidate),
  );
  return citations.length > 0 ? citations : undefined;
}

function normalizeWordDocumentEdits(value: unknown): WordDocumentEdit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): WordDocumentEdit[] => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return [];
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.word_chat_message_id !== "string" ||
      typeof row.block_index !== "number" ||
      typeof row.original_text !== "string" ||
      typeof row.replacement_text !== "string" ||
      (row.apply_mode !== "direct" && row.apply_mode !== "approval") ||
      (row.apply_status !== "proposed" &&
        row.apply_status !== "applied" &&
        row.apply_status !== "unmanaged" &&
        row.apply_status !== "failed")
    ) {
      return [];
    }
    const formats = Array.isArray(row.formats)
      ? row.formats.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return [
      {
        id: row.id,
        messageId: row.word_chat_message_id,
        blockIndex: row.block_index,
        originalText: row.original_text,
        replacementText: row.replacement_text,
        formats,
        ...(row.occurrence === "all" ? { occurrence: "all" as const } : {}),
        ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
        applyMode: row.apply_mode,
        applyStatus: row.apply_status,
        ...(row.resolution_status === "accepted" ||
        row.resolution_status === "rejected"
          ? { resolutionStatus: row.resolution_status }
          : {}),
        ...(typeof row.matched_occurrences === "number"
          ? { matchedOccurrences: row.matched_occurrences }
          : {}),
        ...(typeof row.applied_occurrences === "number"
          ? { appliedOccurrences: row.applied_occurrences }
          : {}),
        ...(typeof row.error_code === "string"
          ? { errorCode: row.error_code }
          : {}),
        ...(typeof row.error_message === "string"
          ? { errorMessage: row.error_message }
          : {}),
      },
    ];
  });
}

async function throwWordChatResponseError(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = await response.text().catch(() => "");
  throw new Error(body || `${fallback} (${response.status}).`);
}

export async function listCloudWordChats(
  documentId: string,
  limit: number,
  offset = 0,
  signal?: AbortSignal,
): Promise<Chat[]> {
  const params = new URLSearchParams({
    document_id: documentId,
    limit: String(limit),
    offset: String(offset),
  });
  const res = await fetchWithRefresh(`${BASE_URL}/word-chat?${params}`, {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json", ...(await getAuthHeaders()) },
  });
  if (!res.ok) {
    await throwWordChatResponseError(res, "Failed to load Word chats");
  }
  return res.json() as Promise<Chat[]>;
}

export async function getCloudWordChat(
  documentId: string,
  chatId: string,
): Promise<{ chat: Chat; messages: Message[] }> {
  const params = new URLSearchParams({ document_id: documentId });
  const res = await fetchWithRefresh(
    `${BASE_URL}/word-chat/${encodeURIComponent(chatId)}?${params}`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...(await getAuthHeaders()) },
    },
  );
  if (!res.ok) {
    await throwWordChatResponseError(res, "Failed to open Word chat");
  }
  const raw = (await res.json()) as {
    chat: Chat;
    messages: WordChatServerMessage[];
  };
  return {
    chat: raw.chat,
    messages: raw.messages.map((message): Message => {
      if (message.role === "user") {
        return {
          id: message.id,
          role: "user",
          content: typeof message.content === "string" ? message.content : "",
          files: message.files ?? undefined,
          workflow: message.workflow ?? undefined,
        };
      }
      const events = normalizeStoredAssistantEvents(message.content);
      const edits = normalizeWordDocumentEdits(message.edits);
      return {
        id: message.id,
        role: "assistant",
        content: assistantContentFromEvents(events),
        events,
        edits: edits.length > 0 ? edits : undefined,
        citations: normalizeWordCitations(message.citations),
      };
    }),
  };
}

export async function updateCloudWordChatModel(
  documentId: string,
  chatId: string,
  model: string,
): Promise<void> {
  const params = new URLSearchParams({ document_id: documentId });
  const res = await fetchWithRefresh(
    `${BASE_URL}/word-chat/${encodeURIComponent(chatId)}/model?${params}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify({ model }),
      keepalive: true,
    },
  );
  if (!res.ok) {
    await throwWordChatResponseError(res, "Failed to save Word chat model");
  }
}

export async function updateCloudWordChatReasoning(
  documentId: string,
  chatId: string,
  reasoningLevel: import("../lib/wordChatTypes").ReasoningLevel,
): Promise<void> {
  const params = new URLSearchParams({ document_id: documentId });
  const res = await fetchWithRefresh(
    `${BASE_URL}/word-chat/${encodeURIComponent(chatId)}/reasoning?${params}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify({ reasoningLevel }),
      keepalive: true,
    },
  );
  if (!res.ok) {
    await throwWordChatResponseError(res, "Failed to save reasoning level");
  }
}

export async function createCloudWordDocumentEdit(args: {
  documentId: string;
  messageId: string;
  blockIndex: number;
  originalText: string;
  replacementText: string;
  formats: string[];
  occurrence?: "all";
  reason?: string;
  applyMode: "direct" | "approval";
}): Promise<WordDocumentEdit> {
  const params = new URLSearchParams({ document_id: args.documentId });
  const res = await fetchWithRefresh(
    `${BASE_URL}/word-chat/messages/${encodeURIComponent(args.messageId)}/edits/${args.blockIndex}?${params}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify({
        original_text: args.originalText,
        replacement_text: args.replacementText,
        formats: args.formats,
        occurrence: args.occurrence ?? null,
        reason: args.reason ?? null,
        apply_mode: args.applyMode,
      }),
      keepalive: true,
    },
  );
  if (!res.ok) {
    await throwWordChatResponseError(res, "Failed to save Word edit");
  }
  const edits = normalizeWordDocumentEdits([await res.json()]);
  const edit = edits[0];
  if (!edit) throw new Error("Word edit response was invalid.");
  return edit;
}

export async function updateCloudWordDocumentEdit(args: {
  documentId: string;
  messageId: string;
  blockIndex: number;
  patch: PersistedWordEditPatch;
}): Promise<void> {
  const params = new URLSearchParams({ document_id: args.documentId });
  const res = await fetchWithRefresh(
    `${BASE_URL}/word-chat/messages/${encodeURIComponent(args.messageId)}/edits/${args.blockIndex}?${params}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify(args.patch),
      keepalive: true,
    },
  );
  if (!res.ok) {
    await throwWordChatResponseError(res, "Failed to update Word edit");
  }
}
