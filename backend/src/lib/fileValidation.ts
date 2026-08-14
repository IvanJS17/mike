/**
 * Upload content validation (W1.9): verify the file's real content (magic
 * bytes) matches the declared extension before accepting it. An attacker
 * could rename an executable to .pdf/.docx; the extension check alone does
 * not stop that.
 */

/** Detect the real kind of a file from its leading bytes. */
export function detectFileKind(bytes: Uint8Array): "pdf" | "ooxml" | "ole2" | null {
  if (bytes.length < 8) return null;

  // PDF: %PDF-
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "pdf";
  }

  // OOXML (docx/xlsx/pptx/xlsm): ZIP container PK\x03\x04
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return "ooxml";
  }

  // Legacy OLE2 (doc/xls/ppt): D0 CF 11 E0 A1 B1 1A E1
  if (
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  ) {
    return "ole2";
  }

  return null;
}

const SUFFIX_TO_KIND: Record<string, "pdf" | "ooxml" | "ole2"> = {
  pdf: "pdf",
  docx: "ooxml",
  xlsx: "ooxml",
  xlsm: "ooxml",
  pptx: "ooxml",
  doc: "ole2",
  xls: "ole2",
  ppt: "ole2",
};

/**
 * Returns an error detail string when the file's real content does not match
 * the declared extension; returns null when it is acceptable.
 */
export function validateUploadContent(
  declaredSuffix: string,
  bytes: Uint8Array,
): string | null {
  const expected = SUFFIX_TO_KIND[declaredSuffix];
  if (!expected) return null; // suffix already gated by ALLOWED_DOCUMENT_TYPES

  const actual = detectFileKind(bytes);
  if (actual !== expected) {
    return `File content does not match its .${declaredSuffix} extension (detected: ${actual ?? "unknown format"}).`;
  }
  return null;
}
