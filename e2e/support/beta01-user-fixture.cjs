"use strict";
/*
 * Beta 0.1 — deterministic auth fixture + tracked business cleanup.
 *
 * Gate 1, fix 2: instead of a new `beta01-owner-<timestamp>-<uuid>` account
 * per run (which accumulates users in the local stack), the setup smoke uses
 * ONE deterministic local identity — beta01-owner@local.test — managed by an
 * idempotent helper: look up by email, create only when missing, reuse the
 * existing account otherwise.
 *
 * The auth admin client is INJECTED so the exact same logic runs against
 * real Supabase (e2e/beta01-setup-smoke.spec.ts) and against an in-memory
 * fake (contractual test scripts/test-beta01-user-fixture.sh) with zero
 * network:
 *
 *     lookupByCredentials(email, password) -> Promise<{id} | null>
 *     createUser(email, password)           -> Promise<{id} | null>
 *     listUsers()                           -> Promise<Array<{id, email}>>
 *     deleteUser(id)                        -> Promise<void>
 *
 * Legacy cleanup: only users whose email starts with the legacy prefix
 * `beta01-owner-` AND differs from the deterministic fixture are removed,
 * exactly once per run, ONLY under the approved local target guard (the spec
 * runs the guard before any mutation). Never touches foreign accounts and
 * never runs against a non-loopback target.
 *
 * TrackedCleanup: business resources (organization/project/matter/document/
 * version) register their deleteFn the moment their IDs are known, so a
 * failure at ANY step still removes everything already captured; run() deletes
 * in reverse registration order (children before parents — safe order),
 * tolerates a failing step (reports it, keeps deleting) and throws only when
 * residue remains, so it never passes silently.
 */

const OWNER_FIXTURE = Object.freeze({
  // Identidad local determinista del owner. NO es un secreto: es un fixture
  // de prueba del stack local (password fixture no secreto).
  email: "beta01-owner@local.test",
  password: "Beta01OwnerPass-2026!",
});

// Prefijo de cuentas legacy que acumulaban las corridas anteriores
// (beta01-owner-<timestamp>-<uuid>@mike.local). El fixture determinista
// (beta01-owner@local.test) NO coincide con este prefijo (el carácter
// siguiente a "owner" es "@", no "-"), pero el filtro explícito lo protege
// igualmente.
const LEGACY_OWNER_PREFIX = "beta01-owner-";

// Idempotente: primera corrida crea la cuenta; corridas siguientes reutilizan
// la misma (mismo user_id). Nunca modifica una cuenta existente con
// credenciales distintas: en ese caso falla explícito.
async function ensureFixtureUser(authAdmin, fixture) {
  const existing = await authAdmin.lookupByCredentials(
    fixture.email,
    fixture.password,
  );
  if (existing && existing.id) {
    return {
      user: {
        id: existing.id,
        email: fixture.email,
        password: fixture.password,
      },
      created: false,
    };
  }
  const created = await authAdmin.createUser(fixture.email, fixture.password);
  if (created && created.id) {
    return {
      user: {
        id: created.id,
        email: fixture.email,
        password: fixture.password,
      },
      created: true,
    };
  }
  throw new Error(
    `beta01 fixture: la cuenta ${fixture.email} existe pero no coincide con el password del fixture`,
  );
}

// Limpieza ONE-SHOT de cuentas legacy (beta01-owner-*) acumuladas por
// corridas anteriores. Sólo toca el prefijo legacy, nunca el fixture
// determinista y nunca cuentas ajenas. Devuelve cuántas eliminó.
async function cleanLegacyOwnerUsers(authAdmin, fixtureEmail) {
  const users = await authAdmin.listUsers();
  let removed = 0;
  for (const user of users) {
    if (typeof user?.email !== "string") continue;
    if (user.email === fixtureEmail) continue;
    if (user.email.startsWith(LEGACY_OWNER_PREFIX)) {
      await authAdmin.deleteUser(user.id);
      removed += 1;
    }
  }
  return removed;
}

// Cleanup registrado: cada recurso de negocio registra su deleteFn en cuanto
// su ID se conoce, así un fallo en cualquier step elimina igualmente todo lo
// ya capturado. run() ejecuta en orden inverso de registro (hijos antes que
// padres), tolera pasos que fallen (los reporta y sigue eliminando) y lanza
// sólo si queda residuo.
class TrackedCleanup {
  constructor() {
    this._steps = [];
  }

  register(label, deleteFn) {
    this._steps.push({ label, deleteFn });
    return this;
  }

  get size() {
    return this._steps.length;
  }

  async run() {
    const failures = [];
    for (const step of [...this._steps].reverse()) {
      try {
        await step.deleteFn();
      } catch (error) {
        failures.push(
          `${step.label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `TrackedCleanup FAILED (${failures.length}/${this._steps.length}): ${failures.join("; ")}`,
      );
    }
  }
}

module.exports = {
  OWNER_FIXTURE,
  LEGACY_OWNER_PREFIX,
  ensureFixtureUser,
  cleanLegacyOwnerUsers,
  TrackedCleanup,
};