import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  produceApprovedReviewReport,
  type ApprovedArtifactAppendPort,
  type ApprovedDocxRendererPort,
} from "./approvedReviewReport";
import type { TenancyReadPort } from "../authorization/tenancyReadPort";
import type { EvidenceResourceScopePort } from "../evidence/appendOnlyEvidence";

const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
};
async function minimalDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("_rels/.rels", "<Relationships/>");
  zip.file("word/document.xml", "<w:document/>");
  return zip.generateAsync({ type: "uint8array" });
}
const outputText = "SECRET raw output";
const outputSha = sha(outputText);
const receiptBody = {
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
  citation_hashes: ["c-1", "c-2", "c-3"].map((citation_id) => ({
    citation_id,
    document_id: "doc",
    document_version_id: "version",
    page: 1,
    span: { start_char: 0, end_char: 5 },
    quote_sha256: sha("Árbol"),
    finding_sha256: sha("Original"),
  })),
};
const canonical = canonicalize(receiptBody);
const receiptHash = sha(canonical);
const citation = {
  citation_id: "c-1",
  document_id: "doc",
  document_version_id: "version",
  page: 1,
  span: { start_char: 0, end_char: 5 },
  quote_sha256: sha("Árbol"),
  finding_text: "Original",
  verified: true as const,
};
const review = {
  review_id: "review",
  revision: 4,
  execution_id: "execution",
  execution_author_user_id: "author",
  reviewer_user_id: "reviewer",
  organization_id: "org",
  matter_id: "matter",
  project_id: "project",
  document_id: "doc",
  document_version_id: "version",
  document_content_sha256: "a".repeat(64),
  evidence_receipt_sha256: receiptHash,
  status: "approved" as const,
  items: [
    {
      item_id: "i-accepted",
      item_key: "c-1",
      original_text: "Original",
      finding_text: "Original",
      status: "accepted" as const,
      comment: null,
      citation,
    },
    {
      item_id: "i-edited",
      item_key: "c-2",
      original_text: "Original",
      finding_text: "Editado",
      status: "edited" as const,
      comment: "SECRET comment",
      citation: { ...citation, citation_id: "c-2" },
    },
    {
      item_id: "i-rejected",
      item_key: "c-3",
      original_text: "Original",
      finding_text: "Original",
      status: "rejected" as const,
      comment: null,
      citation: { ...citation, citation_id: "c-3" },
    },
  ],
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
  evidence_receipt_sha256: receiptHash,
  output_text: outputText,
  output_sha256: outputSha,
  citations: review.items.map((item) => item.citation),
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
function tenancy(
  order: string[] = [],
  overrides: Record<string, unknown> = {},
): TenancyReadPort {
  return {
    getOrganizationMembership: vi.fn(async () => {
      order.push("membership");
      return {
        user_id: "reviewer",
        organization_id: "org",
        role: "org_owner",
        status: "active",
        authorization_epoch: 2,
        ...overrides,
      };
    }) as TenancyReadPort["getOrganizationMembership"],
    getMatter: vi.fn(async () => {
      order.push("matter");
      return {
        matter_id: "matter",
        workspace_id: "ws",
        organization_id: "org",
        visibility: "private",
      };
    }),
    getMatterMembership: vi.fn(async () => {
      order.push("matterMembership");
      return {
        user_id: "reviewer",
        matter_id: "matter",
        role: "matter_owner",
        status: "active",
      };
    }),
  };
}
function resources(
  order: string[] = [],
  overrides: Record<string, unknown> = {},
): EvidenceResourceScopePort {
  return {
    getEvidenceResourceScope: vi.fn(async () => {
      order.push("resourceScope");
      return {
        organization_id: "org",
        matter_id: "matter",
        project_id: "project",
        document_id: "doc",
        document_version_id: "version",
        document_content_sha256: "a".repeat(64),
        ...overrides,
      };
    }),
  };
}
const evidenceReceipt = {
  receipt_version: "evidence-v1",
  canonical_json: canonical,
  receipt_sha256: receiptHash,
};
const minimalCanonical = canonicalize({
  execution_id: "execution",
  receipt_version: "evidence-v1",
});
const minimalReceipt = {
  receipt_version: "evidence-v1",
  canonical_json: minimalCanonical,
  receipt_sha256: sha(minimalCanonical),
};

describe("approved review report", () => {
  it("fails closed before render for scope drift, revocation, fake evidence and missing revision", async () => {
    const safeReview = {
      ...review,
      items: review.items.map((item) =>
        item.status === "accepted"
          ? { ...item, finding_text: item.original_text }
          : item,
      ),
    };
    const cases = [
      {
        reads: tenancy(),
        resources: resources([], { project_id: "foreign" }),
        receipt: evidenceReceipt,
        expected: 4,
      },
      {
        reads: tenancy([], { authorization_epoch: 3 }),
        resources: resources(),
        receipt: evidenceReceipt,
        expected: 4,
      },
      {
        reads: tenancy(),
        resources: resources(),
        receipt: minimalReceipt,
        expected: 4,
      },
      {
        reads: tenancy(),
        resources: resources(),
        receipt: evidenceReceipt,
        expected: undefined,
      },
    ];
    for (const [index, value] of cases.entries()) {
      const renderer = vi.fn(async () => Uint8Array.from([0x50, 0x4b, 3]));
      const append = vi.fn();
      const result = await produceApprovedReviewReport({
        identity,
        granted_scope: scope,
        tenancy_port: value.reads,
        resource_scope_port: value.resources,
        requires_mfa: true,
        idempotency_key: `report:boundary:${index}`,
        ...(value.expected === undefined
          ? {}
          : { expected_review_revision: value.expected }),
        review: safeReview,
        execution,
        evidence_receipt: value.receipt,
        renderer: { render: renderer },
        append_port: { append },
      } as never);
      expect(result.ok).toBe(false);
      expect(renderer, `renderer case ${index}`).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    }
  });

  it("rejects forged accepted content and PK-prefixed junk without append", async () => {
    for (const candidate of [
      {
        ...review,
        items: review.items.map((item) =>
          item.status === "accepted"
            ? { ...item, finding_text: "UNREVIEWED ALTERATION" }
            : item,
        ),
      },
      {
        ...review,
        items: review.items.map((item) =>
          item.status === "accepted"
            ? { ...item, finding_text: item.original_text }
            : item,
        ),
      },
    ]) {
      const append = vi.fn();
      const renderer = vi.fn(async () => Uint8Array.from([0x50, 0x4b, 3]));
      const result = await produceApprovedReviewReport({
        identity,
        granted_scope: scope,
        tenancy_port: tenancy(),
        resource_scope_port: resources(),
        requires_mfa: true,
        idempotency_key: "report:invalid-content",
        expected_review_revision: 4,
        review: candidate,
        execution,
        evidence_receipt: evidenceReceipt,
        renderer: { render: renderer },
        append_port: { append },
      } as never);
      expect(result.ok).toBe(false);
      expect(append).not.toHaveBeenCalled();
    }
  });
  it("snapshots expected review revision exactly once", async () => {
    let reads = 0;
    const append: ApprovedArtifactAppendPort = {
      append: vi.fn(async (artifact) => ({
        disposition: "applied",
        review_id: artifact.review_id,
        review_revision: artifact.review_revision,
        execution_id: artifact.execution_id,
        artifact_sha256: artifact.artifact_sha256,
        idempotency_key: artifact.idempotency_key,
      })),
    };
    const result = await produceApprovedReviewReport({
      identity,
      granted_scope: scope,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      requires_mfa: true,
      idempotency_key: "report:revision-getter",
      get expected_review_revision() {
        reads += 1;
        return reads === 1 ? 4 : 5;
      },
      review,
      execution,
      evidence_receipt: evidenceReceipt,
      renderer: { render: vi.fn(async () => minimalDocx()) },
      append_port: append,
    });
    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
  });

  it("renders a deterministic frozen accepted/edited-only plan and appends actual DOCX hash after fresh auth", async () => {
    const order: string[] = [];
    const bytes = await minimalDocx();
    const renderer: ApprovedDocxRendererPort = {
      render: vi.fn(async (plan) => {
        order.push("render");
        expect(Object.isFrozen(plan.sections)).toBe(true);
        return bytes;
      }),
    };
    const append: ApprovedArtifactAppendPort = {
      append: vi.fn(async (artifact) => {
        order.push("append");
        return {
          disposition: "applied",
          review_id: artifact.review_id,
          review_revision: artifact.review_revision,
          execution_id: artifact.execution_id,
          artifact_sha256: artifact.artifact_sha256,
          idempotency_key: artifact.idempotency_key,
        };
      }),
    };
    const result = await produceApprovedReviewReport({
      identity,
      granted_scope: scope,
      tenancy_port: tenancy(order),
      resource_scope_port: resources(order),
      requires_mfa: true,
      idempotency_key: "report:review:4",
      expected_review_revision: 4,
      review,
      execution,
      evidence_receipt: evidenceReceipt,
      renderer,
      append_port: append,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.artifact_sha256).toBe(sha(bytes));
    expect(order).toEqual([
      "membership",
      "matter",
      "matterMembership",
      "resourceScope",
      "render",
      "append",
    ]);
    const renderedPlan = vi.mocked(renderer.render).mock.calls[0][0];
    const serialized = JSON.stringify(renderedPlan);
    expect(serialized).toContain("Aceptado");
    expect(serialized).toContain("Editado");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("rejected");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects changes_requested, receipt/scope tamper, invalid bytes, stale auth and malformed replay without append", async () => {
    const variants = [
      {
        review: { ...review, status: "changes_requested" },
        receipt: evidenceReceipt,
        bytes: Uint8Array.from([0x50, 0x4b, 3]),
        reads: tenancy(),
      },
      {
        review,
        receipt: { ...evidenceReceipt, receipt_sha256: "0".repeat(64) },
        bytes: Uint8Array.from([0x50, 0x4b, 3]),
        reads: tenancy(),
      },
      {
        review: { ...review, project_id: "other" },
        receipt: evidenceReceipt,
        bytes: Uint8Array.from([0x50, 0x4b, 3]),
        reads: tenancy(),
      },
      {
        review,
        receipt: evidenceReceipt,
        bytes: Uint8Array.from([1, 2, 3]),
        reads: tenancy(),
      },
      {
        review,
        receipt: evidenceReceipt,
        bytes: Uint8Array.from([0x50, 0x4b, 3]),
        reads: tenancy([], { authorization_epoch: 3 }),
      },
    ];
    for (const variant of variants) {
      const append = vi.fn();
      const result = await produceApprovedReviewReport({
        identity,
        granted_scope: scope,
        tenancy_port: variant.reads,
        resource_scope_port: resources(),
        requires_mfa: true,
        idempotency_key: "report:review:4",
        expected_review_revision: 4,
        review: variant.review,
        execution,
        evidence_receipt: variant.receipt,
        renderer: { render: vi.fn(async () => variant.bytes) },
        append_port: { append },
      });
      expect(result.ok).toBe(false);
      expect(append).not.toHaveBeenCalled();
    }
    const append = vi.fn(async () => ({
      disposition: "replayed",
      review_id: "wrong",
    }));
    expect(
      (
        await produceApprovedReviewReport({
          identity,
          granted_scope: scope,
          tenancy_port: tenancy(),
          resource_scope_port: resources(),
          requires_mfa: true,
          idempotency_key: "report:review:4",
          expected_review_revision: 4,
          review,
          execution,
          evidence_receipt: evidenceReceipt,
          renderer: {
            render: vi.fn(async () => minimalDocx()),
          },
          append_port: { append },
        })
      ).ok,
    ).toBe(false);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("snapshots hostile renderer/receipt boundaries opaquely and never retries", async () => {
    const append = vi.fn();
    const throwingRenderer = {
      render: vi.fn(async () => {
        throw new Error("SECRET renderer");
      }),
    };
    const failed = await produceApprovedReviewReport({
      identity,
      granted_scope: scope,
      tenancy_port: tenancy(),
      resource_scope_port: resources(),
      requires_mfa: true,
      idempotency_key: "report:review:4",
      expected_review_revision: 4,
      review,
      execution,
      evidence_receipt: evidenceReceipt,
      renderer: throwingRenderer,
      append_port: { append },
    });
    expect(failed).toEqual({
      ok: false,
      error_class: "approved_report_render_failed",
    });
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    expect(throwingRenderer.render).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });
});
