import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../aiReceipts";
import {
  prepareAiReviewReport,
  type AiReviewReportInput,
} from "../aiReviewReports";

const receiptJson = {
  receipt_version: "beta-0.1",
  execution_id: "execution-1",
  input: {
    document_version_id: "source-version-1",
  },
  result: { status: "succeeded" },
};

const receiptDigest = sha256Hex(canonicalJson(receiptJson));

const baseInput: AiReviewReportInput = {
  execution: {
    id: "execution-1",
    matter_id: "matter-1",
    project_id: "project-1",
    document_id: "document-1",
    document_version_id: "source-version-1",
    status: "succeeded",
  },
  review: {
    id: "review-1",
    execution_id: "execution-1",
    matter_id: "matter-1",
    project_id: "project-1",
    status: "approved",
    created_at: "2026-08-19T12:00:00.000Z",
    completed_at: "2026-08-19T12:05:00.000Z",
  },
  items: [
    {
      item_key: "accepted-1",
      finding_text: "La cláusula permite terminar el contrato.",
      status: "accepted",
      citation_refs: [
        {
          citation_id: "c1",
          document_version_id: "source-version-1",
          page: 2,
          span: { start_char: 4, end_char: 16 },
          quote_sha256: "a".repeat(64),
          verified: true,
        },
      ],
    },
    {
      item_key: "edited-1",
      finding_text: "El aviso final es de treinta días.",
      status: "edited",
      citation_refs: [],
    },
    {
      item_key: "rejected-1",
      finding_text: "ESTE HALLAZGO FUE DESCARTADO Y NO DEBE APARECER",
      status: "rejected",
      citation_refs: [],
    },
  ],
  receipt: {
    id: "receipt-1",
    execution_id: "execution-1",
    receipt_version: "beta-0.1",
    canonical_json: receiptJson,
    receipt_sha256: receiptDigest,
  },
};

describe("AI review report preparation", () => {
  it("includes only final findings, verified citation metadata, and receipt digest", () => {
    const input = baseInput;
    const result = prepareAiReviewReport(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.sections
      .map((section) => section.content ?? "")
      .join("\n");

    expect(content).toContain("La cláusula permite terminar el contrato.");
    expect(content).toContain("El aviso final es de treinta días.");
    expect(content).toContain("c1");
    expect(content).toContain("source-version-1");
    expect(content).toContain("receipt-1");
    expect(content).toContain(receiptDigest);
    expect(content).toContain("Rechazado");
    expect(content).not.toContain("ESTE HALLAZGO FUE DESCARTADO");
    expect(content).not.toMatch(
      /prompt|api[_ -]?key|secret|storage_path|generated\//i,
    );
  });

  it("does not carry rejected finding citations into the final citation section", () => {
    const result = prepareAiReviewReport({
      ...baseInput,
      items: [
        ...baseInput.items,
        {
          item_key: "rejected-2",
          finding_text: "Contenido descartado",
          status: "rejected",
          citation_refs: [
            {
              citation_id: "rejected-citation",
              document_version_id: "source-version-1",
              page: 4,
              span: { start_char: 0, end_char: 8 },
              quote_sha256: "b".repeat(64),
              verified: true,
            },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.sections
      .map((section) => section.content)
      .join("\\n");
    expect(content).not.toContain("rejected-citation");
  });

  it.each([
    [
      "review_not_approved",
      { review: { ...baseInput.review, status: "in_progress" } },
    ],
    [
      "execution_not_succeeded",
      { execution: { ...baseInput.execution, status: "failed" } },
    ],
    [
      "scope_mismatch",
      { review: { ...baseInput.review, matter_id: "other-matter" } },
    ],
    [
      "pending_finding",
      {
        items: [
          {
            ...baseInput.items[0],
            status: "pending",
          },
        ],
      },
    ],
    [
      "unverified_citation",
      {
        items: [
          {
            ...baseInput.items[0],
            citation_refs: [{ verified: false }],
          },
        ],
      },
    ],
  ] as const)(
    "rejects %s before a file can be generated",
    (_code, override) => {
      const input = {
        ...baseInput,
        ...override,
        receipt: { ...baseInput.receipt },
      } as AiReviewReportInput;
      const result = prepareAiReviewReport(input);
      expect(result).toMatchObject({ ok: false, code: _code });
    },
  );
});
