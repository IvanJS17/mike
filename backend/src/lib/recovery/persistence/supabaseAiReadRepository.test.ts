import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  createBoundEvidenceResourceScopePort,
  createSupabaseAiReadRepository,
} from "./supabaseAiReadRepository";
import { buildCanonicalEvidenceReceipt } from "../evidence/appendOnlyEvidence";

const hash = "a".repeat(64);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pageHash = sha("Page");
const executionId = "execution-1";
const projectId = "project-1";
const documentId = "document-1";
const versionId = "version-1";
const citation = {
  citation_id: "citation-1",
  document_id: documentId,
  document_version_id: versionId,
  page: 1,
  span: { start_char: 0, end_char: 4 },
  quote_sha256: pageHash,
  finding_text: "Finding",
  verified: true,
};

function query(result: unknown) {
  const q: Record<string, ReturnType<typeof vi.fn>> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.order = vi.fn(() => q);
  q.maybeSingle = vi.fn(() => q);
  q.then = vi.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolve),
  );
  return q;
}

function db(results: Record<string, unknown>) {
  return {
    from: vi.fn((table: string) => query(results[table])),
  };
}

const executionRow = {
  id: executionId,
  author_user_id: "author-1",
  organization_id: "org-1",
  matter_id: "matter-1",
  project_id: projectId,
  chat_id: null,
  evidence_version: "evidence-v1",
  workflow_key: "review",
  workflow_version: "1",
  workflow_content_hash: hash,
  workflow_source_commit: "a".repeat(40),
  workflow_distribution: "default",
  workflow_type: "assistant",
  workflow_source: "test",
  workflow_approval_provenance: "approved",
  document_id: documentId,
  document_version_id: versionId,
  document_content_sha256: hash,
  route_provider: "provider",
  route_model: "model",
  credential_ref: "credential",
  status: "succeeded",
};

const outputRow = {
  execution_id: executionId,
  output_format: "markdown",
  output_text: "Output",
  output_sha256: "",
  citation_refs: [citation],
};

const receiptRow = {
  execution_id: executionId,
  idempotency_key: "idem-1",
  receipt_version: "evidence-v1",
  canonical_json: "{}",
  receipt_sha256: hash,
};

async function validEvidenceDatabase(
  overrides: {
    execution?: Record<string, unknown>;
    output?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
  } = {},
) {
  const execution = { ...executionRow, ...overrides.execution };
  const effectiveExecutionId = execution.id as string;
  const effectiveProjectId = execution.project_id as string;
  const effectiveChatId =
    typeof execution.chat_id === "string" ? execution.chat_id : undefined;
  const output = {
    ...outputRow,
    execution_id: effectiveExecutionId,
    output_sha256: sha(outputRow.output_text),
    ...overrides.output,
  };
  const built = buildCanonicalEvidenceReceipt({
    idempotency_key: "idem-1",
    execution_id: effectiveExecutionId,
    provenance: {
      tenant_scope: {
        organization_id: "org-1",
        matter_id: "matter-1",
        project_id: effectiveProjectId,
        ...(effectiveChatId === undefined ? {} : { chat_id: effectiveChatId }),
        document_version_id: versionId,
      },
      input_hashes: [hash],
      output_hashes: [output.output_sha256 as string],
      citation_hashes: [citation.quote_sha256],
      route: {
        provider: "provider",
        model: "model",
        credential_ref: "credential",
      },
      workflow: {
        workflow_key: "review",
        version: "1",
        content_hash: hash,
        source_commit: "a".repeat(40),
        distribution: "default",
        type: "assistant",
        source: "test",
        approval_provenance: "approved",
      },
      status: "completed",
    },
    pages: [
      {
        document_id: documentId,
        document_version_id: versionId,
        page: 1,
        text: "Page",
        text_sha256: citation.quote_sha256,
      },
    ],
    output: {
      execution_id: effectiveExecutionId,
      output_text: output.output_text as string,
      output_sha256: output.output_sha256 as string,
    },
    citations: [citation],
  });
  if (!built.ok) throw new Error("test fixture");
  return db({
    ai_executions: { data: execution, error: null },
    ai_output_versions: { data: output, error: null },
    ai_receipts: {
      data: {
        ...receiptRow,
        execution_id: effectiveExecutionId,
        ...overrides.receipt,
        canonical_json: built.receipt.canonical_json,
        receipt_sha256: built.receipt.receipt_sha256,
      },
      error: null,
    },
  });
}

describe("Supabase AI read repository", () => {
  it.each([
    ["execution id", { execution: { id: "wrong-execution" } }],
    ["project", { execution: { project_id: "wrong-project" } }],
    [
      "legacy evidence version",
      { execution: { evidence_version: "legacy-beta-0.1" } },
    ],
    ["output execution id", { output: { execution_id: "wrong-execution" } }],
    ["receipt execution id", { receipt: { execution_id: "wrong-execution" } }],
  ])("rejects a returned %s identity mismatch", async (_name, overrides) => {
    const database = await validEvidenceDatabase(overrides);
    await expect(
      createSupabaseAiReadRepository(database).loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
  });

  it("rejects a returned chat identity different from the requested chat", async () => {
    const database = await validEvidenceDatabase({
      execution: { chat_id: "chat-2" },
    });

    await expect(
      createSupabaseAiReadRepository(database).loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
        chat_id: "chat-1",
      }),
    ).rejects.toThrow("AI read failed");
  });

  it("loads current execution evidence with exact read shapes", async () => {
    const output = { ...outputRow, output_sha256: "" };
    output.output_sha256 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(output.output_text).digest("hex"),
    );
    const built = buildCanonicalEvidenceReceipt({
      idempotency_key: "idem-1",
      execution_id: executionId,
      provenance: {
        tenant_scope: {
          organization_id: "org-1",
          matter_id: "matter-1",
          project_id: projectId,
          document_version_id: versionId,
        },
        input_hashes: [hash],
        output_hashes: [output.output_sha256],
        citation_hashes: [citation.quote_sha256],
        route: {
          provider: "provider",
          model: "model",
          credential_ref: "credential",
        },
        workflow: {
          workflow_key: "review",
          version: "1",
          content_hash: hash,
          source_commit: "a".repeat(40),
          distribution: "default",
          type: "assistant",
          source: "test",
          approval_provenance: "approved",
        },
        status: "completed",
      },
      pages: [
        {
          document_id: documentId,
          document_version_id: versionId,
          page: 1,
          text: "Page",
          text_sha256: citation.quote_sha256,
        },
      ],
      output: {
        execution_id: executionId,
        output_text: output.output_text,
        output_sha256: output.output_sha256,
      },
      citations: [citation],
    });
    if (!built.ok) throw new Error("test fixture");
    const database = db({
      ai_executions: { data: executionRow, error: null },
      ai_output_versions: { data: output, error: null },
      ai_receipts: {
        data: {
          ...receiptRow,
          canonical_json: built.receipt.canonical_json,
          receipt_sha256: built.receipt.receipt_sha256,
        },
        error: null,
      },
    });

    await expect(
      createSupabaseAiReadRepository(database).loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).resolves.toMatchObject({
      execution: { execution_id: executionId, citations: [citation] },
    });

    expect(database.from).toHaveBeenNthCalledWith(1, "ai_executions");
    const executionQuery = database.from.mock.results[0].value;
    expect(executionQuery.select).toHaveBeenCalledWith(
      "id,author_user_id,organization_id,matter_id,project_id,chat_id,evidence_version,workflow_key,workflow_version,workflow_content_hash,workflow_source_commit,workflow_distribution,workflow_type,workflow_source,workflow_approval_provenance,document_id,document_version_id,document_content_sha256,route_provider,route_model,credential_ref,status",
    );
    expect(executionQuery.eq).toHaveBeenNthCalledWith(1, "id", executionId);
    expect(executionQuery.eq).toHaveBeenNthCalledWith(
      2,
      "project_id",
      projectId,
    );
    expect(executionQuery.eq).toHaveBeenNthCalledWith(
      3,
      "evidence_version",
      "evidence-v1",
    );
    expect(executionQuery.maybeSingle).toHaveBeenCalled();
    expect(executionQuery.select.mock.invocationCallOrder[0]).toBeLessThan(
      executionQuery.maybeSingle.mock.invocationCallOrder[0],
    );
    expect(database.from.mock.results[1].value.maybeSingle).toHaveBeenCalled();
    expect(database.from.mock.results[2].value.maybeSingle).toHaveBeenCalled();
    expect(database.from.mock.results[1].value.select).toHaveBeenCalledWith(
      expect.stringContaining("execution_id"),
    );
    expect(database.from.mock.results[2].value.select).toHaveBeenCalledWith(
      expect.stringContaining("execution_id"),
    );
  });

  it("returns null for a missing primary row and protects detached methods", async () => {
    const database = db({ ai_reviews: { data: null, error: null } });
    const repository = createSupabaseAiReadRepository(database);
    const load = repository.loadReview;
    await expect(
      load({ project_id: projectId, execution_id: executionId }),
    ).resolves.toBeNull();
  });

  it("rejects malformed citation arrays and provider errors with one redacted envelope", async () => {
    const database = db({
      ai_reviews: {
        data: { id: "review-1" },
        error: new Error("table=ai_reviews secret"),
      },
    });
    const repository = createSupabaseAiReadRepository(database);
    await expect(
      repository.loadReview({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
    await expect(
      repository.loadReview({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.not.toThrow(/ai_reviews|secret/);
  });

  it("loads a review with only exact parser fields and one citation", async () => {
    const database = db({
      ai_reviews: {
        data: {
          id: "review-1",
          execution_id: executionId,
          revision: 1,
          execution_author_user_id: "author-1",
          reviewer_user_id: "reviewer-1",
          organization_id: "org-1",
          matter_id: "matter-1",
          project_id: projectId,
          document_id: documentId,
          document_version_id: versionId,
          document_content_sha256: hash,
          evidence_receipt_sha256: hash,
          status: "pending",
        },
        error: null,
      },
      ai_review_items: {
        data: [
          {
            review_id: "review-1",
            item_id: "item-1",
            item_key: "key-1",
            original_text: "Original",
            finding_text: "Finding",
            citation_refs: [citation],
            status: "edited",
            comment: null,
          },
        ],
        error: null,
      },
    });
    const review = await createSupabaseAiReadRepository(database).loadReview({
      project_id: projectId,
      execution_id: executionId,
    });
    expect(review).toMatchObject({
      review_id: "review-1",
      items: [{ item_id: "item-1", citation }],
    });
    expect(review?.items[0]).toEqual({
      item_id: "item-1",
      item_key: "key-1",
      original_text: "Original",
      finding_text: "Finding",
      status: "edited",
      comment: null,
      citation,
    });
    expect(database.from.mock.results[0].value.maybeSingle).toHaveBeenCalled();
  });

  it("rejects a review item returned for another review and selects review_id", async () => {
    const database = db({
      ai_reviews: {
        data: {
          id: "review-1",
          execution_id: executionId,
          revision: 1,
          execution_author_user_id: "author-1",
          reviewer_user_id: "reviewer-1",
          organization_id: "org-1",
          matter_id: "matter-1",
          project_id: projectId,
          document_id: documentId,
          document_version_id: versionId,
          document_content_sha256: hash,
          evidence_receipt_sha256: hash,
          status: "pending",
        },
        error: null,
      },
      ai_review_items: {
        data: [
          {
            review_id: "other-review",
            item_id: "item-1",
            item_key: "key-1",
            original_text: "Original",
            finding_text: "Finding",
            citation_refs: [],
            status: "edited",
            comment: null,
          },
        ],
        error: null,
      },
    });
    await expect(
      createSupabaseAiReadRepository(database).loadReview({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
    const itemQuery = database.from.mock.results[1].value;
    expect(itemQuery.select).toHaveBeenCalledWith(
      expect.stringContaining("review_id"),
    );
  });

  it("rejects a review row that disagrees with the requested scope", async () => {
    const database = db({
      ai_reviews: {
        data: {
          id: "review-1",
          execution_id: "other-execution",
          revision: 1,
          execution_author_user_id: "author-1",
          reviewer_user_id: "reviewer-1",
          organization_id: "org-1",
          matter_id: "matter-1",
          project_id: "other-project",
          document_id: documentId,
          document_version_id: versionId,
          document_content_sha256: hash,
          evidence_receipt_sha256: hash,
          status: "pending",
        },
        error: null,
      },
      ai_review_items: {
        data: [
          {
            review_id: "review-1",
            item_id: "item-1",
            item_key: "finding-1",
            original_text: "Finding",
            finding_text: "Finding",
            citation_refs: [],
            status: "pending",
            comment: null,
          },
        ],
        error: null,
      },
    });

    await expect(
      createSupabaseAiReadRepository(database).loadReview({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
  });

  it("rejects a non-singular array envelope", async () => {
    const database = db({
      ai_reviews: { data: [], error: null },
    });
    const repository = createSupabaseAiReadRepository(database);
    await expect(
      repository.loadReview({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
  });

  it("rejects a non-multi array envelope", async () => {
    const database = db({
      ai_document_version_pages: { data: {}, error: null },
    });
    await expect(
      createSupabaseAiReadRepository(database).loadPages({
        document_version_id: versionId,
      }),
    ).rejects.toThrow("AI read failed");
  });

  it("uses optional chat_id and returns null when the primary execution is absent", async () => {
    const database = db({ ai_executions: { data: null, error: null } });
    await expect(
      createSupabaseAiReadRepository(database).loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
        chat_id: "chat-1",
      }),
    ).resolves.toBeNull();
    const executionQuery = database.from.mock.results[0].value;
    expect(executionQuery.maybeSingle).toHaveBeenCalled();
    expect(executionQuery.eq).toHaveBeenCalledWith("chat_id", "chat-1");
  });

  it("redacts a genuinely thrown query", async () => {
    const database = {
      from: vi.fn(() => {
        throw new Error("secret table=ai_reviews");
      }),
    };
    await expect(
      createSupabaseAiReadRepository(database).loadReview({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
    await expect(
      createSupabaseAiReadRepository(database).loadReview({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.not.toThrow(/secret|ai_reviews/);
  });

  it.each([{ data: null }, { error: null }])(
    "rejects a malformed Supabase envelope",
    async (envelope) => {
      const database = db({ ai_reviews: envelope });
      await expect(
        createSupabaseAiReadRepository(database).loadReview({
          project_id: projectId,
          execution_id: executionId,
        }),
      ).rejects.toThrow("AI read failed");
    },
  );

  it.each([
    {
      documents: { id: documentId, project_id: projectId },
      workspaces: { organization_id: "org-1" },
    },
    {
      documents: [{ id: documentId, project_id: projectId }],
      workspaces: [{ organization_id: "org-1" }],
    },
  ])(
    "loads a historical version with either legal joined relation shape and snapshotted context",
    async ({ documents, workspaces }) => {
      const database = db({
        document_versions: {
          data: {
            id: versionId,
            document_id: documentId,
            content_sha256: hash,
            documents,
          },
          error: null,
        },
        matters: {
          data: {
            id: "matter-1",
            project_id: projectId,
            workspace_id: "workspace-1",
            workspaces,
          },
          error: null,
        },
      });
      const expected = {
        organization_id: "org-1",
        matter_id: "matter-1",
        project_id: projectId,
      };
      const port = createBoundEvidenceResourceScopePort(database, expected);
      expected.project_id = "changed";
      await expect(
        port.getEvidenceResourceScope({ document_version_id: versionId }),
      ).resolves.toEqual({
        organization_id: "org-1",
        matter_id: "matter-1",
        project_id: projectId,
        document_id: documentId,
        document_version_id: versionId,
        document_content_sha256: hash,
      });
      const documentQuery = database.from.mock.results[0].value;
      expect(documentQuery.select).toHaveBeenCalledWith(
        "id,document_id,content_sha256,documents!inner(id,project_id)",
      );
      expect(documentQuery.eq).toHaveBeenCalledWith("id", versionId);
      expect(documentQuery.maybeSingle).toHaveBeenCalled();
      const matterQuery = database.from.mock.results[1].value;
      expect(matterQuery.select).toHaveBeenCalledWith(
        "id,project_id,workspace_id,workspaces!inner(organization_id)",
      );
      expect(matterQuery.eq).toHaveBeenCalledWith("id", "matter-1");
      expect(matterQuery.maybeSingle).toHaveBeenCalled();
    },
  );

  it.each([
    { documents: [], workspaces: { organization_id: "org-1" } },
    {
      documents: [
        { id: documentId, project_id: projectId },
        { id: documentId, project_id: projectId },
      ],
      workspaces: { organization_id: "org-1" },
    },
    { documents: { id: documentId, project_id: projectId }, workspaces: [] },
    {
      documents: { id: documentId, project_id: projectId },
      workspaces: [{ organization_id: "org-1" }, { organization_id: "org-1" }],
    },
  ])(
    "rejects empty or multiple joined relations",
    async ({ documents, workspaces }) => {
      const database = db({
        document_versions: {
          data: {
            id: versionId,
            document_id: documentId,
            content_sha256: hash,
            documents,
          },
          error: null,
        },
        matters: {
          data: { id: "matter-1", project_id: projectId, workspaces },
          error: null,
        },
      });
      await expect(
        createBoundEvidenceResourceScopePort(database, {
          organization_id: "org-1",
          matter_id: "matter-1",
          project_id: projectId,
        }).getEvidenceResourceScope({ document_version_id: versionId }),
      ).rejects.toThrow("AI read failed");
    },
  );

  it("fails closed when a dependent output or receipt is missing or malformed", async () => {
    const primary = { ai_executions: { data: executionRow, error: null } };
    await expect(
      createSupabaseAiReadRepository(
        db({ ...primary, ai_output_versions: { data: null, error: null } }),
      ).loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
    await expect(
      createSupabaseAiReadRepository(
        db({
          ...primary,
          ai_output_versions: { data: outputRow, error: null },
          ai_receipts: { data: null, error: null },
        }),
      ).loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
    await expect(
      createSupabaseAiReadRepository(
        db({
          ...primary,
          ai_output_versions: {
            data: { ...outputRow, output_sha256: hash },
            error: null,
          },
          ai_receipts: { data: receiptRow, error: null },
        }),
      ).loadExecutionEvidence({
        project_id: projectId,
        execution_id: executionId,
      }),
    ).rejects.toThrow("AI read failed");
  });

  it("loads a historical source version and ordered pages with exact reads and hashes", async () => {
    const database = db({
      document_versions: {
        data: { document_id: documentId, id: versionId, content_sha256: hash },
        error: null,
      },
      ai_document_version_pages: {
        data: [
          {
            document_id: documentId,
            document_version_id: versionId,
            page: 1,
            content: "Page",
            content_sha256: pageHash,
          },
          {
            document_id: documentId,
            document_version_id: versionId,
            page: 2,
            content: "Next",
            content_sha256: sha("Next"),
          },
        ],
        error: null,
      },
    });
    const repository = createSupabaseAiReadRepository(database);
    await expect(
      repository.loadSourceVersion({ document_version_id: versionId }),
    ).resolves.toEqual({
      document_id: documentId,
      document_version_id: versionId,
      content_sha256: hash,
    });
    await expect(
      repository.loadPages({ document_version_id: versionId }),
    ).resolves.toEqual([
      {
        document_id: documentId,
        document_version_id: versionId,
        page: 1,
        content: "Page",
        content_sha256: pageHash,
      },
      {
        document_id: documentId,
        document_version_id: versionId,
        page: 2,
        content: "Next",
        content_sha256: sha("Next"),
      },
    ]);
    const versionQuery = database.from.mock.results[0].value;
    expect(versionQuery.select).toHaveBeenCalledWith(
      "document_id,id,content_sha256",
    );
    expect(versionQuery.eq).toHaveBeenCalledWith("id", versionId);
    expect(versionQuery.maybeSingle).toHaveBeenCalled();
    const pagesQuery = database.from.mock.results[1].value;
    expect(pagesQuery.select).toHaveBeenCalledWith(
      "document_id,document_version_id,page,content,content_sha256",
    );
    expect(pagesQuery.eq).toHaveBeenCalledWith(
      "document_version_id",
      versionId,
    );
    expect(pagesQuery.order).toHaveBeenCalledWith("page", { ascending: true });
  });

  it("rejects source and page identities that disagree with their filters", async () => {
    const sourceDatabase = db({
      document_versions: {
        data: {
          document_id: documentId,
          id: "other-version",
          content_sha256: hash,
        },
        error: null,
      },
    });
    await expect(
      createSupabaseAiReadRepository(sourceDatabase).loadSourceVersion({
        document_version_id: versionId,
      }),
    ).rejects.toThrow("AI read failed");

    const pagesDatabase = db({
      ai_document_version_pages: {
        data: [
          {
            document_id: documentId,
            document_version_id: "other-version",
            page: 1,
            content: "Page",
            content_sha256: pageHash,
          },
        ],
        error: null,
      },
    });
    await expect(
      createSupabaseAiReadRepository(pagesDatabase).loadPages({
        document_version_id: versionId,
      }),
    ).rejects.toThrow("AI read failed");
  });

  it.each([
    [[{ page: 1, content: "Page", content_sha256: "bad" }]],
    [[{ page: 0, content: "Page", content_sha256: pageHash }]],
    [
      [
        { page: 2, content: "Page", content_sha256: pageHash },
        { page: 2, content: "Next", content_sha256: sha("Next") },
      ],
    ],
  ])("rejects invalid pages", async (pages) => {
    const database = db({
      ai_document_version_pages: {
        data: pages.map((page) => ({
          document_id: documentId,
          document_version_id: versionId,
          ...page,
        })),
        error: null,
      },
    });
    await expect(
      createSupabaseAiReadRepository(database).loadPages({
        document_version_id: versionId,
      }),
    ).rejects.toThrow("AI read failed");
  });

  it("snapshots scope context and rejects a mismatched joined resource", async () => {
    const database = db({
      document_versions: {
        data: {
          id: versionId,
          document_id: documentId,
          content_sha256: hash,
          documents: { id: documentId, project_id: "other-project" },
        },
        error: null,
      },
      matters: {
        data: {
          id: "matter-1",
          project_id: projectId,
          workspace_id: "workspace-1",
          workspaces: { organization_id: "org-1" },
        },
        error: null,
      },
    });
    const expected = {
      organization_id: "org-1",
      matter_id: "matter-1",
      project_id: projectId,
    };
    const port = createBoundEvidenceResourceScopePort(database, expected);
    expected.project_id = "changed";
    const getScope = port.getEvidenceResourceScope;
    await expect(getScope({ document_version_id: versionId })).rejects.toThrow(
      "AI read failed",
    );
  });
});
