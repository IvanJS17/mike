import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const app = readFileSync(resolve(root, "backend/src/app.ts"), "utf8");

test("backend exposes internal readiness and metrics endpoints", () => {
  assert.match(app, /app\.get\("\/ready"/);
  assert.match(app, /app\.get\("\/metrics"/);
  assert.match(app, /readiness/i);
  assert.match(app, /metrics/i);
});

test("observability collects CPU, RAM, disk, queue, and timings without raw payloads", () => {
  const script = readFileSync(resolve(root, "scripts/observability/collect-host-metrics.sh"), "utf8");
  for (const pattern of ["cpu", "memory", "df", "queue", "duration", "ready"]) {
    assert.match(script, new RegExp(pattern, "i"));
  }
  assert.doesNotMatch(script, /prompt|response|api[_-]?key|secret/i);
  const rules = readFileSync(resolve(root, "infra/observability/alerts.yml"), "utf8");
  for (const alert of ["Availability", "Disk", "OOM", "Backup", "Restore", "Publication"]) {
    assert.match(rules, new RegExp(alert, "i"));
  }
});

test("observability runbook requires migration rehearsal, rollback, version inventory, and permission review", () => {
  const runbook = readFileSync(resolve(root, "infra/runbooks/observability.md"), "utf8");
  for (const phrase of ["readiness", "migration", "rollback", "version", "source offer", "permissions"]) {
    assert.match(runbook, new RegExp(phrase, "i"));
  }
});
