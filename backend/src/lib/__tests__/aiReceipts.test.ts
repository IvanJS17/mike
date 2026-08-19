import { describe, expect, it } from "vitest";
import {
  buildExecutionInputHash,
  buildReceipt,
  canonicalJson,
  sha256Hex,
} from "../aiReceipts";

const baseReceipt = {
  receipt_version: "beta-0.1",
  execution_id: "execution-1",
  scope: {
    matter_id: "matter-1",
    project_id: "project-1",
    chat_id: null,
  },
  input: {
    document_id: "document-1",
    document_version_id: "version-1",
    document_version_number: 1,
    document_content_sha256: "a".repeat(64),
    input_sha256: "b".repeat(64),
  },
  route: {
    provider: "deepseek",
    model: "deepseek-chat",
    credential_ref: "deepseek:v1",
  },
  playbook: {
    workflow_id: "beta-0.1-contract-review",
    workflow_version: "1",
    playbook_sha256: "c".repeat(64),
    review_kind: "civil-commercial-contract-review",
  },
  timing: {
    created_at: "2026-08-19T12:00:00.000Z",
    started_at: "2026-08-19T12:00:01.000Z",
    finished_at: "2026-08-19T12:00:02.000Z",
  },
  result: {
    status: "succeeded" as const,
    error_class: null,
    output_id: "output-1",
    output_sha256: "d".repeat(64),
    output_format: "markdown",
  },
  usage: {
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_minor_units: null,
    currency: null,
  },
  citations: [
    {
      citation_id: "c1",
      document_version_id: "version-1",
      page: 1,
      span: { start_char: 0, end_char: 4 },
      quote_sha256: sha256Hex("text"),
      verified: true,
    },
  ],
};

describe("ai receipts", () => {
  it("serializes object keys deterministically without whitespace", () => {
    expect(canonicalJson({ z: 1, a: { d: true, c: "x" } })).toBe(
      '{"a":{"c":"x","d":true},"z":1}',
    );
  });

  it("builds the digest over canonical JSON without embedding the digest", () => {
    const receipt = buildReceipt(baseReceipt);

    expect(receipt.canonical_json).toBe(canonicalJson(baseReceipt));
    expect(receipt.receipt_sha256).toBe(sha256Hex(receipt.canonical_json));
    expect(receipt.canonical_json).not.toContain(receipt.receipt_sha256);
  });

  it("changes the input hash when any frozen input changes", () => {
    const first = buildExecutionInputHash({
      document_version_id: "version-1",
      document_content_sha256: "a".repeat(64),
      workflow_version: "1",
      playbook_sha256: "c".repeat(64),
    });
    const second = buildExecutionInputHash({
      document_version_id: "version-2",
      document_content_sha256: "a".repeat(64),
      workflow_version: "1",
      playbook_sha256: "c".repeat(64),
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("rejects sensitive fields instead of hashing them into a receipt", () => {
    expect(() =>
      buildReceipt({
        ...baseReceipt,
        prompt: "confidential prompt",
        credentialSecret: "server-only-secret",
      }),
    ).toThrow("Receipt contains a forbidden field");
  });

  it("does not accept a secret as part of the canonical receipt contract", () => {
    const receipt = buildReceipt(baseReceipt);

    expect(receipt.canonical_json).not.toContain("server-only-secret");
    expect(receipt.canonical_json).not.toContain("api_key");
  });
});
