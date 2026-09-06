/** Opt-in disposable PostgreSQL probes for the approved-artifact SQL boundary. */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPPORTED_RECOVERY_MIGRATION_ORDER } from "../../lib/recovery/migrationOrder";
import {
  IDS,
  LEGACY_IDS,
  SEED,
  LEGACY_AI_SEED,
} from "./fixtures/recoveryLegacyEvidence";

const BACKEND = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const MIGRATION = "20260905_02_recovery_approved_artifact_storage.sql";
const BASELINE = "d9fa8380e63837b6441cef169cf5ef80dfb55e54";
const RUN = process.env.RUN_RECOVERY_APPROVED_ARTIFACT_RUNTIME === "1";
const CONTAINER = `recovery-approved-artifact-${process.pid}`;
const OWNER = crypto.randomUUID();
const maybe = RUN ? describe : describe.skip;
let container = "";

function read(name: string): string {
  return fs.readFileSync(path.join(BACKEND, name), "utf8");
}
function docker(args: string[], input?: string): string {
  return execFileSync("docker", ["exec", "-i", container, ...args], {
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
      "-h",
      "127.0.0.1",
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
function applyRecovery(db: string, before?: string): void {
  const boundary =
    before === undefined
      ? SUPPORTED_RECOVERY_MIGRATION_ORDER.length
      : SUPPORTED_RECOVERY_MIGRATION_ORDER.findIndex((name) => name === before);
  if (boundary < 0) throw new Error("unknown recovery migration boundary");
  SUPPORTED_RECOVERY_MIGRATION_ORDER.slice(0, boundary).forEach((name) =>
    psql(db, read(`migrations/${name}`)),
  );
}

const BOOTSTRAP = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant all on schema public to service_role;`;

beforeAll(() => {
  if (!RUN) return;
  container = execFileSync(
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
      `recovery.approved.owner=${OWNER}`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw",
      "-e",
      "POSTGRES_PASSWORD=recovery_local_only",
      "postgres:16-alpine",
    ],
    { encoding: "utf8", timeout: 20_000 },
  ).trim();
  const deadline = Date.now() + 60_000;
  let stable = 0;
  while (Date.now() < deadline) {
    try {
      execFileSync(
        "docker",
        ["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
        { encoding: "utf8", timeout: 5_000 },
      );
      stable += 1;
      if (stable === 3) return;
    } catch {
      stable = 0;
    }
  }
  throw new Error("recovery postgres readiness timeout");
});
afterAll(() => {
  if (!RUN || !container) return;
  const inspected = JSON.parse(
    execFileSync("docker", ["inspect", container], {
      encoding: "utf8",
      timeout: 10_000,
    }),
  )[0];
  expect(inspected.Id).toBe(container);
  expect(inspected.Config.Labels["recovery.approved.owner"]).toBe(OWNER);
  execFileSync("docker", ["rm", "-f", container], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(
    execFileSync(
      "docker",
      ["ps", "-a", "--filter", `label=recovery.approved.owner=${OWNER}`, "-q"],
      { encoding: "utf8", timeout: 10_000 },
    ).trim(),
  ).toBe("");
}, 45_000);

describe("approved artifact SQL contract", () => {
  it("keeps the legacy metadata state and exact explicit function in both artifacts", () => {
    const schema = read("schema.sql");
    const migration = read(`migrations/${MIGRATION}`);
    expect(schema).toMatch(/storage_path text,\n  size_bytes integer,/);
    expect(schema).toMatch(/ai_review_exports_storage_metadata_check/);
    expect(migration).toMatch(
      /create or replace function public\.append_ai_review_export/,
    );
    expect(migration).not.toMatch(/pg_get_functiondef|replace\(/);
    expect(migration).toMatch(/size_bytes' !~ '\^\[1-9\]\[0-9\]\*\$'/);
    expect(migration).toMatch(
      /orgs\/%s\/matters\/%s\/projects\/%s\/documents\/%s\/%s\.docx/,
    );
    expect(migration).toMatch(/and storage_path = p_artifact->>'storage_path'/);
    expect(migration).toMatch(
      /and size_bytes = \(p_artifact->>'size_bytes'\)::integer/,
    );
  });
});

maybe("approved artifact SQL runtime", () => {
  it("converges fresh and upgrade paths, preserves legacy rows, and reruns safely", () => {
    docker(["createdb", "-U", "postgres", "recovery_upgrade"]);
    docker(["createdb", "-U", "postgres", "recovery_fresh"]);
    psql("recovery_upgrade", BOOTSTRAP);
    psql("recovery_fresh", BOOTSTRAP);
    psql("recovery_fresh", read("schema.sql"));
    const baseline = execFileSync(
      "git",
      ["show", `${BASELINE}:backend/schema.sql`],
      { cwd: BACKEND, encoding: "utf8" },
    );
    psql("recovery_upgrade", baseline);
    // The supported pre-recovery baseline has no membership status or matter
    // visibility column; the first recovery migration supplies those fields.
    psql(
      "recovery_upgrade",
      SEED.replaceAll("role,status", "role")
        .replaceAll(",'active'", "")
        .replace("project_id,visibility", "project_id")
        .replace(",'private'", "") + LEGACY_AI_SEED,
    );
    applyRecovery("recovery_upgrade", MIGRATION);
    const before = psql(
      "recovery_upgrade",
      "select row_to_json(e)::text from ai_review_exports e;",
    );
    expect(before).toContain(LEGACY_IDS.export);
    psql("recovery_upgrade", read(`migrations/${MIGRATION}`));
    expect(
      psql(
        "recovery_upgrade",
        "select (to_jsonb(e) - 'storage_path' - 'size_bytes')::text from ai_review_exports e;",
      ),
    ).toBe(
      psql(
        "recovery_upgrade",
        `select '${before.replaceAll("'", "''")}'::jsonb::text;`,
      ),
    );
    expect(
      psql(
        "recovery_upgrade",
        "select count(*) from ai_review_exports where storage_path is null and size_bytes is null;",
      ),
    ).toBe("1");
    psql("recovery_upgrade", read(`migrations/${MIGRATION}`));
    // The artifact delta was just checked in isolation; finish the explicit
    // later steps before comparing against the current complete fresh schema.
    const artifactIndex = SUPPORTED_RECOVERY_MIGRATION_ORDER.findIndex(
      (name) => name === MIGRATION,
    );
    SUPPORTED_RECOVERY_MIGRATION_ORDER.slice(artifactIndex + 1).forEach(
      (name) => psql("recovery_upgrade", read(`migrations/${name}`)),
    );
    expect(
      psql("recovery_upgrade", read("scripts/schema-fingerprint.sql")),
    ).toBe(psql("recovery_fresh", read("scripts/schema-fingerprint.sql")));
    expect(
      psql(
        "recovery_fresh",
        "select is_nullable from information_schema.columns where table_name='ai_review_exports' and column_name='storage_path';",
      ),
    ).toBe("YES");
    expect(
      psql(
        "recovery_upgrade",
        "select conname from pg_constraint where conname='ai_review_exports_storage_metadata_check';",
      ),
    ).toBe("ai_review_exports_storage_metadata_check");
    // A second independently upgraded fixture has a review with no existing
    // export; the populated preservation fixture above remains untouched.
    docker(["createdb", "-U", "postgres", "recovery_write"]);
    psql("recovery_write", BOOTSTRAP + baseline);
    const legacyWithoutExport = LEGACY_AI_SEED.replace(
      /insert into public\.ai_review_exports\([\s\S]*?(?=insert into public\.ai_redline_bundles)/,
      "",
    );
    psql(
      "recovery_write",
      SEED.replaceAll("role,status", "role")
        .replaceAll(",'active'", "")
        .replace("project_id,visibility", "project_id")
        .replace(",'private'", "") + legacyWithoutExport,
    );
    applyRecovery("recovery_write");
    const artifact = JSON.parse(
      psql(
        "recovery_write",
        `select jsonb_build_object(
      'idempotency_key','runtime-artifact', 'review_id',id, 'review_revision',revision,
      'execution_id',execution_id, 'organization_id',organization_id,
      'matter_id',matter_id,'project_id',project_id,'document_id',document_id,
      'document_version_id',document_version_id,'source_document_sha256',document_content_sha256,
      'evidence_receipt_sha256',evidence_receipt_sha256,
      'artifact_document_id','${IDS.artifactDocument}', 'artifact_document_version_id','${IDS.artifactVersion}',
      'filename','Informe de revision humana.docx',
      'mime_type','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'artifact_sha256',repeat('f',64), 'size_bytes',12,
      'storage_path','orgs/${IDS.org}/matters/${IDS.matter}/projects/${IDS.project}/documents/${IDS.artifactDocument}/' || repeat('f',64) || '.docx'
    )::text from ai_reviews where id='${LEGACY_IDS.review}';`,
      ),
    );
    const epoch = psql(
      "recovery_write",
      `select authorization_epoch from organizations where id='${IDS.org}';`,
    );
    const invoke = (value: unknown) =>
      psql(
        "recovery_write",
        `set role service_role; select append_ai_review_export('${IDS.reviewer}','${IDS.org}',${epoch},'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb)::text;`,
      );
    const beforeCount = psql(
      "recovery_write",
      "select count(*) from ai_review_exports;",
    );
    for (const change of [
      { storage_path: "foreign/key" },
      { size_bytes: 0 },
      { size_bytes: -1 },
      { size_bytes: 1.5 },
      { size_bytes: null },
      { review_revision: 999 },
    ]) {
      expect(() => invoke({ ...artifact, ...change })).toThrow();
      expect(
        psql("recovery_write", "select count(*) from ai_review_exports;"),
      ).toBe(beforeCount);
    }
    expect(JSON.parse(invoke(artifact)).disposition).toBe("applied");
    expect(JSON.parse(invoke(artifact)).disposition).toBe("replayed");
    expect(
      psql(
        "recovery_write",
        `select storage_path || '|' || size_bytes from document_versions where id='${IDS.artifactVersion}';`,
      ),
    ).toBe(`${artifact.storage_path}|12`);
    expect(() => invoke({ ...artifact, size_bytes: 13 })).toThrow();
    psql(
      "recovery_write",
      `update document_versions set filename='tampered.docx' where id='${IDS.artifactVersion}';`,
    );
    expect(() => invoke(artifact)).toThrow();
    psql(
      "recovery_write",
      `update document_versions set filename='Informe de revision humana.docx' where id='${IDS.artifactVersion}';`,
    );
    expect(() =>
      psql(
        "recovery_write",
        `set role service_role; delete from ai_review_exports where idempotency_key='runtime-artifact';`,
      ),
    ).toThrow();
    expect(() =>
      psql(
        "recovery_write",
        `set role authenticated; select append_ai_review_export('${IDS.reviewer}','${IDS.org}',${epoch},'{}'::jsonb);`,
      ),
    ).toThrow();
  });
});
