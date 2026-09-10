import { describe, expect, it } from "vitest";

import {
  AI_EXECUTION_STATUSES,
  buildExecutionProvenance,
  transitionExecutionStatus,
} from "./executionEvidence";

const H = "a".repeat(64);
const workflow = {
  workflow_key: "civil-commercial-mx-triage",
  version: "0.1.0",
  content_hash: "b".repeat(64),
  source_commit: "c".repeat(40),
  distribution: "addon" as const,
  type: "assistant" as const,
  source: "playbook.md",
  approval_provenance: "review pending",
};
const provenance = {
  tenant_scope: {
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: "project-1",
    document_version_id: "version-1",
  },
  input_hashes: [H],
  output_hashes: ["d".repeat(64)],
  citation_hashes: ["e".repeat(64)],
  route: {
    provider: "openai",
    model: "gpt-5.6-sol",
    credential_ref: "key-v2",
  },
  workflow,
  status: "completed" as const,
};

describe("execution transition matrix", () => {
  it("uses the closed four-status vocabulary", () => {
    expect(AI_EXECUTION_STATUSES).toEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
    ]);
  });

  it.each([
    ["pending", "running", true],
    ["pending", "failed", true],
    ["running", "succeeded", true],
    ["running", "failed", true],
    ["pending", "pending", false],
    ["pending", "succeeded", false],
    ["running", "pending", false],
    ["running", "running", false],
    ["succeeded", "pending", false],
    ["succeeded", "running", false],
    ["succeeded", "failed", false],
    ["succeeded", "succeeded", false],
    ["failed", "pending", false],
    ["failed", "running", false],
    ["failed", "succeeded", false],
    ["failed", "failed", false],
    ["garbage", "running", false],
  ])("%s -> %s allowed=%s", (from, to, allowed) => {
    const result = transitionExecutionStatus(from, to);
    expect(result.ok).toBe(allowed);
    if (!allowed) {
      expect(result).toEqual({
        ok: false,
        error_class: "invalid_execution_transition",
      });
    }
  });
});

describe("terminal execution provenance", () => {
  it("builds the exact actual route/workflow projection deeply frozen", () => {
    const result = buildExecutionProvenance(provenance);
    expect(result).toEqual({ ok: true, provenance });
    if (!result.ok) return;
    expect(Object.isFrozen(result.provenance)).toBe(true);
    expect(Object.isFrozen(result.provenance.tenant_scope)).toBe(true);
    expect(Object.isFrozen(result.provenance.route)).toBe(true);
    expect(Object.isFrozen(result.provenance.workflow)).toBe(true);
    expect(Object.isFrozen(result.provenance.input_hashes)).toBe(true);
    provenance.route.provider = "mutated";
    expect(result.provenance.route.provider).toBe("openai");
  });

  it("accepts a bounded opaque failed error class only", () => {
    expect(
      buildExecutionProvenance({
        ...provenance,
        status: "failed",
        error_class: "provider_timeout",
      }).ok,
    ).toBe(true);
    for (const error_class of ["", " ", "Raw DB exploded!", "x".repeat(65)]) {
      expect(
        buildExecutionProvenance({
          ...provenance,
          status: "failed",
          error_class,
        }),
      ).toEqual({ ok: false, error_class: "invalid_execution_provenance" });
    }
  });

  it.each([
    ["completed error", { error_class: "oops" }],
    ["uppercase hash", { input_hashes: [H.toUpperCase()] }],
    [
      "bad scope",
      { tenant_scope: { ...provenance.tenant_scope, organization_id: "" } },
    ],
    ["bad route", { route: { ...provenance.route, provider: "" } }],
    [
      "workflow drift",
      { workflow: { ...workflow, content_hash: "f".repeat(63) } },
    ],
    ["extra prompt", { prompt: "secret prompt" }],
    ["raw error", { raw_error: "token=secret" }],
    ["provider key", { provider_api_key: "secret" }],
    ["user email", { user_email: "person@example.test" }],
  ])("rejects %s opaquely", (_label, patch) => {
    const result = buildExecutionProvenance({ ...provenance, ...patch });
    expect(result).toEqual({
      ok: false,
      error_class: "invalid_execution_provenance",
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|example|token/i);
  });
});
