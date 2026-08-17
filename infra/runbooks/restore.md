# Restore and recovery qualification runbook

Restore is always executed on a disposable server and a uniquely named Compose
project. It never points at the live project, never reuses live volumes, and
never runs `docker compose down -v`.

## Inputs

Download the encrypted archive and its separately written `SUCCESS.json` marker
from the independent destination. Prepare mode-600 files for the age identity,
disposable Compose env, and disposable Object Storage SSE-C key. Set
`RESTORE_FAILURE_AT` to the declared failure time before running the script.
Keep the live application credentials and Socium recovery identity out of the
restore receipt.

## Procedure

1. Provision or select a disposable server with the same approved image and
   enough disk/RAM for the qualification dataset. Record the base image and all
   CI image digests.
2. Unlock a disposable LUKS2 data volume using the LUKS runbook. Point
   `RESTORE_ROOT` and the Compose bind paths exclusively at that volume.
3. Run `scripts/restore/restore-recovery-set.sh` with the versioned target
   `RESTORE_TARGET_ID=restore-disposable`,
   `RESTORE_DOCKER_CONTEXT=litt-restore-<approved-id>`,
   `RESTORE_PUBLIC_BASE_URL`, `RESTORE_PUBLIC_ALLOWED_HOST`,
   `RESTORE_OBJECT_ENDPOINT`, and `RESTORE_OBJECT_ALLOWED_HOST` exactly matching
   `infra/production/disposable-targets.json`. Provide
   `RESTORE_CA_CERT_FILE` for the disposable Caddy `tls internal` certificate;
   never use `--insecure`. The approved disposable ingress may proxy the HTTPS
   host to Caddy, but no production host port is published. The script decrypts with
   `age`, checks
   `SHA256SUMS`, matches the archive to `SUCCESS.json`, loads PostgreSQL, restores
   object contents into a disposable versioned bucket with SSE-C, and verifies
   backend `/ready` reports database, storage, and Auth green.
4. Supply `RESTORE_EXPECTED_COUNTS_FILE` when the qualification dataset is
   loaded. The minimum dataset is **4 users, 2 workspaces, 6 matters, 100 documents**, memberships/roles, chats, executions, outputs/receipts,
   adversarial reviews, batches/sources/fragments/embeddings, audit events, and
   publication manifests. Record counts and SHA-256s, not customer text or
   secrets.
5. Reconcile object count, content hashes, object-to-row references, execution
   and receipt links, current versions, a positive synonym search, negative
   cross-matter/revoked searches, and publication-manifest state. Verify the
   restored Auth users can sign in through the disposable public route.
6. Preserve the generated restore receipt, timing, image lock, migration
   version, and sanitized logs. Destroy the disposable project only after the
   receipt is copied to the approved evidence store.

## Objectives and rollback

RPO is the seconds between the latest recovered set timestamp and
`RESTORE_FAILURE_AT`; it must be ≤ 24 hours. RTO starts before decryption and
ends only when readiness, integrity checks, and two designated-user accesses
are green; it must be ≤ 4 hours.

If migration or readiness fails, do not edit the live database. Roll back the
candidate release by restoring the previous immutable image lock in the
**disposable** project, or create a new disposable project from the last known
good recovery set. A production migration is preceded by a complete recovery
set and a rehearsed migration. No destructive migration is accepted without a
new restore receipt.

A restore with missing counts, hash mismatch, cross-matter visibility, stale
readiness, or RPO/RTO failure is `restore_failed`, not partial success.
