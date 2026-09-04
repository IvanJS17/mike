import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  produceApprovedRedlineBundle,
  type ApprovedRedlineAppendPort,
} from "./approvedRedlineBundle";
import type { TenancyReadPort } from "../authorization/tenancyReadPort";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pageText = "Árbol contrato cláusula";
const canonical =
  '{"execution_id":"execution","receipt_version":"evidence-v1"}';
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
      item_id: "item-1",
      item_key: "c-1",
      original_text: "Original",
      finding_text: "Reemplazo",
      status: "edited" as const,
      comment: null,
      citation,
    },
    {
      item_id: "item-r",
      item_key: "c-r",
      original_text: "Original",
      finding_text: "Original",
      status: "rejected" as const,
      comment: null,
      citation: {
        ...citation,
        citation_id: "c-r",
        span: { start_char: 6, end_char: 14 },
        quote_sha256: sha("contrato"),
      },
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
  output_text: "SECRET output",
  citations: review.items.map((item) => item.citation),
};
const evidenceReceipt = {
  receipt_version: "evidence-v1",
  canonical_json: canonical,
  receipt_sha256: receiptHash,
};
const pages = [
  {
    document_id: "doc",
    document_version_id: "version",
    page: 1,
    content: pageText,
    content_sha256: sha(pageText),
  },
];
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
function appendPort(): ApprovedRedlineAppendPort {
  return {
    append: vi.fn(async (bundle) => ({
      disposition: "applied",
      review_id: bundle.review_id,
      review_revision: bundle.review_revision,
      execution_id: bundle.execution_id,
      bundle_sha256: bundle.bundle_sha256,
      action_count: bundle.actions.length,
      idempotency_key: bundle.idempotency_key,
    })),
  };
}
const base = {
  identity,
  granted_scope: scope,
  tenancy_port: tenancy(),
  requires_mfa: true,
  idempotency_key: "redline:review:4",
  revision: 1,
  review,
  execution,
  evidence_receipt: evidenceReceipt,
  source_version: {
    document_id: "doc",
    document_version_id: "version",
    content_sha256: "a".repeat(64),
  },
  pages,
};

describe("approved redline bundle", () => {
  it("builds deterministic deeply frozen actions with exact source/span/before/replacement hashes and no rejected content", async () => {
    const first = await produceApprovedRedlineBundle({
      ...base,
      append_port: appendPort(),
    });
    const locale = String.prototype.localeCompare;
    String.prototype.localeCompare = () => -1;
    try {
      const second = await produceApprovedRedlineBundle({
        ...base,
        pages: [...pages].reverse(),
        append_port: appendPort(),
      });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.bundle.bundle_sha256).toBe(second.bundle.bundle_sha256);
      expect(first.bundle.actions[0]).toMatchObject({
        page: 1,
        start: 0,
        end: 5,
        before_text_sha256: sha("Árbol"),
        replacement_text: "Reemplazo",
        replacement_text_sha256: sha("Reemplazo"),
      });
      expect(first.bundle.canonical_json).not.toContain("Reemplazo");
      expect(first.bundle.canonical_json).not.toContain("SECRET");
      expect(Object.isFrozen(first.bundle.actions[0])).toBe(true);
    } finally {
      String.prototype.localeCompare = locale;
    }
  });

  it("fails closed with zero append on duplicates, overlap, tamper, supersession, missing action or stale access", async () => {
    const overlapItem = {
      ...review.items[0],
      item_id: "item-2",
      item_key: "two",
      citation: {
        ...citation,
        citation_id: "c-2",
        span: { start_char: 1, end_char: 5 },
        quote_sha256: sha("rbol"),
      },
    };
    const variants = [
      { pages: [pages[0], pages[0]] },
      { review: { ...review, items: [review.items[0], overlapItem] } },
      { pages: [{ ...pages[0], content_sha256: "0".repeat(64) }] },
      { review: { ...review, revision: 5 } },
      { review: { ...review, items: [review.items[1]] } },
      { reads: tenancy({ authorization_epoch: 3 }) },
    ];
    for (const variant of variants) {
      const append = vi.fn();
      const result = await produceApprovedRedlineBundle({
        ...base,
        ...variant,
        expected_review_revision: 4,
        tenancy_port: variant.reads ?? tenancy(),
        append_port: { append },
      });
      expect(result.ok).toBe(false);
      expect(append).not.toHaveBeenCalled();
    }
  });

  it("accepts exact replay once and contains hostile receipts without raw errors or retry", async () => {
    const replay = appendPort();
    vi.mocked(replay.append).mockImplementationOnce(async (bundle) => ({
      disposition: "replayed",
      review_id: bundle.review_id,
      review_revision: bundle.review_revision,
      execution_id: bundle.execution_id,
      bundle_sha256: bundle.bundle_sha256,
      action_count: bundle.actions.length,
      idempotency_key: bundle.idempotency_key,
    }));
    expect(
      (await produceApprovedRedlineBundle({ ...base, append_port: replay })).ok,
    ).toBe(true);
    expect(replay.append).toHaveBeenCalledTimes(1);
    const hostile = {
      append: vi.fn(async () =>
        Object.defineProperty({}, "review_id", {
          enumerable: true,
          get() {
            throw new Error("SECRET");
          },
        }),
      ),
    };
    const failed = await produceApprovedRedlineBundle({
      ...base,
      append_port: hostile,
    });
    expect(failed).toEqual({
      ok: false,
      error_class: "approved_redline_append_failed",
    });
    expect(hostile.append).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failed)).not.toContain("SECRET");
  });
});
