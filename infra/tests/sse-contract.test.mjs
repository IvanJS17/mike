import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const storage = readFileSync(resolve(root, "backend/src/lib/storage.ts"), "utf8");
const security = readFileSync(resolve(root, "backend/src/lib/storageSse.ts"), "utf8");

test("production storage uses SSE-C for uploads and downloads", () => {
  assert.match(security, /SSECustomerAlgorithm/);
  assert.match(security, /AES256/);
  assert.match(storage, /sseCustomerHeaders\(\)/);
  assert.match(storage, /PutObjectCommand/);
  assert.match(storage, /GetObjectCommand/);
  assert.match(readFileSync(resolve(root, "backend/.env.example"), "utf8"), /R2_SSE_CUSTOMER_KEY/);
});

test("object-storage verification checks privacy, versioning, and a keyless read failure", () => {
  const script = readFileSync(resolve(root, "scripts/object-storage/verify-private-versioning.sh"), "utf8");
  assert.match(script, /get-bucket-versioning/);
  assert.match(script, /public-access-block/);
  assert.match(script, /SSE-C|sse-customer/i);
  assert.match(script, /without|without.*key|no.*key/i);
  execFileSync("bash", ["-n", resolve(root, "scripts/object-storage/verify-private-versioning.sh")]);
});

test("the object-storage runbook keeps the customer key outside the bucket", () => {
  const runbook = readFileSync(resolve(root, "infra/runbooks/object-storage.md"), "utf8");
  assert.match(runbook, /private/i);
  assert.match(runbook, /version/i);
  assert.match(runbook, /SSE-C/i);
  assert.match(runbook, /outside|fuera/i);
  assert.doesNotMatch(runbook, /R2_SSE_CUSTOMER_KEY=[A-Za-z0-9+/=]{20,}/);
});
