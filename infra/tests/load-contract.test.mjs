import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("WS2 load runner fixes the 30-minute profile and all acceptance thresholds", () => {
  const source = readFileSync(resolve(root, "scripts/load/run-ws2-load.sh"), "utf8");
  for (const pattern of [
    "1800",
    "4",
    "10.*MB",
    "100",
    "1000",
    "three",
    "10.*fail",
    "RAM",
    "OOM",
    "swap",
    "disk",
    "5xx",
    "p95",
    "8 GB",
  ]) {
    assert.match(source, new RegExp(pattern, "i"));
  }
  assert.match(source, /report/i);
  assert.doesNotMatch(source, /(?:api[_-]?key|secret|password)\s*=\s*["']/i);
  execFileSync("bash", ["-n", resolve(root, "scripts/load/run-ws2-load.sh")]);
});

test("host firewall allows only the required public ports and VPN SSH", () => {
  const rules = readFileSync(resolve(root, "infra/production/host/nftables.conf.example"), "utf8");
  assert.match(rules, /policy drop/);
  assert.match(rules, /80/);
  assert.match(rules, /443/);
  assert.match(rules, /22/);
  assert.match(rules, /vpn/i);
  assert.doesNotMatch(rules, /dport\s+22[^\n]*0\.0\.0\.0\/0/i);
  const verify = readFileSync(resolve(root, "scripts/production/verify-host-firewall.sh"), "utf8");
  assert.match(verify, /nft/);
  assert.match(verify, /ss\s+-l/);
  execFileSync("bash", ["-n", resolve(root, "scripts/production/verify-host-firewall.sh")]);
});

test("CI publishes backend/frontend image digests and a release manifest", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/production-images.yml"), "utf8");
  assert.match(workflow, /build-push-action/);
  assert.match(workflow, /backend/);
  assert.match(workflow, /frontend/);
  assert.match(workflow, /outputs\.digest/);
  assert.match(workflow, /image-lock.*\.env/);
  const manifest = readFileSync(resolve(root, "scripts/release/write-version-manifest.sh"), "utf8");
  assert.match(manifest, /@sha256:/);
  assert.match(manifest, /source_offer/);
  execFileSync("bash", ["-n", resolve(root, "scripts/release/write-version-manifest.sh")]);
});

test("load runbook records the thresholds and the CX23-to-8GB decision", () => {
  const runbook = readFileSync(resolve(root, "infra/runbooks/load-test.md"), "utf8");
  for (const phrase of ["30 minutes", "4 accounts", "10 MB", "100 documents", "1,000 pages", "p95", "8 GB"]) {
    assert.match(runbook, new RegExp(phrase, "i"));
  }
});
