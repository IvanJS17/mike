# Phase 3 recovery decision package

## Decision boundary

This is a candidate for owner decision, not an integrated/deployed product.
Application verification is complete for the bounded contracts below. Gate 16 is
BLOCKED **at source freeze** until the governing Hermes Reviewer returns a terminal
PASS for the exact tree. Its external receipt and publication receipt finalize the
lifecycle without changing reviewed documentation. A historical PASS never governs
this source. No PR, merge, formal post-merge G5, remote canary or deploy is authorized.

## Exact inputs and publication contract

- Repository: `https://github.com/IvanJS17/mike.git`.
- Recovery branch: `recovery/upstream-1b58-phase2`.
- Parent: `f4dc9846eaa5fba2a97288c645112a59eaadba36`, tree `31262db2d54e11e4c35b7addaaabe81734f97f2e`.
- Pinned upstream: `1b58c7aa0520ff185c44698cea1a9e0c96af50ab`, tree `ce8d7e1a6e4b5460258441a5568a353c52180162`.
- Supported LiTT upgrade baseline/current main observed before publication: `d9fa8380e63837b6441cef169cf5ef80dfb55e54`.
- Remote recovery before publication: `d44edb90e079248351185968cc516ce70f21d9af`.
- Final HEAD/tree, governing card, commit/tree equality and remote readback are
  mechanically recorded in the external closeout receipt, not guessed here.

## Functional result and invariants

The candidate retains upstream core/taskpane architecture and ports LiTT private
matters, MFA/tenancy/epoch checks, scoped document access, governed provider/receipt
contracts, append-only evidence/audit, reviewer separation, approved DOCX/redline
and idempotent publication. CourtListener routes/tools/key/preferences/UI are
removed; uploaded-document citations and ordinary controls are preserved.

The frozen Civil/Mercantile MX R4/R6/R9 definition is synchronized into the sole
`mike_workflows` catalog. Its own source commit survives mixed catalog sync; invalid
explicit source commits are rejected. Beta execution loads the active DB row and
exact prompt bytes/hash rather than falling back to an in-memory registry.
Legal validation remains pending; this is not legal certification.

The final integrated Beta uses real local Auth/MFA, HTTP review/export/publication,
PostgreSQL and MinIO. AI creation is a bounded TEST-HARNESS composition over real
production domain/persistence/parser boundaries with a **fake sender and synthetic
credential**, not a newly invented product endpoint. It proves a distinct reviewer
fixture, not a person's actual legal approval. Google Drive is a consistent fake;
Word is tested separately with Office/API mocks. Browser rendering, real Word,
real LLM/Drive, real DB-BYOK acceptance and load are not inferred from this journey.

## Sixteen-gate matrix

Each PASS has a scoped receipt. Default skips remain omitted, not passed. Backend
and Word have no lint script (not applicable); frontend lint has zero errors and
33 unchanged baseline warnings. Node 26 DOM tests use a scoped
`NODE_OPTIONS=--no-experimental-webstorage`, with real storage assertions intact.

| # | Criterion | State at freeze | Evidence |
| --- | --- | --- | --- |
| 1 | Backend type/build/lint | PASS | `phase3-backend-unit.log`, `final-backend-build.log` |
| 2 | Frontend type/build/lint | PASS | `final-frontend-online-build.log`, `courtlistener-frontend-final.log`, `courtlistener-eslint.json`, `frontend-word-source-equivalence.json` |
| 3 | Word build and bounded E2E | PASS | `phase3-word-final-build.log`, `litt-word-3092102d9a6641bd95205b2ffd505783/command.json` |
| 4 | Fresh bootstrap | PASS | `integrated-core-final.log` |
| 5 | Populated supported ordered upgrade incl historical Drive | PASS | `phase3-drive-sql.log` |
| 6 | Full fresh/upgrade security/schema fingerprint | PASS | `integrated-core-final.log`, `phase3-drive-sql.log` |
| 7 | Auth/MFA/tenancy/private matter/revocation | PASS | `final-beta-runtime-569a3523b797/parent-verified.json` |
| 8 | Providers/router/BYOK/pins/zero real egress | PASS | `phase3-backend-unit.log` |
| 9 | Persisted mike_workflows MX R4/R6/R9 identity | PASS | `final-beta-runtime-569a3523b797/parent-verified.json` |
| 10 | Integrated Beta journey | PASS | `final-beta-runtime-569a3523b797/parent-verified.json` |
| 11 | Approved-redline host contracts | PASS | `litt-word-3092102d9a6641bd95205b2ffd505783/command.json` |
| 12 | Fake Drive publication/retry/reconcile/rehydration | PASS | `phase3-drive-sql.log`, `final-beta-runtime-569a3523b797/parent-verified.json` |
| 13 | Staging smoke and owned cleanup | PASS | `final-beta-runtime-569a3523b797/parent-verified.json` |
| 14 | Functional isolated evidence backup/restore | PASS | `final-beta-runtime-569a3523b797/parent-verified.json` |
| 15 | Secrets/history/diff/generated scope | PASS | `final-history-scan.log`, `final-delta-scan.log` |
| 16 | One governing exact-snapshot Reviewer | BLOCKED | Exact-tree Kanban receipt, external after freeze |

Machine-readable summary: [phase3-verification.json](recovery-evidence/phase3-verification.json).
Raw logs/receipts are under the coordinator evidence directory
`/home/ijs/projects/mike/forensics/slice-g-preflight/resume-20260909/`; hashes in the
summary bind each named log. The deliverable evidence archive contains sanitized
receipts/log excerpts and the later governing/publication receipts. Local command
success is not remote GitHub CI. The schema-drift workflow now invokes the proven
populated/full-fingerprint drivers; default E2E does not inject real-provider secrets.

After the final Beta, only CI wiring, one test-only readiness probe (TCP instead
of the temporary bootstrap socket) and documentation changed. The canonical CI
command was executed locally: 14/14 PASS. The application/image bytes exercised
by Beta are unchanged; this equivalence is recorded separately from the final
Git tree. The earlier readiness attempt remains FAIL, not acceptance evidence.

## Fresh, upgrade and recovery evidence

- Current fresh/upgrade core: 5/5 checks including full schema/security fingerprint,
  populated preservation, malformed-state rollback, native UTF-8 hashing and catalog
  provenance; teardown is part of PASS.
- Supported populated legacy Drive upgrade and publication: 14/14 SQL checks,
  preserving pre-series historical outcomes and immutable data. The explicit
  source-hash manifest keeps the preflight before E2a; no directory-wide replay.
- Final Beta: 147 source checks and 89 restored-target checks; one fake provider
  call and one fake Drive upload. Unknown outcome/retry/reconcile does not duplicate
  the object. Restored review/publication and actual approved DOCX bytes are read back.
- All database content, security, schema and persistent/logical storage invariants
  are checked through the post-HTTP phase. Both stacks, listeners and private
  workspaces were independently absent after teardown.
- This is same-image, stopped-writer, local recovery. It does not establish a
  production rollback procedure, encrypted remote backup, production RPO/RTO,
  cross-version upgrade restore or backup of a real external Drive account.

## Failures retained, not relabelled

Earlier storage, image/file ownership, ambiguous PostgREST join, extension lookup,
canonical/enriched receipt, fake lookup and environment failures remain in their
original logs. Their later successes do not rewrite them. One Core runtime timeout
created a late owned container; its exact-ID rescue is recorded separately and the
original attempt remains FAIL. The successful subsequent runtime includes cleanup.
The offline frontend build failed on required Google Fonts downloads; the actual
successful build fetched public font dependencies. Runtime LLM/Drive egress stayed
fake and isolated. No placeholder fonts or fabricated responses were used.

## Proposed PR — not created

Title: **Recover pinned MikeOSS core with governed LiTT Beta and isolated recovery**

Proposed body:

- Reconstruct the pinned upstream core, preserving the approved compatibility ledger
  rather than merging histories monolithically.
- Preserve private matter/auth/epoch/evidence/review/redline/publication invariants;
  remove unsupported US research; use the persisted versioned MX workflow catalog.
- Include the declared supported upgrade manifest, full fingerprints, real local
  synthetic Beta/restore and truthful host/provider/debt boundaries.
- Link this package, the exact governing review and published recovery OID.

After separate PR authorization, require exact-head results for applicable CI,
Stack tests, schema drift, Word, E2E, secret scan and CodeQL. Inspect actual workflow
filters/job results; absent, skipped-required, stale or cancelled checks are not
GREEN. No deploy is inferred. Re-read PR HEAD and use that exact OID as the merge
guard only after separate merge authorization. Do not reuse a review if bytes move.

## Separate owner decisions and Phase 4 handoff

1. **G3:** authorize creation of the PR; run/read exact-head CI and resolve its actual
   failures. The current package neither creates a PR nor claims remote CI success.
2. **G4:** authorize the method and exact-head merge, then verify resulting main,
   post-merge CI and a bounded smoke on those integrated bytes.
3. **Formal G5:** re-run isolated staging/restore on the integrated commit; this
   candidate's rehearsal does not complete it.
4. **G6:** authorize each real provider, Drive account/folder, SMTP, remote staging,
   backup destination, monitoring/DNS and real Word host separately.
5. **G7:** approve production topology/access/retention, encrypted backup and accepted
   recovery targets, source offer, monitoring/incident owner and rollback triggers.

Only after integration, activate the existing Phase 4 policy: weekly fetch/pin and
classification without merge, bounded sync at least fortnightly, and extraordinary
security windows. Pause feature expansion at the policy thresholds (more than 30
unclassified commits; more than 14 days without intake; security/auth/storage/schema
unclassified for three business days; more than 15 unplanned hot-zone files; or loss
of fresh/upgrade convergence). Do not advance the current upstream pin here. No cron
or external automation was activated. Use the retained debt owner/exit ledger in
`TECHNICAL_DEBT.md`; do not recreate completed A–F analyses or treat this package as
closure of retention, real hosts, performance or operational source-offer work.
