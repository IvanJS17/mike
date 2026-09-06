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
