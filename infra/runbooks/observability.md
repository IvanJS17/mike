# Observability, migration, rollback, and release runbook

## Readiness and metrics

The public Caddy route exposes `/api/ready` for the external availability probe.
The backend endpoint is green only when a real DB query, an S3 list operation,
and a GoTrue `/settings` request all succeed. A 503 response contains only
boolean status and timings; it never returns credentials or dependency errors.

`/metrics` is internal to the Compose network. It reports process CPU/RAM,
request counts, 5xx count, p95 latency, queue depth/retries, and uptime. The
host collector adds encrypted-disk usage, host RAM/CPU, and container resource
percentages. It must be scraped or shipped through the approved monitoring
boundary; do not expose it publicly or log request bodies.

Load `infra/observability/alerts.yml` into the approved monitor. Required alerts
cover availability, disk >=70%, RAM >=75%, OOM, backup/freshness, restore,
publication/reconciliation, and a stalled queue. The first backup failure must
page the operator; 24 hours without a complete set disables real-data intake.

## Migration rehearsal

Before a production migration:

1. create and verify a complete recovery set;
2. freeze the current image lock and record the schema/migration version;
3. create a disposable env/project named `litt-rehearsal-*`;
4. run `scripts/migrations/rehearse-production.sh`, which applies fresh schema
   and then all migrations a second time to exercise idempotency;
5. run readiness, the targeted authorization suite, and the smoke workflow;
6. preserve the sanitized receipt with image digests and migration version.

`apply-production.sh` is used only through the `ops` Compose profile. It does
not run as part of ordinary `up -d`, and it never uses `docker-compose.yml`.

## Rollback

Rollback is immutable and evidence-first:

- stop publication and new migration attempts;
- restore the previous backend/frontend image digests in the deployment env;
- if the schema is incompatible, restore the latest verified recovery set into a
  new disposable project first and validate it;
- apply the approved database restore/migration rollback procedure only after
  the owner authorizes the maintenance window;
- re-run `/api/ready`, authorization checks, and publication reconciliation;
- keep the failed release and receipt for audit; never overwrite the receipt.

No rollback uses mutable tags, `latest`, `docker compose down -v`, or an ad-hoc
SQL edit against production.

## Release inventory and AGPL source offer

Every release receipt records the Git commit, backend/frontend/base image
references by digest, Supabase image versions, migration version, OpenTofu
module version, Caddy configuration digest, and the source offer URL for the
AGPL code. The offer is visible in the Caddy `X-LiTT-Source-Offer` response
header and must resolve to the exact public fork/source snapshot.

## Permissions after infrastructure changes

After every firewall, SSH, volume, secret, Compose, or systemd change:

- verify only nominal VPN keys/users can SSH;
- verify `/srv/litt-data` and `/srv/litt-secrets` are on the LUKS mapper;
- verify secret files are 0600 and directories 0700;
- verify PostgreSQL, Auth, REST, backend, and frontend have no host ports;
- verify only Caddy has 80/443;
- inspect effective Docker mounts, networks, and restart policies;
- record the before/after permission review without including secret values.
