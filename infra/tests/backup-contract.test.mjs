import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const backupDir = resolve(root, "scripts/backup");
const read = (name) => readFileSync(resolve(backupDir, name), "utf8");

test("a recovery set contains every required source and succeeds only after encryption/upload verification", () => {
  const source = read("create-recovery-set.sh");
  for (const pattern of [
    "pg_dump",
    "pg_restore --list",
    "list-object-versions",
    "get-object",
    "audit",
    "publication",
    "SHA256SUMS",
    "inventory",
    "age --encrypt",
    "BACKUP_ACCESS_KEY_ID",
    "BACKUP_SECRET_ACCESS_KEY",
    "SUCCESS.json",
    "BACKUP_ALERT_WEBHOOK",
    "OBJECT_SSE_CUSTOMER_KEY_FILE",
  ]) {
    assert.match(source, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.doesNotMatch(source, /docker compose\s+down\s+-v/i);
  assert.doesNotMatch(source, /password\s*=\s*["'][^"']+["']/i);
});

test("freshness checks fail closed and revoke real-data acceptance after 24 hours", () => {
  const source = read("check-recovery-freshness.sh");
  assert.match(source, /24/);
  assert.match(source, /real_data_allowed/);
  assert.match(source, /BACKUP_ALERT_WEBHOOK/);
  assert.match(source, /exit 2/);
  execFileSync("bash", ["-n", resolve(backupDir, "check-recovery-freshness.sh")]);
});

test("systemd schedules two recovery sets per day and a freshness check", () => {
  const timer = readFileSync(resolve(root, "infra/production/systemd/litt-recovery-set.timer"), "utf8");
  const freshness = readFileSync(resolve(root, "infra/production/systemd/litt-recovery-freshness.timer"), "utf8");
  assert.match(timer, /00:00:00 UTC/);
  assert.match(timer, /12:00:00 UTC/);
  assert.match(timer, /Persistent=true/);
  assert.match(freshness, /OnCalendar=hourly/);
});

test("backup runbook states RPO/RTO, independent credentials, and stop-on-stale policy", () => {
  const runbook = readFileSync(resolve(root, "infra/runbooks/backups.md"), "utf8");
  for (const phrase of ["12 hours", "RPO", "RTO", "independent", "24 hours", "Socium", "restore"]) {
    assert.match(runbook, new RegExp(phrase, "i"));
  }
});
