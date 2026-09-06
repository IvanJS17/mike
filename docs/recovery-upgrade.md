# Supported populated legacy Drive upgrade

This note documents the bounded 5.2a route only. It starts from the pinned LiTT
baseline `d9fa8380e63837b6441cef169cf5ef80dfb55e54` and uses the explicit
coordinator manifest in `backend/src/lib/recovery/supportedUpgradeDriver.ts`.

The manifest applies tenancy and onboarding, then runs
`20260905_03_recovery_drive_publication_preflight.sql` before the unchanged E2a
file, core convergence, and approved-artifact storage. It finishes with
`20260905_04_recovery_drive_publication.sql`. The newer `03`/`04` filenames are
therefore not discovered lexically; direct lexical E2a remains fail-closed on a
populated legacy publication relation.

The driver validates exact source hashes and known transaction envelopes, emits
one SQL script with one outer transaction, and never chooses a database target.
The caller owns the connection and must run the emitted SQL with fail-fast
settings. The preflight takes an exclusive table lock, verifies ownership,
drops only the known obsolete trigger dependency, and moves the same relation
to a private transient schema. The final migration moves that relation back by
OID, captures each original row as `legacy_payload`, rebuilds the canonical
constraints/indexes/RLS/grants, and removes the empty transient schema. Any
failure rolls back schema, rows, relation identity, and privileges together.

The status column uses exactly `PublicationIntent.outcome` from sharedContracts.ts:
`pending`, `uploaded`, `unknown_outcome`, `reconciled`, `failed`. Legacy
`published` rows become `uploaded` with their original object metadata, not newly
`reconciled`: no remote verification is asserted by this migration. Legacy
`pending` and `failed` rows become `unknown_outcome`; their original
`status` and `failure_code` remain in `legacy_payload`. Replaying the driver
does not reclassify canonical failures with no legacy status evidence.
Imported rows are historical evidence only. This slice adds no retry/publication
authority, RPC, API, UI, provider, or Google call.

To emit SQL from the repository root (no connection is opened):

```sh
npm run build --prefix backend
node backend/dist/cli/recovery-upgrade.js emit-sql --migrations-dir backend/migrations > supported-upgrade.sql
```

Do not pipe npm's script banner into psql. The emitted file is intended only for
an explicitly selected, backed-up supported database; this note does not authorize
remote execution. An unknown or changed migration source is rejected before SQL
is emitted. The runtime proves exact legacy row payloads and OID preservation,
full fresh/upgrade fingerprint equality, replay, and transactional rollback.
Historical unknown-upload, recording-failure and cleanup-failure fixtures remain
non-retryable evidence; authenticated and service-role DML stay denied.

The opt-in proof is
`RUN_RECOVERY_DRIVE_UPGRADE_RUNTIME=1 npm test --prefix backend -- src/__tests__/integration/recoveryDriveUpgrade.runtime.test.ts`.
It uses cached `postgres:16-alpine`, `--network=none`, tmpfs storage, synthetic
fixtures, one owner-labeled container, and exact-ID teardown with an absence
assertion.
