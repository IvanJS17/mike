/** Opt-in SQL runtime coverage for the coordinator-owned 5.2 persistence slice. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSupportedUpgradeSql } from "../../lib/recovery/supportedUpgradeDriver";
import {
  BASELINE_LEGACY_SEED,
  IDS,
  LEGACY_AI_SEED,
  LEGACY_IDS,
  SEED,
} from "./fixtures/recoveryLegacyEvidence";

const BACKEND = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const MIGRATIONS = path.join(BACKEND, "migrations");
const BASELINE = "d9fa8380e63837b6441cef169cf5ef80dfb55e54";
const RUN = process.env.RUN_RECOVERY_DRIVE_PUBLICATION_RUNTIME === "1";
const maybe = RUN ? describe : describe.skip;
const IMAGE = "postgres:16-alpine";
const OWNER =
  process.env.RECOVERY_DRIVE_PUBLICATION_OWNER ?? crypto.randomUUID();
if (!/^[0-9a-f-]{36}$/.test(OWNER)) throw new Error("Invalid runtime owner");
const CONTAINER = `recovery-drive-publication-${OWNER}`;
let container = "";

const BOOTSTRAP = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
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

function read(name: string): string {
  return fs.readFileSync(path.join(BACKEND, name), "utf8");
}

function docker(args: string[], input?: string): string {
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    input,
    encoding: "utf8",
    timeout: 30_000,
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

function baselineSchema(): string {
  return execFileSync("git", ["show", `${BASELINE}:backend/schema.sql`], {
    cwd: BACKEND,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function createDatabase(name: string, seed: string): void {
  docker(["createdb", "-U", "postgres", name]);
  psql(name, BOOTSTRAP + baselineSchema() + seed);
  psql(name, buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS }));
}

function sqlJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("'", "''");
}

function approvedArtifact(database: string): Record<string, unknown> {
  return JSON.parse(
    psql(
      database,
      `select jsonb_build_object(
        'idempotency_key','runtime-drive-export',
        'review_id',review.id,
        'review_revision',review.revision,
        'execution_id',review.execution_id,
        'organization_id',review.organization_id,
        'matter_id',review.matter_id,
        'project_id',review.project_id,
        'document_id',review.document_id,
        'document_version_id',review.document_version_id,
        'source_document_sha256',review.document_content_sha256,
        'evidence_receipt_sha256',review.evidence_receipt_sha256,
        'artifact_document_id','${IDS.artifactDocument}',
        'artifact_document_version_id','${IDS.artifactVersion}',
        'filename','Informe de revision humana.docx',
        'mime_type','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'artifact_sha256',repeat('f',64),
        'size_bytes',12,
        'storage_path','orgs/' || review.organization_id || '/matters/' || review.matter_id ||
          '/projects/' || review.project_id || '/documents/${IDS.artifactDocument}/' || repeat('f',64) || '.docx'
      )::text
      from public.ai_reviews review where review.id='${LEGACY_IDS.review}';`,
    ),
  );
}

function appendExport(database: string): void {
  // The old fixture has no project binding; configure the new live operation
  // explicitly after upgrade instead of pretending migration inferred one.
  psql(
    database,
    `update public.matters set project_id='${IDS.project}',
    drive_folder_id='runtime-drive-folder' where id='${IDS.matter}';`,
  );
  const artifact = approvedArtifact(database);
  const epoch = psql(
    database,
    `select authorization_epoch from public.organizations where id='${IDS.org}';`,
  );
  psql(
    database,
    `set role service_role;
     select public.append_ai_review_export('${IDS.reviewer}','${IDS.org}',${epoch},'${sqlJson(artifact)}'::jsonb);`,
  );
  psql(
    database,
    `update public.matters set drive_folder_id='runtime-drive-folder' where id='${IDS.matter}';`,
  );
}

const execAsync = promisify(execFile);
async function callAsync(
  database: string,
  sql: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await execAsync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `set role service_role; select ${sql}::text;`,
    ],
    { timeout: 30_000, maxBuffer: 1_048_576 },
  );
  return JSON.parse(stdout.trim());
}

function call(database: string, sql: string): Record<string, unknown> {
  return JSON.parse(
    psql(database, `set role service_role; select ${sql}::text;`),
  );
}

beforeAll(() => {
  if (!RUN) return;
  container = execFileSync(
    "docker",
    [
      "run",
      "--pull=never",
      "-d",
      "--network=none",
      "--name",
      CONTAINER,
      "--memory=512m",
      "--cpus=1",
      "--pids-limit=128",
      "--label",
      `recovery.drive.publication.owner=${OWNER}`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
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
        ["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
        {
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      stable += 1;
      if (stable === 3) break;
    } catch {
      stable = 0;
    }
  }
  if (stable !== 3)
    throw new Error("recovery Drive publication postgres readiness timeout");
}, 90_000);

afterAll(() => {
  if (!RUN) return;
  const run = (args: string[]) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 90_000,
    }).trim();
  const inventory = () =>
    run([
      "ps",
      "-aq",
      "--filter",
      `label=recovery.drive.publication.owner=${OWNER}`,
    ]);
  const ids = inventory().split(/\s+/).filter(Boolean);
  const errors: unknown[] = [];
  for (const id of ids) {
    try {
      const inspected = JSON.parse(run(["inspect", id]))[0];
      expect(inspected.Config.Labels["recovery.drive.publication.owner"]).toBe(
        OWNER,
      );
      expect(inspected.Name).toBe(`/${CONTAINER}`);
      expect(
        inspected.Mounts.filter(
          (mount: { Type: string }) => mount.Type === "volume",
        ),
      ).toHaveLength(0);
      run(["rm", "-f", inspected.Id]);
    } catch (error) {
      errors.push(error);
    }
  }
  expect(inventory()).toBe("");
  expect(errors).toHaveLength(0);
}, 120_000);

describe("Drive publication RPC SQL contract", () => {
  it("pins the canonical lifecycle RPCs and does not expose direct table DML", () => {
    const migration = read(
      "migrations/20260905_05_recovery_drive_publication_rpc.sql",
    );
    expect(migration).toMatch(/begin_ai_review_drive_publication/);
    expect(migration).toMatch(/record_ai_review_drive_publication_outcome/);
    expect(migration).toMatch(/read_ai_review_drive_publication/);
    expect(migration).toMatch(/unknown_outcome/);
    expect(migration).toMatch(/attempts integer not null default 0/);
    expect(migration).toMatch(
      /revoke all on public\.ai_review_drive_publications from anon, authenticated, service_role/,
    );
  });
});

maybe("Matter Drive folder settings RPC runtime", () => {
  it("sets, clears, replays, and rejects unauthorized or stale matter folder changes without changing publication evidence", () => {
    const database = "recovery_drive_folder_settings";
    const withoutExport = LEGACY_AI_SEED.replace(
      /insert into public\.ai_review_exports\([\s\S]*?(?=insert into public\.ai_redline_bundles)/,
      "",
    );
    createDatabase(database, BASELINE_LEGACY_SEED + withoutExport);
    appendExport(database);

    const epoch = psql(
      database,
      `select authorization_epoch from public.organizations where id='${IDS.org}';`,
    );
    const reviewRevision = psql(
      database,
      `select revision from public.ai_reviews where id='${LEGACY_IDS.review}';`,
    );
    const publication = call(
      database,
      `public.begin_ai_review_drive_publication((select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),${reviewRevision},'${IDS.reviewer}','${IDS.org}',${epoch})`,
    );
    expect(publication.disposition).toBe("claimed");
    const publicationSnapshot = psql(
      database,
      "select to_jsonb(p)::text from public.ai_review_drive_publications p order by id;",
    );
    const update = (
      actor: string,
      organization: string,
      value: string | null,
      project = IDS.project,
      authorizationEpoch = epoch,
    ) =>
      call(
        database,
        `public.update_matter_drive_folder('${IDS.matter}','${project}',${value === null ? "null" : `'${value}'`},'${actor}','${organization}',${authorizationEpoch})`,
      );

    expect(update(IDS.owner, IDS.org, "x".repeat(256)).drive_folder_id).toBe(
      "x".repeat(256),
    );
    for (const invalid of ["x".repeat(257), "", "bad/id", "bad folder"]) {
      expect(() => update(IDS.owner, IDS.org, invalid)).toThrow();
    }
    expect(update(IDS.owner, IDS.org, "folder-owner").drive_folder_id).toBe(
      "folder-owner",
    );
    expect(update(IDS.owner, IDS.org, "folder-owner").drive_folder_id).toBe(
      "folder-owner",
    );
    expect(update(IDS.owner, IDS.org, null).drive_folder_id).toBeNull();
    expect(
      psql(
        database,
        `select drive_folder_id from public.matters where id='${IDS.matter}';`,
      ),
    ).toBe("");
    expect(() =>
      update(IDS.reviewer, IDS.org, "editor-cannot-write"),
    ).toThrow();
    expect(() =>
      update(IDS.outsider, IDS.org, "outsider-cannot-write"),
    ).toThrow();
    expect(() =>
      update(
        IDS.owner,
        IDS.org,
        "scope-mismatch",
        "eeeeeeee-0000-0000-0000-000000000099",
      ),
    ).toThrow();

    psql(
      database,
      `update public.organizations set authorization_epoch=authorization_epoch+1 where id='${IDS.org}';`,
    );
    expect(() =>
      update(IDS.owner, IDS.org, "stale", IDS.project, epoch),
    ).toThrow();
    psql(
      database,
      `update public.matter_memberships set status='revoked' where matter_id='${IDS.matter}' and user_id='${IDS.owner}';`,
    );
    const revokedEpoch = psql(
      database,
      `select authorization_epoch from public.organizations where id='${IDS.org}';`,
    );
    expect(() =>
      update(IDS.owner, IDS.org, "revoked", IDS.project, revokedEpoch),
    ).toThrow();
    expect(
      psql(
        database,
        `select has_function_privilege('service_role','public.update_matter_drive_folder(uuid,uuid,text,uuid,uuid,bigint)','execute'), has_function_privilege('anon','public.update_matter_drive_folder(uuid,uuid,text,uuid,uuid,bigint)','execute'), has_function_privilege('authenticated','public.update_matter_drive_folder(uuid,uuid,text,uuid,uuid,bigint)','execute');`,
      ),
    ).toBe("t|f|f");
    expect(
      psql(
        database,
        "select to_jsonb(p)::text from public.ai_review_drive_publications p order by id;",
      ),
    ).toBe(publicationSnapshot);
  }, 180_000);
});

maybe("Drive publication RPC SQL runtime", () => {
  it("converges fresh and upgrade schemas and proves claim, unknown, replay, CAS, and permissions", async () => {
    const fresh = "recovery_drive_rpc_fresh";
    const success = "recovery_drive_rpc_success";
    const retry = "recovery_drive_rpc_retry";
    const reconcile = "recovery_drive_rpc_reconcile";
    docker(["createdb", "-U", "postgres", fresh]);
    psql(fresh, BOOTSTRAP + read("schema.sql"));

    const withoutExport = LEGACY_AI_SEED.replace(
      /insert into public\.ai_review_exports\([\s\S]*?(?=insert into public\.ai_redline_bundles)/,
      "",
    );
    createDatabase(success, BASELINE_LEGACY_SEED + withoutExport);
    createDatabase(retry, BASELINE_LEGACY_SEED + withoutExport);
    createDatabase(reconcile, BASELINE_LEGACY_SEED + withoutExport);
    expect(psql(success, read("scripts/schema-fingerprint.sql"))).toBe(
      psql(fresh, read("scripts/schema-fingerprint.sql")),
    );

    for (const database of [success, retry, reconcile]) appendExport(database);

    const epoch = psql(
      success,
      `select authorization_epoch from public.organizations where id='${IDS.org}';`,
    );
    const reviewRevision = psql(
      success,
      `select revision from public.ai_reviews where id='${LEGACY_IDS.review}';`,
    );
    expect(() =>
      psql(
        success,
        `begin;
      update public.documents set project_id=null where id='${IDS.document}';
      set role service_role;
      select public.begin_ai_review_drive_publication(
        (select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),
        ${reviewRevision},'${IDS.reviewer}','${IDS.org}',${epoch});
      rollback;`,
      ),
    ).toThrow(/authority is invalid/);
    const claimSql = `public.begin_ai_review_drive_publication((select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),${reviewRevision},'${IDS.reviewer}','${IDS.org}',${epoch})`;
    const settled = await Promise.allSettled([
      callAsync(success, claimSql),
      callAsync(success, claimSql),
    ]);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const claims = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(claims.map((result) => result.disposition).sort()).toEqual([
      "claimed",
      "unknown",
    ]);
    const first = claims.find((result) => result.disposition === "claimed")!;
    expect(first.disposition).toBe("claimed");
    expect(first.outcome).toBe("unknown_outcome");
    expect(first.attempts).toBe(1);
    const second = call(
      success,
      `public.begin_ai_review_drive_publication((select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),${reviewRevision},'${IDS.reviewer}','${IDS.org}',${epoch})`,
    );
    expect(second.disposition).toBe("unknown");
    expect(second.attempts).toBe(1);

    for (const [size, checksum] of [
      [13, "f".repeat(64)],
      [12, "0".repeat(64)],
    ]) {
      expect(() =>
        psql(
          success,
          `begin; set role service_role;
        select public.record_ai_review_drive_publication_outcome(
          '${first.publication_id}',1,'${IDS.reviewer}','${IDS.org}',${epoch},
          'uploaded','runtime-file',${size},'${checksum}',null); rollback;`,
        ),
      ).toThrow(/remote metadata is invalid/);
    }
    const uploaded = call(
      success,
      `public.record_ai_review_drive_publication_outcome('${first.publication_id}',1,'${IDS.reviewer}','${IDS.org}',${epoch},'uploaded','runtime-file',12,repeat('f',64),null)`,
    );
    expect(uploaded.disposition).toBe("applied");
    expect(uploaded.outcome).toBe("uploaded");
    const replay = call(
      success,
      `public.record_ai_review_drive_publication_outcome('${first.publication_id}',1,'${IDS.reviewer}','${IDS.org}',${epoch},'uploaded','runtime-file',12,repeat('f',64),null)`,
    );
    expect(replay.disposition).toBe("replayed");
    const stale = call(
      success,
      `public.record_ai_review_drive_publication_outcome('${first.publication_id}',1,'${IDS.reviewer}','${IDS.org}',${epoch},'uploaded','other-file',12,repeat('f',64),null)`,
    );
    expect(stale.disposition).toBe("conflict");
    expect(() =>
      call(
        success,
        `public.begin_ai_review_drive_publication((select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),${reviewRevision},'${IDS.outsider}','${IDS.org}',${epoch})`,
      ),
    ).toThrow();
    expect(
      call(
        success,
        `public.read_ai_review_drive_publication('${first.publication_id}','${IDS.reviewer}','${IDS.org}',${epoch})`,
      ).outcome,
    ).toBe("uploaded");

    const retryFirst = call(
      retry,
      `public.begin_ai_review_drive_publication((select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),${reviewRevision},'${IDS.reviewer}','${IDS.org}',${epoch})`,
    );
    const failed = call(
      retry,
      `public.record_ai_review_drive_publication_outcome('${retryFirst.publication_id}',1,'${IDS.reviewer}','${IDS.org}',${epoch},'failed',null,null,null,'drive_upload_failed')`,
    );
    expect(failed.outcome).toBe("failed");
    const retryClaim = call(
      retry,
      `public.begin_ai_review_drive_publication((select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),${reviewRevision},'${IDS.reviewer}','${IDS.org}',${epoch})`,
    );
    expect(retryClaim.disposition).toBe("claimed");
    expect(retryClaim.attempts).toBe(2);
    expect(
      call(
        retry,
        `public.record_ai_review_drive_publication_outcome('${retryFirst.publication_id}',1,'${IDS.reviewer}','${IDS.org}',${epoch},'failed',null,null,null,'drive_upload_failed')`,
      ).disposition,
    ).toBe("conflict");
    expect(
      call(
        retry,
        `public.record_ai_review_drive_publication_outcome('${retryFirst.publication_id}',3,'${IDS.reviewer}','${IDS.org}',${epoch},'failed',null,null,null,'drive_upload_failed')`,
      ).outcome,
    ).toBe("failed");
    const thirdClaim = call(
      retry,
      `public.begin_ai_review_drive_publication((select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),${reviewRevision},'${IDS.reviewer}','${IDS.org}',${epoch})`,
    );
    expect(thirdClaim.disposition).toBe("claimed");
    expect(thirdClaim.attempts).toBe(3);
    expect(
      call(
        retry,
        `public.record_ai_review_drive_publication_outcome('${retryFirst.publication_id}',5,'${IDS.reviewer}','${IDS.org}',${epoch},'failed',null,null,null,'drive_upload_failed')`,
      ).outcome,
    ).toBe("failed");
    expect(
      call(
        retry,
        `public.begin_ai_review_drive_publication((select id from public.ai_review_exports where idempotency_key='runtime-drive-export'),${reviewRevision},'${IDS.reviewer}','${IDS.org}',${epoch})`,
      ).disposition,
    ).toBe("conflict");
    const reconciliationClaim = call(reconcile, claimSql);
    const reconciled = call(
      reconcile,
      `public.record_ai_review_drive_publication_outcome('${reconciliationClaim.publication_id}',1,'${IDS.reviewer}','${IDS.org}',${epoch},'reconciled','reconciled-file',12,repeat('f',64),null)`,
    );
    expect(reconciled.outcome).toBe("reconciled");
    expect(
      call(
        reconcile,
        `public.read_ai_review_drive_publication('${reconciliationClaim.publication_id}','${IDS.reviewer}','${IDS.org}',${epoch})`,
      ).outcome,
    ).toBe("reconciled");
    const publicationSnapshot = psql(
      reconcile,
      "select to_jsonb(p)::text from public.ai_review_drive_publications p order by id;",
    );
    const auditSnapshot = psql(
      reconcile,
      "select to_jsonb(a)::text from public.audit_events a order by id;",
    );
    psql(reconcile, buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS }));
    expect(
      psql(
        reconcile,
        "select to_jsonb(p)::text from public.ai_review_drive_publications p order by id;",
      ),
    ).toBe(publicationSnapshot);
    expect(
      psql(
        reconcile,
        "select to_jsonb(a)::text from public.audit_events a order by id;",
      ),
    ).toBe(auditSnapshot);
    expect(() =>
      psql(
        reconcile,
        "set role service_role; update public.ai_review_drive_publications set status='uploaded';",
      ),
    ).toThrow(/permission denied/);
    psql(
      success,
      `update public.organization_memberships set status='revoked' where organization_id='${IDS.org}' and user_id='${IDS.reviewer}';`,
    );
    expect(() =>
      call(
        success,
        `public.read_ai_review_drive_publication('${first.publication_id}','${IDS.reviewer}','${IDS.org}',${epoch})`,
      ),
    ).toThrow();
    const revokedEpoch = psql(
      success,
      `select authorization_epoch from public.organizations where id='${IDS.org}';`,
    );
    expect(() =>
      call(
        success,
        `public.read_ai_review_drive_publication('${first.publication_id}','${IDS.reviewer}','${IDS.org}',${revokedEpoch})`,
      ),
    ).toThrow();
    expect(
      psql(
        retry,
        `select has_table_privilege('service_role','public.ai_review_drive_publications','update') = false and has_table_privilege('authenticated','public.ai_review_drive_publications','update') = false;`,
      ),
    ).toBe("t");
  }, 180_000);
});
