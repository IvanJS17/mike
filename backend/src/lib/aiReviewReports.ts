import { canonicalJson, sha256Hex } from "./aiReceipts";

export type AiReviewReportFindingStatus = "accepted" | "rejected" | "edited";

export type AiReviewReportSection = {
  heading: string;
  content: string;
};

export type AiReviewReportInput = {
  execution: {
    id: string;
    matter_id: string | null;
    project_id: string;
    document_id: string;
    document_version_id: string;
    status: string;
  };
  review: {
    id: string;
    execution_id: string;
    matter_id: string;
    project_id: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  };
  items: {
    item_key: string;
    finding_text: string;
    status: string;
    citation_refs: unknown[];
  }[];
  receipt: {
    id: string;
    execution_id: string;
    receipt_version: string;
    canonical_json: unknown;
    receipt_sha256: string;
  } | null;
};

export type AiReviewReportErrorCode =
  | "execution_not_succeeded"
  | "review_not_approved"
  | "scope_mismatch"
  | "no_findings"
  | "pending_finding"
  | "unverified_citation"
  | "receipt_unavailable"
  | "receipt_invalid";

type VerifiedCitation = {
  citation_id: string;
  document_version_id: string;
  page: number;
  span: { start_char: number; end_char: number };
  quote_sha256: string;
  verified: true;
};

type PreparedFinding = {
  item_key: string;
  finding_text: string;
  status: AiReviewReportFindingStatus;
  citations: VerifiedCitation[];
};

export type PreparedAiReviewReport = {
  ok: true;
  filename: "Informe de revision humana.docx";
  sections: AiReviewReportSection[];
  findings: PreparedFinding[];
  receipt: {
    id: string;
    receipt_version: string;
    receipt_sha256: string;
  };
};

export type AiReviewReportPreparation =
  | PreparedAiReviewReport
  | { ok: false; code: AiReviewReportErrorCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function citationFromUnknown(
  value: unknown,
  documentVersionId: string,
): VerifiedCitation | null {
  if (!isRecord(value) || value.verified !== true) return null;
  const span = value.span;
  if (!isRecord(span)) return null;
  if (
    typeof value.citation_id !== "string" ||
    !value.citation_id.trim() ||
    value.document_version_id !== documentVersionId ||
    !Number.isInteger(value.page) ||
    (value.page as number) < 1 ||
    !Number.isInteger(span.start_char) ||
    !Number.isInteger(span.end_char) ||
    (span.start_char as number) < 0 ||
    (span.end_char as number) <= (span.start_char as number) ||
    !isSha256(value.quote_sha256)
  ) {
    return null;
  }
  return {
    citation_id: value.citation_id.trim(),
    document_version_id: documentVersionId,
    page: value.page as number,
    span: {
      start_char: span.start_char as number,
      end_char: span.end_char as number,
    },
    quote_sha256: value.quote_sha256,
    verified: true,
  };
}

function prepareSections(
  input: AiReviewReportInput,
  findings: PreparedFinding[],
): AiReviewReportSection[] {
  const findingLines = findings.map((finding, index) => {
    const label =
      finding.status === "accepted"
        ? "Aceptado"
        : finding.status === "edited"
          ? "Editado"
          : "Rechazado";
    const text =
      finding.status === "rejected"
        ? "No incluido por decisión del revisor."
        : finding.finding_text;
    return [`${index + 1}. ${finding.item_key} — ${label}`, text].join("\n");
  });
  const citations = findings
    .filter((finding) => finding.status !== "rejected")
    .flatMap((finding) =>
      finding.citations.map((citation) =>
        [
          `Cita ${citation.citation_id}`,
          `Versión: ${citation.document_version_id}`,
          `Página: ${citation.page}`,
          `Rango: ${citation.span.start_char}-${citation.span.end_char}`,
          `Quote SHA-256: ${citation.quote_sha256}`,
          "Verificada: sí",
        ].join(" · "),
      ),
    );

  return [
    {
      heading: "Identificación",
      content: [
        `Matter ID: ${input.review.matter_id}`,
        `Review ID: ${input.review.id}`,
        `Execution ID: ${input.execution.id}`,
        `Project ID: ${input.review.project_id}`,
        `Versión analizada: ${input.execution.document_version_id}`,
      ].join("\n"),
    },
    {
      heading: "Hallazgos finales",
      content: findingLines.join("\n\n"),
    },
    {
      heading: "Citas verificadas",
      content:
        citations.length > 0
          ? citations.join("\n")
          : "No se registraron citas.",
    },
    {
      heading: "Referencia del receipt",
      content: [
        `Receipt ID: ${input.receipt?.id ?? ""}`,
        `Receipt version: ${input.receipt?.receipt_version ?? ""}`,
        `Receipt SHA-256: ${input.receipt?.receipt_sha256 ?? ""}`,
      ].join("\n"),
    },
  ];
}

export function prepareAiReviewReport(
  input: AiReviewReportInput,
): AiReviewReportPreparation {
  if (input.execution.status !== "succeeded") {
    return { ok: false, code: "execution_not_succeeded" };
  }
  if (input.review.status !== "approved") {
    return { ok: false, code: "review_not_approved" };
  }
  if (
    input.execution.matter_id === null ||
    input.review.execution_id !== input.execution.id ||
    input.review.matter_id !== input.execution.matter_id ||
    input.review.project_id !== input.execution.project_id
  ) {
    return { ok: false, code: "scope_mismatch" };
  }
  if (input.items.length === 0) return { ok: false, code: "no_findings" };
  if (!input.receipt) return { ok: false, code: "receipt_unavailable" };
  if (
    input.receipt.execution_id !== input.execution.id ||
    !isSha256(input.receipt.receipt_sha256) ||
    sha256Hex(canonicalJson(input.receipt.canonical_json)) !==
      input.receipt.receipt_sha256
  ) {
    return { ok: false, code: "receipt_invalid" };
  }

  const findings: PreparedFinding[] = [];
  for (const item of input.items) {
    if (
      item.status !== "accepted" &&
      item.status !== "rejected" &&
      item.status !== "edited"
    ) {
      return { ok: false, code: "pending_finding" };
    }
    const citations = item.citation_refs.map((citation) =>
      citationFromUnknown(citation, input.execution.document_version_id),
    );
    if (citations.some((citation) => citation === null)) {
      return { ok: false, code: "unverified_citation" };
    }
    findings.push({
      item_key: item.item_key,
      finding_text: item.finding_text,
      status: item.status,
      citations: citations as VerifiedCitation[],
    });
  }

  return {
    ok: true,
    filename: "Informe de revision humana.docx",
    sections: prepareSections(input, findings),
    findings,
    receipt: {
      id: input.receipt.id,
      receipt_version: input.receipt.receipt_version,
      receipt_sha256: input.receipt.receipt_sha256,
    },
  };
}
