import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const restoreDir = resolve(root, "scripts/restore");
const read = (name) => readFileSync(resolve(restoreDir, name), "utf8");

test("restore decrypts and verifies an immutable recovery set before loading it", () => {
  const source = read("restore-recovery-set.sh");
  for (const pattern of [
    "age --decrypt",
    "sha256sum -c",
    "SUCCESS.json",
    "pg_restore",
    "index.ndjson",
    "--sse-customer-algorithm",
    "readiness",
    "RPO",
    "RTO",
    "disposable",
  ]) {
    assert.match(source, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.doesNotMatch(source, /docker compose\s+down\s+-v/i);
});

test("restore runbook requires the qualification dataset and measured objectives", () => {
  const runbook = readFileSync(resolve(root, "infra/runbooks/restore.md"), "utf8");
  for (const phrase of ["disposable", "4 users", "2 workspaces", "6 matters", "100 documents", "RPO", "RTO", "rollback"]) {
    assert.match(runbook, new RegExp(phrase, "i"));
  }
});

test("restore script passes bash syntax validation", () => {
  execFileSync("bash", ["-n", resolve(restoreDir, "restore-recovery-set.sh")]);
});
