import { describe, it, expect } from "vitest";
import { detectFileKind, validateUploadContent } from "../fileValidation";

const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, // %PDF-1.4
  ...new Array(40).fill(0x20),
]);

const DOCX_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, // PK\x03\x04 (zip/OOXML)
  ...new Array(40).fill(0x00),
]);

const DOC_BYTES = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, // OLE2 (doc/xls/ppt)
  ...new Array(40).fill(0x00),
]);

const EXE_DISGUISED = new Uint8Array([
  0x4d, 0x5a, 0x90, 0x00, // MZ (PE executable)
  ...new Array(60).fill(0x00),
]);

const FAKE_PDF = new Uint8Array([
  0x50, 0x44, 0x46, 0x46, 0x4f, 0x4f, // "PDFFOO" — no es %PDF
  ...new Array(40).fill(0x20),
]);

describe("detectFileKind (W1.9)", () => {
  it("detects real PDFs", () => {
    expect(detectFileKind(PDF_BYTES)).toBe("pdf");
  });

  it("detects OOXML packages (docx/xlsx/pptx)", () => {
    expect(detectFileKind(DOCX_BYTES)).toBe("ooxml");
  });

  it("detects legacy OLE2 documents (doc/xls/ppt)", () => {
    expect(detectFileKind(DOC_BYTES)).toBe("ole2");
  });

  it("rejects executables disguised as documents", () => {
    expect(detectFileKind(EXE_DISGUISED)).toBeNull();
  });

  it("rejects fake PDF headers", () => {
    expect(detectFileKind(FAKE_PDF)).toBeNull();
  });
});

describe("validateUploadContent (W1.9)", () => {
  it("accepts a real PDF declared as pdf", () => {
    expect(validateUploadContent("pdf", PDF_BYTES)).toBeNull();
  });

  it("rejects an executable declared as pdf", () => {
    expect(validateUploadContent("pdf", EXE_DISGUISED)).toContain("does not match");
  });

  it("accepts an OOXML package declared as docx", () => {
    expect(validateUploadContent("docx", DOCX_BYTES)).toBeNull();
  });

  it("accepts OLE2 declared as doc", () => {
    expect(validateUploadContent("doc", DOC_BYTES)).toBeNull();
  });

  it("rejects an OLE2 file declared as pdf", () => {
    expect(validateUploadContent("pdf", DOC_BYTES)).toContain("does not match");
  });

  it("rejects a fake PDF header declared as pdf", () => {
    expect(validateUploadContent("pdf", FAKE_PDF)).toContain("does not match");
  });
});
