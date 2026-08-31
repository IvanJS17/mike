/**
 * Coordinator-owned recovery migration naming/order contract.
 *
 * The repository and its real migration runners use lexical filename order and
 * require `YYYYMMDD_NN_<short_name>.sql`. Recovery migrations therefore stay in
 * that namespace and use `recovery_` at the start of the short name:
 * `YYYYMMDD_NN_recovery_<name>.sql`.
 *
 * A recovery migration must use a date/ordinal stem that is not already present
 * and sorts after the latest existing dated migration. Historical upstream
 * filenames are never renamed or replayed merely to build the recovery branch.
 *
 * Fresh installs bootstrap from `backend/schema.sql`. This module also fixes the
 * explicit marker used to represent that recovery fresh-schema versus supported-
 * incremental convergence has not been proven yet (Slice A owns that proof).
 */

import fs from "node:fs";

export const RECOVERY_MIGRATION_TAG = "_recovery_";

/**
 * Marker prefix for schema fingerprints. Until a Slice A fingerprint is
 * recorded, every recovery fingerprint must carry this marker so that an
 * unconverged fresh/migration state cannot be mistaken for a converged
 * upstream fingerprint.
 */
export const RECOVERY_SCHEMA_FINGERPRINT_MARKER =
  "RECOVERY_SCHEMA_FINGERPRINT:";

const RECOVERY_NAME_PATTERN = /^(\d{8})_(\d{2})_recovery_([a-z0-9_]+)\.sql$/;
const DATED_MIGRATION_PATTERN = /^(\d{8})_(\d{2})_/;

type MigrationStem = {
  date: number;
  ordinal: number;
  text: string;
};

function migrationStem(name: string): MigrationStem | null {
  const match = DATED_MIGRATION_PATTERN.exec(name);
  if (!match) return null;
  return {
    date: Number(match[1]),
    ordinal: Number(match[2]),
    text: `${match[1]}_${match[2]}`,
  };
}

function compareStems(left: MigrationStem, right: MigrationStem): number {
  return left.date - right.date || left.ordinal - right.ordinal;
}

/**
 * Assert one recovery migration filename follows the repository convention,
 * has a unique date/ordinal stem, and appends after the pinned existing series.
 */
export function assertRecoveryMigrationName(
  name: string,
  existingNames: string[] = [],
): void {
  const match = RECOVERY_NAME_PATTERN.exec(name);
  if (!match) {
    throw new Error(
      `recovery migration names must use the ` +
        `YYYYMMDD_NN_recovery_<short_name>.sql convention with a two-digit ordinal: ${name}`,
    );
  }

  const candidate = migrationStem(name);
  if (!candidate) {
    throw new Error(
      `recovery migration has no valid YYYYMMDD_NN stem: ${name}`,
    );
  }
  if (candidate.ordinal === 0) {
    throw new Error(`recovery migration ordinal must start at 01: ${name}`);
  }

  const existing = existingNames
    .map(migrationStem)
    .filter((stem): stem is MigrationStem => stem !== null);

  if (existing.some((stem) => stem.text === candidate.text)) {
    throw new Error(
      `recovery migration date/ordinal stem collides with an existing migration: ${candidate.text}`,
    );
  }

  const latest = existing.reduce<MigrationStem | null>(
    (current, stem) =>
      !current || compareStems(stem, current) > 0 ? stem : current,
    null,
  );
  if (latest && compareStems(candidate, latest) <= 0) {
    throw new Error(
      `recovery migration must append after the latest existing migration stem ${latest.text}: ${name}`,
    );
  }
}

/**
 * Return the same lexical order used by the repository migration runners.
 * Standard `YYYYMMDD_NN_...` names sort by date and ordinal without a parallel
 * recovery namespace or custom apply path.
 */
export function sortRecoveryMigrations(names: string[]): string[] {
  return [...names].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** List recovery-tagged migration filenames in runner-compatible order. */
export function listRecoveryMigrations(migrationsDir: string): string[] {
  if (!fsExists(migrationsDir)) return [];
  return sortRecoveryMigrations(
    fs
      .readdirSync(migrationsDir)
      .filter((name) => RECOVERY_NAME_PATTERN.test(name)),
  );
}

function fsExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
