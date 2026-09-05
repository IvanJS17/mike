/**
 * E2a runtime gate. It is opt-in and never starts Docker during ordinary CI.
 * Run only with RUN_RECOVERY_AI_SCHEMA_RUNTIME=1 and an intentionally
 * available disposable Docker daemon.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const MIGRATIONS_DIR = path.join(BACKEND_DIR, "migrations");
const CANDIDATE = path.join(
  MIGRATIONS_DIR,
  "20260904_01_recovery_ai_evidence_review.sql",
);
const IMAGE = "postgres:16-alpine";
const PASSWORD = "e2a_disposable_password";
const CONTAINER = `e2a-ai-schema-${process.pid}`;
const INCREMENTAL = "e2a_incremental";
const FRESH = "e2a_fresh";
const BLOCKED = "e2a_blocked";
const RUN = process.env.RUN_RECOVERY_AI_SCHEMA_RUNTIME === "1";
const maybe = RUN ? describe : describe.skip;
let ownedContainer = false;

it("has the coordinator migration candidate before starting Docker", () => {
  expect(fs.existsSync(CANDIDATE)).toBe(true);
});

function docker(args: string[], input?: string): string {
  return execFileSync("docker", ["exec", "-i", CONTAINER, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}
function psql(database: string, sql: string): string {
  return docker(
    [
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
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
function apply(database: string, sql: string): void {
  psql(database, sql);
}
function sqlError(database: string, sql: string, pattern: RegExp): void {
  expect(() => psql(database, sql)).toThrow(pattern);
}
function sqlMustRejectAtomically(
  database: string,
  sql: string,
  pattern: RegExp,
): void {
  expect(() =>
    psql(
      database,
      `begin;
       set role service_role;
       ${sql};
       reset role;
       do $unexpected$ begin
         raise exception 'E2A_UNEXPECTED_ACCEPT';
       end $unexpected$;`,
    ),
  ).toThrow(pattern);
}
function file(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}
function gitFile(revision: string, filePath: string): string {
  return execFileSync("git", ["show", `${revision}:${filePath}`], {
    cwd: BACKEND_DIR,
    encoding: "utf8",
  });
}

const BOOTSTRAP = `
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
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant all on schema public to service_role;
`;

const IDS = {
  owner: "11111111-0000-0000-0000-000000000001",
  reviewer: "11111111-0000-0000-0000-000000000002",
  outsider: "11111111-0000-0000-0000-000000000003",
  org: "aaaaaaaa-0000-0000-0000-000000000001",
  workspace: "bbbbbbbb-0000-0000-0000-000000000001",
  matter: "cccccccc-0000-0000-0000-000000000001",
  project: "dddddddd-0000-0000-0000-000000000001",
  document: "eeeeeeee-0000-0000-0000-000000000001",
  version: "ffffffff-0000-0000-0000-000000000001",
  execution: "aaaaaaaa-0000-0000-0000-000000000002",
  blockedExecution: "aaaaaaaa-0000-0000-0000-000000000006",
  review: "bbbbbbbb-0000-0000-0000-000000000002",
  artifactDocument: "eeeeeeee-0000-0000-0000-000000000003",
  artifactVersion: "ffffffff-0000-0000-0000-000000000003",
  collisionArtifactDocument: "eeeeeeee-0000-0000-0000-000000000004",
  collisionArtifactVersion: "ffffffff-0000-0000-0000-000000000004",
} as const;

const LEGACY_IDS = {
  artifactDocument: "eeeeeeee-0000-0000-0000-000000000002",
  artifactVersion: "ffffffff-0000-0000-0000-000000000002",
  execution: "aaaaaaaa-0000-0000-0000-000000000003",
  output: "aaaaaaaa-0000-0000-0000-000000000004",
  receipt: "aaaaaaaa-0000-0000-0000-000000000005",
  review: "bbbbbbbb-0000-0000-0000-000000000003",
  item: "bbbbbbbb-0000-0000-0000-000000000004",
  decision: "bbbbbbbb-0000-0000-0000-000000000005",
  export: "bbbbbbbb-0000-0000-0000-000000000006",
  bundle: "bbbbbbbb-0000-0000-0000-000000000007",
} as const;

const AI_TABLES = [
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

const AI_RPC_SIGNATURES = [
  ["append_ai_evidence_batch", "uuid, uuid, bigint, jsonb"],
  ["create_ai_review", "uuid, uuid, bigint, jsonb"],
  ["apply_ai_review_item_decision", "uuid, uuid, bigint, jsonb"],
  ["complete_ai_review", "uuid, uuid, bigint, jsonb"],
  ["append_ai_review_export", "uuid, uuid, bigint, jsonb"],
  ["append_ai_redline_bundle", "uuid, uuid, bigint, jsonb"],
  ["assert_ai_redline_bundle_access", "uuid, uuid, uuid, bigint, text"],
] as const;

const APPEND_ONLY_LEGACY_ROWS = [
  ["ai_document_version_pages", `document_version_id='${IDS.version}'`],
  ["ai_output_versions", `id='${LEGACY_IDS.output}'`],
  ["ai_receipts", `id='${LEGACY_IDS.receipt}'`],
  ["ai_review_decisions", `id='${LEGACY_IDS.decision}'`],
  ["ai_review_exports", `id='${LEGACY_IDS.export}'`],
  ["ai_redline_bundles", `id='${LEGACY_IDS.bundle}'`],
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const SEED = `
insert into auth.users(id,email) values
 ('${IDS.owner}','owner@e2a.test'), ('${IDS.reviewer}','reviewer@e2a.test'), ('${IDS.outsider}','outsider@e2a.test');
insert into public.organizations(id,name,created_by) values ('${IDS.org}','E2a Org','${IDS.owner}');
insert into public.organization_memberships(organization_id,user_id,role,status) values
 ('${IDS.org}','${IDS.owner}','org_owner','active'), ('${IDS.org}','${IDS.reviewer}','editor','active');
insert into public.projects(id,user_id,name) values ('${IDS.project}','${IDS.owner}','E2a Project');
insert into public.workspaces(id,organization_id,name,created_by) values ('${IDS.workspace}','${IDS.org}','E2a Workspace','${IDS.owner}');
insert into public.workspace_memberships(workspace_id,user_id,role,status) values
 ('${IDS.workspace}','${IDS.owner}','workspace_admin','active'), ('${IDS.workspace}','${IDS.reviewer}','editor','active');
insert into public.matters(id,workspace_id,name,created_by,project_id,visibility) values
 ('${IDS.matter}','${IDS.workspace}','E2a Matter','${IDS.owner}','${IDS.project}','private');
insert into public.matter_memberships(matter_id,user_id,role,status) values
 ('${IDS.matter}','${IDS.owner}','matter_owner','active'), ('${IDS.matter}','${IDS.reviewer}','editor','active');
insert into public.documents(id,project_id,user_id,status) values ('${IDS.document}','${IDS.project}','${IDS.owner}','completed');
insert into public.document_versions(id,document_id,content_sha256,created_at) values
 ('${IDS.version}','${IDS.document}',repeat('a',64),now());
`;

const LEGACY_AI_SEED = `
insert into public.documents(id,project_id,user_id,status) values
 ('${LEGACY_IDS.artifactDocument}','${IDS.project}','${IDS.owner}','completed');
insert into public.document_versions(id,document_id,content_sha256,source,created_at) values
 ('${LEGACY_IDS.artifactVersion}','${LEGACY_IDS.artifactDocument}',repeat('e',64),'ai_review_report',now());
set session_replication_role = replica;
insert into public.ai_document_version_pages(
  document_id,document_version_id,page,content,content_sha256
) values (
  '${IDS.document}','${IDS.version}',2,'Legacy page',
  encode(digest('Legacy page','sha256'),'hex')
);
insert into public.ai_executions(
  id,user_id,matter_id,project_id,workflow_id,workflow_version,playbook_sha256,
  document_id,document_version_id,document_content_sha256,input_sha256,
  route_provider,route_model,credential_ref,status
) values (
  '${LEGACY_IDS.execution}','${IDS.owner}','${IDS.matter}','${IDS.project}',
  'legacy-workflow','1.0.0',repeat('b',64),'${IDS.document}','${IDS.version}',
  repeat('a',64),repeat('a',64),'openai','legacy-model','legacy-credential','succeeded'
);
insert into public.ai_output_versions(
  id,execution_id,output_format,output_text,output_sha256,citation_refs
) values (
  '${LEGACY_IDS.output}','${LEGACY_IDS.execution}','markdown','Legacy output',
  encode(digest('Legacy output','sha256'),'hex'),'[]'::jsonb
);
insert into public.ai_receipts(
  id,execution_id,receipt_version,canonical_json,receipt_sha256
) values (
  '${LEGACY_IDS.receipt}','${LEGACY_IDS.execution}','beta-0.1',
  '{"legacy":true}'::jsonb,repeat('c',64)
);
insert into public.ai_reviews(
  id,execution_id,matter_id,project_id,reviewer_user_id,status
) values (
  '${LEGACY_IDS.review}','${LEGACY_IDS.execution}','${IDS.matter}','${IDS.project}',
  '${IDS.reviewer}','approved'
);
insert into public.ai_review_items(
  id,review_id,item_key,original_text,finding_text,citation_refs,status
) values (
  '${LEGACY_IDS.item}','${LEGACY_IDS.review}','legacy-item','Legacy finding',
  'Legacy finding','[]'::jsonb,'accepted'
);
insert into public.ai_review_decisions(
  id,review_id,review_item_id,actor_user_id,decision,before_state,after_state
) values (
  '${LEGACY_IDS.decision}','${LEGACY_IDS.review}','${LEGACY_IDS.item}',
  '${IDS.reviewer}','accepted','{"status":"pending"}'::jsonb,
  '{"status":"accepted"}'::jsonb
);
insert into public.ai_review_exports(
  id,review_id,execution_id,matter_id,project_id,source_document_version_id,
  document_id,document_version_id,report_version,filename,content_sha256,actor_user_id
) values (
  '${LEGACY_IDS.export}','${LEGACY_IDS.review}','${LEGACY_IDS.execution}',
  '${IDS.matter}','${IDS.project}','${IDS.version}','${LEGACY_IDS.artifactDocument}',
  '${LEGACY_IDS.artifactVersion}',1,'Informe de revision humana.docx',repeat('e',64),
  '${IDS.reviewer}'
);
insert into public.ai_redline_bundles(
  id,bundle_version,revision,review_id,execution_id,matter_id,project_id,
  source_document_version_id,source_document_sha256,receipt_id,receipt_sha256,
  canonical_json,canonical_json_text,bundle_sha256,actions_count,actor_user_id
) values (
  '${LEGACY_IDS.bundle}','beta-0.1',1,'${LEGACY_IDS.review}','${LEGACY_IDS.execution}',
  '${IDS.matter}','${IDS.project}','${IDS.version}',repeat('a',64),
  '${LEGACY_IDS.receipt}',repeat('c',64),'{"actions":[{"legacy":true}]}'::jsonb,
  '{"actions":[{"legacy":true}]}',repeat('d',64),1,'${IDS.reviewer}'
);
set session_replication_role = origin;
`;

const LEGACY_DRIVE_ROW = `
set session_replication_role = replica;
insert into public.ai_review_drive_publications(
  export_id,review_id,execution_id,matter_id,project_id,organization_id,
  authorization_epoch,drive_folder_id,sha256,format_version,status,actor_user_id
) values (
  '${LEGACY_IDS.export}','${LEGACY_IDS.review}','${LEGACY_IDS.execution}',
  '${IDS.matter}','${IDS.project}','${IDS.org}',0,'legacy-folder',repeat('f',64),
  'beta-0.1','pending','${IDS.reviewer}'
);
set session_replication_role = origin;
`;

function tableFingerprint(database: string): unknown[] {
  const raw = psql(
    database,
    `
with target_tables(table_name) as (values
  ('ai_document_version_pages'),('ai_executions'),('ai_output_versions'),('ai_receipts'),
  ('ai_reviews'),('ai_review_items'),('ai_review_decisions'),('ai_review_exports'),('ai_redline_bundles')
), objects as (
  select jsonb_build_object('kind','column','table',c.table_name,'name',c.column_name,
    'type',c.udt_schema||'.'||c.udt_name,'nullable',c.is_nullable,'default',c.column_default) v
    from information_schema.columns c join target_tables t using(table_name) where c.table_schema='public'
  union all select jsonb_build_object('kind','constraint','table',cl.relname,'name',co.conname,'definition',pg_get_constraintdef(co.oid))
    from pg_constraint co join pg_class cl on cl.oid=co.conrelid where cl.relnamespace='public'::regnamespace and cl.relname in(select table_name from target_tables)
  union all select jsonb_build_object('kind','index','table',tablename,'name',indexname,'definition',indexdef)
    from pg_indexes where schemaname='public' and tablename in(select table_name from target_tables)
  union all select jsonb_build_object('kind','rls','table',relname,'enabled',relrowsecurity,'forced',relforcerowsecurity,'owner',pg_get_userbyid(relowner))
    from pg_class where relnamespace='public'::regnamespace and relname in(select table_name from target_tables)
)
select coalesce(jsonb_agg(v order by v), '[]'::jsonb)::text from objects;
`,
  );
  return JSON.parse(raw) as unknown[];
}

function securityFingerprint(database: string): unknown[] {
  const raw = psql(
    database,
    `
with target_tables(table_name) as (values
  ${AI_TABLES.map((table) => `('${table}')`).join(",")}
), objects as (
  select jsonb_build_object('kind','function','name',p.proname,
    'args',oidvectortypes(p.proargtypes),
    'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),
    'security_definer',p.prosecdef,'config',coalesce(p.proconfig,'{}')) v
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'ai_%'
  union all
  select jsonb_build_object('kind','function_acl','name',p.proname,
    'args',oidvectortypes(p.proargtypes),
    'grantee',case when acl.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    'privilege',acl.privilege_type,'grantable',acl.is_grantable) v
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
   where n.nspname='public' and p.proname like 'ai_%'
  union all
  select jsonb_build_object('kind','trigger','table',c.relname,'name',t.tgname,
    'definition',pg_get_triggerdef(t.oid)) v
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    join target_tables tt on tt.table_name=c.relname
   where n.nspname='public' and not t.tgisinternal
  union all
  select jsonb_build_object('kind','policy','table',p.tablename,'name',p.policyname,
    'command',p.cmd,'roles',p.roles,'using',p.qual,'check',p.with_check) v
    from pg_policies p join target_tables tt on tt.table_name=p.tablename
   where p.schemaname='public'
  union all
  select jsonb_build_object('kind','table_acl','table',tt.table_name,
    'grantee',case when acl.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    'privilege',acl.privilege_type,'grantable',acl.is_grantable) v
    from target_tables tt join pg_class c on c.relname=tt.table_name
    join pg_namespace n on n.oid=c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
   where n.nspname='public'
)
select coalesce(jsonb_agg(v order by v),'[]'::jsonb)::text from objects;
`,
  );
  return JSON.parse(raw) as unknown[];
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function expectTableFingerprintsEqual(): void {
  const incremental = tableFingerprint(INCREMENTAL);
  const fresh = tableFingerprint(FRESH);
  const incrementalRows = new Set(incremental.map(canonical));
  const freshRows = new Set(fresh.map(canonical));
  const incrementalOnly = [...incrementalRows].filter(
    (row) => !freshRows.has(row),
  );
  const freshOnly = [...freshRows].filter((row) => !incrementalRows.has(row));
  if (incrementalOnly.length > 0 || freshOnly.length > 0) {
    throw new Error(
      `AI table fingerprint mismatch\nincremental-only: ${incrementalOnly.join("\n")}\nfresh-only: ${freshOnly.join("\n")}`,
    );
  }
  expect(incremental).toHaveLength(fresh.length);
}

maybe("Slice E2a disposable PostgreSQL runtime", () => {
  beforeAll(() => {
    const candidate = file(CANDIDATE);
    const containerId = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-d",
        "--name",
        CONTAINER,
        "-e",
        `POSTGRES_PASSWORD=${PASSWORD}`,
        IMAGE,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(containerId).not.toBe("");
    ownedContainer = true;
    let stableReadyChecks = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        execFileSync(
          "docker",
          ["exec", CONTAINER, "pg_isready", "-U", "postgres"],
          { stdio: "ignore" },
        );
        stableReadyChecks += 1;
        if (stableReadyChecks === 3) break;
      } catch {
        stableReadyChecks = 0;
      }
      execFileSync("sleep", ["1"]);
    }
    if (stableReadyChecks < 3)
      throw new Error("postgres stable readiness timed out");
    for (const db of [INCREMENTAL, FRESH, BLOCKED])
      docker(["createdb", "-U", "postgres", db]);
    const baseline = gitFile(
      "d9fa8380e63837b6441cef169cf5ef80dfb55e54",
      "backend/schema.sql",
    );
    const tenancy = file(
      path.join(MIGRATIONS_DIR, "20260831_01_recovery_identity_tenancy.sql"),
    );
    const onboarding = file(
      path.join(
        MIGRATIONS_DIR,
        "20260902_01_recovery_onboarding_organization.sql",
      ),
    );
    apply(INCREMENTAL, BOOTSTRAP + baseline + tenancy + onboarding);
    apply(INCREMENTAL, SEED + LEGACY_AI_SEED);
    apply(INCREMENTAL, candidate);
    apply(FRESH, BOOTSTRAP + file(path.join(BACKEND_DIR, "schema.sql")));
    apply(INCREMENTAL, candidate);
    apply(BLOCKED, BOOTSTRAP + baseline + tenancy + onboarding);
    apply(BLOCKED, SEED + LEGACY_AI_SEED + LEGACY_DRIVE_ROW);
  }, 300_000);

  afterAll(() => {
    if (ownedContainer) {
      execFileSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
      ownedContainer = false;
    }
    expect(
      execFileSync(
        "docker",
        ["ps", "-a", "--filter", `name=^/${CONTAINER}$`, "-q"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("");
  }, 60_000);

  it("converges the exact AI table fingerprint and has no legacy Drive objects", () => {
    expectTableFingerprintsEqual();
    expect(
      psql(
        INCREMENTAL,
        "select count(*) from pg_class where relnamespace='public'::regnamespace and relname ilike '%drive%';",
      ),
    ).toBe("0");
  });

  it("preserves and truthfully maps the deployed legacy AI rows", () => {
    expect(
      psql(
        INCREMENTAL,
        `select evidence_version || '|' || author_user_id || '|' || workflow_key
           from public.ai_executions where id='${LEGACY_IDS.execution}';`,
      ),
    ).toBe(`legacy-beta-0.1|${IDS.owner}|legacy-workflow`);
    expect(
      psql(
        INCREMENTAL,
        `select receipt_version || '|' || canonical_json
           from public.ai_receipts where id='${LEGACY_IDS.receipt}';`,
      ),
    ).toBe('legacy-beta-0.1|{"legacy": true}');
    expect(
      psql(
        INCREMENTAL,
        `select revision || '|' || status from public.ai_reviews
          where id='${LEGACY_IDS.review}';`,
      ),
    ).toBe("2|approved");
    expect(
      psql(
        INCREMENTAL,
        `select operation || '|' || revision from public.ai_review_decisions
          where id='${LEGACY_IDS.decision}';`,
      ),
    ).toBe("decide|2");
    expect(
      psql(
        INCREMENTAL,
        `select bundle_version || '|' || jsonb_array_length(actions)
           from public.ai_redline_bundles where id='${LEGACY_IDS.bundle}';`,
      ),
    ).toBe("legacy-beta-0.1|1");
    expect(
      psql(
        INCREMENTAL,
        `select count(*) from information_schema.columns
          where table_schema='public' and table_name like 'ai_%'
            and column_name in (
              'receipt_payload','decision_version','artifact_revision',
              'evidence_receipt_id','bundle_payload','action_count'
            );`,
      ),
    ).toBe("0");
    expect(
      psql(
        INCREMENTAL,
        `select count(*) from (values
          ('${LEGACY_IDS.execution}'::uuid),('${LEGACY_IDS.output}'::uuid),
          ('${LEGACY_IDS.receipt}'::uuid),('${LEGACY_IDS.review}'::uuid),
          ('${LEGACY_IDS.item}'::uuid),('${LEGACY_IDS.decision}'::uuid),
          ('${LEGACY_IDS.export}'::uuid),('${LEGACY_IDS.bundle}'::uuid)
        ) expected(id)
        where exists (
          select 1 from public.ai_executions where id=expected.id
          union all select 1 from public.ai_output_versions where id=expected.id
          union all select 1 from public.ai_receipts where id=expected.id
          union all select 1 from public.ai_reviews where id=expected.id
          union all select 1 from public.ai_review_items where id=expected.id
          union all select 1 from public.ai_review_decisions where id=expected.id
          union all select 1 from public.ai_review_exports where id=expected.id
          union all select 1 from public.ai_redline_bundles where id=expected.id
        );`,
      ),
    ).toBe("8");
  });

  it("rolls back rather than discarding a deployed Drive publication", () => {
    sqlError(
      BLOCKED,
      file(CANDIDATE),
      /Non-empty legacy AI Drive publications require the Slice G migration/,
    );
    expect(
      psql(
        BLOCKED,
        "select count(*) from public.ai_review_drive_publications;",
      ),
    ).toBe("1");
    expect(
      psql(
        BLOCKED,
        `select count(*) from information_schema.columns
          where table_schema='public' and table_name='ai_executions'
            and column_name='user_id';`,
      ),
    ).toBe("1");
  });

  it("converges security objects and effective ACLs across incremental and fresh paths", () => {
    const incremental = securityFingerprint(INCREMENTAL);
    const fresh = securityFingerprint(FRESH);
    expect(incremental).toEqual(fresh);
    expect(incremental).not.toEqual([]);
    for (const table of AI_TABLES) {
      expect(
        psql(
          INCREMENTAL,
          `select has_table_privilege('service_role','public.${table}','select')
             and not has_table_privilege('service_role','public.${table}','insert')
             and not has_table_privilege('service_role','public.${table}','update')
             and not has_table_privilege('service_role','public.${table}','delete')
             and not has_table_privilege('service_role','public.${table}','truncate')
             and not has_table_privilege('anon','public.${table}','select')
             and not has_table_privilege('authenticated','public.${table}','select');`,
        ),
      ).toBe("t");
    }
    for (const [name, args] of AI_RPC_SIGNATURES) {
      expect(
        psql(
          INCREMENTAL,
          `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='${name}'
               and oidvectortypes(p.proargtypes)='${args}'
               and p.prosecdef and p.proconfig @> array['search_path=public']
               and has_function_privilege('service_role',p.oid,'execute')
               and not has_function_privilege('anon',p.oid,'execute')
               and not has_function_privilege('authenticated',p.oid,'execute');`,
        ),
      ).toBe("1");
    }
    expect(
      psql(
        INCREMENTAL,
        `select count(*)
           from pg_proc p
           join pg_namespace n on n.oid=p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
           left join pg_roles role on role.oid=acl.grantee
          where n.nspname='public'
            and p.proname in ('ai_review_citation_valid','ai_review_item_valid','ai_review_valid','ai_review_matches_execution_evidence')
            and acl.privilege_type='EXECUTE'
            and (acl.grantee=0 or role.rolname in ('anon','authenticated','service_role'));`,
      ),
    ).toBe("0");
  });

  it("rejects owner-level UPDATE and DELETE for every seeded append-only row", () => {
    for (const [table, predicate] of APPEND_ONLY_LEGACY_ROWS) {
      expect(
        psql(
          INCREMENTAL,
          `select count(*) from public.${table} where ${predicate};`,
        ),
      ).not.toBe("0");
      sqlError(
        INCREMENTAL,
        `set role postgres; update public.${table} set created_at=created_at where ${predicate};`,
        /insert-only|immutable|permission|violates|append/i,
      );
      sqlError(
        INCREMENTAL,
        `set role postgres; delete from public.${table} where ${predicate};`,
        /insert-only|immutable|permission|violates|append/i,
      );
    }
  });

  it("appends current E1 evidence atomically with replay and fail-closed boundaries", () => {
    for (const [name, args] of AI_RPC_SIGNATURES) {
      expect(
        psql(
          INCREMENTAL,
          `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='${name}'
               and oidvectortypes(p.proargtypes)='${args}';`,
        ),
      ).toBe("1");
    }

    const epoch = psql(
      INCREMENTAL,
      `select authorization_epoch from public.organizations where id='${IDS.org}';`,
    );
    const receiptBody = {
      receipt_version: "evidence-v1",
      idempotency_key: "evidence:e2a:1",
      execution_id: IDS.execution,
      tenant_scope: {
        organization_id: IDS.org,
        matter_id: IDS.matter,
        project_id: IDS.project,
        document_version_id: IDS.version,
      },
      route: {
        provider: "openai",
        model: "gpt-5.6-sol",
        credential_ref: "key-v2",
      },
      workflow: {
        workflow_key: "civil-commercial-mx-triage",
        version: "0.1.0",
        content_hash: "b".repeat(64),
        source_commit: "c".repeat(40),
        distribution: "addon",
        type: "assistant",
        source: "playbook.md",
        approval_provenance: "review pending",
      },
      status: "completed",
      input_hashes: ["a".repeat(64)],
      page_hashes: [
        {
          document_id: IDS.document,
          document_version_id: IDS.version,
          page: 1,
          text_sha256: sha256("Árbol jurídico y contrato."),
        },
      ],
      output_hash: sha256("Resultado íntegro"),
      citation_hashes: [
        {
          citation_id: "c-1",
          document_id: IDS.document,
          document_version_id: IDS.version,
          page: 1,
          span: { start_char: 0, end_char: 5 },
          quote_sha256: sha256("Árbol"),
          finding_sha256: sha256("Hallazgo"),
        },
      ],
    };
    const receiptCanonical = canonicalJson(receiptBody);
    const evidence = `jsonb_build_object(
      'idempotency_key','evidence:e2a:1',
      'execution',jsonb_build_object(
        'execution_id','${IDS.execution}'::uuid,
        'provenance',jsonb_build_object(
        'tenant_scope',jsonb_build_object('organization_id','${IDS.org}'::uuid,'matter_id','${IDS.matter}'::uuid,'project_id','${IDS.project}'::uuid,'document_version_id','${IDS.version}'::uuid),
        'input_hashes',jsonb_build_array(repeat('a',64)),
        'output_hashes',jsonb_build_array(encode(digest('Resultado íntegro','sha256'),'hex')),
        'citation_hashes',jsonb_build_array(encode(digest('Árbol','sha256'),'hex')),
        'route',jsonb_build_object('provider','openai','model','gpt-5.6-sol','credential_ref','key-v2'),
        'workflow',jsonb_build_object('workflow_key','civil-commercial-mx-triage','version','0.1.0','content_hash',repeat('b',64),'source_commit',repeat('c',40),'distribution','addon','type','assistant','source','playbook.md','approval_provenance','review pending'),
        'status','completed')),
      'pages',jsonb_build_array(jsonb_build_object('document_id','${IDS.document}'::uuid,'document_version_id','${IDS.version}'::uuid,'page',1,'text','Árbol jurídico y contrato.','text_sha256',encode(digest('Árbol jurídico y contrato.','sha256'),'hex'))),
      'output',jsonb_build_object('execution_id','${IDS.execution}'::uuid,'output_text','Resultado íntegro','output_sha256',encode(digest('Resultado íntegro','sha256'),'hex')),
      'citations',jsonb_build_array(jsonb_build_object('citation_id','c-1','document_id','${IDS.document}'::uuid,'document_version_id','${IDS.version}'::uuid,'page',1,'span',jsonb_build_object('start_char',0,'end_char',5),'quote_sha256',encode(digest('Árbol','sha256'),'hex'),'finding_text','Hallazgo','verified',true)),
      'receipt',jsonb_build_object('receipt_version','evidence-v1','canonical_json',${sqlText(receiptCanonical)},'receipt_sha256','${sha256(receiptCanonical)}')
    )`;
    const receipt = () =>
      psql(
        INCREMENTAL,
        `set role service_role; select public.append_ai_evidence_batch('${IDS.owner}','${IDS.org}',${epoch},${evidence});`,
      );
    const first = receipt();
    expect(JSON.parse(first)).toEqual({
      disposition: "applied",
      idempotency_key: "evidence:e2a:1",
      execution_id: IDS.execution,
      receipt_sha256: expect.any(String),
      counts: { pages: 1, outputs: 1, citations: 1 },
    });
    expect(receipt()).toBe(first.replace('"applied"', '"replayed"'));
    sqlError(
      INCREMENTAL,
      `set role service_role; select public.append_ai_evidence_batch('${IDS.owner}','${IDS.org}',${epoch},${evidence} || jsonb_build_object('output',jsonb_build_object('execution_id','${IDS.execution}'::uuid,'output_text','tampered','output_sha256',encode(digest('tampered','sha256'),'hex'))));`,
      /idempot|content|replay|conflict|hash|provenance/i,
    );
    sqlError(
      INCREMENTAL,
      `set role service_role; select public.append_ai_evidence_batch('${IDS.outsider}','${IDS.org}',${epoch},${evidence});`,
      /authorization|membership|actor|scope|permission/i,
    );
    sqlError(
      INCREMENTAL,
      `set role service_role; select public.append_ai_evidence_batch('${IDS.owner}','${IDS.org}',${Number(epoch) - 1},${evidence});`,
      /epoch|stale|authorization/i,
    );
    expect(
      psql(
        INCREMENTAL,
        `select count(*) from public.ai_executions where id='${IDS.execution}';`,
      ),
    ).toBe("1");
  });

  it("creates, decides and completes the current E1 human review atomically", () => {
    const epoch = Number(
      psql(
        INCREMENTAL,
        `select authorization_epoch from public.organizations where id='${IDS.org}';`,
      ),
    );
    const receiptHash = psql(
      INCREMENTAL,
      `select receipt_sha256 from public.ai_receipts where execution_id='${IDS.execution}';`,
    );
    const citation = {
      citation_id: "c-1",
      document_id: IDS.document,
      document_version_id: IDS.version,
      page: 1,
      span: { start_char: 0, end_char: 5 },
      quote_sha256: sha256("Árbol"),
      finding_text: "Hallazgo",
      verified: true,
    };
    const pendingItem = {
      item_id: "item-current-1",
      item_key: "c-1",
      original_text: "Hallazgo",
      finding_text: "Hallazgo",
      status: "pending",
      comment: null,
      citation,
    };
    const pendingReview = {
      review_id: IDS.review,
      revision: 1,
      execution_id: IDS.execution,
      execution_author_user_id: IDS.owner,
      reviewer_user_id: IDS.reviewer,
      organization_id: IDS.org,
      matter_id: IDS.matter,
      project_id: IDS.project,
      document_id: IDS.document,
      document_version_id: IDS.version,
      document_content_sha256: "a".repeat(64),
      evidence_receipt_sha256: receiptHash,
      status: "pending",
      items: [pendingItem],
    };
    const citationFreeProjection = {
      items: [
        {
          item_key: "finding-1",
          original_text: "Resultado sin citas",
          citation: null,
        },
      ],
    };
    expect(
      psql(
        INCREMENTAL,
        `select public.ai_review_matches_execution_evidence(
          ${sqlText(JSON.stringify(citationFreeProjection))}::jsonb,
          '[]'::jsonb,
          'Resultado sin citas'
        );`,
      ),
    ).toBe("t");
    expect(
      psql(
        INCREMENTAL,
        `select public.ai_review_matches_execution_evidence(
          ${sqlText(
            JSON.stringify({
              items: [
                {
                  ...citationFreeProjection.items[0],
                  item_key: "other-key",
                },
              ],
            }),
          )}::jsonb,
          '[]'::jsonb,
          'Resultado sin citas'
        );`,
      ),
    ).toBe("f");
    const createMutation = {
      idempotency_key: "review:create:1",
      review: pendingReview,
    };
    const callCreate = () =>
      psql(
        INCREMENTAL,
        `set role service_role; select public.create_ai_review(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(JSON.stringify(createMutation))}::jsonb
        );`,
      );

    const invalidCreateReviews = [
      {
        ...pendingReview,
        items: [
          {
            ...pendingItem,
            citation: { ...citation, verified: false },
          },
        ],
      },
      {
        ...pendingReview,
        items: [
          {
            ...pendingItem,
            citation: { ...citation, document_id: IDS.artifactDocument },
          },
        ],
      },
      { ...pendingReview, unexpected_field: "must-reject" },
      {
        ...pendingReview,
        items: [{ ...pendingItem, item_key: "other-key" }],
      },
      {
        ...pendingReview,
        items: [
          {
            ...pendingItem,
            original_text: "Texto arbitrario",
            finding_text: "Texto arbitrario",
          },
        ],
      },
    ];
    for (const [index, invalidReview] of invalidCreateReviews.entries()) {
      sqlMustRejectAtomically(
        INCREMENTAL,
        `select public.create_ai_review(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(
            JSON.stringify({
              idempotency_key: `review:create:invalid:${index}`,
              review: invalidReview,
            }),
          )}::jsonb
        )`,
        /invalid|citation|scope|contract/i,
      );
    }
    expect(
      psql(
        INCREMENTAL,
        `select count(*) from public.ai_reviews where id='${IDS.review}';`,
      ),
    ).toBe("0");

    const created = JSON.parse(callCreate());
    expect(created).toEqual({
      disposition: "applied",
      operation: "create",
      review_id: IDS.review,
      item_id: null,
      revision: 1,
      idempotency_key: "review:create:1",
    });
    expect(JSON.parse(callCreate())).toEqual({
      ...created,
      disposition: "replayed",
    });
    sqlError(
      INCREMENTAL,
      `set role service_role; select public.create_ai_review(
        '${IDS.owner}','${IDS.org}',${epoch},
        ${sqlText(JSON.stringify(createMutation))}::jsonb
      );`,
      /review|actor|scope|invalid|author/i,
    );

    const earlyApproval = {
      idempotency_key: "review:complete:early",
      review: { ...pendingReview, revision: 2, status: "approved" },
    };
    sqlError(
      INCREMENTAL,
      `set role=service_role; select public.complete_ai_review(
        '${IDS.reviewer}','${IDS.org}',${epoch},
        ${sqlText(JSON.stringify(earlyApproval))}::jsonb
      );`,
      /pending|unresolved|approval/i,
    );

    const acceptedItem = { ...pendingItem, status: "accepted" };
    const decidedReview = {
      ...pendingReview,
      revision: 2,
      items: [acceptedItem],
    };
    const decideMutation = {
      idempotency_key: "review:decide:1",
      review: decidedReview,
      item: acceptedItem,
      transition: {
        decision: "accepted",
        before: pendingItem,
        after: acceptedItem,
      },
    };
    const invalidDecisionItem = {
      ...acceptedItem,
      citation: { ...citation, verified: false },
    };
    sqlMustRejectAtomically(
      INCREMENTAL,
      `select public.apply_ai_review_item_decision(
        '${IDS.reviewer}','${IDS.org}',${epoch},
        ${sqlText(
          JSON.stringify({
            ...decideMutation,
            idempotency_key: "review:decide:invalid-citation",
            review: { ...decidedReview, items: [invalidDecisionItem] },
            item: invalidDecisionItem,
            transition: {
              ...decideMutation.transition,
              after: invalidDecisionItem,
            },
          }),
        )}::jsonb
      )`,
      /invalid|citation|scope|contract/i,
    );
    const callDecide = () =>
      psql(
        INCREMENTAL,
        `set role service_role; select public.apply_ai_review_item_decision(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(JSON.stringify(decideMutation))}::jsonb
        );`,
      );
    const decided = JSON.parse(callDecide());
    expect(decided).toEqual({
      disposition: "applied",
      operation: "decide",
      review_id: IDS.review,
      item_id: "item-current-1",
      revision: 2,
      idempotency_key: "review:decide:1",
    });
    expect(JSON.parse(callDecide())).toEqual({
      ...decided,
      disposition: "replayed",
    });
    const decisionReplayCollisions = [
      {
        ...decideMutation,
        review: { ...decidedReview, matter_id: IDS.artifactDocument },
      },
      {
        ...decideMutation,
        review: { ...decidedReview, status: "approved" },
      },
      {
        ...decideMutation,
        transition: {
          ...decideMutation.transition,
          before: { ...pendingItem, comment: "tampered replay" },
        },
      },
    ];
    for (const collision of decisionReplayCollisions) {
      sqlError(
        INCREMENTAL,
        `set role service_role; select public.apply_ai_review_item_decision(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(JSON.stringify(collision))}::jsonb
        );`,
        /idempot|conflict|projection|scope|stale|invalid|contract/i,
      );
    }

    const invalidCompletions = [
      {
        ...decidedReview,
        revision: 3,
        status: "changes_requested",
        matter_id: IDS.artifactDocument,
      },
      {
        ...decidedReview,
        revision: 3,
        status: "changes_requested",
        unexpected_field: "must-reject",
      },
    ];
    for (const [index, invalidReview] of invalidCompletions.entries()) {
      sqlMustRejectAtomically(
        INCREMENTAL,
        `select public.complete_ai_review(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(
            JSON.stringify({
              idempotency_key: `review:complete:invalid:${index}`,
              review: invalidReview,
            }),
          )}::jsonb
        )`,
        /invalid|scope|contract|projection|stale/i,
      );
    }
    expect(
      psql(
        INCREMENTAL,
        `select revision || '|' || status from public.ai_reviews where id='${IDS.review}';`,
      ),
    ).toBe("2|pending");

    const approvedReview = {
      ...decidedReview,
      revision: 3,
      status: "approved",
    };
    const completeMutation = {
      idempotency_key: "review:complete:1",
      review: approvedReview,
    };
    const callComplete = () =>
      psql(
        INCREMENTAL,
        `set role service_role; select public.complete_ai_review(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(JSON.stringify(completeMutation))}::jsonb
        );`,
      );
    const completed = JSON.parse(callComplete());
    expect(completed).toEqual({
      disposition: "applied",
      operation: "complete",
      review_id: IDS.review,
      item_id: null,
      revision: 3,
      idempotency_key: "review:complete:1",
    });
    expect(JSON.parse(callComplete())).toEqual({
      ...completed,
      disposition: "replayed",
    });
    expect(JSON.parse(callDecide())).toEqual({
      ...decided,
      disposition: "replayed",
    });
    sqlError(
      INCREMENTAL,
      `set role service_role; select public.complete_ai_review(
        '${IDS.reviewer}','${IDS.org}',${epoch - 1},
        ${sqlText(JSON.stringify(completeMutation))}::jsonb
      );`,
      /epoch|stale|authorization/i,
    );
    expect(
      psql(
        INCREMENTAL,
        `select revision || '|' || status from public.ai_reviews where id='${IDS.review}';`,
      ),
    ).toBe("3|approved");
    expect(
      psql(
        INCREMENTAL,
        `select count(*) from public.ai_review_decisions where review_id='${IDS.review}';`,
      ),
    ).toBe("3");
  });

  it("appends approved DOCX and redline evidence, then authorizes exact bundle access", () => {
    const epoch = Number(
      psql(
        INCREMENTAL,
        `select authorization_epoch from public.organizations where id='${IDS.org}';`,
      ),
    );
    const receiptHash = psql(
      INCREMENTAL,
      `select receipt_sha256 from public.ai_receipts where execution_id='${IDS.execution}';`,
    );
    const artifact = {
      idempotency_key: "review:export:1",
      review_id: IDS.review,
      review_revision: 3,
      execution_id: IDS.execution,
      organization_id: IDS.org,
      matter_id: IDS.matter,
      project_id: IDS.project,
      document_id: IDS.document,
      document_version_id: IDS.version,
      source_document_sha256: "a".repeat(64),
      evidence_receipt_sha256: receiptHash,
      filename: "Informe de revision humana.docx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      artifact_sha256: "e".repeat(64),
      artifact_document_id: IDS.artifactDocument,
      artifact_document_version_id: IDS.artifactVersion,
    };
    const callExport = () =>
      psql(
        INCREMENTAL,
        `set role service_role; select public.append_ai_review_export(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(JSON.stringify(artifact))}::jsonb
        );`,
      );
    const exported = JSON.parse(callExport());
    expect(exported).toEqual({
      disposition: "applied",
      review_id: IDS.review,
      review_revision: 3,
      execution_id: IDS.execution,
      artifact_sha256: "e".repeat(64),
      idempotency_key: "review:export:1",
    });
    expect(JSON.parse(callExport())).toEqual({
      ...exported,
      disposition: "replayed",
    });
    const exportCollisions = [
      {
        ...artifact,
        artifact_document_id: IDS.collisionArtifactDocument,
        artifact_document_version_id: IDS.collisionArtifactVersion,
      },
      { ...artifact, filename: "different.docx" },
      { ...artifact, mime_type: "application/octet-stream" },
    ];
    for (const collision of exportCollisions) {
      sqlError(
        INCREMENTAL,
        `set role service_role; select public.append_ai_review_export(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(JSON.stringify(collision))}::jsonb
        );`,
        /idempot|conflict|identity|artifact/i,
      );
    }

    const action = {
      action_id: `action-${sha256("current-action")}`,
      review_item_id: "item-current-1",
      citation_id: "c-1",
      document_id: IDS.document,
      document_version_id: IDS.version,
      page: 1,
      start: 0,
      end: 5,
      page_content_sha256: sha256("Árbol jurídico y contrato."),
      before_text_sha256: sha256("Árbol"),
      replacement_text: "Hallazgo",
      replacement_text_sha256: sha256("Hallazgo"),
    };
    const canonicalBody = {
      bundle_version: "approved-redline-v1",
      revision: 1,
      review_id: IDS.review,
      review_revision: 3,
      execution_id: IDS.execution,
      organization_id: IDS.org,
      matter_id: IDS.matter,
      project_id: IDS.project,
      document_id: IDS.document,
      document_version_id: IDS.version,
      source_document_sha256: "a".repeat(64),
      evidence_receipt_version: "evidence-v1",
      evidence_receipt_sha256: receiptHash,
      reviewer_user_id: IDS.reviewer,
      actions: [{ ...action, replacement_text: undefined }],
    };
    delete (canonicalBody.actions[0] as { replacement_text?: string })
      .replacement_text;
    const canonical = canonicalJson(canonicalBody);
    const bundle = {
      idempotency_key: "review:redline:1",
      ...canonicalBody,
      actions: [action],
      canonical_json: canonical,
      bundle_sha256: sha256(canonical),
    };
    const callBundle = () =>
      psql(
        INCREMENTAL,
        `set role service_role; select public.append_ai_redline_bundle(
          '${IDS.reviewer}','${IDS.org}',${epoch},
          ${sqlText(JSON.stringify(bundle))}::jsonb
        );`,
      );
    const bundled = JSON.parse(callBundle());
    expect(bundled).toEqual({
      disposition: "applied",
      review_id: IDS.review,
      review_revision: 3,
      execution_id: IDS.execution,
      bundle_sha256: sha256(canonical),
      action_count: 1,
      idempotency_key: "review:redline:1",
    });
    expect(JSON.parse(callBundle())).toEqual({
      ...bundled,
      disposition: "replayed",
    });
    const bundleId = psql(
      INCREMENTAL,
      "select id from public.ai_redline_bundles where idempotency_key='review:redline:1';",
    );
    expect(
      psql(
        INCREMENTAL,
        `set role service_role; select public.assert_ai_redline_bundle_access(
          '${bundleId}','${IDS.reviewer}','${IDS.org}',${epoch},'review'
        );`,
      ),
    ).toBe("t");
    expect(
      psql(
        INCREMENTAL,
        `set role service_role; select public.assert_ai_redline_bundle_access(
          '${bundleId}','${IDS.owner}','${IDS.org}',${epoch},'read'
        );`,
      ),
    ).toBe("t");
    sqlError(
      INCREMENTAL,
      `set role service_role; select public.assert_ai_redline_bundle_access(
        '${bundleId}','${IDS.outsider}','${IDS.org}',${epoch},'read'
      );`,
      /membership|access|authorization|scope/i,
    );
    sqlError(
      INCREMENTAL,
      `set role service_role; select public.assert_ai_redline_bundle_access(
        '${bundleId}','${IDS.reviewer}','${IDS.org}',${epoch - 1},'review'
      );`,
      /epoch|stale|authorization/i,
    );
  });

  it("seeds synthetic tenant resources and exercises append/review/bundle authorization", () => {
    expect(
      psql(
        INCREMENTAL,
        `select count(*) from public.organizations where id='${IDS.org}' and authorization_epoch >= 0;`,
      ),
    ).toBe("1");
    expect(
      psql(
        INCREMENTAL,
        `select count(*) from public.ai_executions where id='${IDS.blockedExecution}';`,
      ),
    ).toBe("0");
    sqlError(
      INCREMENTAL,
      `set role anon; insert into public.ai_executions(id) values ('${IDS.blockedExecution}');`,
      /permission denied|row-level security/,
    );
    sqlError(
      INCREMENTAL,
      `set role authenticated; insert into public.ai_executions(id) values ('${IDS.blockedExecution}');`,
      /permission denied|row-level security/,
    );
    sqlError(
      INCREMENTAL,
      `set role service_role; insert into public.ai_receipts(execution_id,idempotency_key,receipt_version,canonical_json,receipt_sha256) values ('${IDS.execution}','direct-write','wrong','{}',repeat('b',64));`,
      /check constraint|violates|scope|receipt/,
    );
    expect(
      psql(
        INCREMENTAL,
        "select has_table_privilege('service_role','public.ai_executions','TRUNCATE')",
      ),
    ).toBe("f");
  });

  it("requires append-only rejection, replay identity, fresh epoch and review revisions", () => {
    const epochBefore = Number(
      psql(
        INCREMENTAL,
        `select authorization_epoch from public.organizations where id='${IDS.org}';`,
      ),
    );
    apply(
      INCREMENTAL,
      `set role service_role; select public.revoke_organization_membership('${IDS.org}','${IDS.reviewer}');`,
    );
    expect(
      psql(
        INCREMENTAL,
        `select status from public.organization_memberships where organization_id='${IDS.org}' and user_id='${IDS.reviewer}';`,
      ),
    ).toBe("revoked");
    const epochAfter = Number(
      psql(
        INCREMENTAL,
        `select authorization_epoch from public.organizations where id='${IDS.org}';`,
      ),
    );
    expect(epochAfter).toBe(epochBefore + 1);
    sqlError(
      INCREMENTAL,
      `set role service_role; update public.ai_review_decisions set comment='changed';`,
      /insert-only|immutable|permission|violates/,
    );
    sqlError(
      INCREMENTAL,
      `set role service_role; delete from public.ai_redline_bundles;`,
      /insert-only|immutable|permission|violates/,
    );
    apply(
      INCREMENTAL,
      `set role service_role; select public.revoke_organization_membership('${IDS.org}','${IDS.reviewer}');`,
    );
    expect(
      Number(
        psql(
          INCREMENTAL,
          `select authorization_epoch from public.organizations where id='${IDS.org}';`,
        ),
      ),
    ).toBe(epochAfter);
  });
});
