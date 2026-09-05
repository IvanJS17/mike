/**
 * Opt-in whole-schema recovery gate. Docker is never started unless the
 * caller explicitly opts in. The container is network-isolated, tmpfs-backed,
 * portless, labelled, and every child process has a finite deadline.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BACKEND = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const MIGRATIONS = path.join(BACKEND, "migrations");
const BASELINE = "d9fa8380e63837b6441cef169cf5ef80dfb55e54";
const CORE = "20260905_01_recovery_core_convergence.sql";
const RUN = process.env.RUN_RECOVERY_CORE_CONVERGENCE_RUNTIME === "1";
const maybe = RUN ? describe : describe.skip;
const IMAGE = "postgres:16-alpine";
const CONTAINER = `recovery-core-${process.pid}`;
const OWNER = crypto.randomUUID();
let containerId = "";

const BOOTSTRAP = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
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

function docker(args: string[], input?: string): string {
  return execFileSync("docker", ["exec", "-i", containerId, ...args], {
    input,
    encoding: "utf8",
    timeout: 20_000,
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
function file(name: string): string {
  return fs.readFileSync(path.join(BACKEND, name), "utf8");
}
function fingerprint(db: string): string {
  return psql(db, file("scripts/schema-fingerprint.sql"));
}
function applyRecovery(db: string, before?: string): void {
  const names = fs
    .readdirSync(MIGRATIONS)
    .filter((name) => /^\d{8}_\d{2}_recovery_.*\.sql$/.test(name))
    .filter((name) => !before || name < before)
    .sort();
  for (const name of names)
    psql(db, fs.readFileSync(path.join(MIGRATIONS, name), "utf8"));
}
function preservedData(db: string): unknown {
  return JSON.parse(
    psql(
      db,
      `select json_build_object(
    'audit', (select json_agg(row(id,actor_user_id,organization_id,event_type,event_detail,created_at)) from audit_events),
    'grants', (select json_agg(g) from document_download_grants g),
    'keys', (select json_agg(k) from user_api_keys k),
    'workflow', (select json_agg(row(id,title,type,user_id,prompt_md)) from workflows),
    'chat', (select json_agg(row(id,project_id,user_id,model_provider,model,credential_ref)) from chats),
    'pages', (select json_agg(row(id,document_id,document_version_id,page,content,content_sha256)) from ai_document_version_pages),
    'profiles', (select json_agg(row(user_id,mfa_on_login)) from user_profiles)
  )::text;`,
    ),
  );
}

function seed(db: string): void {
  psql(
    db,
    `
insert into auth.users(id,email) values
 ('11111111-0000-0000-0000-000000000001','owner@recovery.test'),
 ('11111111-0000-0000-0000-000000000002','reviewer@recovery.test');
insert into public.user_profiles(user_id,email) values
 ('11111111-0000-0000-0000-000000000001','owner@recovery.test'),
 ('11111111-0000-0000-0000-000000000002','reviewer@recovery.test') on conflict (user_id) do nothing;
insert into public.organizations(id,name,created_by) values
 ('aaaaaaaa-0000-0000-0000-000000000001','Recovery Org','11111111-0000-0000-0000-000000000001');
insert into public.organization_memberships(organization_id,user_id,role) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','org_owner'),
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000002','editor');
insert into public.workspaces(id,organization_id,name,created_by) values
 ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Recovery Workspace','11111111-0000-0000-0000-000000000001');
insert into public.matters(id,workspace_id,name,created_by) values
 ('cccccccc-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','Recovery Matter','11111111-0000-0000-0000-000000000001');
insert into public.user_api_keys(user_id,provider,encrypted_key,iv,auth_tag,credential_ref) values
 ('11111111-0000-0000-0000-000000000001','gemini','synthetic-ciphertext','synthetic-iv','synthetic-tag','trigger-assigned');
insert into public.projects(id,user_id,name) values
 ('dddddddd-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Recovery Project');
insert into public.documents(id,project_id,user_id,status) values
 ('eeeeeeee-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','completed');
insert into public.document_versions(id,document_id,content_sha256) values
 ('ffffffff-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',repeat('a',64));
insert into public.chats(id,project_id,user_id,model_provider,model,credential_ref,title)
 values ('88888888-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','openai','gpt-test','openai:v1','Pinned route');
insert into public.document_download_grants(id,document_id,document_version_id,issued_to_user,token_hash,storage_path,filename,expires_at)
 values ('99999999-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001','ffffffff-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',repeat('b',64),'projects/p/file','file.docx',now()+interval '1 hour');
insert into public.audit_events(actor_user_id,organization_id,event_type,event_detail)
 values ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','recovery.seed','{"evidence":true}');
insert into public.ai_document_version_pages(document_id,document_version_id,page,content,content_sha256)
 values ('eeeeeeee-0000-0000-0000-000000000001','ffffffff-0000-0000-0000-000000000001',1,'Evidence page',encode(digest('Evidence page','sha256'),'hex'));
insert into public.workflows(id,title,type,user_id) values
 ('aaaaaaaa-0000-0000-0000-000000000010','Legacy workflow','assistant','11111111-0000-0000-0000-000000000001');
`,
  );
}

beforeAll(() => {
  if (!RUN) return;
  containerId = execFileSync(
    "docker",
    [
      "run",
      "--pull=never",
      "--rm",
      "-d",
      "--network=none",
      "--name",
      CONTAINER,
      "--memory=512m",
      "--cpus=1",
      "--pids-limit=128",
      "--label",
      `recovery.core.owner=${OWNER}`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw",
      "-e",
      "POSTGRES_PASSWORD=recovery_local_only",
      IMAGE,
    ],
    { encoding: "utf8", timeout: 20_000 },
  ).trim();
  const deadline = Date.now() + 60_000;
  let stable = 0;
  while (Date.now() < deadline) {
    try {
      execFileSync(
        "docker",
        ["exec", CONTAINER, "pg_isready", "-U", "postgres"],
        {
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      stable += 1;
      if (stable === 3) return;
    } catch {
      stable = 0; /* bounded readiness loop */
    }
  }
  throw new Error("recovery postgres readiness timeout");
});

afterAll(() => {
  if (!RUN) return;
  try {
    const inspected = JSON.parse(
      execFileSync("docker", ["inspect", CONTAINER], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    )[0];
    if (
      inspected.Id !== containerId ||
      inspected.Config.Labels["recovery.core.owner"] !== OWNER
    )
      throw new Error("refusing foreign container cleanup");
    execFileSync("docker", ["rm", "-f", CONTAINER], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } finally {
    const leftovers = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `label=recovery.core.owner=${OWNER}`],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
    expect(leftovers).toBe("");
  }
});

maybe("recovery core convergence runtime", () => {
  it("proves a populated supported upgrade equals fresh and preserves guards", () => {
    docker(["createdb", "-U", "postgres", "recovery_upgrade"]);
    docker(["createdb", "-U", "postgres", "recovery_fresh"]);
    psql("recovery_upgrade", BOOTSTRAP);
    psql("recovery_fresh", BOOTSTRAP);
    psql("recovery_fresh", file("schema.sql"));
    psql(
      "recovery_upgrade",
      execFileSync("git", ["show", `${BASELINE}:backend/schema.sql`], {
        cwd: BACKEND,
        encoding: "utf8",
      }),
    );
    seed("recovery_upgrade");
    const beforeData = preservedData("recovery_upgrade");
    applyRecovery("recovery_upgrade");
    const migration = file(`migrations/${CORE}`);
    expect(preservedData("recovery_upgrade")).toEqual(beforeData);
    const upgradeFingerprint = fingerprint("recovery_upgrade");
    const freshFingerprint = fingerprint("recovery_fresh");
    console.info("Full schema fingerprints", {
      fresh: crypto.createHash("sha256").update(freshFingerprint).digest("hex"),
      upgrade: crypto
        .createHash("sha256")
        .update(upgradeFingerprint)
        .digest("hex"),
    });
    expect(upgradeFingerprint).toBe(freshFingerprint);
    psql("recovery_upgrade", migration);
    expect(fingerprint("recovery_upgrade")).toBe(upgradeFingerprint);
    expect(preservedData("recovery_upgrade")).toEqual(beforeData);
    psql(
      "recovery_upgrade",
      `set role service_role;
      insert into audit_events(actor_user_id,event_type,event_detail,status)
      values ('11111111-0000-0000-0000-000000000001','document.generated','{}','completed');
      reset role;`,
    );
    const before = psql(
      "recovery_upgrade",
      "select count(*) from audit_events;",
    );
    expect(() =>
      psql("recovery_upgrade", "delete from audit_events;"),
    ).toThrow();
    expect(psql("recovery_upgrade", "select count(*) from audit_events;")).toBe(
      before,
    );
    expect(
      psql(
        "recovery_upgrade",
        "select count(*) from document_download_grants;",
      ),
    ).toBe("1");
    expect(psql("recovery_upgrade", "select count(*) from workflows;")).toBe(
      "1",
    );
    expect(
      psql(
        "recovery_upgrade",
        "select count(*) from ai_document_version_pages;",
      ),
    ).toBe("1");
    expect(() =>
      psql("recovery_upgrade", "delete from ai_document_version_pages;"),
    ).toThrow();
    expect(
      psql(
        "recovery_upgrade",
        "select count(*) from chats where credential_ref='openai:v1';",
      ),
    ).toBe("1");
    expect(
      psql(
        "recovery_upgrade",
        "select count(*) from pg_class where relname like 'courtlistener_%';",
      ),
    ).toBe("0");
    expect(
      psql(
        "recovery_upgrade",
        "select relrowsecurity from pg_class where oid='public.projects'::regclass;",
      ),
    ).toBe("t");
    expect(() =>
      psql(
        "recovery_upgrade",
        "set role authenticated; insert into public.projects(user_id,name) values ('11111111-0000-0000-0000-000000000002','denied');",
      ),
    ).toThrow();
  }, 120_000);

  it("fails closed on a malformed legacy identity without losing its value", () => {
    docker(["createdb", "-U", "postgres", "recovery_invalid"]);
    psql("recovery_invalid", BOOTSTRAP);
    psql(
      "recovery_invalid",
      execFileSync("git", ["show", `${BASELINE}:backend/schema.sql`], {
        cwd: BACKEND,
        encoding: "utf8",
      }),
    );
    seed("recovery_invalid");
    applyRecovery("recovery_invalid", CORE);
    psql(
      "recovery_invalid",
      "update documents set user_id='invalid-legacy-owner';",
    );
    const before = fingerprint("recovery_invalid");
    expect(() => psql("recovery_invalid", file(`migrations/${CORE}`))).toThrow(
      /invalid input syntax for type uuid/,
    );
    expect(fingerprint("recovery_invalid")).toBe(before);
    expect(psql("recovery_invalid", "select user_id from documents;")).toBe(
      "invalid-legacy-owner",
    );
  }, 120_000);
});

it("defines an atomic, non-erasing convergence migration", () => {
  const sql = file(`migrations/${CORE}`);
  expect(sql).toMatch(/^begin;/m);
  expect(sql.trim()).toMatch(/commit;$/);
  expect(sql).not.toMatch(/drop\s+table|truncate\s+/i);
});
