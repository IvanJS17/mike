import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SUPPORTED_RECOVERY_MIGRATION_ORDER } from "./migrationOrder";

/**
 * The supported populated-legacy route is intentionally not lexical. The
 * preflight is newer than E2a so that ordinary migration runners remain
 * fail-closed while this one explicitly preserves the legacy relation first.
 */
export const SUPPORTED_RECOVERY_ORDER = SUPPORTED_RECOVERY_MIGRATION_ORDER;

type Envelope =
  | { kind: "bare" }
  | { kind: "wrapped"; prefix: string; suffix: string };

export type KnownMigrationSource = {
  sha256: string;
  envelope: Envelope;
};

function wrapped(prefix: string): Envelope {
  return { kind: "wrapped", prefix, suffix: "commit;\n" };
}

/**
 * Hashes are pinned to the coordinator-approved source files. Adding a source
 * to the route requires changing this allowlist and its focused tests; no
 * generic transaction stripping or directory discovery is permitted.
 */
export const KNOWN_SUPPORTED_MIGRATIONS: Readonly<
  Record<(typeof SUPPORTED_RECOVERY_ORDER)[number], KnownMigrationSource>
> = {
  "20260831_01_recovery_identity_tenancy.sql": {
    sha256: "3b30204dcf45cd2a517db40059f0c12e775bf188a36bb0255ffb3b3f2e95defa",
    envelope: { kind: "bare" },
  },
  "20260902_01_recovery_onboarding_organization.sql": {
    sha256: "5fff9f6c1fc4648083745b840f3eceeb78779f2c3cfff8b3419bf687bb692036",
    envelope: { kind: "bare" },
  },
  "20260905_03_recovery_drive_publication_preflight.sql": {
    sha256: "1f52a97e10191c38fb8e87723e40ab95468cc3710772c355f6342d0e19c1d453",
    envelope: wrapped(
      "-- Migration date: 2026-09-05\n" +
        "-- Preserve the populated legacy Drive relation while the unchanged E2a\n" +
        "-- migration removes its obsolete public relation and guard function.\n" +
        "begin;\n",
    ),
  },
  "20260904_01_recovery_ai_evidence_review.sql": {
    sha256: "57e52368576dcd3d0c9e314d37165d21e26a7598cc9cfabf7d13836018955eb3",
    envelope: wrapped(
      "-- Migration date: 2026-09-04\n" +
        "-- E2a: converge the deployed LiTT AI evidence/review persistence shape with\n" +
        "-- the recovered evidence-v1 and approved-redline-v1 contracts.\n\n" +
        "begin;\n",
    ),
  },
  "20260905_01_recovery_core_convergence.sql": {
    sha256: "30bcdf897c43bf3a77b6d8dc90e5bfb455a42ddf43d9e4b83f56f6fc3b259ec9",
    envelope: wrapped(
      "-- Migration date: 2026-09-05\n" +
        "-- Recovery core convergence: explicit, data-preserving upgrade from supported LiTT baseline.\n" +
        "begin;\n",
    ),
  },
  "20260905_02_recovery_approved_artifact_storage.sql": {
    sha256: "8aaaff3c3638b213819dfc1bd81f4e5b5e8f4f59018598098e3fd20bf09a5a37",
    envelope: wrapped(
      "-- Migration date: 2026-09-05\n" +
        "-- Approved DOCX object identity is durable and append-only.\n" +
        "begin;\n",
    ),
  },
  "20260905_04_recovery_drive_publication.sql": {
    sha256: "d9dc7673e4ef28cb9541ff06a337ec259252f8eea4600e8ab16731af9d1a20ad",
    envelope: wrapped(
      "-- Migration date: 2026-09-05\n" +
        "-- Restore the preserved relation in place and publish a canonical,\n" +
        "-- read-only historical Drive publication shape.\n" +
        "begin;\n",
    ),
  },
  "20260905_05_recovery_drive_publication_rpc.sql": {
    sha256: "d94320e4951e4cba5676918c8553135cb5a25c71d465607d0146f1d37584e1b1",
    envelope: wrapped(
      "-- Migration date: 2026-09-05\n" +
        "-- Coordinator-owned 5.2 Drive publication persistence RPC boundary.\n" +
        "-- Canonical rows are claimed before any external upload and may only be\n" +
        "-- advanced through the two lifecycle RPCs below.\n" +
        "begin;\n",
    ),
  },
  "20260905_06_recovery_matter_drive_folder.sql": {
    sha256: "94c0e9c6a2873f4e4f41b29325d8fd17205b11eb0ab5039009243c80260a9388",
    envelope: wrapped(
      "-- Migration date: 2026-09-05\n" +
        "-- Persist the matter-bound Drive folder through one service-role mutation RPC.\n" +
        "begin;\n",
    ),
  },
  "20260909_01_recovery_native_evidence_hashes.sql": {
    sha256: "af8bede510792f2fae17fd41e6674a06cbb9d6a9a003d46477bca91aadeaf89d",
    envelope: { kind: "wrapped", prefix: "-- Migration date: 2026-09-09\n-- Use PostgreSQL's native SHA-256 over exact UTF-8 bytes. Supabase installs\n-- pgcrypto in extensions; privileged evidence RPCs deliberately search only\n-- public. Do not relocate pgcrypto or widen security-definer search paths.\n-- Existing hashes/rows and RPC grants are unchanged; replacement CHECKs validate\n-- all existing rows. Historical migrations remain immutable.\nbegin;\n", suffix: "commit;\n" },
  },
  "20260909_02_recovery_workflow_provenance.sql": {
    sha256: "a8c28a8e940ad95ed7c9dae12429aa501c36fce3de3b4aa345e68405a6a10df0",
    envelope: { kind: "wrapped", prefix: "-- Migration date: 2026-09-09\n-- Preserve per-entry origin and approval provenance in the sole runtime catalog.\n-- Historical rows retain NULL provenance until a source-backed catalog sync;\n-- do not invent validation or provenance for existing content.\nbegin;\n", suffix: "commit;\n" },
  },
  "20260909_03_recovery_remove_us_research_preference.sql": {
    sha256: "c00e534f17d19e5e0e03c1826b562e0b0936effece15f9639af8ffba6f6cca70",
    envelope: { kind: "wrapped", prefix: "-- CourtListener/US research is excluded from the recovered product.\nBEGIN;\n", suffix: "COMMIT;\n" },
  },
  "20260910_01_recovery_upstream_upload_sessions.sql": {
    sha256: "12c7362891e00e5d4bb22a18c19d26628f32fa0754a7429139268276ed35d62c",
    envelope: wrapped(
        "-- LiTT sync S2 port of upstream 20260828_02_upload_sessions.sql; renamed to the merge-time stem 20260910_01 (recovery series).\n" +
        "-- Body verbatim except the trailing notify pgrst statement, moved inside the transaction so the supported-upgrade\n" +
        "-- driver path (single encompassing transaction) keeps the reload signal.\n" +
        "-- Migration date: 2026-08-28\n" +
        "-- Direct-upload session schema: concurrent sessions, per-file processing jobs,\n" +
        "-- configurable creation limits, worker audit attribution, and a cross-replica\n" +
        "-- per-user claim cap.\n" +
        "--\n" +
        "-- This file consolidates the branch's two earlier drafts (20260824_01 and\n" +
        "-- 20260828_01) into a single transactional migration dated at the tip of the\n" +
        "-- migration order. The split versions had two deployment hazards:\n" +
        "--   1. 20260824_01 sorted BEFORE six migrations already released on main, so\n" +
        "--      an existing deployment (which applies only files newer than its\n" +
        "--      recorded version, in filename order) would skip the table-creating\n" +
        "--      file entirely and then fail on the index below.\n" +
        "--   2. 20260828_01 was non-transactional and dropped claim_upload_processing_job\n" +
        "--      before recreating it \u2014 a failure between the two statements would leave\n" +
        "--      a deployment with no claim function at all.\n" +
        "-- NOTE FOR MERGE: if further migrations land on main before this branch\n" +
        "-- merges, this file must be renamed past them \u2014 the filename is a position in\n" +
        "-- a global order that main owns, assigned at merge time, not authorship time.\n" +
        "begin;\n",
    ),
  },
  "20260910_02_recovery_upstream_db_jobs.sql": {
    sha256: "4d615b6b8e016c34c443b10ddd41b95fc59e2a74f70276c867558696f8dfd4fd",
    envelope: { kind: "bare" },
  },
  "20260910_03_recovery_upstream_organization_access.sql": {
    sha256: "48da784260c1e4a6b75d5dfafd3643466ac7a9dfea62ff0aa5f2b6306b326901",
    envelope: wrapped(
        "-- LiTT sync S3 port of upstream 20260904_01_organization_access.sql; renamed to the merge-time stem 20260910_03 (recovery series).\n" +
        "-- ADAPTED to LiTT invariants; deviations from upstream are marked \"LITT:\" and specified in\n" +
        "-- forensics/upstream-sync-plan-20260912/S3-DESIGN.md (§1 recortes, §2 decisiones):\n" +
        "--   * org_members is NOT adopted: every reference maps to organization_memberships\n" +
        "--     (closed role vocab, status='active', authorization_epoch).\n" +
        "--   * No role defaults on grants or invitations (explicit roles only).\n" +
        "--   * No implicit org-role -> content grants: membership alone grants NOTHING over content;\n" +
        "--     only explicit project_org_access_overrides / workflow_org_access_overrides grant roles.\n" +
        "--     (Upstream's admin->owner and member->editor mapping is rejected.)\n" +
        "--   * LITT: last-org_owner guard added (organization_memberships_protect_last_owner).\n" +
        "--   * user_id stays NOT NULL and user_id FKs are unchanged (no DROP NOT NULL, no FK re-adds).\n" +
        "--   * Org-aware overview RPCs are deferred (S3.2); this file does not touch them.\n" +
        "--   * Legacy shared_with / allow_edit columns are preserved (backfill-only in 20260910_04).\n" +
        "-- Migration date: 2026-09-04\n" +
        "\n" +
        "begin;\n",
    ),
  },
  "20260910_04_recovery_upstream_migrate_legacy_sharing.sql": {
    sha256: "743a5dc381b3e6bd507f1c6db380f724391601fa56d222bc4f6740d4a6791e8e",
    envelope: wrapped(
        "-- LiTT sync S3 port of upstream 20260904_02_migrate_legacy_sharing.sql; renamed to the merge-time stem 20260910_04 (recovery series).\n" +
        "-- ADAPTED: the column drops from upstream are deferred (recorte LiTT #7 in S3-DESIGN.md):\n" +
        "-- projects.shared_with, tabular_reviews.shared_with and workflow_shares.allow_edit are\n" +
        "-- preserved; this file only backfills the new grant tables / role column from them.\n" +
        "-- Legacy columns are written by nothing after S3; runtime reads the grants.\n" +
        "-- Migration date: 2026-09-04\n" +
        "\n" +
        "begin;\n",
    ),
  },
};

function sha256(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

/** Validate and unwrap one named, pinned migration source. */
export function normalizeKnownMigrationEnvelope(
  name: string,
  source: string,
  expected: KnownMigrationSource,
): string {
  if (sha256(source) !== expected.sha256) {
    throw new Error(`known migration source hash mismatch: ${name}`);
  }

  if (expected.envelope.kind === "bare") return source;
  const { prefix, suffix } = expected.envelope;
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) {
    throw new Error(`known migration transaction envelope mismatch: ${name}`);
  }
  return source.slice(prefix.length, source.length - suffix.length);
}

/** Build the one transaction sent by the caller to one psql connection. */
export function buildEncompassingTransaction(statements: string[]): string {
  return ["begin;", ...statements, "commit;", ""].join("\n");
}

export function buildSupportedUpgradeSql(options: {
  migrationsDir: string;
}): string {
  const statements = SUPPORTED_RECOVERY_ORDER.map((name) => {
    const source = fs.readFileSync(path.join(options.migrationsDir, name), "utf8");
    return `-- supported recovery source: ${name}\n${normalizeKnownMigrationEnvelope(
      name,
      source,
      KNOWN_SUPPORTED_MIGRATIONS[name],
    )}`;
  });
  return buildEncompassingTransaction(statements);
}
