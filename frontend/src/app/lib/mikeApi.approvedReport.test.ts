import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./mikeApi";

afterEach(() => vi.unstubAllGlobals());

describe("approved report producer client", () => {
  it("requests a committed report without supplying artifact authority", async () => {
    expect(api.createApprovedReviewReport).toBeTypeOf("function");
    const payload = {
      export_id: "00000000-0000-4000-8000-000000000011",
      artifact: { review_revision: 1 },
      receipt: { disposition: "applied" },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      api.createApprovedReviewReport(
        "project/id",
        "execution?id",
        1,
        "report:key",
      ),
    ).resolves.toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/projects/project%2Fid/ai-executions/execution%3Fid/review/approved-report",
    );
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body as string)).toEqual({
      expected_review_revision: 1,
      idempotency_key: "report:key",
    });
  });
});
