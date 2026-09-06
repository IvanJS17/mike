import { describe, expect, it } from "vitest";

import {
  SUPPORTED_RECOVERY_ORDER,
  buildEncompassingTransaction,
  buildSupportedUpgradeSql,
  normalizeKnownMigrationEnvelope,
} from "./supportedUpgradeDriver";

describe("supported populated legacy Drive upgrade manifest", () => {
  it("places the preflight before E2a and publication alignment after artifact storage", () => {
    expect(SUPPORTED_RECOVERY_ORDER).toEqual([
      "20260831_01_recovery_identity_tenancy.sql",
      "20260902_01_recovery_onboarding_organization.sql",
      "20260905_03_recovery_drive_publication_preflight.sql",
      "20260904_01_recovery_ai_evidence_review.sql",
      "20260905_01_recovery_core_convergence.sql",
      "20260905_02_recovery_approved_artifact_storage.sql",
      "20260905_04_recovery_drive_publication.sql",
      "20260905_05_recovery_drive_publication_rpc.sql",
    ]);
  });

  it("accepts only the exact known transaction envelope for a named source", () => {
    const source = "-- known\nbegin;\nselect 1;\ncommit;\n";
    expect(
      normalizeKnownMigrationEnvelope(
        "known.sql",
        source,
        {
          sha256:
            "2e0d259ffa56622a3515384aa2f4e533b2a0a676dfe262c3f7e466a1487df79e",
          envelope: { prefix: "-- known\nbegin;\n", suffix: "commit;\n" },
        },
      ),
    ).toBe("select 1;\n");
  });

  it("does not strip arbitrary transaction commands or accept an altered source", () => {
    expect(() =>
      normalizeKnownMigrationEnvelope("known.sql", "begin;\nselect 1;\ncommit;\n", {
        sha256:
          "2e0d259ffa56622a3515384aa2f4e533b2a0a676dfe262c3f7e466a1487df79e",
        envelope: { prefix: "-- known\nbegin;\n", suffix: "commit;\n" },
      }),
    ).toThrow(/hash|envelope|known/);
  });

  it("builds one caller-owned transaction with no target database default", () => {
    const sql = buildEncompassingTransaction([
      ...SUPPORTED_RECOVERY_ORDER.slice(0, 2).map(() => "select 1;\n"),
      "select 1;\n",
      "select 1;\n",
      "select 1;\n",
      "select 1;\n",
      "select 1;\n",
    ]);
    expect(sql).toMatch(/^begin;\n/);
    expect(sql).toMatch(/commit;\n$/);
    expect(sql).not.toMatch(/-- database|DB_URL|localhost|postgresql:\/\//i);
  });
});
