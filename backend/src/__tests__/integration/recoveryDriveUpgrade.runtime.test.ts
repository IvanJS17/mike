/**
 * Bounded Slice 5.2a proof. Docker is opt-in and the only database writer is
 * the one psql process that receives the emitted supported-upgrade SQL.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
const E2A = fs.readFileSync(
  path.join(MIGRATIONS, "20260904_01_recovery_ai_evidence_review.sql"),
  "utf8",
);
const IMAGE = "postgres:16-alpine";
const RUN = process.env.RUN_RECOVERY_DRIVE_UPGRADE_RUNTIME === "1";
const maybe = RUN ? describe : describe.skip;
const OWNER = crypto.randomUUID();
const CONTAINER = `recovery-drive-upgrade-${process.pid}`;
const SOURCE = "recovery_drive_seed";
const UPGRADE = "recovery_drive_upgrade";
const DIRECT = "recovery_drive_direct_e2a";
const FORCED = "recovery_drive_forced_failure";
const EMPTY = "recovery_drive_empty";
const FRESH = "recovery_drive_fresh";
let containerId = "";

function docker(args: string[], input?: string): string {
  return execFileSync("docker", ["exec", "-i", CONTAINER, ...args], {
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

function file(name: string): string {
  return fs.readFileSync(path.join(BACKEND, name), "utf8");
}

function baselineSchema(): string {
  return execFileSync("git", ["show", `${BASELINE}:backend/schema.sql`], {
    cwd: BACKEND,
    encoding: "utf8",
  });
}

function apply(database: string, sql: string): void {
  psql(database, sql);
}

function jsonRows(database: string): string {
  return psql(
    database,
    "select coalesce(jsonb_agg(to_jsonb(publication_row) order by publication_row.id), '[]'::jsonb) from public.ai_review_drive_publications publication_row;",
  );
}

function legacyPayloadRows(database: string): string {
  return psql(
    database,
    "select coalesce(jsonb_agg(legacy_payload order by id), '[]'::jsonb) from public.ai_review_drive_publications;",
  );
}

function publicationOid(database: string): string {
  return psql(
    database,
    "select oid::text from pg_class where oid='public.ai_review_drive_publications'::regclass;",
  );
}

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

const EXTRA_LEGACY_ROWS = `
set session_replication_role = replica;
insert into public.documents(id,project_id,user_id,status) values
 ('eeeeeeee-0000-0000-0000-000000000010','${IDS.project}','${IDS.owner}','completed'),
 ('eeeeeeee-0000-0000-0000-000000000011','${IDS.project}','${IDS.owner}','completed');
insert into public.document_versions(id,document_id,content_sha256,created_at) values
 ('ffffffff-0000-0000-0000-000000000010','eeeeeeee-0000-0000-0000-000000000010',repeat('1',64),now()),
 ('ffffffff-0000-0000-0000-000000000011','eeeeeeee-0000-0000-0000-000000000011',repeat('2',64),now());
insert into public.ai_executions(
  id,user_id,matter_id,project_id,workflow_id,workflow_version,playbook_sha256,
  document_id,document_version_id,document_content_sha256,input_sha256,
  route_provider,route_model,credential_ref,status
) values
 ('aaaaaaaa-0000-0000-0000-000000000012','${IDS.owner}','${IDS.matter}','${IDS.project}',
  'legacy-workflow-2','1.0.0',repeat('5',64),'${IDS.document}','${IDS.version}',repeat('a',64),repeat('a',64),
  'openai','legacy-model','legacy-credential','succeeded'),
 ('aaaaaaaa-0000-0000-0000-000000000013','${IDS.owner}','${IDS.matter}','${IDS.project}',
  'legacy-workflow-3','1.0.0',repeat('6',64),'${IDS.document}','${IDS.version}',repeat('a',64),repeat('a',64),
  'openai','legacy-model','legacy-credential','succeeded');
insert into public.ai_receipts(
  id,execution_id,receipt_version,canonical_json,receipt_sha256
) values
 ('aaaaaaaa-0000-0000-0000-000000000014','aaaaaaaa-0000-0000-0000-000000000012','beta-0.1','{"legacy":true}'::jsonb,repeat('7',64)),
 ('aaaaaaaa-0000-0000-0000-000000000015','aaaaaaaa-0000-0000-0000-000000000013','beta-0.1','{"legacy":true}'::jsonb,repeat('8',64));
insert into public.ai_reviews(
  id,execution_id,matter_id,project_id,reviewer_user_id,status
) values
 ('bbbbbbbb-0000-0000-0000-000000000012','aaaaaaaa-0000-0000-0000-000000000012','${IDS.matter}','${IDS.project}','${IDS.reviewer}','approved'),
 ('bbbbbbbb-0000-0000-0000-000000000013','aaaaaaaa-0000-0000-0000-000000000013','${IDS.matter}','${IDS.project}','${IDS.reviewer}','approved');
insert into public.ai_review_exports(
  id,review_id,execution_id,matter_id,project_id,source_document_version_id,
  document_id,document_version_id,report_version,filename,content_sha256,actor_user_id
) values
 ('bbbbbbbb-0000-0000-0000-000000000010','bbbbbbbb-0000-0000-0000-000000000012','aaaaaaaa-0000-0000-0000-000000000012','${IDS.matter}','${IDS.project}',
  'ffffffff-0000-0000-0000-000000000010','eeeeeeee-0000-0000-0000-000000000010','ffffffff-0000-0000-0000-000000000010',1,
  'Informe de revision humana.docx',repeat('3',64),'${IDS.reviewer}'),
 ('bbbbbbbb-0000-0000-0000-000000000011','bbbbbbbb-0000-0000-0000-000000000013','aaaaaaaa-0000-0000-0000-000000000013','${IDS.matter}','${IDS.project}',
  'ffffffff-0000-0000-0000-000000000011','eeeeeeee-0000-0000-0000-000000000011','ffffffff-0000-0000-0000-000000000011',1,
  'Informe de revision humana.docx',repeat('4',64),'${IDS.reviewer}');
insert into public.ai_review_drive_publications(
  id,export_id,review_id,execution_id,matter_id,project_id,organization_id,
  authorization_epoch,drive_folder_id,file_id,sha256,format_version,status,
  size_bytes,checksum,failure_code,actor_user_id,created_at,updated_at
) values
 ('bbbbbbbb-0000-0000-0000-000000000020','${LEGACY_IDS.export}','${LEGACY_IDS.review}','${LEGACY_IDS.execution}','${IDS.matter}','${IDS.project}','${IDS.org}',
  0,'legacy-folder-published','legacy-file',repeat('f',64),'beta-0.1','published',321,'legacy-checksum',null,'${IDS.reviewer}',
  '2026-01-01 00:00:00+00','2026-01-01 00:00:01+00'),
 ('bbbbbbbb-0000-0000-0000-000000000021','bbbbbbbb-0000-0000-0000-000000000010','bbbbbbbb-0000-0000-0000-000000000012','aaaaaaaa-0000-0000-0000-000000000012','${IDS.matter}','${IDS.project}','${IDS.org}',
  0,'legacy-folder-pending',null,repeat('a',64),'beta-0.1','pending',null,null,null,'${IDS.reviewer}',
  '2026-01-02 00:00:00+00','2026-01-02 00:00:01+00'),
 ('bbbbbbbb-0000-0000-0000-000000000022','bbbbbbbb-0000-0000-0000-000000000011','bbbbbbbb-0000-0000-0000-000000000013','aaaaaaaa-0000-0000-0000-000000000013','${IDS.matter}','${IDS.project}','${IDS.org}',
  0,'legacy-folder-failed',null,repeat('b',64),'beta-0.1','failed',null,null,'drive_upload_failed','${IDS.reviewer}',
  '2026-01-03 00:00:00+00','2026-01-03 00:00:01+00');
set session_replication_role = origin;
`;

// Reuse the approved shared fixture while projecting only the columns that
// existed in the pinned d9fa baseline. The recovery series adds membership
// status and the matter project/visibility fields later.

beforeAll(() => {
  if (!RUN) return;
  containerId = execFileSync(
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
      `recovery.drive.owner=${OWNER}`,
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
    throw new Error("recovery Drive upgrade postgres readiness timeout");

  docker(["createdb", "-U", "postgres", SOURCE]);
  apply(SOURCE, BOOTSTRAP + baselineSchema());
  apply(SOURCE, BASELINE_LEGACY_SEED + LEGACY_AI_SEED + EXTRA_LEGACY_ROWS);
  for (const database of [UPGRADE, DIRECT, FORCED])
    docker(["createdb", "-U", "postgres", "-T", SOURCE, database]);
  docker(["createdb", "-U", "postgres", EMPTY]);
  apply(EMPTY, BOOTSTRAP + baselineSchema());
  docker(["createdb", "-U", "postgres", FRESH]);
  apply(FRESH, BOOTSTRAP + file("schema.sql"));
});

afterAll(async () => {
  if (!RUN || !containerId) return;
  try {
    const inspected = JSON.parse(
      execFileSync("docker", ["inspect", CONTAINER], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    )[0];
    if (
      inspected.Id !== containerId ||
      inspected.Config.Labels["recovery.drive.owner"] !== OWNER
    ) {
      throw new Error("refusing foreign recovery Drive container cleanup");
    }
    execFileSync("docker", ["rm", "-f", CONTAINER], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } finally {
    // Docker removal and its list index can settle separately. Read the exact
    // owner until absent, within a strict bound; never skip the residual gate.
    await vi.waitFor(
      () => {
        expect(
          execFileSync(
            "docker",
            ["ps", "-aq", "--filter", `label=recovery.drive.owner=${OWNER}`],
            { encoding: "utf8", timeout: 5_000 },
          ).trim(),
        ).toBe("");
      },
      { timeout: 10_000, interval: 200 },
    );
  }
}, 60_000);

it("has the bounded supported-upgrade sources", () => {
  expect(
    fs.existsSync(
      path.join(
        MIGRATIONS,
        "20260905_03_recovery_drive_publication_preflight.sql",
      ),
    ),
  ).toBe(true);
  expect(
    fs.existsSync(
      path.join(MIGRATIONS, "20260905_04_recovery_drive_publication.sql"),
    ),
  ).toBe(true);
});

maybe("populated legacy Drive publication upgrade", () => {
  it("does not relabel an existing canonical failure as a legacy unknown on replay", () => {
    const db = "recovery_canonical_replay";
    docker(["createdb", "-U", "postgres", db]);
    apply(db, BOOTSTRAP + baselineSchema());
    apply(db, BASELINE_LEGACY_SEED + LEGACY_AI_SEED);
    apply(db, buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS }));
    apply(
      db,
      `insert into public.ai_review_drive_publications (
      id,idempotency_key,export_id,review_id,execution_id,matter_id,project_id,organization_id,
      authorization_epoch,drive_folder_id,sha256,format_version,status,failure_code,actor_user_id
    ) values ('cccccccc-0000-0000-0000-000000000020','canonical-failure','${LEGACY_IDS.export}',
      '${LEGACY_IDS.review}','${LEGACY_IDS.execution}','${IDS.matter}','${IDS.project}','${IDS.org}',
      0,'synthetic-folder',repeat('f',64),'approved-report-v1','failed','drive_upload_failed','${IDS.reviewer}');`,
    );
    const before = jsonRows(db);
    expect(before).toContain('"legacy_payload": {}');
    apply(db, buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS }));
    expect(jsonRows(db)).toBe(before);
  }, 120_000);

  it.each([
    "drive_upload_outcome_unknown",
    "publication_record_failed",
    "drive_cleanup_failed",
  ])(
    "preserves an actual historical %s without authorizing retry",
    (code) => {
      const db = `legacy_${code}`;
      docker(["createdb", "-U", "postgres", db]);
      apply(db, BOOTSTRAP + baselineSchema());
      apply(
        db,
        BASELINE_LEGACY_SEED +
          LEGACY_AI_SEED +
          EXTRA_LEGACY_ROWS.replace("'drive_upload_failed'", `'${code}'`),
      );
      const before = jsonRows(db);
      expect(before).toContain(code);
      apply(db, buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS }));
      expect(legacyPayloadRows(db)).toBe(before);
      expect(
        psql(
          db,
          `select status from public.ai_review_drive_publications where id='bbbbbbbb-0000-0000-0000-000000000022';`,
        ),
      ).toBe("unknown_outcome");
    },
    120_000,
  );
  it("fails direct E2a closed without changing the populated legacy relation", () => {
    const before = jsonRows(DIRECT);
    const oid = publicationOid(DIRECT);
    expect(() => apply(DIRECT, E2A)).toThrow(
      /Non-empty legacy AI Drive publications require the Slice G migration/,
    );
    expect(jsonRows(DIRECT)).toBe(before);
    expect(publicationOid(DIRECT)).toBe(oid);
  }, 120_000);

  it("keeps the empty baseline route convergent with the fresh schema", () => {
    apply(EMPTY, buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS }));
    expect(psql(EMPTY, file("scripts/schema-fingerprint.sql"))).toBe(
      psql(FRESH, file("scripts/schema-fingerprint.sql")),
    );
    expect(
      psql(EMPTY, "select count(*) from public.ai_review_drive_publications;"),
    ).toBe("0");
  }, 180_000);

  it("proves OID-preserving mapping, canonical convergence, and conservative states", () => {
    const beforeRows = jsonRows(UPGRADE);
    const beforeOid = publicationOid(UPGRADE);
    expect(beforeRows).not.toBe("[]");
    apply(UPGRADE, buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS }));

    expect(publicationOid(UPGRADE)).toBe(beforeOid);
    expect(legacyPayloadRows(UPGRADE)).toBe(beforeRows);
    expect(
      psql(
        UPGRADE,
        "select count(*) from public.ai_review_drive_publications;",
      ),
    ).toBe("3");
    expect(
      psql(
        UPGRADE,
        `select string_agg(status, ',' order by id),
                string_agg(legacy_payload->>'status', ',' order by id),
                string_agg(coalesce(legacy_payload->>'failure_code',''), ',' order by id)
           from public.ai_review_drive_publications;`,
      ),
    ).toBe(
      "uploaded,unknown_outcome,unknown_outcome|published,pending,failed|,,drive_upload_failed",
    );
    expect(
      psql(
        UPGRADE,
        `select file_id || '|' || size_bytes || '|' || checksum || '|' ||
                drive_folder_id || '|' || created_at::text || '|' || updated_at::text
           from public.ai_review_drive_publications
          where id='bbbbbbbb-0000-0000-0000-000000000020';`,
      ),
    ).toContain(
      "legacy-file|321|legacy-checksum|legacy-folder-published|2026-01-01",
    );
    expect(
      psql(
        UPGRADE,
        "select count(*) from pg_namespace where nspname='recovery_drive_publication_upgrade_private';",
      ),
    ).toBe("0");
    expect(
      psql(
        UPGRADE,
        "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='ai_review_drive_publication_guard';",
      ),
    ).toBe("0");
    expect(
      psql(
        UPGRADE,
        "select has_table_privilege('service_role','public.ai_review_drive_publications','select') and not has_table_privilege('service_role','public.ai_review_drive_publications','insert') and not has_table_privilege('service_role','public.ai_review_drive_publications','update') and not has_table_privilege('service_role','public.ai_review_drive_publications','delete') and not has_table_privilege('anon','public.ai_review_drive_publications','select') and not has_table_privilege('authenticated','public.ai_review_drive_publications','select');",
      ),
    ).toBe("t");
    expect(psql(UPGRADE, file("scripts/schema-fingerprint.sql"))).toBe(
      psql(FRESH, file("scripts/schema-fingerprint.sql")),
    );

    const canonicalRows = jsonRows(UPGRADE);
    const canonicalOid = publicationOid(UPGRADE);
    const canonicalFingerprint = psql(
      UPGRADE,
      file("scripts/schema-fingerprint.sql"),
    );
    apply(UPGRADE, buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS }));
    expect(jsonRows(UPGRADE)).toBe(canonicalRows);
    expect(publicationOid(UPGRADE)).toBe(canonicalOid);
    expect(psql(UPGRADE, file("scripts/schema-fingerprint.sql"))).toBe(
      canonicalFingerprint,
    );
  }, 180_000);

  it("rolls back the whole supported route after preservation on a forced later failure", () => {
    const beforeRows = jsonRows(FORCED);
    const beforeOid = publicationOid(FORCED);
    const beforeSchema = psql(FORCED, file("scripts/schema-fingerprint.sql"));
    const supported = buildSupportedUpgradeSql({ migrationsDir: MIGRATIONS });
    const forced = supported.replace(
      "\ncommit;\n",
      "\ndo $forced$ begin raise exception 'forced supported upgrade failure'; end $forced$;\ncommit;\n",
    );
    expect(() => apply(FORCED, forced)).toThrow(
      /forced supported upgrade failure/,
    );
    expect(jsonRows(FORCED)).toBe(beforeRows);
    expect(publicationOid(FORCED)).toBe(beforeOid);
    expect(psql(FORCED, file("scripts/schema-fingerprint.sql"))).toBe(
      beforeSchema,
    );
    expect(
      psql(
        FORCED,
        "select count(*) from information_schema.columns where table_schema='public' and table_name='ai_executions' and column_name='user_id';",
      ),
    ).toBe("1");
    expect(
      psql(
        FORCED,
        "select count(*) from pg_namespace where nspname='recovery_drive_publication_upgrade_private';",
      ),
    ).toBe("0");
  }, 180_000);
});
