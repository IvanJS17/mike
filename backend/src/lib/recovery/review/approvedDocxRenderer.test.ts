import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { approvedDocxRenderer } from "./approvedDocxRenderer";

describe("approved DOCX renderer", () => {
  it("does not change approved bytes with wall-clock time during recovery", async () => {
    const plan = {
      title: "Informe de revisión humana" as const,
      review_id: "review",
      review_revision: 2,
      execution_id: "execution",
      matter_id: "matter",
      project_id: "project",
      document_id: "document",
      document_version_id: "version",
      evidence_receipt_sha256: "a".repeat(64),
      findings: [],
      sections: [{ heading: "Approved", content: "same bytes" }],
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const first = await approvedDocxRenderer.render(plan);
      vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
      expect(await approvedDocxRenderer.render(plan)).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });
  it("produces a real DOCX ZIP containing the approved sections", async () => {
    const bytes = await approvedDocxRenderer.render({
      title: "Informe de revisión humana",
      review_id: "review",
      review_revision: 2,
      execution_id: "execution",
      matter_id: "matter",
      project_id: "project",
      document_id: "document",
      document_version_id: "version",
      evidence_receipt_sha256: "a".repeat(64),
      findings: [],
      sections: [{ heading: "Hallazgos aprobados", content: "Texto aprobado" }],
    });
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("_rels/.rels")).not.toBeNull();
    const document = await zip.file("word/document.xml")!.async("string");
    expect(document).toContain("Hallazgos aprobados");
    expect(document).toContain("Texto aprobado");
  });
});
