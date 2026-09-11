export type SourceDocumentType =
  "docx" | "pdf" | "spreadsheet" | "legislation";

export type SourceDocumentMetadata = {
  label: string;
  value: string;
  format?: "date";
};

export type SourceDocumentAction = {
  type: "download" | "link";
  url: string;
  label: string;
  title?: string;
};

export type SourceDocumentQuote = {
  quote: string;
  verification?: {
    verified: boolean;
    source_excerpt?: string;
    start_char?: number;
    end_char?: number;
  };
  target: {
    page?: number | string;
    sheet?: string;
    cell?: string;
    subdocument_id?: string;
  };
};

export type SourceSubdocument = {
  document_id: string;
  title: string;
  type: "html";
  html?: string | null;
  text?: string | null;
};

export type SourceDocument = {
  document_id: string;
  title: string;
  type: SourceDocumentType;
  metadata: SourceDocumentMetadata[];
  actions?: SourceDocumentAction[];
  quotes: SourceDocumentQuote[];
  subdocuments?: SourceSubdocument[];
  version_id?: string | null;
  version_number?: number | null;
};

export function sourceDocumentType(filename: string): SourceDocumentType {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "docx" || extension === "doc") return "docx";
  if (extension === "xlsx" || extension === "xlsm" || extension === "xls") {
    return "spreadsheet";
  }
  return "pdf";
}
