#!/usr/bin/env bash
#
# Contractual test for the deterministic Beta 0.1 user fixture (Gate 1, fix 2).
#
# Demonstrates, WITHOUT raising the stack and with ZERO network:
#   1. first run CREATES the fixture account;
#   2. second run REUSES the same user_id and the fixture store never grows;
#   3. a partial business failure still cleans every already-captured ID
#      (TrackedCleanup runs ALL registered steps even when one fails) and
#      the failure is reported;
#   4. legacy cleanup removes ONLY `beta01-owner-*` users, never foreign
#      accounts and never the deterministic fixture, and is idempotent
#      (fixture count does not grow on repeat).
#
# The auth admin client is a FAKE in-memory store with the same interface the
# spec injects; globalThis.fetch is replaced by a spy that fails hard, so this
# test can never touch HTTP.
#
# Usage: bash scripts/test-beta01-user-fixture.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE_HELPER="$ROOT/e2e/support/beta01-user-fixture.cjs"
TMP="$(mktemp -d /tmp/beta01-user-fixture.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

TEST_PROGRAM="$TMP/fixture-contract.cjs"
cat >"$TEST_PROGRAM" <<'NODE'
"use strict";

const helperPath = process.argv[2];
if (!helperPath) throw new Error("missing helper path");
const {
  OWNER_FIXTURE,
  ensureFixtureUser,
  cleanLegacyOwnerUsers,
  TrackedCleanup,
} = require(helperPath);

// ZERO network: any fetch in this contractual test is a bug.
globalThis.fetch = async function spyFetch() {
  throw new Error("user-fixture contractual test must never perform HTTP requests");
};

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// In-memory fake of the Supabase auth admin client (same interface used by
// e2e/beta01-setup-smoke.spec.ts: lookupByCredentials / createUser /
// listUsers / deleteUser).
function fakeAuthAdmin(seed = []) {
  const users = new Map(); // email -> { id, email, password }
  for (const user of seed) users.set(user.email, { ...user });
  let nextId = 1000;
  return {
    users,
    async lookupByCredentials(email, password) {
      const user = users.get(email);
      return user && user.password === password ? { id: user.id } : null;
    },
    async createUser(email, password) {
      if (users.has(email)) return null; // Supabase 422: la cuenta ya existe
      const id = `fake-user-${(nextId += 1)}`;
      users.set(email, { id, email, password });
      return { id };
    },
    async listUsers() {
      return [...users.values()].map(({ id, email }) => ({ id, email }));
    },
    async deleteUser(id) {
      for (const [email, user] of users) {
        if (user.id === id) {
          users.delete(email);
          return;
        }
      }
      throw new Error(`deleteUser: user ${id} not found`);
    },
  };
}

async function main() {
  // Case 1: la primera corrida CREA el fixture (una sola cuenta en el store).
  const client1 = fakeAuthAdmin();
  const first = await ensureFixtureUser(client1, OWNER_FIXTURE);
  check(
    "c1 first run creates",
    first.created === true &&
      typeof first.user.id === "string" &&
      first.user.id.length > 0,
    `user_id=${first.user.id}`,
  );
  check("c1 fixture store holds exactly 1 user", client1.users.size === 1);

  // Case 2: la segunda corrida REUTILIZA el mismo user_id; el conteo no crece.
  const second = await ensureFixtureUser(client1, OWNER_FIXTURE);
  check(
    "c2 second run reuses same user_id",
    second.created === false && second.user.id === first.user.id,
    `user_id=${second.user.id}`,
  );
  check("c2 fixture count does not grow", client1.users.size === 1);

  // Case 3: fallo parcial — todos los IDs ya capturados se limpian aunque un
  // delete falle, y el fallo se reporta (nunca pasa residuo en silencio).
  const cleanup = new TrackedCleanup();
  const removed = [];
  for (const label of [
    "version",
    "document",
    "matter",
    "organization",
    "project",
  ]) {
    cleanup.register(label, async () => {
      removed.push(label);
      if (label === "document") throw new Error("boom (delete de documento)");
    });
  }
  let cleanupError = null;
  try {
    await cleanup.run();
  } catch (error) {
    cleanupError = error;
  }
  check(
    "c3 partial failure still cleans every captured ID",
    removed.sort().join(",") ===
      "document,matter,organization,project,version",
    `removed=${[...removed].sort().join(",")}`,
  );
  check(
    "c3 cleanup failure is reported",
    cleanupError !== null &&
      String(cleanupError.message).includes("document") &&
      String(cleanupError.message).includes("boom"),
  );

  // Case 4: legacy cleanup — sólo `beta01-owner-*`, nunca ajenos ni el
  // fixture; repetido no crece el conteo.
  const client2 = fakeAuthAdmin([
    { id: "legacy-1", email: "beta01-owner-1712345678901-a1b2c3d4@mike.local" },
    { id: "legacy-2", email: "beta01-owner-1712345678999-e5f6a7b8@mike.local" },
    { id: "foreign-1", email: "someone@example.com" },
    { id: "foreign-2", email: "e2e@mike.local" },
  ]);
  await ensureFixtureUser(client2, OWNER_FIXTURE);
  const removedLegacy = await cleanLegacyOwnerUsers(
    client2,
    OWNER_FIXTURE.email,
  );
  check(
    "c4 legacy cleanup removed exactly the legacy owners",
    removedLegacy === 2,
    `removed=${removedLegacy}`,
  );
  check(
    "c4 legacy cleanup never touches foreign users",
    client2.users.has("someone@example.com") &&
      client2.users.has("e2e@mike.local"),
  );
  check(
    "c4 deterministic fixture survives legacy cleanup",
    client2.users.has(OWNER_FIXTURE.email),
  );
  const removedAgain = await cleanLegacyOwnerUsers(
    client2,
    OWNER_FIXTURE.email,
  );
  check(
    "c4 legacy cleanup is idempotent (no growth on repeat)",
    removedAgain === 0 && client2.users.size === 3,
    `store size=${client2.users.size}`,
  );
  await ensureFixtureUser(client2, OWNER_FIXTURE);
  check("c4 fixture count never grows after use", client2.users.size === 3);

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL unhandled: ${error.message}`);
  process.exit(1);
});
NODE

node "$TEST_PROGRAM" "$FIXTURE_HELPER"
echo "ALL PASS — beta01 user fixture contractual test OK"