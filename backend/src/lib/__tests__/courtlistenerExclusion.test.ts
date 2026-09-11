import { afterEach, describe, expect, it, vi } from "vitest";
import { runToolCalls } from "../chat/tools/toolDispatcher";
import { buildMessages } from "../chat/contextBuilders";

const removedTools = [
  ["courtlistener_search_case_law", { query: "contract" }],
  ["courtlistener_get_cases", { cluster_ids: [123] }],
  ["courtlistener_find_in_case", { cluster_id: 123, query: "contract" }],
  ["courtlistener_read_case", { cluster_id: 123 }],
  ["courtlistener_verify_citations", { citations: ["410 U.S. 113"] }],
] as const;

describe("CourtListener execution exclusion", () => {
  it("preserves filename spotlighting with the document-only nonce argument", () => {
    const messages = buildMessages([], [{ doc_id: "doc-0", filename: "synthetic.docx" }],
      undefined, undefined, "exclusion-nonce");
    expect(JSON.stringify(messages)).toContain("exclusion-nonce");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(removedTools)("%s cannot fetch or produce research output", async (name, args) => {
    vi.stubEnv("COURTLISTENER_API_TOKEN", "exclusion-test-token");
    const fetch = vi.fn().mockRejectedValue(new Error("Network forbidden in exclusion test"));
    vi.stubGlobal("fetch", fetch);
    const write = vi.fn();
    const result = await runToolCalls(
      [{ id: "removed-tool", function: { name, arguments: JSON.stringify(args) } }],
      new Map(), "user-1", {} as never, write,
    );
    expect.soft(fetch).not.toHaveBeenCalled();
    expect.soft(write).not.toHaveBeenCalled();
    expect.soft(result.toolResults).toEqual([]);
    expect.soft(result).not.toHaveProperty("courtlistenerEvents");
    expect.soft(result).not.toHaveProperty("caseCitationEvents");
  });
});
