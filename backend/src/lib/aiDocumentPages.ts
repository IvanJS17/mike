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
  if (type === "docx" || type.includes("wordprocessingml")) {
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
  if (source.page_count == null || extracted.length !== source.page_count) {
    return { pages: [], sourceContentSha256 };
  }

  const { data: stored, error } = await db
    .from("ai_document_version_pages")
    .select("page, content, content_sha256")
    .eq("document_id", source.document_id)
    .eq("document_version_id", source.document_version_id)
    .order("page", { ascending: true });
  if (error) throw error;

  const storedPages = (stored ?? []) as {
    page: number;
    content: string;
    content_sha256: string;
  }[];
  if (storedPages.length > 0) {
    const validStoredPages =
      storedPages.length === extracted.length
      && storedPages.every(
        (page, index) =>
          page.page === index + 1
          && page.content === extracted[index]
          && page.content_sha256 === sha256Hex(page.content),
      );
    return {
      pages: validStoredPages
        ? storedPages.map((page) => ({
            page: page.page,
            text: page.content,
            textSha256: page.content_sha256,
          }))
        : [],
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
  if (insertError) throw insertError;
  return {
    pages: rows.map((row) => ({
      page: row.page,
      text: row.content,
      textSha256: row.content_sha256,
    })),
    sourceContentSha256,
  };
}
