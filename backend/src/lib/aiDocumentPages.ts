import type { createServerSupabase } from "./supabase";
import { downloadFile } from "./storage";
import { sha256Hex } from "./aiReceipts";
import { STANDARD_FONT_DATA_URL } from "./chat/types";

export type AiDocumentVersionPage = {
  page: number;
  text: string;
  textSha256: string;
};

export type AiDocumentVersionPagesResult = {
  pages: AiDocumentVersionPage[];
  sourceContentSha256: string | null;
};

type Db = ReturnType<typeof createServerSupabase>;

type VersionSource = {
  document_id: string;
  document_version_id: string;
  content_sha256: string;
  storage_path?: string | null;
  file_type?: string | null;
  page_count: number | null;
};

type StoredPageRow = {
  page: number;
  content: string;
  content_sha256: string;
};

/** DOCX bytes have no physical pages: a valid extraction is exactly one logical page. */
export function isDocxFileType(fileType: string | null | undefined): boolean {
  const type = (fileType ?? "").toLowerCase();
  return type === "docx" || type.includes("wordprocessingml");
}

function storedPagesMatch(
  stored: StoredPageRow[],
  extracted: string[],
): boolean {
  return (
    stored.length === extracted.length
    && stored.every(
      (page, index) =>
        page.page === index + 1
        && page.content === extracted[index]
        && page.content_sha256 === sha256Hex(page.content),
    )
  );
}

function storedPagesToResult(
  stored: StoredPageRow[],
): AiDocumentVersionPage[] {
  return stored.map((page) => ({
    page: page.page,
    text: page.content,
    textSha256: page.content_sha256,
  }));
}

async function extractPdfPages(bytes: ArrayBuffer): Promise<string[]> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  const pdf = await (
    pdfjsLib as unknown as {
      getDocument: (opts: unknown) => {
        promise: Promise<{
          numPages: number;
          getPage: (page: number) => Promise<{
            getTextContent: () => Promise<{ items: { str?: string }[] }>;
          }>;
        }>;
      };
    }
  ).getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pages: string[] = [];
  for (let page = 1; page <= pdf.numPages; page += 1) {
    const source = await pdf.getPage(page);
    const content = await source.getTextContent();
    pages.push(content.items.map((item) => item.str ?? "").join(" "));
  }
  return pages;
}

async function extractPagesFromBytes(
  source: VersionSource,
  raw: ArrayBuffer,
): Promise<string[]> {
  const type = (source.file_type ?? "").toLowerCase();
  if (type === "pdf" || type === "application/pdf") {
    try {
      return await extractPdfPages(raw);
    } catch {
      return [];
    }
  }
  if (isDocxFileType(source.file_type)) {
    try {
      const mammoth = await import("mammoth");
      const extracted = await mammoth.extractRawText({ buffer: Buffer.from(raw) });
      return extracted.value ? [extracted.value] : [];
    } catch {
      return [];
    }
  }
  const text = Buffer.from(raw).toString("utf8");
  return text ? [text] : [];
}

export async function loadAiDocumentVersionPages(
  db: Db,
  source: VersionSource,
): Promise<AiDocumentVersionPagesResult> {
  if (!source.storage_path || !/^[a-f0-9]{64}$/.test(source.content_sha256)) {
    return { pages: [], sourceContentSha256: null };
  }

  const raw = await downloadFile(source.storage_path);
  if (!raw) return { pages: [], sourceContentSha256: null };
  const sourceContentSha256 = sha256Hex(raw);
  if (sourceContentSha256 !== source.content_sha256) {
    return { pages: [], sourceContentSha256 };
  }

  const extracted = await extractPagesFromBytes(source, raw);
  if (extracted.length === 0) return { pages: [], sourceContentSha256 };
  // DOCX uploads record page_count=null; a valid, hash-verified extraction
  // defines exactly one logical page. Every other type stays fail-closed:
  // page_count is required and must match the extracted pages.
  const isDocx = isDocxFileType(source.file_type);
  if (
    (!isDocx && source.page_count == null)
    || (source.page_count != null && extracted.length !== source.page_count)
  ) {
    return { pages: [], sourceContentSha256 };
  }

  const { data: stored, error } = await db
    .from("ai_document_version_pages")
    .select("page, content, content_sha256")
    .eq("document_id", source.document_id)
    .eq("document_version_id", source.document_version_id)
    .order("page", { ascending: true });
  if (error) throw error;

  const storedPages = (stored ?? []) as StoredPageRow[];
  if (storedPages.length > 0) {
    if (!storedPagesMatch(storedPages, extracted)) {
      return { pages: [], sourceContentSha256 };
    }
    return {
      pages: storedPagesToResult(storedPages),
      sourceContentSha256,
    };
  }

  const rows = extracted.map((text, index) => ({
    document_id: source.document_id,
    document_version_id: source.document_version_id,
    page: index + 1,
    content: text,
    content_sha256: sha256Hex(text),
  }));
  const { error: insertError } = await db
    .from("ai_document_version_pages")
    .insert(rows);
  if (insertError) {
    // A concurrent execution may have persisted identical pages between our
    // read and our insert (the (document_version_id, page) unique index
    // rejects the duplicate). Re-read and verify: if the stored pages are
    // byte-identical to this extraction, both runs succeed; otherwise the
    // insert failure propagates and the execution fails closed.
    const { data: concurrentStored, error: rereadError } = await db
      .from("ai_document_version_pages")
      .select("page, content, content_sha256")
      .eq("document_id", source.document_id)
      .eq("document_version_id", source.document_version_id)
      .order("page", { ascending: true });
    if (
      !rereadError
      && storedPagesMatch((concurrentStored ?? []) as StoredPageRow[], extracted)
    ) {
      return {
        pages: storedPagesToResult((concurrentStored ?? []) as StoredPageRow[]),
        sourceContentSha256,
      };
    }
    throw insertError;
  }
  return {
    pages: rows.map((row) => ({
      page: row.page,
      text: row.content,
      textSha256: row.content_sha256,
    })),
    sourceContentSha256,
  };
}
