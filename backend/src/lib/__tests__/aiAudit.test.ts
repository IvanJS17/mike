import { describe, expect, it } from "vitest";
import { buildAiAuditDetail } from "../audit";

describe("AI audit metadata", () => {
  it("contains identifiers and hashes only, never content or secrets", () => {
    const detail = buildAiAuditDetail({
      executionId: "execution-1",
      projectId: "project-1",
      matterId: "matter-1",
      documentVersionId: "version-1",
      inputSha256: "a".repeat(64),
      outputSha256: "b".repeat(64),
      status: "succeeded",
      routeProvider: "deepseek",
      routeModel: "deepseek-chat",
      credentialRef: "deepseek:v1",
      errorClass: null,
      prompt: "confidential prompt",
      credentialSecret: "server-only-secret",
      content: "private document body",
    });

    expect(detail).toEqual({
      execution_id: "execution-1",
      project_id: "project-1",
      matter_id: "matter-1",
      document_version_id: "version-1",
      input_sha256: "a".repeat(64),
      output_sha256: "b".repeat(64),
      status: "succeeded",
      route_provider: "deepseek",
      route_model: "deepseek-chat",
      credential_ref: "deepseek:v1",
      error_class: null,
    });
    expect(JSON.stringify(detail)).not.toContain("server-only-secret");
    expect(JSON.stringify(detail)).not.toContain("private document body");
  });
});
