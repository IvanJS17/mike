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
const MIGRATION_NAME = "20260902_01_recovery_onboarding_organization.sql";
const MIGRATION_PATH = path.join(BACKEND_DIR, "migrations", MIGRATION_NAME);
const SCHEMA_PATH = path.join(BACKEND_DIR, "schema.sql");

function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function functionSql(sql: string): string {
  const match = sql.match(
    /create\s+or\s+replace\s+function\s+public\.provision_initial_organization\s*\([\s\S]*?\$\$;/i,
  );
  return match?.[0] ?? "";
}

const migration = readIfExists(MIGRATION_PATH);
const schema = readIfExists(SCHEMA_PATH);
const migrationFunction = functionSql(migration);
const schemaFunction = functionSql(schema);

describe("recovery onboarding organization migration", () => {
  it("uses one collision-free dated migration", () => {
    expect(migration).not.toBe("");
    expect(migration).toMatch(/^-- Migration date: 2026-09-02\b/m);
    const candidateStem = MIGRATION_NAME.slice(0, 11);
    const existingAtIntroduction = fs
      .readdirSync(path.join(BACKEND_DIR, "migrations"))
      .filter(
        (name) =>
          name.endsWith(".sql") &&
          name !== MIGRATION_NAME &&
          name.slice(0, 11) <= candidateStem,
      );
    expect(() =>
      assertRecoveryMigrationName(MIGRATION_NAME, existingAtIntroduction),
    ).not.toThrow();
  });

  it("adds one explicit profile marker for the initial organization", () => {
    for (const sql of [migration, schema]) {
      expect(sql).toMatch(
        /alter\s+table\s+public\.user_profiles\s+add\s+column\s+if\s+not\s+exists\s+onboarding_organization_id\s+uuid/i,
      );
      expect(sql).toMatch(
        /onboarding_organization_id[\s\S]*references\s+public\.organizations\s*\(id\)/i,
      );
    }
  });

  it("defines the same hardened service-role RPC in migration and fresh schema", () => {
    expect(schemaFunction).toBe(migrationFunction);
    for (const sql of [migrationFunction, schemaFunction]) {
      expect(sql).toContain("provision_initial_organization");
      expect(sql).toMatch(/p_user_id\s+uuid/i);
      expect(sql).toMatch(/p_organization_name\s+text/i);
      expect(sql).toMatch(/security\s+definer/i);
      expect(sql).toMatch(/set\s+search_path\s*=\s*public/i);
      expect(sql).toMatch(/for\s+update/i);
      expect(sql).toMatch(/insert\s+into\s+public\.organizations/i);
      expect(sql).toMatch(/insert\s+into\s+public\.organization_memberships/i);
      expect(sql).toMatch(/'org_owner'/i);
      expect(sql).toMatch(/'active'/i);
      expect(sql).toMatch(/update\s+public\.user_profiles/i);
      expect(sql).not.toMatch(/insert\s+into\s+public\.(workspaces|matters)/i);
    }
  });

  it("serializes by the profile row and reuses the recorded organization", () => {
    for (const sql of [migrationFunction, schemaFunction]) {
      expect(sql).toMatch(
        /select[\s\S]*onboarding_organization_id[\s\S]*from\s+public\.user_profiles[\s\S]*where[\s\S]*user_id\s*=\s*p_user_id[\s\S]*for\s+update/i,
      );
      expect(sql).toMatch(/if\s+existing_organization_id\s+is\s+not\s+null/i);
      expect(sql).toMatch(/'reused'/i);
      expect(sql).toMatch(/'created'/i);
    }
  });

  it("revokes PUBLIC/browser execution and grants only service_role", () => {
    for (const sql of [migration, schema]) {
      expect(sql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.provision_initial_organization\s*\(uuid\s*,\s*text\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i,
      );
      expect(sql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.provision_initial_organization\s*\(uuid\s*,\s*text\s*\)\s+to\s+service_role/i,
      );
    }
  });
});
