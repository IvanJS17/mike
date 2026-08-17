import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const storageDir = resolve(root, "scripts/storage");
const read = (name) => readFileSync(resolve(storageDir, name), "utf8");

test("LUKS2 formatting is explicit, destructive, and never receives a password argument", () => {
  const source = read("format-luks2.sh");
  assert.match(source, /LUKS2_CONFIRM=YES/);
  assert.match(source, /cryptsetup luksFormat/);
  assert.match(source, /--type luks2/);
  assert.match(source, /--batch-mode/);
  assert.doesNotMatch(source, /--key-file|--key-file=|password=/i);
  assert.match(source, /mkfs\.ext4/);
});

test("unlock and lock scripts require the expected encrypted mapper and mount", () => {
  const unlock = read("unlock-luks2.sh");
  const lock = read("lock-luks2.sh");
  assert.match(unlock, /cryptsetup isLuks/);
  assert.match(unlock, /cryptsetup luksOpen/);
  assert.match(unlock, /mount/);
  assert.match(unlock, /findmnt/);
  assert.match(lock, /docker compose/);
  assert.match(lock, /umount/);
  assert.match(lock, /cryptsetup luksClose/);
  assert.match(lock, /LUKS2_CONFIRM=YES/);
  for (const source of [unlock, lock]) {
    assert.doesNotMatch(source, /--key-file|--key-file=|password=/i);
  }
});

test("the production start guard refuses an unmounted root filesystem", () => {
  const guard = read("verify-encrypted-mount.sh");
  assert.match(guard, /findmnt/);
  assert.match(guard, /LITT_DATA_ROOT/);
  assert.match(guard, /crypt/);
  assert.match(guard, /exit 1/);
  assert.doesNotMatch(guard, /docker compose up|compose up/);
});

test("the LUKS2 runbook documents reboot unlock, permissions, and no-volume-destruction rules", () => {
  const runbook = readFileSync(resolve(root, "infra/runbooks/luks2.md"), "utf8");
  for (const phrase of ["LUKS2", "reboot", "findmnt", "0700"]) {
    assert.match(runbook, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(runbook, /docker compose\s+down -v/i);
});

test("all storage scripts pass bash syntax validation", () => {
  for (const name of ["format-luks2.sh", "unlock-luks2.sh", "lock-luks2.sh", "verify-encrypted-mount.sh", "../production-up.sh"]) {
    execFileSync("bash", ["-n", resolve(storageDir, name)]);
  }
});
