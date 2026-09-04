import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as moduleExports from "./executionProvenance";
import { parseExecutionProvenance } from "./executionProvenance";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

type ForbiddenArchitectureUsage =
  | "backend"
  | "contexts"
  | "hooks"
  | "mikeApi"
  | "network"
  | "ui-components";

const HEADLESS_MODULES = [
  "src/app/components/recovery/assistant/executionProvenance.ts",
  "src/app/components/recovery/assistant/streamIdentityGuard.ts",
  "src/app/components/recovery/review/reviewPresentation.ts",
] as const;

function findForbiddenArchitectureUsage(
  source: string,
): ForbiddenArchitectureUsage[] {
  const moduleSpecifiers = Array.from(
    source.matchAll(
      /\b(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
    ),
    (match) => match[1] ?? match[2],
  );
  const usesPathSegment = (segment: string) =>
    moduleSpecifiers.some((specifier) =>
      specifier.split("/").includes(segment),
    );
  const violations = new Set<ForbiddenArchitectureUsage>();

  if (moduleSpecifiers.some((specifier) => specifier.includes("mikeApi"))) {
    violations.add("mikeApi");
  }
  if (usesPathSegment("contexts")) violations.add("contexts");
  if (usesPathSegment("hooks")) violations.add("hooks");
  if (usesPathSegment("backend")) violations.add("backend");
  if (
    /\b(?:fetch|WebSocket|EventSource|XMLHttpRequest)\s*\(/.test(source) ||
    moduleSpecifiers.some((specifier) =>
      /^(?:node:)?(?:http|https|net)$|^(?:axios|got|ky|undici)$/.test(specifier),
    )
  ) {
    violations.add("network");
  }
  if (
    moduleSpecifiers.some((specifier) =>
      specifier.split("/").some((segment) =>
        ["components", "modals", "popups", "ui"].includes(segment),
      ),
    )
  ) {
    violations.add("ui-components");
  }

  return [...violations];
}

function validPayload() {
  return {
    tenant_scope: {
      organization_id: "org-1",
      matter_id: "matter-1",
      project_id: "project-1",
      chat_id: "chat-1",
      document_version_id: "version-1",
    },
    input_hashes: [HASH],
    output_hashes: ["c".repeat(64)],
    citation_hashes: ["d".repeat(64)],
    route: {
      provider: "openai",
      model: "gpt-test",
      credential_ref: "credential-1",
    },
    workflow: {
      workflow_key: "contract-review",
      version: "1.0.0",
      content_hash: "e".repeat(64),
      source_commit: COMMIT,
      distribution: "default",
      type: "assistant",
      source: "pinned-upstream",
      approval_provenance: "owner-approved",
    },
    status: "completed",
  };
}

describe("parseExecutionProvenance", () => {
  it("projects an exact valid payload into a deeply immutable safe model", () => {
    const payload = validPayload();
    const result = parseExecutionProvenance(payload);

    expect(result).toEqual(payload);
    expect(result).not.toBe(payload);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.tenant_scope)).toBe(true);
    expect(Object.isFrozen(result?.input_hashes)).toBe(true);
    expect(Object.isFrozen(result?.route)).toBe(true);
    expect(Object.isFrozen(result?.workflow)).toBe(true);
  });

  it.each([
    ["partial", { ...validPayload(), route: undefined }],
    ["extra", { ...validPayload(), extra: "not-allowed" }],
    ["api key", { ...validPayload(), api_key: "secret-value" }],
    ["access token", { ...validPayload(), access_token: "secret-value" }],
    ["refresh token", { ...validPayload(), refresh_token: "secret-value" }],
    ["prompt", { ...validPayload(), prompt: "private prompt" }],
    ["document text", { ...validPayload(), document_text: "private text" }],
    ["raw error", { ...validPayload(), raw_error: "stack details" }],
    [
      "membership identity",
      {
        ...validPayload(),
        tenant_scope: { ...validPayload().tenant_scope, membership_id: "member-1" },
      },
    ],
  ])("rejects %s without reflecting rejected input", (_name, payload) => {
    expect(parseExecutionProvenance(payload)).toBeNull();
    expect(JSON.stringify(parseExecutionProvenance(payload))).not.toContain(
      "secret-value",
    );
  });

  it.each([
    ["uppercase input hash", { input_hashes: ["A".repeat(64)] }],
    ["short output hash", { output_hashes: ["c".repeat(63)] }],
    ["invalid citation hash", { citation_hashes: ["z".repeat(64)] }],
    ["blank route provider", { route: { ...validPayload().route, provider: " " } }],
    ["blank route model", { route: { ...validPayload().route, model: "" } }],
    [
      "blank credential ref",
      { route: { ...validPayload().route, credential_ref: "" } },
    ],
    ["invalid workflow key", { workflow: { ...validPayload().workflow, workflow_key: "Bad Key" } }],
    ["invalid content hash", { workflow: { ...validPayload().workflow, content_hash: HASH.slice(1) } }],
    ["invalid source commit", { workflow: { ...validPayload().workflow, source_commit: "abc" } }],
    ["invalid distribution", { workflow: { ...validPayload().workflow, distribution: "private" } }],
    ["invalid type", { workflow: { ...validPayload().workflow, type: "agent" } }],
    ["blank source", { workflow: { ...validPayload().workflow, source: "" } }],
    ["blank approval provenance", { workflow: { ...validPayload().workflow, approval_provenance: "" } }],
    ["invalid status", { status: "pending" }],
    ["raw failed error", { status: "failed", error_class: { message: "raw" } }],
  ])("rejects %s", (_name, replacement) => {
    expect(
      parseExecutionProvenance({ ...validPayload(), ...replacement }),
    ).toBeNull();
  });

  it("allows only an opaque non-empty error class on failed executions", () => {
    expect(
      parseExecutionProvenance({
        ...validPayload(),
        status: "failed",
        error_class: "provider_unavailable",
      }),
    ).toMatchObject({ status: "failed", error_class: "provider_unavailable" });
    expect(
      parseExecutionProvenance({
        ...validPayload(),
        status: "completed",
        error_class: "unexpected",
      }),
    ).toBeNull();
  });

  it("locks the runtime export surface", () => {
    expect(Object.keys(moduleExports)).toEqual(["parseExecutionProvenance"]);
  });

  it.each([
    ["mikeApi", 'import { streamChat } from "@/app/lib/mikeApi";'],
    ["contexts", 'import { useUser } from "@/app/contexts/UserContext";'],
    ["hooks", 'import { useAssistantChat } from "@/app/hooks/useAssistantChat";'],
    ["backend", 'import type { Route } from "../../../../../../../backend/src/routes";'],
    ["network", 'const response = fetch("/api/recovery");'],
    ["ui-components", 'import { Button } from "@/app/components/ui/button";'],
  ] as const)("detects forbidden %s architecture usage", (category, source) => {
    expect(findForbiddenArchitectureUsage(source)).toEqual([category]);
  });

  it("keeps every recovery presentation module headless", () => {
    for (const modulePath of HEADLESS_MODULES) {
      const source = readFileSync(modulePath, "utf8");
      expect(findForbiddenArchitectureUsage(source), modulePath).toEqual([]);
    }
  });
});
