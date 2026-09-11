import JSZip from "jszip";

import type {
  ApprovedDocxRendererPort,
  ApprovedReviewReportPlan,
} from "./approvedReviewReport";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function paragraph(value: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`;
}

export class ApprovedDocxRenderer implements ApprovedDocxRendererPort {
  async render(plan: ApprovedReviewReportPlan): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    const body = [
      paragraph(plan.title),
      ...plan.sections.flatMap((section) => [
        paragraph(section.heading),
        paragraph(section.content),
      ]),
    ].join("");
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    );
    // ZIP timestamps are packaging metadata, not evidence timestamps. Pin every
    // entry, including implicit directories, so an interrupted append can recover
    // the identical content-addressed object after a process restart.
    zip.forEach((_path, entry) => {
      entry.date = new Date("1980-01-01T00:00:00Z");
    });
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }
}

export const approvedDocxRenderer = new ApprovedDocxRenderer();
