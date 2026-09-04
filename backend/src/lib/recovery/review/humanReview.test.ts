import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  completeHumanReview,
  createHumanReview,
  decideHumanReviewItem,
  parseHumanReview,
  reviewMatchesExecutionEvidence,
  type HumanReviewMutationPort,
} from "./humanReview";
import type { TenancyReadPort } from "../authorization/tenancyReadPort";
import type { EvidenceResourceScopePort } from "../evidence/appendOnlyEvidence";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
};
const identity = {
  user_id: "reviewer",
  transport: { kind: "web_session" as const },
  mfa_satisfied: true,
};
const scope = {
  user_id: "reviewer",
  organization_id: "org",
  workspace_id: "ws",
  matter_id: "matter",
  membership_role: "matter_owner" as const,
  authorization_epoch: 2,
  requires_explicit_matter_membership: true,
};
const citation = {
  citation_id: "citation-1",
  document_id: "doc",
  document_version_id: "version",
  page: 1,
  span: { start_char: 0, end_char: 5 },
  quote_sha256: sha("Árbol"),
  finding_text: "Original",
  verified: true as const,
};
const outputText = "Sin citas";
const outputSha = sha(outputText);
const evidenceCanonical = canonicalize({
  receipt_version: "evidence-v1",
  idempotency_key: "evidence:execution:v1",
  execution_id: "execution",
  tenant_scope: {
    organization_id: "org",
    matter_id: "matter",
    project_id: "project",
    document_version_id: "version",
  },
  route: { provider: "openai", model: "gpt-5.6-sol", credential_ref: "key-v2" },
  workflow: {
    workflow_key: "civil-commercial-mx-triage",
    version: "0.1.0",
    content_hash: "c".repeat(64),
    source_commit: "d".repeat(40),
    distribution: "addon",
    type: "assistant",
    source: "playbook.md",
    approval_provenance: "approved",
  },
  status: "completed",
  input_hashes: ["a".repeat(64)],
  page_hashes: [
    {
      document_id: "doc",
      document_version_id: "version",
      page: 1,
      text_sha256: sha("page"),
    },
  ],
  output_hash: outputSha,
  citation_hashes: [
    {
      citation_id: "citation-1",
      document_id: "doc",
      document_version_id: "version",
      page: 1,
      span: { start_char: 0, end_char: 5 },
      quote_sha256: sha("Árbol"),
      finding_sha256: sha("Original"),
    },
  ],
});
const evidenceReceipt = {
  receipt_version: "evidence-v1" as const,
  canonical_json: evidenceCanonical,
  receipt_sha256: sha(evidenceCanonical),
};
const noCitationCanonical = canonicalize({
  ...JSON.parse(evidenceCanonical),
  citation_hashes: [],
});
const noCitationReceipt = {
  receipt_version: "evidence-v1" as const,
  canonical_json: noCitationCanonical,
  receipt_sha256: sha(noCitationCanonical),
};
const execution = {
  execution_id: "execution",
  author_user_id: "author",
  status: "succeeded",
  organization_id: "org",
  matter_id: "matter",
  project_id: "project",
  document_id: "doc",
  document_version_id: "version",
  document_content_sha256: "a".repeat(64),
  evidence_receipt_sha256: evidenceReceipt.receipt_sha256,
  output_text: outputText,
  output_sha256: outputSha,
  citations: [citation],
};

function resources(
  overrides: Record<string, unknown> = {},
): EvidenceResourceScopePort {
  return {
    getEvidenceResourceScope: vi.fn(async () => ({
      organization_id: "org",
      matter_id: "matter",
      project_id: "project",
      document_id: "doc",
      document_version_id: "version",
      document_content_sha256: "a".repeat(64),
      ...overrides,
    })),
  };
}

function tenancy(overrides: Record<string, unknown> = {}): TenancyReadPort {
  return {
    getOrganizationMembership: vi.fn(async () => ({
      user_id: "reviewer",
      organization_id: "org",
      role: "org_owner",
      status: "active",
      authorization_epoch: 2,
      ...overrides,
    })) as TenancyReadPort["getOrganizationMembership"],
    getMatter: vi.fn(async () => ({
      matter_id: "matter",
      workspace_id: "ws",
      organization_id: "org",
      visibility: "private",
    })),
    getMatterMembership: vi.fn(async () => ({
      user_id: "reviewer",
      matter_id: "matter",
      role: "matter_owner",
      status: "active",
    })),
  };
}

function port(): HumanReviewMutationPort {
  return {
    create: vi.fn(async (value) => ({
      disposition: "applied",
      operation: "create",
      review_id: value.review.review_id,
      item_id: null,
      revision: value.review.revision,
      idempotency_key: value.idempotency_key,
    })),
    decide: vi.fn(async (value) => ({
      disposition: "applied",
      operation: "decide",
      review_id: value.review.review_id,
      item_id: value.item.item_id,
      revision: value.review.revision,
      idempotency_key: value.idempotency_key,
    })),
    complete: vi.fn(async (value) => ({
      disposition: "applied",
      operation: "complete",
      review_id: value.review.review_id,
      item_id: null,
      revision: value.review.revision,
      idempotency_key: value.idempotency_key,
    })),
  };
}

const auth = {
  identity,
  granted_scope: scope,
  tenancy_port: tenancy(),
  resource_scope_port: resources(),
  evidence_receipt: evidenceReceipt,
  requires_mfa: true,
};

describe("human review", () => {
  it("rejects forged accepted-state content centrally", () => {
    const forged = {
      review_id: "review-forged",
      revision: 2,
      execution_id: "execution",
      execution_author_user_id: "author",
      reviewer_user_id: "reviewer",
      organization_id: "org",
      matter_id: "matter",
      project_id: "project",
      document_id: "doc",
      document_version_id: "version",
      document_content_sha256: "a".repeat(64),
      evidence_receipt_sha256: evidenceReceipt.receipt_sha256,
      status: "approved",
      items: [
        {
          item_id: "item",
          item_key: "citation-1",
          original_text: "Original",
          finding_text: "UNREVIEWED ALTERATION",
          status: "accepted",
          comment: null,
          citation,
        },
      ],
    };
    expect(parseHumanReview(forged)).toBeNull();
    expect(
      reviewMatchesExecutionEvidence(forged as never, execution as never),
    ).toBe(false);
  });

  it("snapshots a changing decision getter and a mutation method exactly once", async () => {
    const writes = port();
    const created = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      evidence_receipt: evidenceReceipt,
      idempotency_key: "review:create:getters",
      review_id: "review-getters",
      execution,
      mutation_port: writes,
    } as never);
    if (!created.ok) return;
    let decisionReads = 0;
    let methodReads = 0;
    const mutationPort = Object.defineProperty(port(), "decide", {
      enumerable: true,
      get() {
        methodReads += 1;
        return writes.decide;
      },
    });
    const result = await decideHumanReviewItem({
      ...auth,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      idempotency_key: "review:decide:getters",
      review: created.review,
      item_id: created.review.items[0].item_id,
      get decision() {
        decisionReads += 1;
        return decisionReads === 1 ? "accepted" : "edited";
      },
      mutation_port: mutationPort,
    } as never);
    expect(result.ok).toBe(true);
    expect(decisionReads).toBe(1);
    expect(methodReads).toBe(1);
  });
  it("creates one immutable pending item per verified citation after a fresh eligible-role recheck", async () => {
    const writes = port();
    const result = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:create:1",
      review_id: "review",
      execution,
      mutation_port: writes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.items).toHaveLength(1);
    expect(result.review.items[0]).toMatchObject({
      item_key: "citation-1",
      original_text: "Original",
      finding_text: "Original",
      status: "pending",
    });
    expect(Object.isFrozen(result.review.items[0].citation)).toBe(true);
    expect(writes.create).toHaveBeenCalledTimes(1);
  });

  it("keeps citation-free output reviewable and rejects duplicates, wrong role, same author, or stale access with zero write", async () => {
    const cases: Array<{
      execution?: unknown;
      scope?: typeof scope;
      reads?: TenancyReadPort;
    }> = [
      { execution: { ...execution, citations: [citation, citation] } },
      { scope: { ...scope, membership_role: "viewer" as never } },
      { execution: { ...execution, author_user_id: "reviewer" } },
      { reads: tenancy({ authorization_epoch: 3 }) },
    ];
    for (const value of cases) {
      const writes = port();
      const result = await createHumanReview({
        ...auth,
        granted_scope: value.scope ?? scope,
        tenancy_port: value.reads ?? tenancy(),
        idempotency_key: "review:create:1",
        review_id: "review",
        execution: value.execution ?? execution,
        mutation_port: writes,
      });
      expect(result.ok).toBe(false);
      expect(writes.create).not.toHaveBeenCalled();
    }
    const writes = port();
    const noCitations = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:create:2",
      review_id: "review-2",
      execution: {
        ...execution,
        citations: [],
        evidence_receipt_sha256: noCitationReceipt.receipt_sha256,
      },
      evidence_receipt: noCitationReceipt,
      mutation_port: writes,
    });
    expect(noCitations.ok && noCitations.review.items[0].original_text).toBe(
      "Sin citas",
    );
  });

  it("records immutable before/after decisions and enforces edit/comment bounds and terminal immutability", async () => {
    const writes = port();
    const created = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:create:3",
      review_id: "review-3",
      execution,
      mutation_port: writes,
    });
    if (!created.ok) throw new Error("fixture");
    const decided = await decideHumanReviewItem({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:decide:1",
      review: created.review,
      item_id: created.review.items[0].item_id,
      decision: "edited",
      finding_text: "  Corregido  ",
      comment: " nota ",
      mutation_port: writes,
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.transition.before.status).toBe("pending");
    expect(decided.transition.after).toMatchObject({
      status: "edited",
      finding_text: "Corregido",
      comment: "nota",
    });
    expect(created.review.items[0].status).toBe("pending");
    const invalid = await decideHumanReviewItem({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:decide:2",
      review: created.review,
      item_id: created.review.items[0].item_id,
      decision: "edited",
      finding_text: " ",
      mutation_port: writes,
    });
    expect(invalid.ok).toBe(false);
    const terminal = { ...decided.review, status: "approved" as const };
    expect(
      (
        await decideHumanReviewItem({
          ...auth,
          tenancy_port: tenancy(),
          idempotency_key: "review:decide:3",
          review: terminal,
          item_id: terminal.items[0].item_id,
          decision: "accepted",
          mutation_port: writes,
        })
      ).ok,
    ).toBe(false);
  });

  it("approves only fully resolved exact verified state; changes_requested is terminal but not approval authority", async () => {
    const writes = port();
    const created = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:create:4",
      review_id: "review-4",
      execution,
      mutation_port: writes,
    });
    if (!created.ok) throw new Error("fixture");
    expect(
      (
        await completeHumanReview({
          ...auth,
          tenancy_port: tenancy(),
          idempotency_key: "review:complete:0",
          review: created.review,
          execution,
          terminal_state: "approved",
          mutation_port: writes,
        })
      ).ok,
    ).toBe(false);
    const decided = await decideHumanReviewItem({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:decide:4",
      review: created.review,
      item_id: created.review.items[0].item_id,
      decision: "accepted",
      mutation_port: writes,
    });
    if (!decided.ok) throw new Error("fixture");
    const approved = await completeHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:complete:1",
      review: decided.review,
      execution,
      terminal_state: "approved",
      mutation_port: writes,
    });
    expect(approved.ok && approved.review.status).toBe("approved");
    const requested = await completeHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:complete:2",
      review: decided.review,
      execution,
      terminal_state: "changes_requested",
      mutation_port: writes,
    });
    expect(requested.ok && requested.review.status).toBe("changes_requested");
  });

  it("contains dependency/hostile receipt failures, writes at most once, and accepts exact replay", async () => {
    const writes = port();
    vi.mocked(writes.create).mockResolvedValueOnce({
      disposition: "replayed",
      operation: "create",
      review_id: "review-5",
      item_id: null,
      revision: 1,
      idempotency_key: "review:create:5",
    });
    const replay = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:create:5",
      review_id: "review-5",
      execution,
      mutation_port: writes,
    });
    expect(replay.ok).toBe(true);
    const hostile = port();
    vi.mocked(hostile.create).mockResolvedValueOnce(
      Object.defineProperty({}, "review_id", {
        enumerable: true,
        get() {
          throw new Error("SECRET");
        },
      }),
    );
    const failed = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:create:6",
      review_id: "review-6",
      execution,
      mutation_port: hostile,
    });
    expect(failed).toEqual({ ok: false, error_class: "review_write_failed" });
    expect(hostile.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failed)).not.toContain("SECRET");
  });
});
