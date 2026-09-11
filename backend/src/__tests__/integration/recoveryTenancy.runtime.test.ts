/**
 * Slice A2a — runtime probes on a disposable PostgreSQL harness.
 *
 * Gated: set RUN_RECOVERY_TENANCY_RUNTIME=1 to execute. The harness starts a
 * throwaway `postgres:16-alpine` container with a Supabase-shaped bootstrap
 * (roles anon/authenticated/service_role, auth.users, auth.uid()), applies the
 * exact LiTT baseline `d9fa8380...:backend/schema.sql` plus the recovery
 * migration on one database, and the fresh `backend/schema.sql` on another,
 * then proves the targeted tenancy fingerprints are byte-identical and every
 * RLS/grant/epoch security property holds. No ports are published; the
 * container is removed in afterAll and zero residue is asserted.
 *
 * Without the env var the file skips, so the default unit gate stays
 * infrastructure-independent.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BACKEND_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const MIGRATION_PATH = path.join(
  BACKEND_DIR,
  "migrations",
  "20260831_01_recovery_identity_tenancy.sql",
);
const FRESH_SCHEMA_PATH = path.join(BACKEND_DIR, "schema.sql");
const LITT_BASELINE_REF =
  "d9fa8380e63837b6441cef169cf5ef80dfb55e54:backend/schema.sql";

const RUN = process.env.RUN_RECOVERY_TENANCY_RUNTIME === "1";
const maybe = RUN ? describe : describe.skip;

const IMAGE = "postgres:16-alpine";
const CONTAINER = `a2a-tenancy-${process.pid}`;
const DB_A = "a2a_incremental";
const DB_B = "a2a_fresh";

const ORG1 = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG2 = "aaaaaaaa-0000-0000-0000-000000000002";
const WS1 = "bbbbbbbb-0000-0000-0000-000000000001";
const MATTER1 = "cccccccc-0000-0000-0000-000000000001";
const U1 = "11111111-0000-0000-0000-000000000001";
const U2 = "22222222-0000-0000-0000-000000000002";
const U3 = "33333333-0000-0000-0000-000000000003";
const U4 = "44444444-0000-0000-0000-000000000004";
const U6 = "66666666-0000-0000-0000-000000000006";
const U7 = "77777777-0000-0000-0000-000000000007";

const TENANCY_TABLES = [
  "organizations",
  "organization_memberships",
  "workspaces",
  "workspace_memberships",
  "matters",
  "matter_memberships",
];

const SHARED_FUNCTIONS = [
  "organization_role",
  "is_organization_member",
  "is_workspace_admin",
  "matter_role",
  "matters_select_visible",
  "bump_authorization_epoch",
  "bump_epoch_for_organization_membership_mutation",
  "bump_epoch_for_workspace_membership_mutation",
  "bump_epoch_for_matter_membership_mutation",
  "revoke_organization_membership",
];

let containerRunning = false;

function docker(args: string[], input?: string): string {
  return execFileSync("docker", ["exec", "-i", CONTAINER, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function psql(db: string, sql: string): string {
  return docker(
    [
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    sql,
  ).trim();
}

function expectPsqlError(db: string, sql: string, pattern: RegExp): void {
  let failed = false;
  try {
    psql(db, sql);
  } catch (error) {
    failed = true;
    const err = error as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    expect(output).toMatch(pattern);
  }
  expect(failed).toBe(true);
}

function scalar(db: string, sql: string): string {
  return psql(db, sql).split("\n")[0].trim();
}

function countRows(db: string, table: string, where = "true"): number {
  return Number(
    scalar(db, `select count(*) from public.${table} where ${where};`),
  );
}

function epochOf(db: string, org: string): number {
  return Number(
    scalar(
      db,
      `select authorization_epoch from public.organizations where id = '${org}';`,
    ),
  );
}

const BOOTSTRAP_SQL = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin;
  end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant all on schema public to service_role;
`;

/** Targeted tenancy fingerprint (or full-schema fingerprint when full=true). */
function fingerprintSql(full: boolean): string {
  const tableFilter = full
    ? `select table_name as tname from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`
    : `select unnest(array['${TENANCY_TABLES.join("','")}']) as tname`;
  const functionFilter = full
    ? `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`
    : `select unnest(array['${SHARED_FUNCTIONS.join("','")}']) as proname`;
  return `
with tenancy as (${tableFilter}),
shared_functions as (${functionFilter}),
cols as (
  select jsonb_build_object('k','column','table',c.table_name,'ord',c.ordinal_position,
    'name',c.column_name,'type',c.data_type,'udt',c.udt_name,'null',c.is_nullable,
    'default',c.column_default) o
  from information_schema.columns c join tenancy t on t.tname = c.table_name
  where c.table_schema = 'public'),
cons as (
  select jsonb_build_object('k','constraint','table',n.relname,'name',con.conname,
    'type',con.contype,'def',pg_get_constraintdef(con.oid)) o
  from pg_constraint con
  join pg_class n on n.oid = con.conrelid
  join pg_namespace ns on ns.oid = n.relnamespace
  join tenancy t on t.tname = n.relname
  where ns.nspname = 'public'),
idx as (
  select jsonb_build_object('k','index','table',i.tablename,'name',i.indexname,
    'def',i.indexdef) o
  from pg_indexes i join tenancy t on t.tname = i.tablename
  where i.schemaname = 'public'),
rls as (
  select jsonb_build_object('k','rls','table',n.relname,'enabled',n.relrowsecurity) o
  from pg_class n
  join pg_namespace ns on ns.oid = n.relnamespace
  join tenancy t on t.tname = n.relname
  where ns.nspname = 'public' and n.relkind = 'r'),
pol as (
  select jsonb_build_object('k','policy','table',p.tablename,'name',p.policyname,
    'cmd',p.cmd,'roles',p.roles,'qual',p.qual,'check',p.with_check) o
  from pg_policies p join tenancy t on t.tname = p.tablename
  where p.schemaname = 'public'),
fns as (
  select jsonb_build_object('k','function','id',p.proname || '(' ||
      pg_get_function_identity_arguments(p.oid) || ')',
    'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner)) o
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  join shared_functions s on s.proname = p.proname
  where ns.nspname = 'public'),
trig as (
  select jsonb_build_object('k','trigger','table',n.relname,'name',tg.tgname,
    'def',pg_get_triggerdef(tg.oid)) o
  from pg_trigger tg
  join pg_class n on n.oid = tg.tgrelid
  join pg_namespace ns on ns.oid = n.relnamespace
  join tenancy t on t.tname = n.relname
  where ns.nspname = 'public' and not tg.tgisinternal),
owners as (
  select jsonb_build_object('k','owner','table',n.relname,
    'owner',pg_get_userbyid(n.relowner)) o
  from pg_class n
  join pg_namespace ns on ns.oid = n.relnamespace
  join tenancy t on t.tname = n.relname
  where ns.nspname = 'public' and n.relkind = 'r'),
acl_t as (
  select jsonb_build_object('k','table_grant','table',c.relname,
    'grantee',g.grantee,'priv',g.privilege_type) o
  from pg_class c
  join pg_namespace ns on ns.oid = c.relnamespace
  join tenancy t on t.tname = c.relname
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) g
  where ns.nspname = 'public'),
acl_f as (
  select jsonb_build_object('k','function_grant','fn',p.proname || '(' ||
      pg_get_function_identity_arguments(p.oid) || ')',
    'grantee',g.grantee,'priv',g.privilege_type) o
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  join shared_functions s on s.proname = p.proname
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
  where ns.nspname = 'public')
select (select jsonb_agg(o order by o) from (
  select o from cols union all select o from cons union all select o from idx
  union all select o from rls union all select o from pol union all select o from fns
  union all select o from trig union all select o from owners
  union all select o from acl_t union all select o from acl_f
) all_items)::text;
`;
}

function fingerprint(db: string, full = false): string {
  return psql(db, fingerprintSql(full));
}

function tableNames(db: string): Set<string> {
  const out = psql(
    db,
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name;`,
  );
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

const SEED_SQL = `
insert into auth.users (id, email) values
  ('${U1}', 'u1@test.local'),
  ('${U2}', 'u2@test.local'),
  ('${U3}', 'u3@test.local'),
  ('${U4}', 'u4@test.local'),
  ('${U6}', 'u6@test.local'),
  ('${U7}', 'u7@test.local');

insert into public.organizations (id, name, created_by) values
  ('${ORG1}', 'Org One', '${U1}'),
  ('${ORG2}', 'Org Two', '${U3}');

insert into public.organization_memberships (organization_id, user_id, role, status) values
  ('${ORG1}', '${U1}', 'org_owner', 'active'),
  ('${ORG1}', '${U2}', 'viewer', 'active'),
  ('${ORG2}', '${U3}', 'org_owner', 'active');

insert into public.workspaces (id, organization_id, name, created_by) values
  ('${WS1}', '${ORG1}', 'WS One', '${U1}');

insert into public.workspace_memberships (workspace_id, user_id, role, status) values
  ('${WS1}', '${U2}', 'viewer', 'active');

insert into public.matters (id, workspace_id, name, created_by, visibility) values
  ('${MATTER1}', '${WS1}', 'Matter One', '${U1}', 'private');

insert into public.matter_memberships (matter_id, user_id, role, status) values
  ('${MATTER1}', '${U1}', 'matter_owner', 'active');

-- Fixture setup exercises all three insert triggers. Normalize the epoch only
-- after seeding so each behavior test can assert its own exact delta.
update public.organizations set authorization_epoch = 0;
`;

function asUser(user: string, sql: string): string {
  return [
    `set role authenticated;`,
    `set request.jwt.claim.sub = '${user}';`,
    sql,
  ].join("\n");
}

maybe("recovery tenancy runtime harness", () => {
  beforeAll(() => {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
    });
  });

  afterAll(() => {
    try {
      execFileSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
    } catch {
      // container may already be gone; residue assertion below still runs
    }
    const remaining = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `name=a2a-tenancy-`],
      { encoding: "utf8" },
    ).trim();
    expect(remaining).toBe("");
    fs.rmSync("/tmp/a2a-authority", { recursive: true, force: true });
    fs.rmSync(`/tmp/a2a-tenancy-${process.pid}`, {
      recursive: true,
      force: true,
    });
  }, 60_000);

  it("starts the disposable postgres harness with no published ports", () => {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-d",
        "--name",
        CONTAINER,
        "-e",
        "POSTGRES_PASSWORD=postgres",
        IMAGE,
      ],
      { encoding: "utf8" },
    );
    containerRunning = true;
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        execFileSync(
          "docker",
          ["exec", CONTAINER, "pg_isready", "-U", "postgres"],
          { encoding: "utf8" },
        );
        ready = true;
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
    expect(ready).toBe(true);
    docker(["createdb", "-U", "postgres", DB_A]);
    docker(["createdb", "-U", "postgres", DB_B]);
    psql(DB_A, BOOTSTRAP_SQL);
    psql(DB_B, BOOTSTRAP_SQL);
  }, 180_000);

  it("applies the exact d9fa8380 LiTT baseline cleanly", () => {
    const baseline = execFileSync("git", ["show", LITT_BASELINE_REF], {
      cwd: BACKEND_DIR,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    psql(DB_A, baseline);
    // Positive evidence the real baseline is present (not an ancestor).
    for (const table of TENANCY_TABLES) {
      expect(
        scalar(
          DB_A,
          `select count(*) from information_schema.tables where table_schema='public' and table_name='${table}';`,
        ),
      ).toBe("1");
    }
    expect(
      scalar(
        DB_A,
        `select count(*) from pg_policies where schemaname='public';`,
      ),
    ).toBe("15");
    expect(
      scalar(
        DB_A,
        `select count(*) from information_schema.table_privileges
         where table_schema='public' and grantee='authenticated'
         and table_name='organizations' and privilege_type='DELETE';`,
      ),
    ).toBe("1");
  }, 120_000);

  it("applies the recovery migration and re-applies it safely", () => {
    const migration = fs.readFileSync(MIGRATION_PATH, "utf8");
    psql(DB_A, migration);
    psql(DB_A, migration); // idempotent re-run must not fail
    expect(
      scalar(
        DB_A,
        `select count(*) from information_schema.columns
         where table_schema='public' and table_name='organization_memberships'
         and column_name='status' and is_nullable='NO';`,
      ),
    ).toBe("1");
    expect(
      scalar(
        DB_A,
        `select column_default from information_schema.columns
         where table_schema='public' and table_name='matters' and column_name='visibility';`,
      ),
    ).toContain("private");
    expect(
      scalar(
        DB_A,
        `select count(*) from pg_policies where schemaname='public' and tablename in ('organizations','organization_memberships','workspaces','workspace_memberships','matters','matter_memberships');`,
      ),
    ).toBe("6");
  }, 120_000);

  it("applies the fresh target schema on the second database", () => {
    psql(DB_B, fs.readFileSync(FRESH_SCHEMA_PATH, "utf8"));
    expect(
      scalar(
        DB_B,
        `select count(*) from information_schema.columns
         where table_schema='public' and table_name='matter_memberships'
         and column_name='status' and is_nullable='NO';`,
      ),
    ).toBe("1");
  }, 120_000);

  it("creates zero onboarding records or default roles in either database", () => {
    for (const db of [DB_A, DB_B]) {
      for (const table of TENANCY_TABLES) {
        expect(countRows(db, table)).toBe(0);
      }
    }
  });

  it("targeted tenancy fingerprints are byte-identical (baseline+migration vs fresh)", () => {
    const a = fingerprint(DB_A);
    const b = fingerprint(DB_B);
    expect(a).not.toBe("");
    if (a !== b) {
      // Diff diagnostics by section to make any mismatch actionable.
      const parse = (s: string) =>
        JSON.parse(s) as Array<Record<string, unknown>>;
      const pa = parse(a);
      const pb = parse(b);
      const onlyA = pa.filter(
        (x) => !pb.some((y) => JSON.stringify(y) === JSON.stringify(x)),
      );
      const onlyB = pb.filter(
        (x) => !pa.some((y) => JSON.stringify(y) === JSON.stringify(x)),
      );
      throw new Error(
        `tenancy fingerprint mismatch\nincremental-only (${onlyA.length}): ${JSON.stringify(onlyA.slice(0, 12))}\nfresh-only (${onlyB.length}): ${JSON.stringify(onlyB.slice(0, 12))}`,
      );
    }
    expect(a).toContain('"policy"');
    expect(a).toContain('"function"');
    expect(a).toContain('"trigger"');
  }, 120_000);

  it("full-schema fingerprint drift is real, non-tenancy, and classified open_phase3", () => {
    const fullA = fingerprint(DB_A, true);
    const fullB = fingerprint(DB_B, true);
    expect(fullA).not.toBe("");
    expect(fullB).not.toBe("");
    expect(fullA).not.toBe(fullB);

    const aNames = tableNames(DB_A);
    const bNames = tableNames(DB_B);
    const onlyA = [...aNames].filter((n) => !bNames.has(n));
    const onlyB = [...bNames].filter((n) => !aNames.has(n));
    // Honest convergence boundary: drift exists (upstream tables not yet
    // ported in the incremental path, LiTT tables not in the upstream fresh
    // schema) and NONE of it is the six tenancy tables.
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyB.length).toBeGreaterThan(0);
    for (const table of TENANCY_TABLES) {
      expect(onlyA).not.toContain(table);
      expect(onlyB).not.toContain(table);
      expect(aNames.has(table)).toBe(true);
      expect(bNames.has(table)).toBe(true);
    }
    const fullAHash = createHash("sha256").update(fullA).digest("hex");
    const fullBHash = createHash("sha256").update(fullB).digest("hex");
    const classification = `open_phase3: incrementalOnly=${onlyA.length}, freshOnly=${onlyB.length}, incrementalSha256=${fullAHash}, freshSha256=${fullBHash}`;
    console.log(`[A2a full fingerprint] ${classification}`);
    console.log(
      `[A2a full fingerprint] incremental-only tables: ${onlyA.join(", ")}`,
    );
    expect(classification).toMatch(/^open_phase3:/);
  }, 120_000);

  it("seeds synthetic fixtures for behavior probes", () => {
    psql(DB_A, SEED_SQL);
    expect(countRows(DB_A, "organizations")).toBe(2);
    expect(epochOf(DB_A, ORG1)).toBe(0);
  });

  it("active org membership grants reads; inactive and revoked revoke them", () => {
    expect(
      Number(
        scalar(DB_A, asUser(U2, `select count(*) from public.organizations;`)),
      ),
    ).toBe(1);
    expect(
      Number(
        scalar(DB_A, asUser(U2, `select count(*) from public.workspaces;`)),
      ),
    ).toBe(1);

    psql(
      DB_A,
      `update public.organization_memberships set status='inactive' where organization_id='${ORG1}' and user_id='${U2}';`,
    );
    expect(
      Number(
        scalar(DB_A, asUser(U2, `select count(*) from public.organizations;`)),
      ),
    ).toBe(0);
    expect(
      Number(
        scalar(DB_A, asUser(U2, `select count(*) from public.workspaces;`)),
      ),
    ).toBe(0);

    psql(
      DB_A,
      `update public.organization_memberships set status='revoked' where organization_id='${ORG1}' and user_id='${U2}';`,
    );
    expect(
      Number(
        scalar(DB_A, asUser(U2, `select count(*) from public.organizations;`)),
      ),
    ).toBe(0);

    psql(
      DB_A,
      `update public.organization_memberships set status='active' where organization_id='${ORG1}' and user_id='${U2}';`,
    );
    expect(
      Number(
        scalar(DB_A, asUser(U2, `select count(*) from public.organizations;`)),
      ),
    ).toBe(1);
  });

  it("private matters need explicit active membership; public matters need active org membership", () => {
    // Private matter: U2 has org membership but no matter membership.
    expect(
      Number(scalar(DB_A, asUser(U2, `select count(*) from public.matters;`))),
    ).toBe(0);

    psql(
      DB_A,
      `insert into public.matter_memberships (matter_id, user_id, role, status) values ('${MATTER1}', '${U2}', 'viewer', 'active');`,
    );
    expect(
      Number(scalar(DB_A, asUser(U2, `select count(*) from public.matters;`))),
    ).toBe(1);
    // Roster visibility for members: own row plus the owner row.
    expect(
      Number(
        scalar(
          DB_A,
          asUser(U2, `select count(*) from public.matter_memberships;`),
        ),
      ),
    ).toBe(2);

    psql(
      DB_A,
      `delete from public.matter_memberships where matter_id='${MATTER1}' and user_id='${U2}';`,
    );
    expect(
      Number(scalar(DB_A, asUser(U2, `select count(*) from public.matters;`))),
    ).toBe(0);

    // Public visibility: active org membership alone unlocks the read.
    psql(
      DB_A,
      `update public.matters set visibility='public' where id='${MATTER1}';`,
    );
    expect(
      Number(scalar(DB_A, asUser(U2, `select count(*) from public.matters;`))),
    ).toBe(1);
    // ...but the roster stays member-scoped.
    expect(
      Number(
        scalar(
          DB_A,
          asUser(U2, `select count(*) from public.matter_memberships;`),
        ),
      ),
    ).toBe(0);
    psql(
      DB_A,
      `update public.matters set visibility='private' where id='${MATTER1}';`,
    );
    expect(
      Number(scalar(DB_A, asUser(U2, `select count(*) from public.matters;`))),
    ).toBe(0);
  });

  it("cross-org and cross-user reads fail closed", () => {
    // U3 only belongs to ORG2: sees nothing of ORG1, even public matters.
    psql(
      DB_A,
      `update public.matters set visibility='public' where id='${MATTER1}';`,
    );
    expect(
      Number(
        scalar(DB_A, asUser(U3, `select count(*) from public.organizations;`)),
      ),
    ).toBe(1);
    expect(
      Number(scalar(DB_A, asUser(U3, `select count(*) from public.matters;`))),
    ).toBe(0);
    expect(
      Number(
        scalar(DB_A, asUser(U3, `select count(*) from public.workspaces;`)),
      ),
    ).toBe(0);
    psql(
      DB_A,
      `update public.matters set visibility='private' where id='${MATTER1}';`,
    );
  });

  it("authenticated users cannot enumerate other users' membership rows or roles", () => {
    expect(
      Number(
        scalar(
          DB_A,
          asUser(U2, `select count(*) from public.organization_memberships;`),
        ),
      ),
    ).toBe(1);
    expect(
      Number(
        scalar(
          DB_A,
          asUser(
            U2,
            `select count(*) from public.organization_memberships where user_id <> '${U2}';`,
          ),
        ),
      ),
    ).toBe(0);
    expect(
      Number(
        scalar(
          DB_A,
          asUser(
            U2,
            `select count(*) from public.workspace_memberships where user_id <> '${U2}';`,
          ),
        ),
      ),
    ).toBe(0);
    expect(
      scalar(
        DB_A,
        asUser(
          U2,
          `select coalesce(public.organization_role('${ORG2}'), 'null');`,
        ),
      ),
    ).toBe("null");
    expect(
      scalar(DB_A, asUser(U2, `select public.organization_role('${ORG1}');`)),
    ).toBe("viewer");
  });

  it("authenticated browser DML is denied on tenancy tables (no grants, no policies)", () => {
    expectPsqlError(
      DB_A,
      asUser(
        U2,
        `insert into public.organizations (id, name, created_by) values (gen_random_uuid(), 'x', '${U2}');`,
      ),
      /permission denied/i,
    );
    expectPsqlError(
      DB_A,
      asUser(U2, `update public.organizations set name='x';`),
      /permission denied/i,
    );
    expectPsqlError(
      DB_A,
      asUser(U2, `delete from public.matters;`),
      /permission denied/i,
    );
    expectPsqlError(
      DB_A,
      asUser(
        U2,
        `insert into public.matters (id, workspace_id, name, created_by) values (gen_random_uuid(), '${WS1}', 'x', '${U2}');`,
      ),
      /permission denied/i,
    );
  });

  it("anon has zero tenancy privileges", () => {
    for (const table of TENANCY_TABLES) {
      expectPsqlError(
        DB_A,
        `set role anon; select * from public.${table};`,
        /permission denied/i,
      );
    }
    expectPsqlError(
      DB_A,
      `set role anon; select public.organization_role('${ORG1}');`,
      /permission denied/i,
    );
  });

  it("helpers and epoch RPCs reject direct misuse by non-service roles", () => {
    expectPsqlError(
      DB_A,
      asUser(U2, `select public.bump_authorization_epoch('${ORG1}');`),
      /permission denied/i,
    );
    expectPsqlError(
      DB_A,
      asUser(
        U2,
        `select public.revoke_organization_membership('${ORG1}', '${U3}');`,
      ),
      /permission denied/i,
    );
    expectPsqlError(
      DB_A,
      asUser(
        U2,
        `select public.bump_epoch_for_organization_membership_mutation();`,
      ),
      /permission denied/i,
    );
  });

  it("service_role keeps only intended data operations (no TRUNCATE)", () => {
    expectPsqlError(
      DB_A,
      `set role service_role; truncate public.organizations;`,
      /permission denied|must be owner/i,
    );
  });

  it("bumps the owning organization epoch exactly +1 per membership row change and not for no-op updates", () => {
    // U4 starts with no memberships. Org membership lifecycle: insert, no-op,
    // role change, status change, delete.
    let before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `insert into public.organization_memberships (organization_id, user_id, role, status) values ('${ORG1}', '${U4}', 'editor', 'active');`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `update public.organization_memberships set role='editor', status='active' where organization_id='${ORG1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `update public.organization_memberships set role='viewer' where organization_id='${ORG1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `update public.organization_memberships set status='inactive' where organization_id='${ORG1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `update public.organization_memberships set status='active' where organization_id='${ORG1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `delete from public.organization_memberships where organization_id='${ORG1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);
  });

  it("workspace and matter membership mutations bump the ORG epoch through the hierarchy, except no-ops", () => {
    let before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `insert into public.workspace_memberships (workspace_id, user_id, role, status) values ('${WS1}', '${U4}', 'editor', 'active');`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `update public.workspace_memberships set role='editor', status='active' where workspace_id='${WS1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `update public.workspace_memberships set role='viewer' where workspace_id='${WS1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `delete from public.workspace_memberships where workspace_id='${WS1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `insert into public.matter_memberships (matter_id, user_id, role, status) values ('${MATTER1}', '${U4}', 'editor', 'active');`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `update public.matter_memberships set role='editor', status='active' where matter_id='${MATTER1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before);

    before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `delete from public.matter_memberships where matter_id='${MATTER1}' and user_id='${U4}';`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);
  });

  it("revoke_organization_membership persists revoked status, bumps exactly once, and no-ops cleanly", () => {
    psql(
      DB_A,
      `insert into public.organization_memberships (organization_id, user_id, role, status) values ('${ORG1}', '${U6}', 'viewer', 'active');`,
    );
    const before = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `select public.revoke_organization_membership('${ORG1}', '${U6}');`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(before + 1);
    expect(
      scalar(
        DB_A,
        `select status from public.organization_memberships where organization_id='${ORG1}' and user_id='${U6}';`,
      ),
    ).toBe("revoked");

    // Revoking an already-revoked member changes nothing and must not bump.
    const beforeNoop = epochOf(DB_A, ORG1);
    psql(
      DB_A,
      `select public.revoke_organization_membership('${ORG1}', '${U6}');`,
    );
    expect(epochOf(DB_A, ORG1)).toBe(beforeNoop);
    expect(
      scalar(
        DB_A,
        `select status from public.organization_memberships where organization_id='${ORG1}' and user_id='${U6}';`,
      ),
    ).toBe("revoked");
  });

  it("matter→workspace→organization hierarchy and FK semantics remain LiTT-compatible", () => {
    expect(
      scalar(
        DB_A,
        `select w.organization_id from public.matters m join public.workspaces w on w.id = m.workspace_id where m.id = '${MATTER1}';`,
      ),
    ).toBe(ORG1);
    expectPsqlError(
      DB_A,
      `insert into public.matters (id, workspace_id, name, created_by) values (gen_random_uuid(), gen_random_uuid(), 'orphan', '${U1}');`,
      /violates foreign key/i,
    );
    // Role vocabularies still enforced.
    expectPsqlError(
      DB_A,
      `insert into public.organization_memberships (organization_id, user_id, role, status) values ('${ORG1}', '${U7}', 'admin', 'active');`,
      /check constraint/i,
    );
    expectPsqlError(
      DB_A,
      `insert into public.organization_memberships (organization_id, user_id, role, status) values ('${ORG1}', '${U7}', 'viewer', 'pending');`,
      /check constraint/i,
    );
    expectPsqlError(
      DB_A,
      `update public.matters set visibility='internal' where id='${MATTER1}';`,
      /check constraint/i,
    );
  });
});
