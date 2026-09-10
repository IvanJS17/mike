import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  completeHumanReview,
  createHumanReview,
  decideHumanReviewItem,
  parseBoundEvidenceReceipt,
  parseHumanReview,
  parseHumanReviewExecution,
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
  it("accepts canonical chat scope, preserves hashed output bytes, and rejects non-E1a receipt arrays", () => {
    const secondCitation = {
      ...citation,
      citation_id: "citation-2",
      page: 2,
      finding_text: "Segundo",
    };
    const output = "  Sin citas\n";
    const chatBody = {
      ...JSON.parse(evidenceCanonical),
      tenant_scope: {
        organization_id: "org",
        matter_id: "matter",
        project_id: "project",
        chat_id: "chat-1",
        document_version_id: "version",
      },
      input_hashes: ["0".repeat(64), "a".repeat(64), "a".repeat(64)],
      page_hashes: [
        JSON.parse(evidenceCanonical).page_hashes[0],
        {
          document_id: "doc",
          document_version_id: "version",
          page: 2,
          text_sha256: sha("page-2"),
        },
      ],
      output_hash: sha(output),
      citation_hashes: [citation, secondCitation].map((item) => ({
        citation_id: item.citation_id,
        document_id: item.document_id,
        document_version_id: item.document_version_id,
        page: item.page,
        span: item.span,
        quote_sha256: item.quote_sha256,
        finding_sha256: sha(item.finding_text),
      })),
    };
    const canonical = canonicalize(chatBody);
    const parsedExecution = parseHumanReviewExecution({
      ...execution,
      chat_id: "chat-1",
      evidence_receipt_sha256: sha(canonical),
      output_text: output,
      output_sha256: sha(output),
      citations: [citation, secondCitation],
    });
    expect(parsedExecution?.output_text).toBe(output);
    expect(parsedExecution && sha(parsedExecution.output_text)).toBe(
      parsedExecution?.output_sha256,
    );
    const boundReceipt =
      parsedExecution &&
      parseBoundEvidenceReceipt(
        {
          receipt_version: "evidence-v1",
          canonical_json: canonical,
          receipt_sha256: sha(canonical),
        },
        parsedExecution,
      );
    expect(boundReceipt).not.toBeNull();
    expect(boundReceipt?.receipt_sha256).toBe(sha(canonical));
    expect(boundReceipt?.page_hashes).toEqual(chatBody.page_hashes);
    expect(Object.isFrozen(boundReceipt?.page_hashes)).toBe(true);
    expect(Object.isFrozen(boundReceipt?.page_hashes[0])).toBe(true);

    for (const invalidBody of [
      {
        ...chatBody,
        citation_hashes: [
          chatBody.citation_hashes[0],
          chatBody.citation_hashes[0],
        ],
      },
      { ...chatBody, input_hashes: [...chatBody.input_hashes].reverse() },
      { ...chatBody, page_hashes: [...chatBody.page_hashes].reverse() },
      { ...chatBody, citation_hashes: [...chatBody.citation_hashes].reverse() },
    ]) {
      const invalidCanonical = canonicalize(invalidBody);
      expect(
        parsedExecution &&
          parseBoundEvidenceReceipt(
            {
              receipt_version: "evidence-v1",
              canonical_json: invalidCanonical,
              receipt_sha256: sha(invalidCanonical),
            },
            {
              ...parsedExecution,
              evidence_receipt_sha256: sha(invalidCanonical),
            },
          ),
      ).toBeNull();
    }
  });

  it("snapshots create identifiers and complete terminal state exactly once", async () => {
    let reviewIdReads = 0;
    let createKeyReads = 0;
    const created = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      get review_id() {
        reviewIdReads += 1;
        return reviewIdReads === 1 ? "review-snapshot" : "review-forged";
      },
      get idempotency_key() {
        createKeyReads += 1;
        return createKeyReads === 1 ? "review:create:snapshot" : "forged";
      },
      execution,
      mutation_port: port(),
    });
    expect(created.ok).toBe(true);
    expect(reviewIdReads).toBe(1);
    expect(createKeyReads).toBe(1);
    if (!created.ok) return;

    const decided = await decideHumanReviewItem({
      ...auth,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      idempotency_key: "review:decide:snapshot",
      review: created.review,
      item_id: created.review.items[0].item_id,
      decision: "accepted",
      mutation_port: port(),
    });
    if (!decided.ok) throw new Error("fixture");
    let terminalReads = 0;
    const completed = await completeHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      idempotency_key: "review:complete:snapshot",
      review: decided.review,
      execution,
      get terminal_state() {
        terminalReads += 1;
        return terminalReads === 1 ? "approved" : "changes_requested";
      },
      mutation_port: port(),
    });
    expect(completed.ok && completed.review.status).toBe("approved");
    expect(terminalReads).toBe(1);
  });

  it("round-trips completion before authorization and writes only the parsed projection", async () => {
    const setupWrites = port();
    const created = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      idempotency_key: "review:create:complete-round-trip",
      review_id: "review-complete-round-trip",
      execution,
      mutation_port: setupWrites,
    });
    if (!created.ok) throw new Error("fixture");
    const decided = await decideHumanReviewItem({
      ...auth,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      idempotency_key: "review:decide:complete-round-trip",
      review: created.review,
      item_id: created.review.items[0].item_id,
      decision: "accepted",
      mutation_port: setupWrites,
    });
    if (!decided.ok) throw new Error("fixture");

    const invalidTenancy = tenancy();
    const invalidResources = resources();
    const invalidWrites = port();
    const objectKeys = Object.keys;
    const keysSpy = vi.spyOn(Object, "keys").mockImplementation(((
      value: object,
    ) => {
      const keys = objectKeys(value);
      return (value as { status?: unknown }).status === "approved" &&
        keys.includes("review_id")
        ? [...keys, "unexpected"]
        : keys;
    }) as typeof Object.keys);
    let invalidCompletion;
    try {
      invalidCompletion = await completeHumanReview({
        ...auth,
        tenancy_port: invalidTenancy,
        resource_scope_port: invalidResources,
        idempotency_key: "review:complete:invalid-round-trip",
        review: decided.review,
        execution,
        terminal_state: "approved",
        mutation_port: invalidWrites,
      });
    } finally {
      keysSpy.mockRestore();
    }
    expect(invalidCompletion).toEqual({
      ok: false,
      error_class: "invalid_review",
    });
    expect(invalidTenancy.getOrganizationMembership).not.toHaveBeenCalled();
    expect(invalidResources.getEvidenceResourceScope).not.toHaveBeenCalled();
    expect(invalidWrites.complete).not.toHaveBeenCalled();

    const successWrites = port();
    const completed = await completeHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      idempotency_key: "review:complete:valid-round-trip",
      review: decided.review,
      execution,
      terminal_state: "approved",
      mutation_port: successWrites,
    });
    if (!completed.ok) throw new Error("completion");
    const sentReview = vi.mocked(successWrites.complete).mock.calls[0][0]
      .review;
    expect(sentReview.items).not.toBe(decided.review.items);
    expect(sentReview.items[0]).not.toBe(decided.review.items[0]);
    expect(completed.review).toBe(sentReview);
    expect(Object.isFrozen(completed.review.items[0])).toBe(true);
  });

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

  it("round-trips repeated decisions with canonical accepted/rejected text and explicit edits", async () => {
    const writes = port();
    const created = await createHumanReview({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:create:redecision",
      review_id: "review-redecision",
      execution,
      mutation_port: writes,
    });
    if (!created.ok) throw new Error("fixture");
    const edited = await decideHumanReviewItem({
      ...auth,
      tenancy_port: tenancy(),
      idempotency_key: "review:decide:edited",
      review: created.review,
      item_id: created.review.items[0].item_id,
      decision: "edited",
      finding_text: "Explicit replacement",
      mutation_port: writes,
    });
    if (!edited.ok) throw new Error("fixture");

    for (const decision of ["accepted", "rejected"] as const) {
      const terminalDecision = await decideHumanReviewItem({
        ...auth,
        tenancy_port: tenancy(),
        idempotency_key: `review:decide:${decision}`,
        review: edited.review,
        item_id: edited.review.items[0].item_id,
        decision,
        mutation_port: writes,
      });
      expect(terminalDecision.ok).toBe(true);
      if (!terminalDecision.ok) continue;
      expect(terminalDecision.review.items[0].finding_text).toBe("Original");
      expect(parseHumanReview(terminalDecision.review)).not.toBeNull();

      const reedited = await decideHumanReviewItem({
        ...auth,
        tenancy_port: tenancy(),
        idempotency_key: `review:decide:${decision}:edited`,
        review: terminalDecision.review,
        item_id: terminalDecision.review.items[0].item_id,
        decision: "edited",
        finding_text: `Explicit ${decision} replacement`,
        mutation_port: writes,
      });
      expect(reedited.ok).toBe(true);
      if (reedited.ok)
        expect(reedited.review.items[0].finding_text).toBe(
          `Explicit ${decision} replacement`,
        );
    }
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
