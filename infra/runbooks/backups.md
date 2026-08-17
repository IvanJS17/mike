# Backup and recovery-set runbook

A recovery set is the unit of backup success. A job is not successful if any
component, checksum, encryption step, independent-destination upload, or final
marker is missing.

## Required contents

Every 12 hours, at 00:00 and 12:00 UTC, the recovery timer creates a set containing:

- PostgreSQL custom-format dump and `pg_restore --list` output;
- every application-bucket object version and delete marker, plus the key/version
  index and per-object checksums;
- audit exports and publication manifests;
- sanitized production config and the release/version manifest;
- inventory, component counts, and `SHA256SUMS`;
- a complete `age`-encrypted archive;
- a copy in a separate recovery destination using credentials that are not used
  by the application and cannot be deleted/reduced by the application account;
- a final `SUCCESS.json` marker written only after remote metadata matches the
  encrypted archive checksum.

The secret recovery package is not stored in Git or this bucket. Socium holds
it separately, with the age identity/private key, LUKS header backup, key
custody record, and rotation receipt.

## Configuration and credentials

Place one mode-600 `/srv/litt-data/secrets/backup.env` outside Git. It contains the
paths and credentials named by `create-recovery-set.sh` and
`check-recovery-freshness.sh`. It must define separate object and backup
credentials, the mode-600 `OBJECT_SSE_CUSTOMER_KEY_FILE`, the age recipients file, the alert webhook, and the sanitized
config/audit/publication paths. Never print or paste the file.

Install the scripts as `/usr/local/sbin/litt-create-recovery-set` and
`litt-check-recovery-freshness`; install the four systemd units from
`infra/production/systemd/`, then enable both timers. The recovery timer has
exactly two UTC runs: 00:00 and 12:00. The freshness timer runs hourly.

## Freshness and data gate

The freshness job reads `recovery/latest-success.json` from the independent
destination. If it is missing, malformed, or older than 24 hours, it:

1. writes `backup_freshness_ok=false` under the encrypted state directory;
2. sends the first-failure alert to the approved webhook;
3. exits non-zero so systemd/monitoring records the failure;
4. blocks production data writes through the backend freshness gate until a complete set is restored.

Synthetic/anonymous qualification may continue, but the stale state must not be
reported as a healthy Gate B or Gate E environment.

## Restore objectives

The recovery test measures **RPO ≤ 24 hours** from the last recovered data
through the declared failure time and **RTO ≤ 4 hours** from failure declaration
to green readiness, integrity verification, and access by two designated users.
The test runs on a disposable server and never overwrites the live host.

At minimum record set ID, timestamps, dump/object counts, checksums, image
references, migration version, restore commands, readiness, and elapsed RTO.
Do not record secrets, passphrases, access tokens, or customer content.

## Failure handling

A failed job is a failed recovery point, even if the PostgreSQL dump exists.
Investigate the first failing component, preserve the failed set directory for
forensics, alert, and rerun the complete set. Do not mark partial output as
`latest-success`. If the age threshold is reached, stop real-data intake first;
repairing the job comes second.
