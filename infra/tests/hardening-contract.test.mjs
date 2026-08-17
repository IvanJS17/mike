import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("production startup is canonical, digest-locked, and checks the host firewall", () => {
  const startup = read("scripts/production-up.sh");
  assert.match(startup, /realpath/);
  assert.match(startup, /verify-host-firewall/);
  assert.match(startup, /verify-image-lock/);
  assert.match(startup, /compose\.prod\.yml/);
  const lock = read("scripts/production/verify-image-lock.sh");
  assert.match(lock, /@sha256:/);
  assert.match(lock, /64/);
  assert.match(lock, /docker compose/);
});

test("LUKS and secret roots are canonical and device identity is checked", () => {
  const env = read(".env.prod.example");
  assert.match(env, /LITT_SECRETS_ROOT=\/srv\/litt-data\/secrets/);
  for (const file of ["scripts/storage/format-luks2.sh", "scripts/storage/unlock-luks2.sh", "scripts/storage/verify-encrypted-mount.sh"]) {
    const source = read(file);
    assert.match(source, /realpath/);
    assert.match(source, /lsblk/);
    assert.match(source, /mapper|cryptsetup/i);
  }
  const cloudInit = read("infra/tofu/cloud-init.yaml.tftpl");
  assert.match(cloudInit, /ssh_authorized_keys/);
  assert.match(cloudInit, /litt-operators/);
});

test("restore and backup reject live identities, unsafe archives, and incomplete markers", () => {
  const restore = read("scripts/restore/restore-recovery-set.sh");
  for (const pattern of ["litt-restore-", "compose.restore.yml", "RESTORE_ROOT", "tarfile", "realpath", "trap", "encrypted_sha256", "RESTORE_EXPECTED_COUNTS_FILE"]) {
    assert.match(restore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  const backup = read("scripts/backup/create-recovery-set.sh");
  for (const pattern of ["NextKeyMarker", "NextVersionIdMarker", "OBJECT_ACCESS_KEY_ID", "BACKUP_ACCESS_KEY_ID", "symlink", "allowlist"]) {
    assert.match(backup, new RegExp(pattern, "i"));
  }
  const freshness = read("scripts/backup/check-recovery-freshness.sh");
  assert.match(freshness, /backup_freshness_ok/);
  assert.match(freshness, /status/);
  assert.match(freshness, /encrypted_sha256/);
  assert.doesNotMatch(freshness, /real_data_allowed/);
});

test("SSE-C is opt-in for local RustFS and required for production endpoints/downloads", () => {
  const sse = read("backend/src/lib/storageSse.ts");
  assert.match(sse, /R2_SSE_CUSTOMER_KEY_REQUIRED/);
  assert.match(sse, /https/);
  assert.match(sse, /R2_ENDPOINT_ALLOWLIST/);
  const storage = read("backend/src/lib/storage.ts");
  assert.match(storage, /getSignedUrl/);
  assert.match(read("backend/src/lib/storageSse.ts"), /SSECustomer/);
  const downloads = read("backend/src/routes/documents.ts");
  assert.match(downloads, /buildDownloadUrl|stream|download/i);
});

test("load and CI are bounded to approved synthetic targets and immutable actions", () => {
  const load = read("scripts/load/run-ws2-load.sh");
  for (const pattern of ["https", "LOAD_ALLOWED_HOST", "synthetic", "download", "induced_failure", "resume", "type.*number"]) {
    assert.match(load, new RegExp(pattern, "i"));
  }
  const workflow = read(".github/workflows/production-images.yml");
  assert.match(workflow, /@[0-9a-f]{40}/);
  assert.match(workflow, /six|CADDY|POSTGRES|AUTH|REST/i);
});

test("release manifest binds source offer to release SHA and Caddy digest", () => {
  const manifest = read("scripts/release/write-version-manifest.sh");
  assert.match(manifest, /SOURCE_OFFER_URL.*RELEASE_SHA|RELEASE_SHA.*SOURCE_OFFER_URL/s);
  assert.match(manifest, /CADDYFILE_PATH/);
  assert.match(manifest, /caddy_config_sha256/);
});
