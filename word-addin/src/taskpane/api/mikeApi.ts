/// <reference types="office-js" />
/**
 * Configured @mike/api-client barrel for the Word add-in — the single place the
 * shared typed client is wired to the add-in's Office session. Mirrors
 * apps/web/src/app/lib/mikeApi.ts, but its auth comes from ../auth/session
 * (OfficeRuntime.storage-backed) instead of Supabase's browser SDK.
 *
 * Components import API functions FROM THIS MODULE (not from "@mike/api-client"
 * directly) so that importing any of them runs the side-effecting
 * configureMikeApiClient() below before the first request leaves.
 */
import { configureMikeApiClient } from "@mike/api-client";
import type { Document } from "@mike/core";
import type {
  ApprovedRedlineBundle,
  RedlineExecutionScope,
} from "../lib/redline";
import { getFreshAccessToken, refreshSession } from "../auth/session";

// Guard the `process` reference: webpack's EnvironmentPlugin only substitutes
// registered vars, and a stale dev server can leave a literal `process.env...`
// that throws "process is not defined" in the browser — the typeof guard
// short-circuits before touching `process`, falling back safely.
const BASE_URL: string =
  (typeof process !== "undefined" && process.env.REACT_APP_API_BASE_URL) ||
  "http://localhost:3001";

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getFreshAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Reactive 401 recovery in ONE place (replaces the old client.ts replay): if a
// request is rejected, refresh the session once and replay with the new token.
const fetchWithRefresh: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;
  const refreshed = await refreshSession();
  if (!refreshed) return res; // refresh failed → session cleared → surfaces 401
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  headers.set("Authorization", `Bearer ${refreshed}`);
  return fetch(input, { ...init, headers });
};

configureMikeApiClient({
  baseUrl: BASE_URL,
  getAuthHeaders,
  fetchImpl: fetchWithRefresh,
});

export * from "@mike/api-client";

/**
 * List a project's documents (GET /projects/:id/documents). @mike/api-client
 * exposes no wrapper for this endpoint (the web app reads project.documents off
 * GET /projects/:id instead), so this thin helper reuses the SAME configured
 * auth + 401-refresh transport as the rest of the client rather than
 * re-declaring a bespoke HTTP layer — and keeps the add-in on the exact same
 * endpoint it has always called.
 */
export async function listProjectDocuments(
  projectId: string
): Promise<Document[]> {
  const res = await fetchWithRefresh(
    `${BASE_URL}/projects/${projectId}/documents`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...(await getAuthHeaders()) },
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET /projects/${projectId}/documents failed (${res.status}): ${body}`
    );
  }
  return res.json() as Promise<Document[]>;
}

export type AiExecutionSummary = RedlineExecutionScope & {
  status: "pending" | "running" | "succeeded" | "failed";
  error_class: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
};

export class WordAddinApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "WordAddinApiError";
    this.status = status;
    this.code = code;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetchWithRefresh(`${BASE_URL}${path}`, {
    cache: "no-store",
    headers: { Accept: "application/json", ...(await getAuthHeaders()) },
  });
  if (res.ok) return (await res.json()) as T;

  const body = await res.text().catch(() => "");
  let code: string | null = null;
  let detail: string | null = null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown; detail?: unknown };
    code = typeof parsed.code === "string" ? parsed.code : null;
    detail = typeof parsed.detail === "string" ? parsed.detail : null;
  } catch {
    // Keep error text out of the task pane when the server did not return its
    // structured, content-free error contract.
  }
  throw new WordAddinApiError(
    res.status,
    detail ?? `Mike API request failed (${res.status}).`,
    code
  );
}

export async function listAiExecutions(
  projectId: string
): Promise<AiExecutionSummary[]> {
  return getJson<AiExecutionSummary[]>(
    `/projects/${encodeURIComponent(projectId)}/ai-executions`
  );
}

export async function getApprovedRedlineBundle(
  projectId: string,
  executionId: string,
  revision = 1
): Promise<ApprovedRedlineBundle> {
  return getJson<ApprovedRedlineBundle>(
    `/projects/${encodeURIComponent(projectId)}/ai-executions/${encodeURIComponent(
      executionId
    )}/review/redline-bundle?revision=${revision}`
  );
}
