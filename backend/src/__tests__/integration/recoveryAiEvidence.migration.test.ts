import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertRecoveryMigrationName } from "../../lib/recovery/migrationOrder";

const BACKEND_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const MIGRATIONS_DIR = path.join(BACKEND_DIR, "migrations");
const CANDIDATE = "20260904_01_recovery_ai_evidence_review.sql";
const CANDIDATE_PATH = path.join(MIGRATIONS_DIR, CANDIDATE);
const BASELINE_COMMIT = "d9fa8380e63837b6441cef169cf5ef80dfb55e54";
const TABLES = [
  "ai_document_version_pages",
  "ai_executions",
  "ai_output_versions",
  "ai_receipts",
  "ai_reviews",
  "ai_review_items",
  "ai_review_decisions",
  "ai_review_exports",
  "ai_redline_bundles",
] as const;
const RPCS = [
  "append_ai_evidence_batch",
  "create_ai_review",
  "apply_ai_review_item_decision",
  "complete_ai_review",
  "append_ai_review_export",
  "append_ai_redline_bundle",
  "assert_ai_redline_bundle_access",
] as const;

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function gitShow(spec: string): string {
  return execFileSync("git", ["show", spec], {
    cwd: BACKEND_DIR,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function tableBlock(sql: string, table: string): string {
  const match = new RegExp(
    `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\s*\\(`,
    "i",
  ).exec(sql);
  if (!match) return "";
  const end = sql.indexOf(";", match.index);
  return end < 0 ? "" : sql.slice(match.index, end + 1);
}

function functionBlock(sql: string, name: string): string {
  const match = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`,
    "i",
  ).exec(sql);
  if (!match) return "";
  const end = sql.indexOf("$$;", match.index);
  return end < 0 ? "" : sql.slice(match.index, end + 3);
}

const migration = read(CANDIDATE_PATH).toLowerCase();
const schema = read(path.join(BACKEND_DIR, "schema.sql")).toLowerCase();
const baseline = gitShow(`${BASELINE_COMMIT}:backend/schema.sql`).toLowerCase();
const domain = [
  "evidence/appendOnlyEvidence.ts",
  "evidence/executionEvidence.ts",
  "review/humanReview.ts",
  "review/approvedRedlineBundle.ts",
  "review/approvedReviewReport.ts",
  "sharedContracts.ts",
]
  .map((file) =>
    read(path.join(BACKEND_DIR, "src/lib/recovery", file)).toLowerCase(),
  )
  .join("\n");

describe("Slice E2a AI evidence/review persistence migration", () => {
  it("uses the exact collision-free recovery slot", () => {
    expect(migration).not.toBe("");
    expect(migration).toMatch(/^-- migration date: 2026-09-04\b/m);
    const existing = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql") && name !== CANDIDATE);
    expect(() =>
      assertRecoveryMigrationName(CANDIDATE, existing),
    ).not.toThrow();
    expect(() =>
      assertRecoveryMigrationName(CANDIDATE, [
        ...existing,
        "20260904_01_other.sql",
      ]),
    ).toThrow(/collides/i);
  });

  it("alters the deployed LiTT AI tables instead of hiding CREATE no-ops", () => {
    for (const table of TABLES) {
      expect(tableBlock(baseline, table)).not.toBe("");
      expect(tableBlock(schema, table)).not.toBe("");
      expect(migration).toMatch(
        new RegExp(`alter\\s+table\\s+public\\.${table}\\b`, "i"),
      );
      expect(migration).not.toMatch(
        new RegExp(
          `create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+public\\.${table}\\b`,
          "i",
        ),
      );
    }
    expect(baseline).toContain(
      "receipt_version text not null default 'beta-0.1'",
    );
    expect(baseline).toContain(
      "status in ('in_progress', 'approved', 'changes_requested')",
    );
    expect(migration).toMatch(
      /status\s*=\s*case\s+when\s+review\.status\s*=\s*'in_progress'\s+then\s+'pending'/,
    );
    expect(migration).toMatch(
      /if\s+exists[\s\S]*ai_review_drive_publications[\s\S]*raise\s+exception[\s\S]*drop\s+table\s+public\.ai_review_drive_publications/,
    );
    expect(schema).not.toMatch(/ai_review_drive_publications/);
    expect(schema).toMatch(/drive_folder_id/);
  });

  it("materializes the current E1 contract without obsolete duplicate route fields", () => {
    for (const token of [
      'receipt_version: "evidence-v1"',
      'bundle_version: "approved-redline-v1"',
      "organization_id",
      "matter_id",
      "project_id",
      "document_id",
      "document_version_id",
      "workflow_key",
      "content_hash",
      "source_commit",
      "approval_provenance",
      "provider",
      "model",
      "credential_ref",
      "idempotency_key",
      "review_revision",
      "replacement_text_sha256",
    ]) {
      expect(domain).toContain(token);
    }

    const execution = tableBlock(schema, "ai_executions");
    for (const column of [
      "idempotency_key",
      "evidence_version",
      "author_user_id",
      "organization_id",
      "matter_id",
      "project_id",
      "document_id",
      "document_version_id",
      "workflow_key",
      "workflow_version",
      "workflow_content_hash",
      "workflow_source_commit",
      "workflow_distribution",
      "workflow_type",
      "workflow_source",
      "workflow_approval_provenance",
      "input_hashes",
      "route_provider",
      "route_model",
      "credential_ref",
    ]) {
      expect(execution).toContain(column);
      expect(migration).toContain(column);
    }
    expect(execution).not.toContain("actual_provider");
    expect(execution).not.toContain("actual_model");
    expect(execution).not.toContain("playbook_sha256");
    expect(execution).not.toMatch(/\bworkflow_id\b/);

    const receipt = tableBlock(schema, "ai_receipts");
    for (const column of [
      "idempotency_key",
      "receipt_version",
      "canonical_json",
      "receipt_sha256",
    ]) {
      expect(receipt).toContain(column);
    }
    expect(receipt).toContain("evidence-v1");

    const review = tableBlock(schema, "ai_reviews");
    for (const column of [
      "idempotency_key",
      "revision",
      "execution_author_user_id",
      "reviewer_user_id",
      "organization_id",
      "document_content_sha256",
      "evidence_receipt_sha256",
    ]) {
      expect(review).toContain(column);
    }
    expect(review).toContain("'pending'");
    expect(review).not.toContain("'in_progress'");

    const bundle = tableBlock(schema, "ai_redline_bundles");
    for (const column of [
      "idempotency_key",
      "review_revision",
      "organization_id",
      "document_id",
      "evidence_receipt_version",
      "evidence_receipt_sha256",
      "reviewer_user_id",
      "canonical_json",
      "actions",
      "bundle_sha256",
    ]) {
      expect(bundle).toContain(column);
    }
    expect(bundle).toContain("approved-redline-v1");
    expect(bundle).toMatch(/default\s+'approved-redline-v1'/);
    expect(bundle).toContain("'legacy-beta-0.1', 'approved-redline-v1'");
  });

  it("preserves historical rows explicitly and removes obsolete executable shape", () => {
    expect(migration).toMatch(/legacy-beta-0\.1/);
    expect(migration).toMatch(
      /update\s+public\.ai_executions[\s\S]*organization_id/,
    );
    expect(migration).toMatch(
      /update\s+public\.ai_executions[\s\S]*workflow_key/,
    );
    expect(migration).toMatch(
      /update\s+public\.ai_receipts[\s\S]*canonical_json/,
    );
    expect(migration).toMatch(
      /rename\s+column\s+user_id\s+to\s+author_user_id/,
    );
    expect(migration).toMatch(
      /rename\s+column\s+workflow_id\s+to\s+workflow_key/,
    );
    expect(migration).toMatch(
      /rename\s+column\s+playbook_sha256\s+to\s+workflow_content_hash/,
    );
    expect(migration).toMatch(
      /rename\s+column\s+input_sha256\s+to\s+input_hashes/,
    );
    expect(tableBlock(schema, "ai_executions")).not.toMatch(
      /\b(playbook_sha256|input_sha256)\b/,
    );
  });

  it("fails closed on retention and restricts every AI parent reference", () => {
    expect(migration).not.toMatch(/delete\s+from\s+public\.ai_/);
    expect(migration).not.toMatch(/truncate\s+(?:table\s+)?public\.ai_/);
    for (const table of TABLES) {
      const block = tableBlock(schema, table);
      expect(block).not.toMatch(/on\s+delete\s+cascade/);
    }
    expect(schema).toMatch(
      /document_versions_source_check[\s\S]*'ai_review_report'/,
    );
  });

  it("keeps writes behind locked SECURITY DEFINER RPCs", () => {
    for (const rpc of RPCS) {
      const inMigration = functionBlock(migration, rpc);
      const inSchema = functionBlock(schema, rpc);
      for (const block of [inMigration, inSchema]) {
        expect(block).not.toBe("");
        expect(block).toMatch(/security\s+definer/);
        expect(block).toMatch(/set\s+search_path\s*=\s*public/);
      }
      expect(migration).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+function\\s+public\\.${rpc}\\([\\s\\S]*?from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+public\\.${rpc}\\([\\s\\S]*?to\\s+service_role`,
          "i",
        ),
      );
    }
    expect(migration).toMatch(/authorization_epoch[\s\S]*for\s+update/);
    expect(migration).toMatch(
      /organization_memberships[\s\S]*status\s*=\s*'active'/,
    );
    expect(migration).toMatch(/matter_memberships[\s\S]*status\s*=\s*'active'/);
    expect(migration).not.toMatch(
      /create\s+or\s+replace\s+function\s+public\.revoke_organization_membership/,
    );
    expect(migration).not.toMatch(
      /drop\s+function[\s\S]*revoke_organization_membership/,
    );
  });

  it("enforces append-only tables, RLS, and least-privilege table grants", () => {
    for (const table of TABLES) {
      expect(schema).toMatch(
        new RegExp(
          `alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon\\s*,\\s*authenticated\\s*,\\s*service_role`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `grant\\s+select\\s+on\\s+public\\.${table}\\s+to\\s+service_role`,
          "i",
        ),
      );
      expect(migration).not.toMatch(
        new RegExp(
          `grant\\s+[^;]*(insert|update|delete|truncate)[^;]*public\\.${table}[^;]*service_role`,
          "i",
        ),
      );
    }
    for (const table of [
      "ai_document_version_pages",
      "ai_output_versions",
      "ai_receipts",
      "ai_review_decisions",
      "ai_review_exports",
      "ai_redline_bundles",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `create\\s+trigger\\s+\\w+[^;]*before\\s+update\\s+or\\s+delete\\s+on\\s+public\\.${table}`,
          "i",
        ),
      );
    }
  });
});
