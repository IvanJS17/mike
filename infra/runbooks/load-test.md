# WS2 Gate B load profile

Run only against the approved private staging/Hetzner candidate with synthetic
or anonymized fixtures. Set `LOAD_APPROVAL=YES` after recording the owner,
window, source IP, and cleanup plan. The runner refuses the local Compose file
and does not read credentials from Git.

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
- sanitized host metrics fixture for RAM, OOM, swap, disk, queue resume, and
  readiness.

Run:

```bash
scripts/load/run-ws2-load.sh
```

The user fixture and metrics fixture are mode-600 files outside Git. The report
contains only counts, timings, status codes, thresholds, and image/version
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
sanitized metrics input. Stop the runner, delete only its synthetic fixture and
its disposable queue rows, and verify no load process or listener remains. Do
not stop the governed local demo stack or remove its volumes.
