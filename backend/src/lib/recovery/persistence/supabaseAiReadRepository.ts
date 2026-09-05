import { createHash } from "node:crypto";
import {
  parseBoundEvidenceReceipt,
  parseHumanReview,
  parseHumanReviewExecution,
  type HumanReview,
} from "../review/humanReview";
import type { EvidenceResourceScopePort } from "../evidence/appendOnlyEvidence";

export const AI_READ_FAILURE = "AI read failed";

type QueryResult = { data: unknown; error: unknown };
type FilterQuery = PromiseLike<QueryResult> & {
  eq(column: string, value: unknown): FilterQuery;
  order(column: string, options?: { ascending?: boolean }): FilterQuery;
  maybeSingle(): PromiseLike<QueryResult>;
};
type QueryStart = {
  select(columns: string): FilterQuery;
};
export type SupabaseAiReadClient = { from(table: string): QueryStart };

const EXECUTION_COLUMNS =
  "id,author_user_id,organization_id,matter_id,project_id,chat_id,evidence_version,workflow_key,workflow_version,workflow_content_hash,workflow_source_commit,workflow_distribution,workflow_type,workflow_source,workflow_approval_provenance,document_id,document_version_id,document_content_sha256,route_provider,route_model,credential_ref,status";
const OUTPUT_COLUMNS =
  "execution_id,output_format,output_text,output_sha256,citation_refs";
const RECEIPT_COLUMNS =
  "execution_id,idempotency_key,receipt_version,canonical_json,receipt_sha256";
const REVIEW_COLUMNS =
  "id,execution_id,revision,execution_author_user_id,reviewer_user_id,organization_id,matter_id,project_id,document_id,document_version_id,document_content_sha256,evidence_receipt_sha256,status";
const ITEM_COLUMNS =
  "review_id,item_id,item_key,original_text,finding_text,citation_refs,status,comment";
const PAGE_COLUMNS =
  "document_id,document_version_id,page,content,content_sha256";
const SCOPE_DOCUMENT_COLUMNS =
  "id,document_id,content_sha256,documents!inner(id,project_id)";
const SCOPE_MATTER_COLUMNS =
  "id,project_id,workspace_id,workspaces!inner(organization_id)";
const SHA256_RE = /^[0-9a-f]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeClient(value: unknown): SupabaseAiReadClient {
  if (!record(value) || typeof value.from !== "function") {
    throw new Error(AI_READ_FAILURE);
  }
  const from = value.from;
  return {
    from(table) {
      try {
        const query = from.call(value, table) as unknown;
        if (!record(query) || typeof query.select !== "function") {
          throw new Error();
        }
        return query as QueryStart;
      } catch {
        throw new Error(AI_READ_FAILURE);
      }
    },
  };
}

async function readMany(
  run: () => PromiseLike<QueryResult>,
): Promise<unknown[]> {
  try {
    const result = await run();
    if (
      !record(result) ||
      !Object.prototype.hasOwnProperty.call(result, "data") ||
      !Object.prototype.hasOwnProperty.call(result, "error") ||
      result.error != null ||
      !Array.isArray(result.data)
    )
      throw new Error();
    return result.data;
  } catch {
    throw new Error(AI_READ_FAILURE);
  }
}

async function readOne(
  run: () => PromiseLike<QueryResult>,
  required: boolean,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await run();
    if (
      !record(result) ||
      !Object.prototype.hasOwnProperty.call(result, "data") ||
      !Object.prototype.hasOwnProperty.call(result, "error") ||
      result.error != null
    )
      throw new Error();
    if (result.data === null && !required) return null;
    if (!record(result.data)) throw new Error();
    return result.data;
  } catch {
    throw new Error(AI_READ_FAILURE);
  }
}

function citations(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(AI_READ_FAILURE);
  return value;
}

export function createSupabaseAiReadRepository(client: unknown) {
  const db = normalizeClient(client);
  const loadExecutionEvidence = async (input: {
    project_id: string;
    execution_id: string;
    chat_id?: string;
  }) => {
    try {
      const executionRow = await readOne(() => {
        const query = db
          .from("ai_executions")
          .select(EXECUTION_COLUMNS)
          .eq("id", input.execution_id)
          .eq("project_id", input.project_id)
          .eq("evidence_version", "evidence-v1");
        return (
          input.chat_id === undefined
            ? query
            : query.eq("chat_id", input.chat_id)
        ).maybeSingle();
      }, false);
      if (!executionRow) return null;
      if (
        executionRow.id !== input.execution_id ||
        executionRow.project_id !== input.project_id ||
        executionRow.evidence_version !== "evidence-v1" ||
        (input.chat_id !== undefined && executionRow.chat_id !== input.chat_id)
      )
        throw new Error(AI_READ_FAILURE);
      const output = await readOne(
        () =>
          db
            .from("ai_output_versions")
            .select(OUTPUT_COLUMNS)
            .eq("execution_id", input.execution_id)
            .maybeSingle(),
        true,
      );
      const receiptRow = await readOne(
        () =>
          db
            .from("ai_receipts")
            .select(RECEIPT_COLUMNS)
            .eq("execution_id", input.execution_id)
            .eq("receipt_version", "evidence-v1")
            .maybeSingle(),
        true,
      );
      if (!output || !receiptRow) throw new Error(AI_READ_FAILURE);
      if (output.execution_id !== executionRow.id)
        throw new Error(AI_READ_FAILURE);
      if (receiptRow.execution_id !== executionRow.id)
        throw new Error(AI_READ_FAILURE);
      const execution = parseHumanReviewExecution({
        execution_id: executionRow.id,
        author_user_id: executionRow.author_user_id,
        status: executionRow.status,
        organization_id: executionRow.organization_id,
        matter_id: executionRow.matter_id,
        project_id: executionRow.project_id,
        ...(executionRow.chat_id == null
          ? {}
          : { chat_id: executionRow.chat_id }),
        document_id: executionRow.document_id,
        document_version_id: executionRow.document_version_id,
        document_content_sha256: executionRow.document_content_sha256,
        evidence_receipt_sha256: receiptRow.receipt_sha256,
        output_text: output.output_text,
        output_sha256: output.output_sha256,
        citations: citations(output.citation_refs),
      });
      if (!execution) throw new Error(AI_READ_FAILURE);
      const evidence_receipt = parseBoundEvidenceReceipt(
        {
          receipt_version: receiptRow.receipt_version,
          canonical_json: receiptRow.canonical_json,
          receipt_sha256: receiptRow.receipt_sha256,
        },
        execution,
      );
      if (!evidence_receipt) throw new Error(AI_READ_FAILURE);
      return { execution, evidence_receipt };
    } catch (error) {
      if (error instanceof Error && error.message === AI_READ_FAILURE)
        throw error;
      throw new Error(AI_READ_FAILURE);
    }
  };

  const loadReview = async (input: {
    project_id: string;
    execution_id: string;
  }): Promise<HumanReview | null> => {
    try {
      const reviewRow = await readOne(
        () =>
          db
            .from("ai_reviews")
            .select(REVIEW_COLUMNS)
            .eq("execution_id", input.execution_id)
            .eq("project_id", input.project_id)
            .maybeSingle(),
        false,
      );
      if (!reviewRow) return null;
      if (
        reviewRow.execution_id !== input.execution_id ||
        reviewRow.project_id !== input.project_id
      )
        throw new Error(AI_READ_FAILURE);
      const itemRows = await readMany(() =>
        db
          .from("ai_review_items")
          .select(ITEM_COLUMNS)
          .eq("review_id", reviewRow.id)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
      );
      const items = itemRows.map((item) => {
        if (!record(item)) throw new Error(AI_READ_FAILURE);
        if (item.review_id !== reviewRow.id) throw new Error(AI_READ_FAILURE);
        const refs = citations(item.citation_refs);
        if (refs.length > 1) throw new Error(AI_READ_FAILURE);
        return {
          item_id: item.item_id,
          item_key: item.item_key,
          original_text: item.original_text,
          finding_text: item.finding_text,
          status: item.status,
          comment: item.comment ?? null,
          citation: refs.length === 0 ? null : refs[0],
        };
      });
      const { id, ...reviewFields } = reviewRow;
      const review = parseHumanReview({
        ...reviewFields,
        review_id: id,
        items,
      });
      if (!review) throw new Error(AI_READ_FAILURE);
      return review;
    } catch (error) {
      if (error instanceof Error && error.message === AI_READ_FAILURE)
        throw error;
      throw new Error(AI_READ_FAILURE);
    }
  };

  const loadSourceVersion = async (input: { document_version_id: string }) => {
    try {
      const row = await readOne(
        () =>
          db
            .from("document_versions")
            .select("document_id,id,content_sha256")
            .eq("id", input.document_version_id)
            .maybeSingle(),
        false,
      );
      if (!row) return null;
      if (
        typeof row.document_id !== "string" ||
        row.id !== input.document_version_id ||
        typeof row.content_sha256 !== "string" ||
        !SHA256_RE.test(row.content_sha256)
      )
        throw new Error(AI_READ_FAILURE);
      return {
        document_id: row.document_id,
        document_version_id: row.id,
        content_sha256: row.content_sha256,
      };
    } catch {
      throw new Error(AI_READ_FAILURE);
    }
  };

  const loadPages = async (input: { document_version_id: string }) => {
    try {
      const rows = await readMany(() =>
        db
          .from("ai_document_version_pages")
          .select(PAGE_COLUMNS)
          .eq("document_version_id", input.document_version_id)
          .order("page", { ascending: true }),
      );
      let previous = 0;
      return rows.map((row) => {
        if (
          !record(row) ||
          typeof row.document_id !== "string" ||
          row.document_version_id !== input.document_version_id ||
          typeof row.page !== "number" ||
          !Number.isInteger(row.page) ||
          row.page <= previous ||
          typeof row.content !== "string" ||
          typeof row.content_sha256 !== "string" ||
          !SHA256_RE.test(row.content_sha256) ||
          createHash("sha256").update(row.content).digest("hex") !==
            row.content_sha256
        )
          throw new Error(AI_READ_FAILURE);
        previous = row.page;
        return {
          document_id: row.document_id,
          document_version_id: row.document_version_id,
          page: row.page,
          content: row.content,
          content_sha256: row.content_sha256,
        };
      });
    } catch {
      throw new Error(AI_READ_FAILURE);
    }
  };

  return { loadExecutionEvidence, loadReview, loadSourceVersion, loadPages };
}

export function createBoundEvidenceResourceScopePort(
  client: unknown,
  expected: { organization_id: string; matter_id: string; project_id: string },
): EvidenceResourceScopePort {
  const db = normalizeClient(client);
  const bound = Object.freeze({ ...expected });
  return {
    getEvidenceResourceScope: async ({ document_version_id }) => {
      try {
        const row = await readOne(
          () =>
            db
              .from("document_versions")
              .select(SCOPE_DOCUMENT_COLUMNS)
              .eq("id", document_version_id)
              .maybeSingle(),
          false,
        );
        if (!row) throw new Error(AI_READ_FAILURE);
        const relation = (value: unknown): Record<string, unknown> => {
          if (record(value)) return value;
          if (Array.isArray(value) && value.length === 1 && record(value[0]))
            return value[0];
          throw new Error(AI_READ_FAILURE);
        };
        const documents = relation(row.documents);
        const matter = await readOne(
          () =>
            db
              .from("matters")
              .select(SCOPE_MATTER_COLUMNS)
              .eq("id", bound.matter_id)
              .maybeSingle(),
          true,
        );
        if (!matter) throw new Error(AI_READ_FAILURE);
        const workspace = relation(matter.workspaces);
        if (
          row.id !== document_version_id ||
          documents.id !== row.document_id ||
          documents.project_id !== bound.project_id ||
          matter.id !== bound.matter_id ||
          matter.project_id !== bound.project_id ||
          workspace.organization_id !== bound.organization_id ||
          typeof row.document_id !== "string" ||
          typeof row.content_sha256 !== "string" ||
          !SHA256_RE.test(row.content_sha256)
        )
          throw new Error(AI_READ_FAILURE);
        return {
          organization_id: bound.organization_id,
          matter_id: bound.matter_id,
          project_id: bound.project_id,
          document_id: row.document_id,
          document_version_id,
          document_content_sha256: row.content_sha256,
        };
      } catch (error) {
        if (error instanceof Error && error.message === AI_READ_FAILURE)
          throw error;
        throw new Error(AI_READ_FAILURE);
      }
    },
  };
}
