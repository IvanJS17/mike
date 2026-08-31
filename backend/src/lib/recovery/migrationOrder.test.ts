import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECOVERY_MIGRATION_TAG,
  RECOVERY_SCHEMA_FINGERPRINT_MARKER,
  assertRecoveryMigrationName,
  listRecoveryMigrations,
  sortRecoveryMigrations,
} from "./migrationOrder";

const BACKEND_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MIGRATIONS_DIR = path.join(BACKEND_DIR, "migrations");

function gitLsMigrations(): string[] {
  return execFileSync("git", ["ls-files", "migrations"], {
    cwd: BACKEND_DIR,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.endsWith(".sql"))
    .map((line) => path.basename(line));
}

describe("recovery migration naming contract", () => {
  it("uses the repository YYYYMMDD_NN convention with a recovery tag", () => {
    expect(() =>
      assertRecoveryMigrationName("20260831_01_recovery_tenancy.sql", [
        "20260827_03_remove_minimal_reasoning.sql",
      ]),
    ).not.toThrow();
    expect(() =>
      assertRecoveryMigrationName("recovery_20260831_01_tenancy.sql", [
        "20260827_03_remove_minimal_reasoning.sql",
      ]),
    ).toThrow(/YYYYMMDD_NN/);
  });

  it("rejects a date and ordinal stem already used by upstream", () => {
    expect(() =>
      assertRecoveryMigrationName("20260827_03_recovery_tenancy.sql", [
        "20260827_03_remove_minimal_reasoning.sql",
      ]),
    ).toThrow(/collides/);
  });

  it("rejects recovery migrations that do not append after the pinned upstream series", () => {
    expect(() =>
      assertRecoveryMigrationName("20260826_04_recovery_tenancy.sql", [
        "20260826_03_chat_reasoning_selection.sql",
        "20260827_03_remove_minimal_reasoning.sql",
      ]),
    ).toThrow(/after the latest existing migration/);
  });

  it("rejects non-numeric, zero, or unpadded ordinals", () => {
    for (const name of [
      "20260831_2_recovery_x.sql",
      "20260831_00_recovery_x.sql",
      "20260831_ab_recovery_x.sql",
    ]) {
      expect(() => assertRecoveryMigrationName(name)).toThrow(
        /ordinal|YYYYMMDD_NN/,
      );
    }
  });
});

describe("recovery migration ordering contract", () => {
  it("uses the runner-compatible lexical order across upstream and recovery migrations", () => {
    const ordered = sortRecoveryMigrations([
      "20260831_01_recovery_baseline.sql",
      "20260827_03_remove_minimal_reasoning.sql",
      "20260828_01_recovery_tenancy.sql",
      "20260419_tabular_chat_jsonb.sql",
    ]);
    expect(ordered).toEqual([
      "20260419_tabular_chat_jsonb.sql",
      "20260827_03_remove_minimal_reasoning.sql",
      "20260828_01_recovery_tenancy.sql",
      "20260831_01_recovery_baseline.sql",
    ]);
  });

  it("orders recovery migrations by date then numeric ordinal", () => {
    const ordered = sortRecoveryMigrations([
      "20260901_02_recovery_b.sql",
      "20260901_10_recovery_a.sql",
      "20260901_01_recovery_c.sql",
    ]);
    expect(ordered).toEqual([
      "20260901_01_recovery_c.sql",
      "20260901_02_recovery_b.sql",
      "20260901_10_recovery_a.sql",
    ]);
  });
});

describe("recovery migration ledger state", () => {
  it("starts with zero recovery migrations and a pending fresh-schema fingerprint", () => {
    const committed = gitLsMigrations().filter((name) =>
      name.includes(RECOVERY_MIGRATION_TAG),
    );
    expect(committed).toEqual([]);
    const onDisk = listRecoveryMigrations(MIGRATIONS_DIR);
    expect(onDisk).toEqual([]);
    expect(RECOVERY_SCHEMA_FINGERPRINT_MARKER).toMatch(
      /^RECOVERY_SCHEMA_FINGERPRINT:/,
    );
  });
});
