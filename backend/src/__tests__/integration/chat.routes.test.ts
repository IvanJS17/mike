import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// This file's model-selection coverage pushes past the chat limiter's
// 30-requests-per-window budget, so later requests would answer 429 before any
// route logic runs. Hoisted so it precedes app.ts's limiter construction;
// scoped to tests — production reads its own env.
vi.hoisted(() => {
    process.env.RATE_LIMIT_CHAT_MAX = "1000";
});

// Hoisted mock fn so the vi.mock factory below (which is itself hoisted above
// the imports) can reference it. Lets each test drive the stream outcome.
const { runLLMStream, dbInserts, dbUpdates, dbRpcCalls, dbControl } =
    vi.hoisted(() => ({
        runLLMStream: vi.fn(),
        dbInserts: [] as { table: string; value: unknown }[],
        dbUpdates: [] as {
            table: string;
            value: unknown;
            filters: { column: string; value: unknown }[];
        }[],
        dbRpcCalls: [] as { name: string; args: unknown }[],
        dbControl: {
            failAssistantReservation: false,
            terminalUpdateFailures: 0,
            terminalUpdateAttempts: 0,
            terminalUpdateGate: null as Promise<void> | null,
            wordChatMissing: false,
            // When set, selects on chat_messages resolve against these rows with
            // the eq/not/order/limit chain genuinely applied (a mini query
            // engine), so tests can prove which assistant row a query picks.
            assistantMessageRows: null as Record<string, unknown>[] | null,
            // When set, selects on `chats` resolve to this row instead of the
            // default owned-by-u1 row, so tests can present a conversation
            // shared by another user.
            chatRow: null as Record<string, unknown> | null,
            // When true, begin_memory_conversation_turn fails at the DB,
            // proving the route fails closed before streaming.
            failMemoryFence: false,
            // When true, selects on `projects` resolve to no row, so every
            // project verdict in the request comes back as "no access" (the
            // member was removed from the project).
            projectMissing: false,
            // When set, selects on `projects` resolve to a row owned by this
            // user (not the caller), so the caller's project role comes from a
            // grant instead of the creator shortcut.
            projectOwnerId: null as string | null,
            // When set, selects on `project_access_grants` resolve to this
            // role, so a request can authenticate as a project viewer/editor.
            projectGrantRole: null as string | null,
        },
    }));

// A permissive, chainable Supabase stub. Every query-builder method returns the
// same object (so arbitrary chains work), the object is awaitable (thenable),
// and the terminal single()/maybeSingle() resolve to a chat row. The chat
// routes only read `.id`/`.title` and check `.error`, so this is enough to let
// a request flow through chat creation and message inserts without real IO.
function makeQuery(table: string) {
    let result: { data: unknown; error: { message: string } | null } =
        table === "chats" && dbControl.chatRow
            ? { data: dbControl.chatRow, error: null }
            : table === "project_access_grants" && dbControl.projectGrantRole
              ? { data: { role: dbControl.projectGrantRole }, error: null }
              : table === "projects" && dbControl.projectMissing
                ? { data: null, error: null }
                : table === "projects" && dbControl.projectOwnerId
                  ? {
                        data: {
                            id: "p1",
                            user_id: dbControl.projectOwnerId,
                            org_id: null,
                        },
                        error: null,
                    }
                  : {
                        data: {
                            id: "chat-1",
                            title: null,
                            user_id: "u1",
                            project_id: null,
                        },
                        error: null,
                    };
    const q: Record<string, unknown> = {};
    let activeUpdate:
        | {
              table: string;
              value: unknown;
              filters: { column: string; value: unknown }[];
          }
        | undefined;
    const chain = [
        "delete",
        "upsert",
        "neq",
        "in",
        "is",
        "or",
        "lt",
        "gt",
        "gte",
        "lte",
        "filter",
        "range",
        "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    // Select-chain state, applied against dbControl.assistantMessageRows when
    // the query resolves (see q.then below).
    let didSelect = false;
    const selectState = {
        filters: [] as { column: string; op: string; value: unknown }[],
        order: null as { column: string; ascending: boolean } | null,
        limit: null as number | null,
    };
    q.select = vi.fn(() => {
        didSelect = true;
        return q;
    });
    q.not = vi.fn((column: string, operator: string, value: unknown) => {
        selectState.filters.push({ column, op: `not-${operator}`, value });
        return q;
    });
    q.order = vi.fn((column: string, opts?: { ascending?: boolean }) => {
        selectState.order = { column, ascending: opts?.ascending !== false };
        return q;
    });
    q.limit = vi.fn((count: number) => {
        selectState.limit = count;
        return q;
    });
    q.insert = vi.fn((value: unknown) => {
        dbInserts.push({ table, value });
        if (
            dbControl.failAssistantReservation &&
            table === "chat_messages" &&
            (value as { role?: unknown }).role === "assistant"
        ) {
            result = {
                data: null,
                error: { message: "assistant reservation failed" },
            };
        }
        return q;
    });
    q.update = vi.fn((value: unknown) => {
        activeUpdate = { table, value, filters: [] };
        dbUpdates.push(activeUpdate);
        return q;
    });
    q.eq = vi.fn((column: string, value: unknown) => {
        if (activeUpdate) activeUpdate.filters.push({ column, value });
        else selectState.filters.push({ column, op: "eq", value });
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() => {
        if (
            didSelect &&
            table === "chat_messages" &&
            dbControl.assistantMessageRows
        ) {
            let rows = [...dbControl.assistantMessageRows];
            for (const filter of selectState.filters) {
                if (filter.op === "eq") {
                    rows = rows.filter(
                        (row) => row[filter.column] === filter.value,
                    );
                }
            }
            return Promise.resolve({ data: rows[0] ?? null, error: null });
        }
        return Promise.resolve(
            table === "word_chats" && dbControl.wordChatMissing
                ? { data: null, error: null }
                : result,
        );
    });
    q.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
    ) => {
        const resolveQuery = async () => {
            if (activeUpdate?.table === "chat_messages") {
                dbControl.terminalUpdateAttempts += 1;
                if (dbControl.terminalUpdateGate) {
                    await dbControl.terminalUpdateGate;
                }
                if (
                    dbControl.terminalUpdateAttempts <=
                    dbControl.terminalUpdateFailures
                ) {
                    return {
                        data: null,
                        error: {
                            message: `terminal update failed (attempt ${dbControl.terminalUpdateAttempts})`,
                        },
                    };
                }
            }
            if (
                !activeUpdate &&
                didSelect &&
                table === "chat_messages" &&
                dbControl.assistantMessageRows
            ) {
                let rows = [...dbControl.assistantMessageRows];
                for (const f of selectState.filters) {
                    if (f.op === "eq") {
                        rows = rows.filter((row) => row[f.column] === f.value);
                    } else if (f.op === "not-is" && f.value === null) {
                        rows = rows.filter((row) => row[f.column] !== null);
                    }
                }
                if (selectState.order) {
                    const { column, ascending } = selectState.order;
                    rows = [...rows].sort(
                        (a, b) =>
                            String(a[column]).localeCompare(String(b[column])) *
                            (ascending ? 1 : -1),
                    );
                }
                if (selectState.limit != null) {
                    rows = rows.slice(0, selectState.limit);
                }
                return { data: rows, error: null };
            }
            return result;
        };
        return resolveQuery().then(resolve, reject);
    };
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn((name: string, args: unknown) => {
            dbRpcCalls.push({ name, args });
            if (
                name === "begin_memory_conversation_turn" &&
                dbControl.failMemoryFence
            ) {
                return Promise.resolve({
                    data: null,
                    error: { message: "memory activity could not be fenced" },
                });
            }
            return Promise.resolve({
                data: name.startsWith("append_chat_") ? "appended" : null,
                error: null,
            });
        }),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

// Authenticate every request as user "u1" without exercising the real Supabase
// JWT path. requireMfaIfEnrolled must be exported too — userRouter (mounted by
// the app) imports it at module load.
vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// Keep the real error helpers (the failure-path test relies on genuine
// isAbortError + AssistantStreamError behavior) but stub the functions that
// would otherwise hit the DB or the LLM.
vi.mock("../../lib/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/chat")>();
    return {
        ...actual,
        buildDocContext: vi.fn(async () => ({
            docIndex: {},
            docStore: new Map(),
        })),
        enrichWithPriorEvents: vi.fn(async (messages: unknown) => messages),
        buildWorkflowStore: vi.fn(async () => new Map()),
        buildMessages: vi.fn(() => []),
        runLLMStream: (...args: unknown[]) => runLLMStream(...args),
    };
});

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: vi.fn(async () => ({
        legal_research_us: false,
        title_model: "test-model",
        tabular_model: "test-model",
        last_selected_chat_model: null,
        last_selected_reasoning_level: null,
        api_keys: { gemini: "test-key" },
        personalisation: {
            displayName: "Ada",
            organisation: "Acme LLP",
            jurisdiction: "Singapore",
            practiceSetting: "private_practice",
            professionalTitle: "Partner",
            practiceAreas: ["Litigation"],
        },
    })),
    persistLastSelectedChatModel: vi.fn(async () => null),
    persistLastSelectedReasoningLevel: vi.fn(async () => null),
    getUserApiKeys: vi.fn(async () => ({})),
}));

// The title generator reaches an LLM provider; the access tests only need to
// prove WHEN that write path is (not) entered. The default mirrors the suite's
// environment (no usable title model, so the route keeps its fallback path);
// the generate-title suite queues a resolved value per request.
vi.mock("../../lib/chatTitle", () => ({
    generateAssistantChatTitle: vi.fn(async () => {
        throw new Error("title model unavailable in tests");
    }),
}));

import { app } from "../../app";

const VALID_BODY = {
    messages: [{ role: "user", content: "hello" }],
    model: "gemini-3-flash-preview",
};

function findAssistantReservation() {
    return dbInserts.find(
        ({ table, value }) =>
            table === "chat_messages" &&
            (value as { role?: unknown }).role === "assistant",
    );
}

function findAssistantUpdate() {
    return dbUpdates.find(({ table }) => table === "chat_messages");
}

describe("POST /chat — streaming endpoint", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbInserts.length = 0;
        dbUpdates.length = 0;
        dbRpcCalls.length = 0;
        dbControl.failAssistantReservation = false;
        dbControl.terminalUpdateFailures = 0;
        dbControl.terminalUpdateAttempts = 0;
        dbControl.terminalUpdateGate = null;
        dbControl.wordChatMissing = false;
        dbControl.assistantMessageRows = null;
        dbControl.chatRow = null;
        dbControl.failMemoryFence = false;
        dbControl.projectMissing = false;
        dbControl.projectOwnerId = null;
        dbControl.projectGrantRole = null;
        runLLMStream.mockResolvedValue({
            fullText: "hi there",
            events: [],
            citations: [],
        });
    });

    it("streams SSE with a chat_id event on the happy path", async () => {
        const chatLib = await import("../../lib/chat");
        let reservationExistedBeforeStreaming = false;
        runLLMStream.mockImplementation(async () => {
            reservationExistedBeforeStreaming = !!findAssistantReservation();
            return {
                fullText: "hi there",
                events: [{ type: "content", text: "hi there" }],
                citations: [],
            };
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.text).toContain('"type":"chat_id"');
        expect(res.text).toContain('"type":"chat_title"');
        expect(runLLMStream).toHaveBeenCalledTimes(1);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ emitDone: false }),
        );
        const systemPromptExtra = vi.mocked(chatLib.buildMessages).mock
            .calls[0]?.[2] as string;
        expect(systemPromptExtra).toContain("USER PERSONALISATION");
        expect(systemPromptExtra).toContain('"title": "Partner"');
        expect(systemPromptExtra).toContain(
            '"professional_setting": "Private practice"',
        );

        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { chatId: string; assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(reservationExistedBeforeStreaming).toBe(true);
        expect(metadata.assistantMessageId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            chat_id: metadata.chatId,
            role: "assistant",
            content: null,
            citations: null,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: [{ type: "content", text: "hi there" }],
            citations: null,
        });
        expect(assistantUpdate?.filters).toEqual(
            expect.arrayContaining([
                { column: "id", value: metadata.assistantMessageId },
                { column: "chat_id", value: metadata.chatId },
            ]),
        );
    });

    it("rejects a chat without an explicit model before streaming", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: VALID_BODY.messages });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            code: "model_required",
            detail: "Select a model before sending a message.",
        });
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("uses the profile last-selected model when a new chat omits model", async () => {
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            legal_research_us: false,
            title_model: null,
            tabular_model: null,
            last_selected_chat_model: "gpt-5.6-luna",
            api_keys: { openai: "test-key" },
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: VALID_BODY.messages });

        expect(res.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ model: "gpt-5.6-luna" }),
        );
        expect(dbInserts).toContainEqual({
            table: "chats",
            value: expect.objectContaining({ model: "gpt-5.6-luna" }),
        });
        expect(
            userSettings.persistLastSelectedChatModel,
        ).not.toHaveBeenCalled();
    });

    it("surfaces an empty upstream completion as a visible retry error", async () => {
        // Some providers end the stream cleanly but produce no content.
        // Silence reads as a hung composer, so the route emits an explicit,
        // safe-to-display error event before closing the stream.
        runLLMStream.mockResolvedValue({
            fullText: "",
            events: [],
            citations: [],
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.text).toContain('"type":"error"');
        expect(res.text).toContain("empty response");
        expect(res.text).toContain('"safe_to_display":true');
        expect(res.text).toContain("[DONE]");
    });

    it("stores cloud Word chats only in the document-scoped Word tables", async () => {
        const chatLib = await import("../../lib/chat");
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: [{ role: "user", content: "Visible prompt" }],
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "Contract.docx",
                storage: "cloud",
                document_context: "GOVERNED BY DELAWARE LAW",
                model: "gemini-3-flash-preview",
            });

        expect(res.status).toBe(200);
        expect(dbInserts.some(({ table }) => table === "chats")).toBe(false);
        expect(dbInserts.some(({ table }) => table === "chat_messages")).toBe(
            false,
        );
        expect(dbInserts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    table: "word_chats",
                    value: expect.objectContaining({
                        user_id: "u1",
                        word_document_id: "chat-1",
                    }),
                }),
                expect.objectContaining({
                    table: "word_chat_messages",
                    value: expect.objectContaining({
                        role: "user",
                        content: "Visible prompt",
                    }),
                }),
                expect.objectContaining({
                    table: "word_chat_messages",
                    value: expect.objectContaining({ role: "assistant" }),
                }),
            ]),
        );
        const call = vi.mocked(chatLib.buildMessages).mock.calls[0];
        const docAvailability = call[1] as {
            doc_id: string;
            filename: string;
        }[];
        const systemPromptExtra = call[2] as string;
        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            docStore: Map<
                string,
                {
                    filename: string;
                    inline_text?: string;
                }
            >;
        };
        expect(systemPromptExtra).toContain("running inside Microsoft Word");
        expect(systemPromptExtra).toContain("USER PERSONALISATION");
        expect(systemPromptExtra).toContain('"jurisdiction": "Singapore"');
        expect(systemPromptExtra).toContain(
            '\"deleted_text\":\"exact text copied from the active Word document\"',
        );
        expect(systemPromptExtra).not.toContain("GOVERNED BY DELAWARE LAW");
        expect(docAvailability).toContainEqual({
            doc_id: "active-word-document",
            filename: "Contract.docx",
        });
        expect(streamArgs.docStore.get("active-word-document")).toMatchObject({
            filename: "Contract.docx",
            inline_text: "GOVERNED BY DELAWARE LAW",
        });
        expect(
            dbInserts.find(
                ({ table, value }) =>
                    table === "word_chat_messages" &&
                    (value as { role?: unknown }).role === "user",
            )?.value,
        ).toMatchObject({ content: "Visible prompt" });
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ includeAskInputs: false }),
        );
    });

    it.each([
        [{ messages: VALID_BODY.messages }, "document_id must be a UUID"],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "   ",
            },
            "document_name must be a non-empty string",
        ],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "weird",
            },
            'storage must be "cloud" or "local"',
        ],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                chat_id: "not-a-uuid",
            },
            "chat_id must be a UUID",
        ],
    ])(
        "rejects invalid Word-chat input before streaming",
        async (body, detail) => {
            const res = await request(app)
                .post("/word-chat")
                .set("Authorization", "Bearer test")
                .send(body);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(detail);
            expect(runLLMStream).not.toHaveBeenCalled();
            expect(dbInserts).toEqual([]);
        },
    );

    it("rejects a Word chat without an explicit model before creating storage", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: VALID_BODY.messages,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "cloud",
            });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("model_required");
        expect(dbInserts).toEqual([]);
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("uses the shared last-selected model for a local Word chat", async () => {
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            legal_research_us: false,
            title_model: null,
            tabular_model: null,
            last_selected_chat_model: "gpt-5.6-luna",
            api_keys: { openai: "test-key" },
        });

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: VALID_BODY.messages,
                storage: "local",
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
            });

        expect(res.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ model: "gpt-5.6-luna" }),
        );
    });

    it("rejects a resumed Word chat outside the scoped document and user", async () => {
        dbControl.wordChatMissing = true;

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                chat_id: "96fdeaa1-af40-475e-9834-703004783f21",
                storage: "cloud",
            });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Chat not found");
        expect(runLLMStream).not.toHaveBeenCalled();
        expect(
            dbInserts.some(({ table }) => table === "word_chat_messages"),
        ).toBe(false);
    });

    it("streams local Word chats without inserting any chat rows", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "96fdeaa1-af40-475e-9834-703004783f21",
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "local",
            });

        expect(res.status).toBe(200);
        expect(res.text).toContain(
            '"chatId":"96fdeaa1-af40-475e-9834-703004783f21"',
        );
        expect(dbInserts).toEqual([]);
        expect(dbUpdates).toEqual([]);
        expect(runLLMStream).toHaveBeenCalledTimes(1);
    });

    it("does not finish the SSE response until the terminal assistant update succeeds", async () => {
        let releaseTerminalUpdate!: () => void;
        dbControl.terminalUpdateGate = new Promise<void>((resolve) => {
            releaseTerminalUpdate = resolve;
        });

        let requestSettled = false;
        const responsePromise = request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY)
            .then((response) => {
                requestSettled = true;
                return response;
            });

        await vi.waitFor(() => {
            expect(dbControl.terminalUpdateAttempts).toBe(1);
        });
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ emitDone: false }),
        );
        expect(requestSettled).toBe(false);

        releaseTerminalUpdate();
        const res = await responsePromise;

        expect(requestSettled).toBe(true);
        expect(res.text).toContain("data: [DONE]");
        expect(res.text).not.toContain(
            "The response was generated but could not be saved",
        );
    });

    it("retries a failed terminal assistant update up to success", async () => {
        dbControl.terminalUpdateFailures = 2;

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(dbControl.terminalUpdateAttempts).toBe(3);
        expect(
            dbUpdates.filter(({ table }) => table === "chat_messages"),
        ).toHaveLength(3);
        expect(res.text).toContain("data: [DONE]");
        expect(res.text).not.toContain(
            "The response was generated but could not be saved",
        );
    });

    it("reports a terminal persistence failure before ending the SSE stream", async () => {
        dbControl.terminalUpdateFailures = 3;
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(dbControl.terminalUpdateAttempts).toBe(3);
        expect(
            dbUpdates.filter(({ table }) => table === "chat_messages"),
        ).toHaveLength(3);

        const errorIndex = res.text.indexOf(
            "The response was generated but could not be saved",
        );
        const doneIndex = res.text.indexOf("data: [DONE]");
        expect(errorIndex).toBeGreaterThanOrEqual(0);
        expect(doneIndex).toBeGreaterThan(errorIndex);
        expect(errorSpy).toHaveBeenCalledWith(
            "[chat/stream] failed to save assistant response",
            expect.objectContaining({
                message: "terminal update failed (attempt 3)",
            }),
        );
        errorSpy.mockRestore();
    });

    it("fails before advertising SSE metadata when the assistant row cannot be reserved", async () => {
        dbControl.failAssistantReservation = true;
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(500);
        expect(res.headers["content-type"]).not.toContain("text/event-stream");
        expect(res.body.detail).toBe("Something went wrong. Please try again.");
        expect(res.text).not.toContain('"type":"chat_id"');
        expect(findAssistantReservation()).toBeDefined();
        expect(runLLMStream).not.toHaveBeenCalled();
        expect(findAssistantUpdate()).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
            "[chat/stream] failed to reserve assistant message",
            expect.objectContaining({
                message: "assistant reservation failed",
            }),
        );
        errorSpy.mockRestore();
    });

    it("surfaces a stream failure as an in-stream error event, not an HTTP error", async () => {
        runLLMStream.mockRejectedValue(new Error("upstream LLM failure"));

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        // Headers were already flushed (200) before the stream threw, so the
        // failure surfaces as an in-stream error event + [DONE].
        expect(res.status).toBe(200);
        expect(res.text).toContain('"type":"error"');
        expect(res.text).toContain("[DONE]");

        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            role: "assistant",
        });
        expect(assistantUpdate?.filters).toContainEqual({
            column: "id",
            value: metadata.assistantMessageId,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: [
                expect.objectContaining({
                    type: "error",
                    message:
                        "The response could not be completed. Please try again.",
                }),
            ],
        });
    });

    it("uses the streamed assistant message id when persisting a cancelled partial response", async () => {
        const { AssistantStreamAbortError } = await import("../../lib/chat");
        runLLMStream.mockRejectedValue(
            new AssistantStreamAbortError("partial", [
                { type: "content", text: "partial" },
            ]),
        );

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            role: "assistant",
        });
        expect(assistantUpdate?.filters).toContainEqual({
            column: "id",
            value: metadata.assistantMessageId,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: expect.arrayContaining([
                { type: "content", text: "partial" },
                { type: "content", text: "Cancelled by user." },
            ]),
        });
    });

    it("does not allocate or insert a new assistant message for an ask-input continuation", async () => {
        dbControl.assistantMessageRows = [
            {
                id: "assistant-existing",
                chat_id: "chat-1",
                role: "assistant",
                content: [
                    {
                        type: "ask_inputs",
                        event_id: "ask-1",
                        items: [
                            {
                                id: "choice-1",
                                kind: "choice",
                                question: "Continue?",
                                options: [{ value: "Yes" }, { value: "No" }],
                                allow_other: false,
                                other_label: "Other",
                            },
                        ],
                    },
                ],
                citations: null,
                author_user_id: "u1",
                created_at: "2026-01-01T00:00:00Z",
            },
        ];
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "chat-1",
                ask_inputs_response: {
                    assistant_message_id: "assistant-existing",
                    ask_event_id: "ask-1",
                    responses: [
                        {
                            id: "choice-1",
                            kind: "choice",
                            question: "Continue?",
                            answer: "Yes",
                        },
                    ],
                },
            });

        expect(res.status).toBe(200);
        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as Record<string, unknown>;
        expect(metadata).not.toHaveProperty("assistantMessageId");
        expect(
            dbInserts.filter(
                ({ table, value }) =>
                    table === "chat_messages" &&
                    (value as { role?: unknown }).role === "assistant",
            ),
        ).toEqual([]);
    });

    it("appends ask-input responses to the real last assistant message, skipping a null-content reservation", async () => {
        // A stream that died before its save path (or a concurrently
        // streaming POST) leaves the newest assistant row as an empty
        // reservation. The continuation must attach the user's answers to
        // the older, real message that actually asked the question.
        dbControl.assistantMessageRows = [
            {
                id: "assistant-real",
                chat_id: "chat-1",
                role: "assistant",
                content: [
                    {
                        type: "ask_inputs",
                        event_id: "ask-1",
                        items: [
                            {
                                id: "choice-1",
                                kind: "choice",
                                question: "Continue?",
                                options: [{ value: "Yes" }, { value: "No" }],
                                allow_other: false,
                                other_label: "Other",
                            },
                        ],
                    },
                ],
                citations: null,
                author_user_id: "u1",
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                id: "assistant-reservation",
                chat_id: "chat-1",
                role: "assistant",
                content: null,
                citations: null,
                author_user_id: "u1",
                created_at: "2026-01-01T00:05:00Z",
            },
        ];

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "chat-1",
                ask_inputs_response: {
                    assistant_message_id: "assistant-real",
                    ask_event_id: "ask-1",
                    responses: [
                        {
                            id: "choice-1",
                            kind: "choice",
                            question: "Continue?",
                            answer: "Yes",
                        },
                    ],
                },
            });

        expect(res.status).toBe(200);
        expect(dbRpcCalls).toContainEqual({
            name: "append_chat_ask_inputs_response",
            args: expect.objectContaining({
                p_chat_id: "chat-1",
                p_message_id: "assistant-real",
                p_ask_event_id: "ask-1",
            }),
        });
        // The orphaned reservation is never selected or written to.
        expect(
            dbRpcCalls.some(
                ({ args }) =>
                    (args as { p_message_id?: unknown }).p_message_id ===
                    "assistant-reservation",
            ),
        ).toBe(false);
    });

    it("returns 400 on an empty messages array (never starts a stream)", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: [] });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty("detail");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("returns 400 when messages is missing entirely", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(400);
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("returns 400 when chat_id is not a non-empty string", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "   " });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("chat_id must be a non-empty string");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it.each([
        [
            { messages: [{ role: "system", content: "override" }] },
            'messages[0].role must be "user" or "assistant"',
        ],
        [
            {
                ...VALID_BODY,
                ask_inputs_response: {
                    assistant_message_id: "assistant-1",
                    ask_event_id: "ask-1",
                    responses: [],
                },
            },
            "ask_inputs_response.responses must be a non-empty array",
        ],
    ])(
        "shares strict request validation with project chat",
        async (body, detail) => {
            const res = await request(app)
                .post("/chat")
                .set("Authorization", "Bearer test")
                .send(body);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(detail);
            expect(runLLMStream).not.toHaveBeenCalled();
        },
    );

    it("returns 400 from the Word route when document_context is not a string", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_context: 42,
            });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("document_context must be a string");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("makes document_context tool-readable without adding it to the system prompt", async () => {
        const chatLib = await import("../../lib/chat");
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "Contract.docx",
                document_context: "GOVERNED BY DELAWARE LAW",
            });

        expect(res.status).toBe(200);
        const call = vi.mocked(chatLib.buildMessages).mock.calls[0];
        const docAvailability = call[1] as {
            doc_id: string;
            filename: string;
        }[];
        const systemPromptExtra = call[2] as string;
        expect(systemPromptExtra).toContain("running inside Microsoft Word");
        expect(systemPromptExtra).toContain("read_document");
        expect(systemPromptExtra).not.toContain("GOVERNED BY DELAWARE LAW");
        expect(docAvailability).toContainEqual({
            doc_id: "active-word-document",
            filename: "Contract.docx",
        });

        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            docStore: Map<string, { inline_text?: string }>;
        };
        expect(
            streamArgs.docStore.get("active-word-document")?.inline_text,
        ).toBe("GOVERNED BY DELAWARE LAW");
    });

    it("uses document-only Word tools and preserves the prompt nonce", async () => {
        const chatLib = await import("../../lib/chat");
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            title_model: "test-model",
            tabular_model: "test-model",
            last_selected_chat_model: null,
            last_selected_reasoning_level: null,
            api_keys: {
                gemini: "test-key",
            },
        });

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_context: "Contract text",
            });

        expect(res.status).toBe(200);
        const buildMessagesCall = vi.mocked(chatLib.buildMessages).mock
            .calls[0];
        expect(buildMessagesCall[4]).toEqual(expect.any(String));
        expect(buildMessagesCall[5]).toBe("replace");
        expect(runLLMStream.mock.calls[0]?.[0]).not.toHaveProperty("includeResearchTools");
        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            apiKeys?: { courtlistener?: string };
        };
        expect(streamArgs.apiKeys?.courtlistener).toBeUndefined();
    });

    it("keeps personal memory out of a conversation shared by another user", async () => {
        // A collaborator's chat in a personal (non-org) project is still a
        // shared audience. The stream must be told so, so personal/app memory
        // is never folded into a conversation other people can read.
        dbControl.chatRow = {
            id: "chat-1",
            title: "Shared plan",
            model: null,
            reasoning_level: null,
            user_id: "u2",
            project_id: "p1",
        };

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(res.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({
                includeMemory: true,
                memorySharedAudience: true,
                memoryProjectId: "p1",
            }),
        );
    });

    it("rejects a project chat once its author lost access to the project", async () => {
        // Revoking a member's project access must also remove them from the
        // project's conversations. Current project members still read this
        // thread, so it can never fall back to its author's private audience:
        // the owner shortcut in getAccessibleChat would otherwise let the
        // revoked author keep extending it (with their app memory folded in).
        dbControl.chatRow = {
            id: "chat-1",
            title: "Revoked access",
            model: null,
            reasoning_level: null,
            user_id: "u1",
            project_id: "p1",
        };
        dbControl.projectMissing = true;

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Chat not found");
        expect(runLLMStream).not.toHaveBeenCalled();
        expect(
            dbRpcCalls.some(
                ({ name }) => name === "begin_memory_conversation_turn",
            ),
        ).toBe(false);
    });

    it("blocks a project viewer from opening a new chat in a project", async () => {
        // POST /chat without a chat_id creates the conversation first. A
        // viewer can read the project (project.view) but creating a chat
        // contributes content to it (content.edit) — the verdict
        // validateAccessibleProjectId enforces, 404 without leaking project
        // existence (upstream parity).
        dbControl.projectOwnerId = "u2";
        dbControl.projectGrantRole = "viewer";

        const denied = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, project_id: "p1" });

        expect(denied.status).toBe(404);
        expect(denied.body.detail).toBe("Project not found");
        expect(dbInserts).toHaveLength(0);
        expect(dbUpdates).toHaveLength(0);
        expect(runLLMStream).not.toHaveBeenCalled();

        // The project editor keeps the documented new-chat flow.
        dbControl.projectGrantRole = "editor";
        const allowed = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, project_id: "p1" });

        expect(allowed.status).toBe(200);
        expect(dbInserts).toContainEqual({
            table: "chats",
            value: expect.objectContaining({ project_id: "p1", user_id: "u1" }),
        });
        expect(runLLMStream).toHaveBeenCalledTimes(1);
    });

    it("blocks a project viewer from writing to an existing project chat", async () => {
        // A viewer can read a project conversation (GET) but POST /chat writes
        // a user message and triggers generation, so it requires content.edit —
        // the same capability the new-chat path demands. Editors (and the
        // owner/creator) keep writing.
        dbControl.chatRow = {
            id: "chat-1",
            title: "Read-only thread",
            model: null,
            reasoning_level: null,
            user_id: "u2",
            project_id: "p1",
        };
        dbControl.projectOwnerId = "u2";
        dbControl.projectGrantRole = "viewer";

        const denied = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(denied.status).toBe(403);
        expect(denied.body.detail).toBe(
            "You do not have permission to modify this chat",
        );
        expect(runLLMStream).not.toHaveBeenCalled();
        expect(dbInserts.some(({ table }) => table === "chat_messages")).toBe(
            false,
        );
        expect(dbUpdates).toHaveLength(0);

        // The same request from an editor on the project is admitted.
        dbControl.projectGrantRole = "editor";
        const allowed = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(allowed.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledTimes(1);
    });

    it("fails closed before streaming when memory activity cannot be fenced", async () => {
        dbControl.failMemoryFence = true;
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(500);
        expect(res.body.detail).toBe("Something went wrong. Please try again.");
        expect(runLLMStream).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});

describe("POST /chat/create — the «New chat» door", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbInserts.length = 0;
        dbControl.chatRow = null;
        dbControl.projectMissing = false;
        dbControl.projectOwnerId = null;
        dbControl.projectGrantRole = null;
    });

    it("blocks a project viewer from creating a project chat", async () => {
        // Creating the row before streaming into it is the «New chat» path
        // (the workspace saves the chat with project_id). Same verdict as
        // POST /chat: content.edit, via validateAccessibleProjectId.
        dbControl.projectOwnerId = "u2";
        dbControl.projectGrantRole = "viewer";

        const denied = await request(app)
            .post("/chat/create")
            .set("Authorization", "Bearer test")
            .send({ project_id: "p1" });

        expect(denied.status).toBe(404);
        expect(denied.body.detail).toBe("Project not found");
        expect(dbInserts).toHaveLength(0);

        // An editor on the project is admitted.
        dbControl.projectGrantRole = "editor";
        const allowed = await request(app)
            .post("/chat/create")
            .set("Authorization", "Bearer test")
            .send({ project_id: "p1" });

        expect(allowed.status).toBe(200);
        expect(allowed.body).toEqual({ id: "chat-1" });
        expect(dbInserts).toContainEqual({
            table: "chats",
            value: { user_id: "u1", project_id: "p1" },
        });
    });

    it("keeps a standalone chat outside project verdicts", async () => {
        const res = await request(app)
            .post("/chat/create")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(200);
        expect(dbInserts).toContainEqual({
            table: "chats",
            value: { user_id: "u1", project_id: null },
        });
    });
});

describe("PATCH /chat/:chatId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbUpdates.length = 0;
        dbControl.chatRow = null;
        dbControl.projectMissing = false;
        dbControl.projectOwnerId = null;
        dbControl.projectGrantRole = null;
    });

    it("returns 400 when no supported update is provided", async () => {
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "title, model, or reasoningLevel is required",
        );
    });

    it("updates the chat and profile when a model is selected", async () => {
        const userSettings = await import("../../lib/userSettings");
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ model: "gemini-3-flash-preview" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { model: "gemini-3-flash-preview" },
            filters: [{ column: "id", value: "chat-1" }],
        });
        expect(userSettings.persistLastSelectedChatModel).toHaveBeenCalledWith(
            "u1",
            "gemini-3-flash-preview",
            expect.anything(),
        );
    });

    it("updates the chat and profile when reasoning is selected", async () => {
        const userSettings = await import("../../lib/userSettings");
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ reasoningLevel: "xhigh" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { reasoning_level: "xhigh" },
            filters: [{ column: "id", value: "chat-1" }],
        });
        expect(
            userSettings.persistLastSelectedReasoningLevel,
        ).toHaveBeenCalledWith("u1", "xhigh", expect.anything());
    });

    it("blocks a project viewer from changing model or reasoning on a project chat", async () => {
        // Model/reasoning live on the chat row, so changing them is a write
        // into project content (content.edit); the title stays author-scoped.
        dbControl.chatRow = {
            id: "chat-1",
            title: "Read-only thread",
            model: null,
            reasoning_level: null,
            user_id: "u2",
            project_id: "p1",
        };
        dbControl.projectOwnerId = "u2";
        dbControl.projectGrantRole = "viewer";

        const deniedModel = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ model: "gemini-3-flash-preview" });

        expect(deniedModel.status).toBe(403);
        expect(deniedModel.body.detail).toBe(
            "You do not have permission to modify this chat",
        );
        expect(dbUpdates).toHaveLength(0);

        const deniedReasoning = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ reasoningLevel: "xhigh" });

        expect(deniedReasoning.status).toBe(403);
        expect(dbUpdates).toHaveLength(0);

        // An editor on the project keeps the current behaviour.
        dbControl.projectGrantRole = "editor";
        const allowed = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ model: "gemini-3-flash-preview" });

        expect(allowed.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { model: "gemini-3-flash-preview" },
            filters: [{ column: "id", value: "chat-1" }],
        });
    });
});

describe("POST /chat/:chatId/generate-title", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbUpdates.length = 0;
        dbControl.chatRow = null;
        dbControl.projectMissing = false;
        dbControl.projectOwnerId = null;
        dbControl.projectGrantRole = null;
    });

    it("blocks a project viewer before the title write or the LLM call", async () => {
        // generate-title UPDATEs chats.title and calls the title model: a
        // write into a project chat, so seeing the chat is not enough.
        dbControl.chatRow = {
            id: "chat-1",
            title: "Read-only thread",
            model: null,
            reasoning_level: null,
            user_id: "u2",
            project_id: "p1",
        };
        dbControl.projectOwnerId = "u2";
        dbControl.projectGrantRole = "viewer";
        const titleLib = await import("../../lib/chatTitle");

        const denied = await request(app)
            .post("/chat/chat-1/generate-title")
            .set("Authorization", "Bearer test")
            .send({ message: "hello", model: "gemini-3-flash-preview" });

        expect(denied.status).toBe(403);
        expect(denied.body.detail).toBe(
            "You do not have permission to modify this chat",
        );
        expect(dbUpdates).toHaveLength(0);
        expect(titleLib.generateAssistantChatTitle).not.toHaveBeenCalled();

        // An editor on the project keeps generating titles.
        vi.mocked(titleLib.generateAssistantChatTitle).mockResolvedValueOnce(
            "Mocked Title",
        );
        dbControl.projectGrantRole = "editor";
        const allowed = await request(app)
            .post("/chat/chat-1/generate-title")
            .set("Authorization", "Bearer test")
            .send({ message: "hello", model: "gemini-3-flash-preview" });

        expect(allowed.status).toBe(200);
        expect(allowed.body).toEqual({ title: "Mocked Title" });
        expect(titleLib.generateAssistantChatTitle).toHaveBeenCalledTimes(1);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { title: "Mocked Title" },
            filters: [{ column: "id", value: "chat-1" }],
        });
    });

    it("keeps title generation unchanged for a standalone chat", async () => {
        const titleLib = await import("../../lib/chatTitle");
        vi.mocked(titleLib.generateAssistantChatTitle).mockResolvedValueOnce(
            "Mocked Title",
        );
        const res = await request(app)
            .post("/chat/chat-1/generate-title")
            .set("Authorization", "Bearer test")
            .send({ message: "hello", model: "gemini-3-flash-preview" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ title: "Mocked Title" });
        expect(titleLib.generateAssistantChatTitle).toHaveBeenCalledTimes(1);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { title: "Mocked Title" },
            filters: [{ column: "id", value: "chat-1" }],
        });
    });
});

describe("PATCH /word-chat/:chatId/model", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbUpdates.length = 0;
        dbControl.wordChatMissing = false;
    });

    it("updates a cloud Word chat and the profile on selection", async () => {
        const userSettings = await import("../../lib/userSettings");
        const chatId = "6f783e59-35c4-4ddc-896a-94aa4d05a768";
        const documentId = "6f783e59-35c4-4ddc-896a-94aa4d05a767";
        const res = await request(app)
            .patch(`/word-chat/${chatId}/model`)
            .query({ document_id: documentId })
            .set("Authorization", "Bearer test")
            .send({ model: "gemini-3-flash-preview" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "word_chats",
            value: expect.objectContaining({
                model: "gemini-3-flash-preview",
            }),
            filters: [
                { column: "id", value: chatId },
                { column: "user_id", value: "u1" },
            ],
        });
        expect(userSettings.persistLastSelectedChatModel).toHaveBeenCalledWith(
            "u1",
            "gemini-3-flash-preview",
            expect.anything(),
        );
    });
});
