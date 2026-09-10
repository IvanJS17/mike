import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  appendEvidenceAtomically,
  buildCanonicalEvidenceReceipt,
  requestEvidenceDeletion,
  type AtomicEvidenceAppendPort,
  type EvidenceResourceScopePort,
} from "./appendOnlyEvidence";
import type { TenancyReadPort } from "../authorization/tenancyReadPort";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pageText = "Árbol jurídico y contrato.";
const outputText = "Resultado íntegro";
const quote = "Árbol";
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
const scope = {
  user_id: "user-1",
  organization_id: "org-1",
  workspace_id: "workspace-1",
  matter_id: "matter-1",
  membership_role: "matter_owner" as const,
  authorization_epoch: 3,
  requires_explicit_matter_membership: true,
};
const identity = {
  user_id: "user-1",
  transport: { kind: "web_session" as const },
  mfa_satisfied: true,
};
const provenance = {
  tenant_scope: {
    organization_id: "org-1",
    matter_id: "matter-1",
    project_id: "project-1",
    document_version_id: "version-1",
  },
  input_hashes: ["a".repeat(64)],
  output_hashes: [sha(outputText)],
  citation_hashes: [sha(quote)],
  route: {
    provider: "openai",
    model: "gpt-5.6-sol",
    credential_ref: "key-v2",
  },
  workflow,
  status: "completed" as const,
};
const evidence = {
  execution_id: "execution-1",
  provenance,
  pages: [
    {
      document_id: "doc-1",
      document_version_id: "version-1",
      page: 1,
      text: pageText,
      text_sha256: sha(pageText),
    },
  ],
  output: {
    execution_id: "execution-1",
    output_text: outputText,
    output_sha256: sha(outputText),
  },
  citation_candidates: [
    {
      citation_id: "c-1",
      document_id: "doc-1",
      document_version_id: "version-1",
      page: 1,
      span: { start_char: 0, end_char: 5 },
      quote,
      quote_sha256: sha(quote),
      finding_text: "Hallazgo",
    },
  ],
};

function verifiedCitation(
  value: (typeof evidence.citation_candidates)[number],
) {
  return {
    citation_id: value.citation_id,
    document_id: value.document_id,
    document_version_id: value.document_version_id,
    page: value.page,
    span: value.span,
    quote_sha256: value.quote_sha256,
    finding_text: value.finding_text,
    verified: true as const,
  };
}

function tenancy(overrides: Record<string, unknown> = {}): TenancyReadPort {
  return {
    getOrganizationMembership: vi.fn(async () => ({
      user_id: "user-1",
      organization_id: "org-1",
      role: "org_owner",
      status: "active",
      authorization_epoch: 3,
      ...overrides,
    })) as TenancyReadPort["getOrganizationMembership"],
    getMatter: vi.fn(async () => ({
      matter_id: "matter-1",
      workspace_id: "workspace-1",
      organization_id: "org-1",
      visibility: "private",
    })),
    getMatterMembership: vi.fn(async () => ({
      user_id: "user-1",
      matter_id: "matter-1",
      role: "matter_owner",
      status: "active",
    })),
  };
}

function resourceScope(
  overrides: Record<string, unknown> = {},
): EvidenceResourceScopePort {
  return {
    getEvidenceResourceScope: vi.fn(async () => ({
      organization_id: "org-1",
      matter_id: "matter-1",
      project_id: "project-1",
      document_id: "doc-1",
      document_version_id: "version-1",
      document_content_sha256: "a".repeat(64),
      ...overrides,
    })),
  };
}

function input(
  port: AtomicEvidenceAppendPort,
  reads = tenancy(),
  resources = resourceScope(),
) {
  return {
    identity,
    granted_scope: scope,
    tenancy_port: reads,
    resource_scope_port: resources,
    requires_mfa: true,
    idempotency_key: "evidence:execution-1:v1",
    evidence,
    append_port: port,
  };
}

describe("canonical receipt", () => {
  it("is deterministic under page/citation permutation, Unicode and locale monkeypatch", () => {
    const c2 = {
      ...evidence.citation_candidates[0],
      citation_id: "A",
      span: { start_char: 6, end_char: 14 },
      quote: "jurídico",
      quote_sha256: sha("jurídico"),
    };
    const page2 = {
      ...evidence.pages[0],
      page: 2,
      text: "ñ",
      text_sha256: sha("ñ"),
    };
    const receiptProvenance = {
      ...provenance,
      citation_hashes: [sha("jurídico"), sha(quote)],
    };
    const a = buildCanonicalEvidenceReceipt({
      execution_id: evidence.execution_id,
      idempotency_key: "evidence:execution-1:v1",
      provenance: receiptProvenance,
      pages: [page2, evidence.pages[0]],
      output: evidence.output,
      citations: [
        verifiedCitation({ ...c2, finding_text: "Ünico" }),
        verifiedCitation(evidence.citation_candidates[0]),
      ],
    });
    const locale = String.prototype.localeCompare;
    String.prototype.localeCompare = () => -1;
    try {
      const b = buildCanonicalEvidenceReceipt({
        execution_id: evidence.execution_id,
        idempotency_key: "evidence:execution-1:v1",
        provenance: receiptProvenance,
        pages: [evidence.pages[0], page2],
        output: evidence.output,
        citations: [
          verifiedCitation(evidence.citation_candidates[0]),
          verifiedCitation({ ...c2, finding_text: "Ünico" }),
        ],
      });
      expect(a).toEqual(b);
      expect(a.ok).toBe(true);
    } finally {
      String.prototype.localeCompare = locale;
    }
  });

  it("pins finding integrity by hash without storing finding text", () => {
    const baseCitation = verifiedCitation(evidence.citation_candidates[0]);
    const changedFinding = "Hallazgo distinto";
    const first = buildCanonicalEvidenceReceipt({
      execution_id: evidence.execution_id,
      idempotency_key: "evidence:execution-1:v1",
      provenance,
      pages: evidence.pages,
      output: evidence.output,
      citations: [baseCitation],
    });
    const second = buildCanonicalEvidenceReceipt({
      execution_id: evidence.execution_id,
      idempotency_key: "evidence:execution-1:v1",
      provenance,
      pages: evidence.pages,
      output: evidence.output,
      citations: [{ ...baseCitation, finding_text: changedFinding }],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.receipt.receipt_sha256).not.toBe(
      second.receipt.receipt_sha256,
    );
    expect(second.receipt.canonical_json).toContain(sha(changedFinding));
    expect(second.receipt.canonical_json).not.toContain(changedFinding);
  });

  it("rejects malformed direct receipt inputs instead of hashing declarations", () => {
    const base = {
      execution_id: evidence.execution_id,
      idempotency_key: "evidence:execution-1:v1",
      provenance,
      pages: evidence.pages,
      output: evidence.output,
      citations: [verifiedCitation(evidence.citation_candidates[0])],
    };
    for (const invalid of [
      { ...base, output: { ...base.output, output_text: "tampered" } },
      {
        ...base,
        pages: [{ ...base.pages[0], text: "tampered" }],
      },
      {
        ...base,
        provenance: { ...base.provenance, output_hashes: ["0".repeat(64)] },
      },
    ]) {
      expect(buildCanonicalEvidenceReceipt(invalid)).toEqual({
        ok: false,
        error_class: "invalid_evidence_append",
      });
    }
  });

  it("snapshots changing raw receipt getters exactly once before validation", () => {
    let outputTextReads = 0;
    const changingOutput = {
      execution_id: evidence.execution_id,
      output_sha256: evidence.output.output_sha256,
    } as Record<string, unknown>;
    Object.defineProperty(changingOutput, "output_text", {
      enumerable: true,
      get() {
        outputTextReads += 1;
        return outputTextReads < 3 ? evidence.output.output_text : "tampered";
      },
    });
    const candidate = buildCanonicalEvidenceReceipt({
      execution_id: evidence.execution_id,
      idempotency_key: "evidence:execution-1:v1",
      provenance,
      pages: evidence.pages,
      output: changingOutput,
      citations: [verifiedCitation(evidence.citation_candidates[0])],
    });
    const honest = buildCanonicalEvidenceReceipt({
      execution_id: evidence.execution_id,
      idempotency_key: "evidence:execution-1:v1",
      provenance,
      pages: evidence.pages,
      output: evidence.output,
      citations: [verifiedCitation(evidence.citation_candidates[0])],
    });

    expect(outputTextReads).toBe(1);
    expect(candidate).toEqual(honest);
    expect(candidate.ok).toBe(true);
  });
});

describe("atomic append boundary", () => {
  it.each([
    [
      "execution id",
      {
        ...evidence,
        execution_id: " execution-1",
        output: { ...evidence.output, execution_id: " execution-1" },
      },
    ],
    [
      "document id",
      {
        ...evidence,
        pages: [{ ...evidence.pages[0], document_id: "doc-1 " }],
        citation_candidates: [
          { ...evidence.citation_candidates[0], document_id: "doc-1 " },
        ],
      },
    ],
  ])(
    "rejects whitespace alias in %s before append",
    async (_label: string, aliased: unknown) => {
      const append = vi.fn(
        async (batch: Parameters<AtomicEvidenceAppendPort["append"]>[0]) => ({
          disposition: "applied",
          idempotency_key: batch.idempotency_key,
          execution_id: batch.execution.execution_id,
          receipt_sha256: batch.receipt.receipt_sha256,
          counts: { pages: 1, outputs: 1, citations: 1 },
        }),
      );
      const result = await appendEvidenceAtomically({
        ...input({ append }),
        evidence: aliased,
      });
      expect(result).toEqual({
        ok: false,
        error_class: "invalid_evidence_append",
      });
      expect(append).not.toHaveBeenCalled();
    },
  );

  it.each(["applied", "replayed"] as const)(
    "accepts exact %s receipt with one append",
    async (disposition) => {
      const append = vi.fn(async (batch) => ({
        disposition,
        idempotency_key: batch.idempotency_key,
        execution_id: batch.execution.execution_id,
        receipt_sha256: batch.receipt.receipt_sha256,
        counts: { pages: 1, outputs: 1, citations: 1 },
      }));
      const result = await appendEvidenceAtomically(input({ append }));
      expect(result.ok).toBe(true);
      expect(append).toHaveBeenCalledTimes(1);
      const batch = append.mock.calls[0][0];
      expect(Object.isFrozen(batch)).toBe(true);
      expect(Object.isFrozen(batch.execution.provenance)).toBe(true);
      expect(Object.isFrozen(batch.pages[0])).toBe(true);
      expect(Object.isFrozen(batch.receipt)).toBe(true);
    },
  );

  it.each([
    ["revoked", { status: "revoked" }],
    ["epoch", { authorization_epoch: 4 }],
  ])("%s fresh denial causes zero append", async (_label, overrides) => {
    const append = vi.fn();
    const result = await appendEvidenceAtomically(
      input({ append }, tenancy(overrides)),
    );
    expect(result.ok).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it("removed private-matter membership causes zero append", async () => {
    const append = vi.fn();
    const reads = tenancy();
    vi.mocked(reads.getMatterMembership).mockResolvedValueOnce(null);
    expect((await appendEvidenceAtomically(input({ append }, reads))).ok).toBe(
      false,
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("rejects internally consistent foreign resource scope with zero append", async () => {
    const append = vi.fn();
    const foreignVersion = "version-foreign";
    const foreignDocument = "doc-foreign";
    const foreignProject = "project-foreign";
    const foreignEvidence = {
      ...evidence,
      provenance: {
        ...provenance,
        tenant_scope: {
          ...provenance.tenant_scope,
          project_id: foreignProject,
          document_version_id: foreignVersion,
        },
      },
      pages: [
        {
          ...evidence.pages[0],
          document_id: foreignDocument,
          document_version_id: foreignVersion,
        },
      ],
      citation_candidates: [
        {
          ...evidence.citation_candidates[0],
          document_id: foreignDocument,
          document_version_id: foreignVersion,
        },
      ],
    };
    const request = input(
      { append },
      tenancy(),
      resourceScope({
        organization_id: "org-foreign",
        matter_id: "matter-foreign",
        project_id: foreignProject,
        document_id: foreignDocument,
        document_version_id: foreignVersion,
      }),
    );
    request.evidence = foreignEvidence;
    expect(await appendEvidenceAtomically(request)).toEqual({
      ok: false,
      error_class: "evidence_authorization_failed",
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("fails closed on malformed or throwing resource scope readback", async () => {
    for (const resources of [
      { getEvidenceResourceScope: vi.fn(async () => ({ nope: true })) },
      {
        getEvidenceResourceScope: vi.fn(async () => {
          throw new Error("raw SECRET scope failure");
        }),
      },
    ]) {
      const append = vi.fn();
      const result = await appendEvidenceAtomically(
        input({ append }, tenancy(), resources),
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(append).not.toHaveBeenCalled();
    }
  });

  it("MFA and dependency failures cause zero append", async () => {
    const append = vi.fn();
    const mfa = input({ append });
    mfa.identity = { ...identity, mfa_satisfied: false };
    expect((await appendEvidenceAtomically(mfa)).ok).toBe(false);
    const reads = tenancy();
    vi.mocked(reads.getOrganizationMembership).mockRejectedValueOnce(
      new Error("SECRET db"),
    );
    expect((await appendEvidenceAtomically(input({ append }, reads))).ok).toBe(
      false,
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("validates evidence before auth reads, then rechecks immediately before append", async () => {
    const order: string[] = [];
    const reads = tenancy();
    vi.mocked(reads.getOrganizationMembership).mockImplementation(async () => {
      order.push("membership");
      return {
        user_id: "user-1",
        organization_id: "org-1",
        role: "org_owner",
        status: "active",
        authorization_epoch: 3,
      };
    });
    vi.mocked(reads.getMatter).mockImplementation(async () => {
      order.push("matter");
      return {
        matter_id: "matter-1",
        workspace_id: "workspace-1",
        organization_id: "org-1",
        visibility: "private",
      };
    });
    vi.mocked(reads.getMatterMembership).mockImplementation(async () => {
      order.push("matterMembership");
      return {
        user_id: "user-1",
        matter_id: "matter-1",
        role: "matter_owner",
        status: "active",
      };
    });
    const resources = resourceScope();
    vi.mocked(resources.getEvidenceResourceScope).mockImplementation(
      async () => {
        order.push("resourceScope");
        return {
          organization_id: "org-1",
          matter_id: "matter-1",
          project_id: "project-1",
          document_id: "doc-1",
          document_version_id: "version-1",
          document_content_sha256: "a".repeat(64),
        };
      },
    );
    const append = vi.fn(async (batch) => {
      order.push("append");
      return {
        disposition: "applied" as const,
        idempotency_key: batch.idempotency_key,
        execution_id: batch.execution.execution_id,
        receipt_sha256: batch.receipt.receipt_sha256,
        counts: { pages: 1, outputs: 1, citations: 1 },
      };
    });
    const result = await appendEvidenceAtomically(
      input({ append }, reads, resources),
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual([
      "membership",
      "matter",
      "matterMembership",
      "resourceScope",
      "append",
    ]);
    const invalid = input({ append }, reads);
    invalid.evidence = {
      ...evidence,
      output: { ...evidence.output, output_sha256: "0".repeat(64) },
    };
    order.length = 0;
    expect((await appendEvidenceAtomically(invalid)).ok).toBe(false);
    expect(order).toEqual([]);
  });

  it.each(["throw", "malformed", "mismatch"])(
    "fails opaquely without retry for %s port receipt",
    async (kind) => {
      const append = vi.fn(async (batch) => {
        if (kind === "throw") throw new Error("raw SECRET");
        if (kind === "malformed") return { nope: true };
        return {
          disposition: "replayed",
          idempotency_key: "other",
          execution_id: batch.execution.execution_id,
          receipt_sha256: batch.receipt.receipt_sha256,
          counts: { pages: 1, outputs: 1, citations: 1 },
        };
      });
      const result = await appendEvidenceAtomically(input({ append }));
      expect(result).toEqual({
        ok: false,
        error_class: "evidence_append_failed",
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(append).toHaveBeenCalledTimes(1);
    },
  );

  it("snapshots hostile port receipts once and catches getters opaquely", async () => {
    const throwing = vi.fn(
      async (batch: Parameters<AtomicEvidenceAppendPort["append"]>[0]) => {
        const receipt: Record<string, unknown> = {
          idempotency_key: batch.idempotency_key,
          execution_id: batch.execution.execution_id,
          receipt_sha256: batch.receipt.receipt_sha256,
          counts: { pages: 1, outputs: 1, citations: 1 },
        };
        Object.defineProperty(receipt, "disposition", {
          enumerable: true,
          get: () => {
            throw new Error("raw SECRET getter");
          },
        });
        return receipt;
      },
    );
    await expect(
      appendEvidenceAtomically(input({ append: throwing })),
    ).resolves.toEqual({
      ok: false,
      error_class: "evidence_append_failed",
    });

    let reads = 0;
    const changing = vi.fn(
      async (batch: Parameters<AtomicEvidenceAppendPort["append"]>[0]) => {
        const receipt: Record<string, unknown> = {
          idempotency_key: batch.idempotency_key,
          execution_id: batch.execution.execution_id,
          receipt_sha256: batch.receipt.receipt_sha256,
          counts: { pages: 1, outputs: 1, citations: 1 },
        };
        Object.defineProperty(receipt, "disposition", {
          enumerable: true,
          get: () => (++reads === 1 ? "applied" : "replayed"),
        });
        return receipt;
      },
    );
    const result = await appendEvidenceAtomically(input({ append: changing }));
    expect(result).toMatchObject({
      ok: true,
      receipt: { disposition: "applied" },
    });
    expect(reads).toBe(1);
  });

  it("rejects every mismatched receipt identity/count without retry", async () => {
    for (const changed of [
      { execution_id: "other" },
      { receipt_sha256: "0".repeat(64) },
      { counts: { pages: 2, outputs: 1, citations: 1 } },
    ]) {
      const append = vi.fn(async (batch) => ({
        disposition: "replayed" as const,
        idempotency_key: batch.idempotency_key,
        execution_id: batch.execution.execution_id,
        receipt_sha256: batch.receipt.receipt_sha256,
        counts: { pages: 1, outputs: 1, citations: 1 },
        ...changed,
      }));
      expect(await appendEvidenceAtomically(input({ append }))).toEqual({
        ok: false,
        error_class: "evidence_append_failed",
      });
      expect(append).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects extra input before auth and prevents port mutation", async () => {
    const reads = tenancy();
    const append = vi.fn(async (batch) => {
      expect(() => {
        batch.execution.provenance.route.provider = "mutated";
      }).toThrow();
      expect(() => {
        batch.receipt.receipt_sha256 = "0".repeat(64);
      }).toThrow();
      return {
        disposition: "applied" as const,
        idempotency_key: batch.idempotency_key,
        execution_id: batch.execution.execution_id,
        receipt_sha256: batch.receipt.receipt_sha256,
        counts: { pages: 1, outputs: 1, citations: 1 },
      };
    });
    const valid = await appendEvidenceAtomically(input({ append }, reads));
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(Object.isFrozen(valid.receipt)).toBe(true);

    const bad = input({ append }, reads);
    bad.evidence = {
      ...evidence,
      provider_api_key: "SECRET",
    } as unknown as typeof bad.evidence;
    expect(await appendEvidenceAtomically(bad)).toEqual({
      ok: false,
      error_class: "invalid_evidence_append",
    });
    expect(reads.getOrganizationMembership).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("exports typed blocked deletion and a single-operation port", () => {
    expect(requestEvidenceDeletion()).toEqual({
      ok: false,
      blocked: true,
      kind: "evidence_deletion",
      reason:
        "append-only AI evidence deletion requires an approved retention decision",
    });
    const source = readFileSync(
      new URL("./appendOnlyEvidence.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("interface AtomicEvidenceAppendPort");
    const port = source.match(
      /interface AtomicEvidenceAppendPort \{[\s\S]*?\n\}/,
    )?.[0];
    expect(port).toBeDefined();
    expect(port).not.toMatch(/\b(update|delete|upsert)\s*\(/);
  });
});

describe("runtime import lock", () => {
  it("exports only the bounded runtime APIs", async () => {
    expect(Object.keys(await import("./executionEvidence")).sort()).toEqual(
      [
        "AI_EXECUTION_STATUSES",
        "buildExecutionProvenance",
        "transitionExecutionStatus",
      ].sort(),
    );
    expect(Object.keys(await import("./citationEvidence")).sort()).toEqual(
      ["verifyCitationBatch", "verifyCitationCandidate"].sort(),
    );
    expect(Object.keys(await import("./appendOnlyEvidence")).sort()).toEqual(
      [
        "appendEvidenceAtomically",
        "buildCanonicalEvidenceReceipt",
        "requestEvidenceDeletion",
      ].sort(),
    );
  });

  it("contains no forbidden runtime dependency", () => {
    for (const file of [
      "executionEvidence.ts",
      "citationEvidence.ts",
      "appendOnlyEvidence.ts",
    ]) {
      const source = readFileSync(
        new URL(`./${file}`, import.meta.url),
        "utf8",
      );
      for (const banned of [
        "supabase",
        "routes/",
        "storage",
        "@ai-sdk",
        "node:http",
        "undici",
        'from "../aiExecutions"',
        'from "../aiCitations"',
        "fetch(",
      ]) {
        expect(source.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    }
  });
});
