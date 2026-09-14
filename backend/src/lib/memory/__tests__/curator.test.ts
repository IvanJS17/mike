/**
 * LiTT (S5b/A4): curator behaviour at the process seam.
 *
 * Ported from the upstream `scope-bound memory curator tool` describe, adapted
 * to LiTT's `runMemoryCuratorScope(args, services?)` seam (the per-run governed
 * default is built in `curator.ts`), plus the LiTT-only terminal branch: a
 * governed-egress block fails the consolidation without retrying.
 */
import { describe, expect, it, vi } from "vitest";
import type { StreamChatParams } from "../../llm";
import {
  handleMemoryConsolidation,
  MEMORY_CURATOR_WRITE_TOOL,
  runMemoryCuratorScope,
  type CuratorScopeServices,
  type MemoryCuratorStoredMessage,
} from "../curator";
import {
  ensureMemoryFile,
  getMemoryCurrent,
  type MemoryCurrent,
  type MemoryFileRow,
} from "../files";
import { ensureChatAccess } from "../../access";
import { createGovernedCuratorStream } from "../curatorEgress";
import type { DbJob } from "../../dbq/types";

vi.mock("../../access", () => ({
  checkProjectAccess: vi.fn(),
  ensureChatAccess: vi.fn(async () => ({ ok: true })),
  ensureReviewAccess: vi.fn(async () => ({ ok: true })),
  projectHasSharedAudience: vi.fn(async () => false),
}));

vi.mock("../../userSettings", () => ({
  getUserModelSettings: vi.fn(async () => ({
    last_selected_chat_model: "openai:gpt-test",
    api_keys: {},
    memory_curator_model: null,
  })),
}));

vi.mock("../../modelSelection", () => ({
  resolveEffectiveChatModel: vi.fn(async () => ({
    ok: true,
    model: "openai:gpt-test",
  })),
}));

vi.mock("../files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../files")>();
  return {
    ...actual,
    ensureMemoryFile: vi.fn(),
    getMemoryCurrent: vi.fn(),
  };
});

vi.mock("../curatorEgress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../curatorEgress")>();
  return {
    ...actual,
    createGovernedCuratorStream: vi.fn(
      () => async (): Promise<never> => {
        throw new actual.MemoryCuratorEgressBlockedError(
          "real_provider_egress_blocked",
          "real provider host is not allowlisted",
        );
      },
    ),
  };
});

function memoryFile(scope: "user" | "project" = "user"): MemoryFileRow {
  return {
    id: "memory-file",
    scope,
    user_id: scope === "user" ? "actor" : null,
    project_id: scope === "project" ? "project" : null,
    enabled: true,
    epoch: 7,
    revision: 1,
    learning_cutoff_at: "2026-09-05T00:00:00.000Z",
    content: "# Existing",
    content_sha256: null,
    size_bytes: 12,
    last_source_job_id: null,
    status: "processing",
    last_error_code: null,
    last_source: null,
    updated_by: null,
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:00.000Z",
  };
}

function args(scope: "user" | "project" = "user") {
  return {
    db: {} as never,
    file: memoryFile(scope),
    current: { content: "# Existing", revision: 1 },
    transcript: "User: Keep responses concise",
    model: "openai:gpt-test",
    actorUserId: "actor",
    actorEmail: "actor@example.com",
    stateId: "state",
    generation: 4,
    expectedEpoch: 7,
    sourceEpoch: 2,
    conversationGeneration: 11,
    surface: "chat" as const,
    conversationId: "chat",
    turnId: "turn",
    jobId: "job",
  };
}

function services(overrides: Partial<CuratorScopeServices> = {}) {
  return {
    stream: vi.fn(async () => ({ fullText: "" })),
    write: vi.fn(async () => ({
      applied: true,
      current: {
        enabled: true,
        content: "# Updated",
        revision: 2,
        hash: "hash",
        updated_at: "2026-09-05T00:01:00.000Z",
        updated_by: "actor",
        source: "curator" as const,
        status: "idle" as const,
        status_updated_at: "2026-09-05T00:01:00.000Z",
      },
    })),
    checkProject: vi.fn(async () => ({
      ok: true as const,
      projectRole: "editor" as const,
      project: { id: "project" },
    })) as unknown as CuratorScopeServices["checkProject"],
    ...overrides,
  } as CuratorScopeServices;
}

describe("scope-bound memory curator tool", () => {
  it("exposes only complete Markdown and writes to the server-bound scope", async () => {
    const svc = services();
    svc.stream = vi.fn(async (params: StreamChatParams) => {
      await params.runTools?.([
        {
          id: "call-1",
          name: "write_memory_file",
          input: {
            expectedRevision: 1,
            markdown: "# Updated\n- Concise",
            changeSummary: "Remember concise response preference",
          },
        },
      ]);
      return { fullText: "" };
    });

    const result = await runMemoryCuratorScope(args(), svc);

    expect(result).toEqual({ outcome: "updated", revision: 2 });
    expect(svc.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTools: true,
        tools: [MEMORY_CURATOR_WRITE_TOOL],
      }),
    );
    expect(svc.write).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ id: "memory-file", scope: "user" }),
        content: "# Updated\n- Concise",
        expectedRevision: 1,
        expectedEpoch: 7,
        sourceEpoch: 2,
        conversationGeneration: 11,
        sourceJobId: "job",
      }),
    );
    // The tool still demands a rationale so the model has to justify the
    // rewrite, but nothing stores it: the file keeps only its current body.
    expect(svc.write.mock.calls[0]![0]).not.toHaveProperty("changeSummary");
    expect(
      Object.keys(
        MEMORY_CURATOR_WRITE_TOOL.function.parameters.properties as object,
      ),
    ).toEqual(["markdown", "expectedRevision", "changeSummary"]);
    expect(JSON.stringify(MEMORY_CURATOR_WRITE_TOOL)).not.toMatch(
      /owner|project_id|scope|storage_path/i,
    );
  });

  it("records no change when the model calls no tool", async () => {
    const svc = services();
    const result = await runMemoryCuratorScope(args(), svc);
    expect(result).toEqual({ outcome: "no_change", revision: 1 });
    expect(svc.write).not.toHaveBeenCalled();
  });

  it("re-checks canonical project edit access inside the tool", async () => {
    const svc = services({
      checkProject: vi.fn(async () => ({ ok: false as const, status: 404 })) as never,
    });
    svc.stream = vi.fn(async (params: StreamChatParams) => {
      await params.runTools?.([
        {
          id: "call-1",
          name: "write_memory_file",
          input: {
            expectedRevision: 1,
            markdown: "# Bad",
            changeSummary: "Bad update",
          },
        },
      ]);
      return { fullText: "" };
    });
    const result = await runMemoryCuratorScope(args("project"), svc);
    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "access_revoked",
    });
    expect(svc.write).not.toHaveBeenCalled();
  });

  it("never lets raw provider errors escape into persisted DB job errors", async () => {
    const svc = services({
      stream: vi.fn(async () => {
        throw new Error("SECRET transcript and provider credential");
      }),
    });
    await expect(runMemoryCuratorScope(args(), svc)).rejects.toThrow(
      /^Memory curator scope failed$/,
    );
  });
});

type Loose = Record<string, unknown>;

/**
 * Minimal `chat_messages` query double: mirrors the columns the curator's
 * eligibility loader filters on and resolves the two shapes it awaits
 * (assistants via `limit`, inputs via `in`).
 */
function chatMessageBuilder(rows: MemoryCuratorStoredMessage[]): Loose {
  let selected = [...rows];
  let limit = Number.POSITIVE_INFINITY;
  const builder: Loose = {};
  const chain = (): Loose => builder;
  builder.select = chain;
  builder.eq = (column: string, value: unknown) => {
    if (column !== "chat_id") {
      selected = selected.filter(
        (candidate) => (candidate as unknown as Loose)[column] === value,
      );
    }
    return builder;
  };
  builder.not = (column: string, _operator: string, value: unknown) => {
    if (value === null) {
      selected = selected.filter(
        (candidate) => (candidate as unknown as Loose)[column] != null,
      );
    }
    return builder;
  };
  builder.in = (column: string, values: unknown[]) => {
    selected = selected.filter((candidate) =>
      values.includes((candidate as unknown as Loose)[column]),
    );
    return builder;
  };
  builder.order = chain;
  builder.limit = (value: number) => {
    limit = value;
    return builder;
  };
  builder.maybeSingle = async () => ({
    data: selected.slice(0, limit)[0] ?? null,
    error: null,
  });
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) =>
    Promise.resolve({ data: selected.slice(0, limit), error: null }).then(
      resolve,
      reject,
    );
  return builder;
}

function singleRowBuilder(value: unknown): Loose {
  const builder: Loose = {};
  const chain = (): Loose => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.not = chain;
  builder.gt = chain;
  builder.order = chain;
  builder.limit = chain;
  builder.maybeSingle = async () => ({ data: value, error: null });
  return builder;
}

describe("memory curator governed egress terminal branch", () => {
  it("fails the consolidation without retrying when egress is blocked", async () => {
    const messages: MemoryCuratorStoredMessage[] = [
      {
        id: "input-1",
        role: "user",
        content: "Keep it concise",
        author_user_id: "actor",
        memory_input_message_id: null,
        memory_eligible_at: null,
        memory_app_eligible_at: null,
        created_at: "2026-09-05T00:00:01.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "content", text: "Understood" }],
        author_user_id: "actor",
        memory_input_message_id: "input-1",
        memory_eligible_at: "2026-09-05T00:00:02.000Z",
        memory_app_eligible_at: "2026-09-05T00:00:02.000Z",
        created_at: "2026-09-05T00:00:02.000Z",
      },
    ];
    const appFile = memoryFile("user");
    const current: MemoryCurrent = {
      enabled: true,
      content: "# Existing",
      revision: 1,
      hash: null,
      updated_at: null,
      updated_by: null,
      source: null,
      status: "processing",
      status_updated_at: "2026-09-05T00:00:00.000Z",
    };

    vi.mocked(ensureChatAccess).mockResolvedValue({ ok: true } as never);
    vi.mocked(ensureMemoryFile).mockResolvedValue(appFile);
    vi.mocked(getMemoryCurrent).mockResolvedValue({ current, file: appFile });

    const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> =
      [];
    const tables: Record<string, unknown> = {
      memory_consolidation_states: {
        id: "state-1",
        surface: "chat",
        conversation_id: "chat-1",
        actor_user_id: "actor",
        project_id: null,
        generation: 4,
        processed_generation: 0,
        latest_turn_id: null,
        status: "processing",
      },
      memory_conversation_activity: {
        generation: 11,
        quiet_until: null,
        deleted_at: null,
      },
      memory_conversation_turn_leases: null,
      chats: {
        id: "chat-1",
        user_id: "actor",
        project_id: null,
        org_id: null,
        model: "openai:gpt-test",
      },
      memory_files: { id: "file-1", epoch: 7 },
      memory_consolidation_results: null,
    };
    const db = {
      auth: {
        admin: {
          getUserById: async () => ({
            data: { user: { email: "actor@example.com" } },
            error: null,
          }),
        },
      },
      from: (table: string) =>
        table === "chat_messages"
          ? chatMessageBuilder(messages)
          : singleRowBuilder(tables[table] ?? null),
      rpc: async (name: string, params: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        return name === "set_memory_consolidation_status"
          ? { data: true, error: null }
          : { data: null, error: null };
      },
    };
    const job: DbJob = {
      id: "job",
      kind: "memory.consolidate",
      payload: {
        stateId: "state-1",
        generation: 4,
        appEpoch: 7,
        sourceEpoch: 2,
        conversationGeneration: 11,
        actorUserId: "actor",
        projectId: null,
        terminalAt: null,
        turnId: null,
      },
      status: "running",
      attempts: 0,
      max_attempts: 3,
      run_at: "2026-09-05T00:00:00.000Z",
      claimed_at: null,
      finished_at: null,
      last_error: null,
      dedupe_key: null,
      result: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const result = await handleMemoryConsolidation(db as never, job);

    expect(result).toEqual({
      skipped: "egress_blocked",
      outcomes: { user: "egress_blocked" },
    });

    const statusCalls = rpcCalls
      .filter((call) => call.name === "set_memory_consolidation_status")
      .map((call) => call.params.p_status);
    expect(statusCalls).toEqual(["processing", "failed"]);
    expect(
      rpcCalls.find(
        (call) =>
          call.name === "set_memory_consolidation_status" &&
          call.params.p_status === "failed",
      )?.params.p_error_code,
    ).toBe("curation_egress_blocked");

    expect(
      rpcCalls.some(
        (call) =>
          call.name === "refresh_memory_file_status" &&
          call.params.p_requested_status === "failed" &&
          call.params.p_error_code === "curation_egress_blocked",
      ),
    ).toBe(true);

    // Terminal: one governed stream attempt, no scope retry / no rethrow.
    expect(vi.mocked(createGovernedCuratorStream)).toHaveBeenCalledTimes(1);
  });
});
