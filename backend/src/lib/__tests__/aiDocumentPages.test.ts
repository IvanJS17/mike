import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { sha256Hex } from "../aiReceipts";
import { loadAiDocumentVersionPages } from "../aiDocumentPages";
import type { createServerSupabase } from "../supabase";

type Db = ReturnType<typeof createServerSupabase>;

const { downloadFile } = vi.hoisted(() => ({
  downloadFile: vi.fn(),
}));

vi.mock("../storage", () => ({
  downloadFile,
}));

const DOCX_TEXT = "Cláusula uno de prueba.\n\nCláusula dos de prueba.\n\n";
const PDF_PAGE_1 = "page 1 content";
const PDF_PAGE_2 = "page 2 content";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (pageNumber: number) => ({
        getTextContent: async () => ({
          items: [{ str: `page ${pageNumber} content` }],
        }),
      }),
    }),
  })),
}));

async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      `<w:p><w:r><w:t xml:space="preserve">Cláusula uno de prueba.</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t xml:space="preserve">Cláusula dos de prueba.</w:t></w:r></w:p>` +
      `</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

type Rows = Record<string, Record<string, unknown>[]>;

function makeDb() {
  const writes: { table: string; operation: string; payload?: unknown }[] = [];
  const rows: Rows = {
    ai_document_version_pages: [],
  };
  let failNextInsert = false;

  function queryFor(table: string) {
    let current = [...((rows[table] ?? []) as Record<string, unknown>[])];
    let inserted: Record<string, unknown> | null = null;
    let insertError: Error | null = null;
    const query: Record<string, any> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn((column: string, value: unknown) => {
      current = current.filter((row) => row[column] === value);
      return query;
    });
    query.is = vi.fn((column: string, value: unknown) => {
      current = current.filter((row) => (row[column] ?? null) === value);
      return query;
    });
    query.order = vi.fn(() => query);
    query.limit = vi.fn(() => query);
    query.insert = vi.fn((payload: Record<string, unknown>) => {
      inserted = payload;
      writes.push({ table, operation: "insert", payload });
      const items = (Array.isArray(payload) ? payload : [payload]) as Record<
        string,
        unknown
      >[];
      (rows[table] as Record<string, unknown>[]).push(...items);
      if (failNextInsert) {
        failNextInsert = false;
        // Simulate the concurrent winner: its rows land in storage between
        // our read and our insert, and the unique index rejects ours.
        insertError = new Error(
          'duplicate key value violates unique constraint "ai_document_version_pages_version_page_key"',
        );
      }
      return query;
    });
    query.update = vi.fn((_payload: Record<string, unknown>) => query);
    query.single = vi.fn(async () => ({ data: current[0] ?? null, error: null }));
    query.maybeSingle = query.single;
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) =>
      Promise.resolve({ data: current, error: insertError }).then(
        resolve,
        reject,
      );
    return query;
  }

  const db = {
    from: vi.fn((table: string) => queryFor(table)),
  } as unknown as Db;
  return { db, rows, writes, failNextInsert: () => { failNextInsert = true; } };
}

const BASE_SOURCE = {
  document_id: "document-1",
  document_version_id: "version-1",
  storage_path: "storage/document-1/version-1.docx",
};

describe("loadAiDocumentVersionPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists exactly one logical page for a DOCX with a null page count", async () => {
    const bytes = await makeDocx();
    downloadFile.mockResolvedValue(toArrayBuffer(bytes));
    const { db, rows, writes } = makeDb();

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(bytes),
      file_type: "docx",
      page_count: null,
    });

    expect(result.sourceContentSha256).toBe(sha256Hex(bytes));
    expect(result.pages).toEqual([
      { page: 1, text: DOCX_TEXT, textSha256: sha256Hex(DOCX_TEXT) },
    ]);
    const pageInserts = writes.filter(
      (write) =>
        write.table === "ai_document_version_pages"
        && write.operation === "insert",
    );
    expect(pageInserts).toHaveLength(1);
    expect(pageInserts[0]?.payload).toEqual([
      {
        document_id: "document-1",
        document_version_id: "version-1",
        page: 1,
        content: DOCX_TEXT,
        content_sha256: sha256Hex(DOCX_TEXT),
      },
    ]);
    expect(rows.ai_document_version_pages).toHaveLength(1);
  });

  it("reuses verified stored pages without inserting duplicates (idempotent)", async () => {
    const bytes = await makeDocx();
    downloadFile.mockResolvedValue(toArrayBuffer(bytes));
    const { db, rows, writes } = makeDb();
    rows.ai_document_version_pages = [
      {
        document_id: "document-1",
        document_version_id: "version-1",
        page: 1,
        content: DOCX_TEXT,
        content_sha256: sha256Hex(DOCX_TEXT),
      },
    ];

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(bytes),
      file_type: "docx",
      page_count: null,
    });

    expect(result.pages).toEqual([
      { page: 1, text: DOCX_TEXT, textSha256: sha256Hex(DOCX_TEXT) },
    ]);
    expect(
      writes.filter((write) => write.table === "ai_document_version_pages"),
    ).toHaveLength(0);
  });

  it("fails closed on stored pages that do not match the extraction", async () => {
    const bytes = await makeDocx();
    downloadFile.mockResolvedValue(toArrayBuffer(bytes));
    const { db, rows } = makeDb();
    rows.ai_document_version_pages = [
      {
        document_id: "document-1",
        document_version_id: "version-1",
        page: 1,
        content: "texto manipulado",
        content_sha256: sha256Hex("texto manipulado"),
      },
    ];

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(bytes),
      file_type: "docx",
      page_count: null,
    });

    expect(result).toEqual({
      pages: [],
      sourceContentSha256: sha256Hex(bytes),
    });
  });

  it("recovers when a concurrent execution persisted identical pages first", async () => {
    const bytes = await makeDocx();
    downloadFile.mockResolvedValue(toArrayBuffer(bytes));
    const { db, rows, writes, failNextInsert } = makeDb();

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(bytes),
      file_type: "docx",
      page_count: null,
    });

    // First run: clean insert, no race fired.
    expect(result.pages).toEqual([
      { page: 1, text: DOCX_TEXT, textSha256: sha256Hex(DOCX_TEXT) },
    ]);
    expect(rows.ai_document_version_pages).toHaveLength(1);
    expect(
      writes.filter((write) => write.table === "ai_document_version_pages"),
    ).toHaveLength(1);

    // Second run: the select races ahead of the concurrent winner (still
    // sees no rows), then the insert collides with the row the winner
    // persisted in between; the lib re-reads, verifies byte identity and
    // reuses the stored page without error.
    rows.ai_document_version_pages = [];
    failNextInsert();
    const second = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(bytes),
      file_type: "docx",
      page_count: null,
    });

    expect(second.pages).toEqual([
      { page: 1, text: DOCX_TEXT, textSha256: sha256Hex(DOCX_TEXT) },
    ]);
    expect(rows.ai_document_version_pages).toHaveLength(1);
    expect(
      writes.filter((write) => write.table === "ai_document_version_pages"),
    ).toHaveLength(2);
  });

  it("fails closed on a corrupt DOCX", async () => {
    const corrupt = Buffer.from("not a zip file at all");
    downloadFile.mockResolvedValue(toArrayBuffer(corrupt));
    const { db } = makeDb();

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(corrupt),
      file_type: "docx",
      page_count: null,
    });

    expect(result).toEqual({
      pages: [],
      sourceContentSha256: sha256Hex(corrupt),
    });
  });

  it("requires a declared page count for PDF and fails on null", async () => {
    const bytes = Buffer.from("fake pdf bytes");
    downloadFile.mockResolvedValue(toArrayBuffer(bytes));
    const { db, rows } = makeDb();

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(bytes),
      file_type: "pdf",
      page_count: null,
    });

    expect(result).toEqual({
      pages: [],
      sourceContentSha256: sha256Hex(bytes),
    });
    expect(rows.ai_document_version_pages).toHaveLength(0);
  });

  it("fails closed when the PDF page count does not match the extracted pages", async () => {
    const bytes = Buffer.from("fake pdf bytes");
    downloadFile.mockResolvedValue(toArrayBuffer(bytes));
    const { db, rows } = makeDb();

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(bytes),
      file_type: "pdf",
      page_count: 1,
    });

    expect(result).toEqual({
      pages: [],
      sourceContentSha256: sha256Hex(bytes),
    });
    expect(rows.ai_document_version_pages).toHaveLength(0);
  });

  it("accepts a PDF whose declared page count matches the extraction", async () => {
    const bytes = Buffer.from("fake pdf bytes");
    downloadFile.mockResolvedValue(toArrayBuffer(bytes));
    const { db, rows } = makeDb();

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: sha256Hex(bytes),
      file_type: "pdf",
      page_count: 2,
    });

    expect(result.sourceContentSha256).toBe(sha256Hex(bytes));
    expect(result.pages).toEqual([
      { page: 1, text: PDF_PAGE_1, textSha256: sha256Hex(PDF_PAGE_1) },
      { page: 2, text: PDF_PAGE_2, textSha256: sha256Hex(PDF_PAGE_2) },
    ]);
    expect(rows.ai_document_version_pages).toHaveLength(2);
  });

  it("fails closed when stored bytes do not match the frozen content hash", async () => {
    const stored = Buffer.from("stored bytes");
    const frozenContentSha256 = sha256Hex(Buffer.from("other frozen bytes"));
    downloadFile.mockResolvedValue(toArrayBuffer(stored));
    const { db, rows } = makeDb();

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      content_sha256: frozenContentSha256,
      file_type: "docx",
      page_count: null,
    });

    expect(result).toEqual({
      pages: [],
      sourceContentSha256: sha256Hex(stored),
    });
    expect(rows.ai_document_version_pages).toHaveLength(0);
  });

  it("fails closed without a storage path or a valid content hash", async () => {
    const { db } = makeDb();

    const result = await loadAiDocumentVersionPages(db, {
      ...BASE_SOURCE,
      storage_path: null,
      content_sha256: sha256Hex(await makeDocx()),
      file_type: "docx",
      page_count: null,
    });

    expect(result).toEqual({ pages: [], sourceContentSha256: null });
  });
});