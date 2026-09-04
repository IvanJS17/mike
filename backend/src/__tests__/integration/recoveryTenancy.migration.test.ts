/**
 * Slice A2a — static RED regressions for the seven prior-candidate blockers.
 *
 * These tests scan the exact LiTT baseline `d9fa8380e63837b6441cef169cf5ef80dfb55e54:backend/schema.sql`
 * (read through the local git object database), the recovery migration
 * `20260831_01_recovery_identity_tenancy.sql`, and the fresh `backend/schema.sql`.
 *
 * Runtime behavior (RLS, epoch bumps, fingerprints) is proven separately in
 * `recoveryTenancy.runtime.test.ts` (gated on a disposable harness container).
 * Here the scans are anchored with positive controls against the baseline so
 * they cannot pass vacuously (blocker 7).
 */

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

/** Exact executable LiTT baseline pinned by the A2a task. */
const LITT_BASELINE_REF =
  "d9fa8380e63837b6441cef169cf5ef80dfb55e54:backend/schema.sql";
const MIGRATION_NAME = "20260831_01_recovery_identity_tenancy.sql";
const MIGRATION_PATH = path.join(BACKEND_DIR, "migrations", MIGRATION_NAME);
const FRESH_SCHEMA_PATH = path.join(BACKEND_DIR, "schema.sql");

const TENANCY_TABLES = [
  "organizations",
  "organization_memberships",
  "workspaces",
  "workspace_memberships",
  "matters",
  "matter_memberships",
];

/** Baseline helpers preserved from LiTT. */
const BASELINE_HELPER_NAMES = [
  "organization_role",
  "is_organization_member",
  "is_workspace_admin",
  "matter_role",
];

/** All target helpers, including public-matter visibility. */
const HELPER_NAMES = [...BASELINE_HELPER_NAMES, "matters_select_visible"];

/** The 15 baseline policies: 6 SELECT + 9 browser DML. */
const BASELINE_SELECT_POLICIES = [
  "organizations_select_member",
  "org_memberships_select_member",
  "workspaces_select_member",
  "workspace_memberships_select_member",
  "matters_select_member",
  "matter_memberships_select_member",
];
const BASELINE_DML_POLICIES = [
  "organizations_update_owner",
  "org_memberships_insert_owner",
  "org_memberships_delete_owner",
  "workspaces_update_member",
  "workspace_memberships_insert_admin",
  "workspace_memberships_delete_admin",
  "matters_update_member",
  "matter_memberships_insert_owner",
  "matter_memberships_delete_owner",
];

function baselineSchema(): string {
  return execFileSync("git", ["show", LITT_BASELINE_REF], {
    cwd: BACKEND_DIR,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Remove `--` line comments so scans only see executable SQL. */
function stripSqlComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** Extract `create or replace function public.<name>(<params>) ... $$body$$`. */
function extractFunctions(
  sql: string,
): Map<string, { params: string; body: string }> {
  const found = new Map<string, { params: string; body: string }>();
  const pattern =
    /create\s+or\s+replace\s+function\s+public\.([a-z_]+)\s*\(([^)]*)\)([\s\S]*?)as\s+\$\$([\s\S]*?)\$\$/gi;
  for (const match of sql.matchAll(pattern)) {
    found.set(match[1], { params: match[2], body: match[4] });
  }
  return found;
}

const baseline = baselineSchema();
const migration = readIfExists(MIGRATION_PATH) ?? "";
const fresh = readIfExists(FRESH_SCHEMA_PATH) ?? "";

const baselineSql = stripSqlComments(baseline);
const migrationSql = stripSqlComments(migration);
const freshSql = stripSqlComments(fresh);

describe("blocker 1: migration targets the exact d9fa8380 LiTT baseline", () => {
  it("pins the exact baseline blob and can read it from the local object DB", () => {
    expect(LITT_BASELINE_REF).toMatch(
      /^d9fa8380e63837b6441cef169cf5ef80dfb55e54:/,
    );
    expect(baseline).toContain("authorization_epoch");
  });

  it("uses the required filename, migration date, and repository convention", () => {
    expect(migration).not.toBe("");
    expect(MIGRATION_NAME).toBe("20260831_01_recovery_identity_tenancy.sql");
    expect(migration).toMatch(/^-- Migration date: 2026-08-31\b/m);
    const existing = execFileSync(
      "git",
      [
        "ls-tree",
        "-r",
        "--name-only",
        "d9fa8380e63837b6441cef169cf5ef80dfb55e54",
        "--",
        "migrations",
      ],
      {
        cwd: BACKEND_DIR,
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter((line) => line.endsWith(".sql"))
      .map((line) => path.basename(line))
      .filter((name) => name !== MIGRATION_NAME);
    expect(() =>
      assertRecoveryMigrationName(MIGRATION_NAME, existing),
    ).not.toThrow();
    expect(() =>
      assertRecoveryMigrationName(MIGRATION_NAME, [
        ...existing,
        "20260831_01_other.sql",
      ]),
    ).toThrow(/collides with an existing migration/i);
  });
});

describe("blocker 2: LiTT tables are ALTERED to target shape (no no-op create)", () => {
  it("does not create the six tenancy tables (they exist in the baseline)", () => {
    for (const table of TENANCY_TABLES) {
      const noOp = new RegExp(
        `create\\s+table\\s+(if\\s+not\\s+exists\\s+)?public\\.${table}\\b`,
        "i",
      );
      expect(migration).not.toMatch(noOp);
    }
    // Positive control: the baseline really creates them, so the regex above
    // would catch a migration that recreates instead of alters.
    for (const table of TENANCY_TABLES) {
      expect(baseline).toMatch(
        new RegExp(
          `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`,
          "i",
        ),
      );
    }
  });

  it("adds membership status via ALTER TABLE ... ADD COLUMN on all three membership tables", () => {
    for (const table of [
      "organization_memberships",
      "workspace_memberships",
      "matter_memberships",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `alter\\s+table\\s+public\\.${table}\\s+add\\s+column\\s+(if\\s+not\\s+exists\\s+)?status\\b`,
          "i",
        ),
      );
    }
  });

  it("adds matter visibility via ALTER TABLE ... ADD COLUMN on matters", () => {
    expect(migration).toMatch(
      /alter\s+table\s+public\.matters\s+add\s+column\s+(if\s+not\s+exists\s+)?visibility\b/i,
    );
  });

  it("backfills existing rows and enforces NOT NULL on the new columns", () => {
    for (const table of [
      "organization_memberships",
      "workspace_memberships",
      "matter_memberships",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `update\\s+public\\.${table}\\s+set\\s+status\\s*=\\s*'active'`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `alter\\s+table\\s+public\\.${table}\\s+alter\\s+column\\s+status\\s+set\\s+not\\s+null`,
          "i",
        ),
      );
    }
    expect(migration).toMatch(
      /update\s+public\.matters\s+set\s+visibility\s*=\s*'private'/i,
    );
    expect(migration).toMatch(
      /alter\s+table\s+public\.matters\s+alter\s+column\s+visibility\s+set\s+not\s+null/i,
    );
  });
});

describe("blocker 3: roles, workspace→matter hierarchy, and org epoch stay LiTT-compatible", () => {
  it("keeps the closed LiTT role vocabularies (baseline checks remain in force)", () => {
    // The closed role vocabularies live in the baseline CHECK constraints,
    // which the migration must leave untouched.
    expect(baselineSql).toMatch(
      /'org_owner', 'workspace_admin', 'editor', 'viewer', 'technical_operator'/,
    );
    expect(baselineSql).toMatch(
      /'workspace_admin', 'editor', 'viewer', 'technical_operator'/,
    );
    expect(baselineSql).toMatch(
      /'matter_owner', 'editor', 'viewer', 'technical_operator'/,
    );
    // None of the baseline role checks are dropped or rewritten.
    for (const table of [
      "organization_memberships",
      "workspace_memberships",
      "matter_memberships",
    ]) {
      expect(migration).not.toMatch(new RegExp(`${table}_role_check`, "i"));
    }
    expect(migration).not.toMatch(
      /alter\s+table\s+public\.\w+\s+drop\s+constraint\s+if\s+exists\s+\w*role_check/i,
    );
  });

  it("keeps the closed recovery status and visibility vocabularies", () => {
    expect(migration).toMatch(/'active'\s*,\s*'inactive'\s*,\s*'revoked'/);
    expect(migration).toMatch(/'public'\s*,\s*'private'/);
  });

  it("drops no columns and no baseline constraints (FK semantics preserved)", () => {
    expect(countMatches(migration, /drop\s+column/gi)).toBe(0);
    expect(countMatches(migration, /drop\s+table/gi)).toBe(0);
    // The only permitted drop-constraint statements are the migration's own
    // status/visibility checks (idempotent drop-before-add); every baseline
    // constraint name is off-limits.
    const drops = [
      ...migrationSql.matchAll(/drop\s+constraint\s+if\s+exists\s+([a-z_]+)/gi),
    ].map((m) => m[1]);
    expect([...drops].sort()).toEqual([
      "matter_memberships_status_check",
      "matters_visibility_check",
      "organization_memberships_status_check",
      "workspace_memberships_status_check",
    ]);
  });

  it("keeps the organization epoch on organizations and does not rebuild the table", () => {
    expect(migration).not.toMatch(
      /alter\s+table\s+public\.organizations\s+drop\s+column\s+authorization_epoch/i,
    );
    expect(baseline).toMatch(
      /authorization_epoch\s+bigint\s+not\s+null\s+default\s+0/,
    );
  });

  it("keeps matters anchored to workspaces (hierarchy untouched)", () => {
    expect(baselineSql).toMatch(
      /workspace_id\s+uuid\s+not\s+null\s+references\s+public\.workspaces\(id\)\s+on\s+delete\s+cascade/,
    );
    // The migration's only constraint drops are its own status/visibility
    // checks (allowlist asserted above); no baseline constraint is dropped.
  });
});

describe("blocker 4: helpers are scope-id-only and bind the user through auth.uid()", () => {
  it("defines the four tenancy helpers with exactly one uuid scope parameter and auth.uid() inside", () => {
    const fns = extractFunctions(migration);
    for (const name of HELPER_NAMES) {
      const fn = fns.get(name);
      if (!fn) {
        throw new Error(
          `migration must (re)define the LiTT helper public.${name}`,
        );
      }
      expect(fn.params.replace(/\s+/g, " ").trim()).toMatch(
        /^p_(org|ws|matter)\s+uuid$/,
      );
      expect(fn.body).toContain("auth.uid()");
      expect(fn.body).not.toMatch(/\bp_user\b/);
      // Positive control for preserved helpers: the baseline defines each one,
      // proving the extractor is not vacuous. The public-visibility helper is
      // intentionally new in recovery.
      if (BASELINE_HELPER_NAMES.includes(name)) {
        expect(extractFunctions(baseline).get(name)).toBeDefined();
      }
    }
  });

  it("gates helper checks on active membership status", () => {
    const fns = extractFunctions(migration);
    for (const name of HELPER_NAMES) {
      const fn = fns.get(name);
      if (!fn) throw new Error(`missing helper ${name}`);
      expect(fn.body).toMatch(/status\s*=\s*'active'/);
    }
  });

  it("revokes PUBLIC/anon execute on the helpers and grants only authenticated", () => {
    for (const name of HELPER_NAMES) {
      expect(migration).toMatch(
        new RegExp(
          `revoke\\s+execute\\s+on\\s+function\\s+public\\.${name}\\(uuid\\)\\s+from\\s+public\\s*,\\s*anon`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\(uuid\\)\\s+to\\s+authenticated`,
          "i",
        ),
      );
    }
    // Positive control: the baseline never revoked PUBLIC — this hardening is new.
    expect(baseline).not.toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.organization_role\(uuid\)/i,
    );
  });
});

describe("blocker 5: browser DML grants/policies are removed, intended SELECT remains", () => {
  it("drops every baseline browser DML policy and never recreates it", () => {
    for (const name of BASELINE_DML_POLICIES) {
      expect(migration).toMatch(
        new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${name}\\b`, "i"),
      );
      expect(migration).not.toMatch(
        new RegExp(`create\\s+policy\\s+${name}\\b`, "i"),
      );
      // Positive control: baseline defines it (so the drop is meaningful).
      expect(baseline).toMatch(
        new RegExp(`create\\s+policy\\s+${name}\\b`, "i"),
      );
    }
  });

  it("keeps exactly the six intended SELECT policies", () => {
    for (const name of BASELINE_SELECT_POLICIES) {
      expect(migration).toMatch(
        new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${name}\\b`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(
          `create\\s+policy\\s+${name}\\b\\s*\\n?[\\s\\S]{0,400}?for\\s+select\\b`,
          "i",
        ),
      );
    }
    expect(countMatches(migration, /create\s+policy/gi)).toBe(6);
    expect(countMatches(baseline, /create\s+policy/gi)).toBe(15);
  });

  it("grants authenticated SELECT only — zero INSERT/UPDATE/DELETE table grants", () => {
    for (const table of TENANCY_TABLES) {
      expect(migration).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon\\b`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `revoke\\s+(all|insert\\s*,\\s*update\\s*,\\s*delete)\\s+on\\s+public\\.${table}\\s+from\\s+authenticated`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `grant\\s+select\\s+on\\s+public\\.${table}\\s+to\\s+authenticated`,
          "i",
        ),
      );
    }
    // No authenticated DML grant of any kind on the six tables.
    const grantStatements = migration.match(/grant\s+[^;]+;/gi) ?? [];
    for (const statement of grantStatements) {
      if (
        TENANCY_TABLES.some((table) =>
          new RegExp(`public\\.${table}\\b`, "i").test(statement),
        ) &&
        /\bauthenticated\b/i.test(statement)
      ) {
        expect(statement).toMatch(/^grant\s+select\s+on\s+public\./i);
      }
    }
    // Positive control: the baseline grants authenticated full DML on the six.
    expect(baseline).toMatch(
      /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+public\.organizations\s+to\s+authenticated/i,
    );
  });

  it("grants service_role only intended data operations on the six (no ALL/TRUNCATE/REFERENCES/TRIGGER)", () => {
    for (const table of TENANCY_TABLES) {
      expect(migration).toMatch(
        new RegExp(
          `grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s*,\\s*delete\\s+on\\s+public\\.${table}\\s+to\\s+service_role`,
          "i",
        ),
      );
    }
    expect(migration).not.toMatch(
      /grant\s+all\b[\s\S]{0,200}?public\.(organizations|workspaces|matters)/i,
    );
    expect(migration).not.toMatch(/grant\s+truncate\b/i);
    expect(migration).not.toMatch(/grant\s+references\b/i);
    expect(migration).not.toMatch(/grant\s+trigger\b/i);
  });
});

describe("blocker 6: deletion/retention semantics are NOT changed", () => {
  it("introduces no destructive DDL and no retention claims", () => {
    expect(countMatches(migrationSql, /drop\s+table|truncate\b/gi)).toBe(0);
    expect(migrationSql).not.toMatch(/on\s+delete\s+set\s+null\s*;/i);
    // FK cascade semantics on the six remain exactly as in the baseline.
    expect(baselineSql).toMatch(
      /references\s+public\.organizations\(id\)\s+on\s+delete\s+cascade/,
    );
  });
});

describe("blocker 7: static assertions are non-vacuous (positive controls fail on the baseline)", () => {
  it("the DML-grant scan would flag the baseline state", () => {
    // The exact regex used in blocker 5 must match the baseline's
    // authenticated DML grants, proving the scan detects what it claims to.
    expect(baseline).toMatch(
      /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+public\.workspaces\s+to\s+authenticated/i,
    );
  });

  it("the epoch-increment scan sees both baseline increment sites but exactly one in the migration", () => {
    // Baseline: bump_authorization_epoch + manual increment inside
    // revoke_organization_membership (the double-bump hazard).
    const increment =
      /authorization_epoch\s*=\s*authorization_epoch\s*\+\s*1/gi;
    expect(countMatches(baseline, increment)).toBe(2);
    expect(countMatches(migration, increment)).toBe(1);
    expect(countMatches(fresh, increment)).toBe(1);
  });

  it("the revoke RPC no longer increments the epoch manually (single linearized bump via trigger)", () => {
    const fns = extractFunctions(migration);
    const revoke = fns.get("revoke_organization_membership");
    if (!revoke) {
      throw new Error("migration must redefine revoke_organization_membership");
    }
    expect(revoke.body).not.toMatch(/authorization_epoch/);
    const baselineFns = extractFunctions(baseline);
    expect(baselineFns.get("revoke_organization_membership")?.body).toMatch(
      /authorization_epoch\s*=\s*authorization_epoch\s*\+\s*1/,
    );
  });

  it("the revoke RPC persists status=revoked instead of deleting the membership", () => {
    const fns = extractFunctions(migration);
    const revoke = fns.get("revoke_organization_membership");
    if (!revoke) {
      throw new Error("migration must redefine revoke_organization_membership");
    }
    expect(revoke.body).toMatch(
      /update\s+public\.organization_memberships[\s\S]*set\s+status\s*=\s*'revoked'/i,
    );
    expect(revoke.body).not.toMatch(
      /delete\s+from\s+public\.organization_memberships/i,
    );
  });

  it("epoch trigger functions suppress role/status no-op updates", () => {
    const fns = extractFunctions(migration);
    for (const name of [
      "bump_epoch_for_organization_membership_mutation",
      "bump_epoch_for_workspace_membership_mutation",
      "bump_epoch_for_matter_membership_mutation",
    ]) {
      const fn = fns.get(name);
      if (!fn) throw new Error(`missing trigger function ${name}`);
      expect(fn.body).toMatch(/tg_op\s*=\s*'UPDATE'/i);
      expect(fn.body).toMatch(
        /new\.role\s+is\s+not\s+distinct\s+from\s+old\.role/i,
      );
      expect(fn.body).toMatch(
        /new\.status\s+is\s+not\s+distinct\s+from\s+old\.status/i,
      );
    }
  });

  it("defines epoch-mutation triggers on all three membership tables", () => {
    for (const table of [
      "organization_memberships",
      "workspace_memberships",
      "matter_memberships",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `create\\s+trigger\\s+[a-z_]+\\s*\\n?\\s*after\\s+insert\\s+or\\s+update\\s+or\\s+delete\\s+on\\s+public\\.${table}\\b`,
          "i",
        ),
      );
    }
    // Fresh schema mirrors the same triggers.
    for (const table of [
      "organization_memberships",
      "workspace_memberships",
      "matter_memberships",
    ]) {
      expect(fresh).toMatch(
        new RegExp(
          `after\\s+insert\\s+or\\s+update\\s+or\\s+delete\\s+on\\s+public\\.${table}\\b`,
          "i",
        ),
      );
    }
  });
});

describe("fresh backend/schema.sql mirrors the migrated target tenancy shape", () => {
  it("carries status columns with defaults on membership tables", () => {
    for (const table of [
      "organization_memberships",
      "workspace_memberships",
      "matter_memberships",
    ]) {
      expect(fresh).toMatch(
        new RegExp(
          `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\s*\\([\\s\\S]*?status\\s+text\\s+not\\s+null\\s+default\\s+'active'`,
          "i",
        ),
      );
    }
  });

  it("carries visibility on matters with the private default", () => {
    expect(fresh).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.matters\s*\([\s\S]*?visibility\s+text\s+not\s+null\s+default\s+'private'/i,
    );
  });

  it("grants anon zero tenancy privileges", () => {
    for (const table of TENANCY_TABLES) {
      expect(fresh).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon\\b`,
          "i",
        ),
      );
    }
  });
});
