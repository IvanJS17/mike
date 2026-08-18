# WS2 Gate B load profile

Run only against the versioned target in `infra/production/disposable-targets.json`:
`LOAD_DISPOSABLE_TARGET_ID=staging-load-disposable`, with
`LOAD_BASE_URL` and `LOAD_ALLOWED_HOST` equal to that manifest. The target must
not be localhost, production, or the governed local demo. Set `LOAD_APPROVAL=YES`
only after recording the owner, window, source IP, and cleanup plan.

## Fixed profile

- 30 minutes exactly (`1800` seconds);
- 4 authenticated accounts, each creating/listing/opening workspaces and matters;
- accounts: 4;
- 4 accounts total;
- uploads/downloads of 10 MB files;
- 3 configured chat/workflow paths;
- one 100-document / 1,000-page batch;
- 100 documents total;
- 1,000 pages total;
- 10 induced failures followed by an idempotent resume;
- collector versionado de muestras agregadas para RAM, OOM, swap, disk, cola,
  tiempos y readiness; no se acepta un JSON de métricas suministrado por el operador.

Run:

```bash
scripts/load/run-ws2-load.sh
```

The disposable backend must set `SYNTHETIC_LOAD_ENABLED=true`; the production
Compose environment never enables this seam. The runner uses the exact routes and three interactive paths in
`infra/production/disposable-targets.json`: `/api/test/load/workspaces` and
`/api/test/load/matters` create/list the real tenancy rows, `/api/single-documents`
for upload, the user-bound `/api/download/user/<token>` URL returned by upload,
`/api/test/load/batch` for the durable synthetic queue ledger, and
`POST:/api/chat`, `POST:/api/workflows`, `GET:/api/test/load/workspaces` for
interactive paths. The fixture contains only four synthetic users and is mode-600
outside Git; metrics are collected by `scripts/load/collect-disposable-metrics.sh`.
The report contains only counts, timings, status codes, thresholds, and image/version
references. It must not contain user tokens or document content.

## Passing thresholds

- RAM sustained `<75%`;
- zero OOM events;
- swap not sustained beyond 5 minutes;
- disk `<70%`;
- own-service 5xx `<1%`;
- own-service p95 `<2 seconds`, excluding external LLM latency;
- queue resumes all ten induced failures without duplicates;
- readiness remains green.

A failed threshold produces `resize_to_8gb_and_repeat_profile`; it does not
silently pass or change OpenTofu. If the optimized 8 GB repeat still fails, Gate
B remains red and the architecture decision returns to Iván.

## Evidence and cleanup

Preserve the JSON report, timestamps, image digests, migration version, and the
collector samples. The runner deletes its four real tenancy rows, uploaded
objects, and `synthetic_load_runs` row in its cleanup trap; after interruption,
run `REAPER_APPROVAL=YES REAPER_TARGET_KIND=load REAPER_TARGET_ID=staging-load-disposable REAPER_DOCKER_CONTEXT=litt-load-disposable REAPER_PROJECT=litt-load-disposable REAPER_COMPOSE_ENV_FILE=/srv/litt-load/secrets/compose.env LITT_APP_ROOT=/opt/litt scripts/restore/reap-disposable-target.sh`, then verify no load process, container, volume, network, or listener remains. Do not stop the governed local demo stack or remove its volumes.
