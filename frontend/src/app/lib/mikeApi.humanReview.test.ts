import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./mikeApi";

afterEach(() => vi.unstubAllGlobals());

describe("persisted human review client", () => {
  it("reads the authoritative review without accepting client authority", async () => {
    expect(api).toHaveProperty("getHumanReviewState");
    const payload = {
      review_id: "review-id", revision: 3, execution_id: "execution?id",
      project_id: "project/id", matter_id: "matter-id", organization_id: "org-id",
      document_id: "document-id", document_version_id: "version-id",
      document_content_sha256: "a".repeat(64), evidence_receipt_sha256: "b".repeat(64),
      execution_author_user_id: "author-id", reviewer_user_id: "reviewer-id",
      status: "approved", items: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.getHumanReviewState("project/id", "execution?id")).resolves.toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/project%2Fid/ai-executions/execution%3Fid/review");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBeUndefined();
    expect(init.method ?? "GET").toBe("GET");
  });
});
