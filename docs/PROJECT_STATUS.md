# LiTT Project Status

> Canonical operational status for this fork. Kanban cards are execution receipts,
> not the project roadmap or source of truth.

**Last reconciled:** 2026-08-30<br>
**Repository:** `IvanJS17/mike`<br>
**Upstream:** `Open-Legal-Products/mike`

## Executive status

LiTT is a Mexican legal-practice adaptation of MikeOSS. The Phase 0 control package,
the reviewed Beta Jurídica 0.1 baseline and the reviewed upstream compatibility
ledger are integrated in `origin/main`. Phase 0 and Phase 1 are complete. Product
recovery implementation has not started: no writer is active, and Phase 2 remains
blocked on the coordinator-owned compiling contract scaffold and migration baseline.

This is not a production-readiness claim. No current remote staging or production
runtime was verified while producing this status.

## Immutable Git identities

The values below were read from Git after fetching `origin` and `upstream` on
2026-08-30. The ledger-acceptance baseline is the immutable input to this docs-only
closeout; this file intentionally does not predeclare the future squash OID of its
own PR.

| Line | Commit | Tree | Meaning |
| --- | --- | --- | --- |
| Common ancestor | `204d2d533a075c74fc69f8b283c70fb4e94ec104` | `0cf7a04ffbe325b005066d6783238ac872ce3b88` | Last shared lineage baseline |
| Ledger-acceptance LiTT baseline | `0cafb80c85e8a0e75f7f78df744eb4806b7057d6` | `e2d87cd2e9712233c3fe409949986e0feee8f083` | PR #19 squash; control package, Beta and compatibility ledger integrated before this docs-only closeout |
| Final Beta PR head | `192310b6930d430667d729ed943e15e8441a61b1` | `5fbf99682e0e9592bfc53ff7a7cd7cdf3f8144d6` | Exact PR #18 head after the reviewed Playwright selector delta |
| Historical Beta analysis reference | `22cba89fe104b3c9df518762fb5a7170a5b16b03` | `4aba258495698862e5e77268beeefd5ca38ea459` | Behavior snapshot inspected by all four read-only analyses |
| Pinned MikeOSS recovery target | `1b58c7aa0520ff185c44698cea1a9e0c96af50ab` | `ce8d7e1a6e4b5460258441a5568a353c52180162` | Upstream target analyzed and re-fetched unchanged at closeout |

Git relations from the common ancestor:

- At ledger acceptance, LiTT main had 19 fork-only commits and lacked 278 commits
  from the pinned upstream target.
- From the common ancestor, that baseline changed 265 paths and upstream changed
  718 paths; 108 paths overlapped.
- The ledger-acceptance baseline differs from the final Beta PR head on seven paths: `README.md`,
  the five canonical control documents and the compatibility ledger. The composed
  Beta/control proof is recorded in the compatibility ledger; no monolithic merge
  was used.

Moving refs can change after this document. Every recovery task must fetch and pin a
new immutable tuple before implementation.

## Product boundary

### MikeOSS core

The upstream product supplies the general legal-AI platform: authentication,
projects, document library, assistant/chat, tabular review, workflows, model
providers, Word add-in and supporting infrastructure.

### LiTT adaptation

LiTT adds or changes behavior for Mexican legal practice and controlled firm use:

- organization/workspace/matter tenancy and private matters;
- expanded RLS, authorization epochs and revocation boundaries;
- governed BYOK/model routing;
- insert-only audit and AI evidence records;
- expiring, single-use document download grants;
- removal of the US CourtListener workflow from the Mexican product surface;
- Civil/Mercantile MX playbook provenance;
- human review, approved DOCX, redline and Shared Drive publication;
- reproducible local staging, recovery and external-canary harnesses.

### Beta Jurídica 0.1

Beta 0.1 is an acceptance journey, not the whole product. It proves this vertical
slice with local fakes:

```text
owner/private matter
  -> DOCX R4/R6/R9
  -> deterministic AI execution + hashes/citations/receipt
  -> different reviewer reject/edit/accept
  -> approved DOCX + redline
  -> fake Drive publication + idempotent rehydration
  -> audit assertions + outsider 404
  -> disposable teardown with zero owned residue
```

It does not prove all assistant tools, all model providers, complete tabular review,
remote staging, production, real Google Drive, load/performance, or upgrade of an
existing production database.

## Beta evidence receipt

Historical reviewed candidate: `test/beta01-integrated-recovery@22cba89`.

Observed implementation evidence:

- targeted Playwright: 2/2 passed;
- `tsc`: passed;
- shell syntax and helper syntax checks: passed;
- `git diff --check`: passed;
- focused `aiCitations`: 16/16 passed;
- disposable cleanup: zero owned processes/containers;
- real AI calls: 0;
- real Google calls: 0.

Independent governing review:

- Kanban task: `t_6ad4f0c2`;
- reviewed exact commit/tree: `22cba89` / `4aba258`;
- verdict: **PASS with non-blocking reservations**.

Integration evidence:

- final PR head: `192310b6930d430667d729ed943e15e8441a61b1` /
  `5fbf99682e0e9592bfc53ff7a7cd7cdf3f8144d6`;
- PR #18 exact-head CI: 8/8 PASS;
- squash merge: `cc497bbf8f2ca7407d19801c4750340636e46548` /
  `60aba275013aa788bc6d57ddd32b20f5cca03afb`;
- post-merge push workflows: CI, Stack tests, CodeQL, Secret scan and Scorecard PASS;
- bounded integrated Beta journey: 2/2 PASS with fake provider/Drive;
- real AI calls: 0; real Google calls: 0;
- attributed cleanup: zero owned resources and the disposable worktree removed.

This evidence proves the local/integrated Beta boundary only. It does not imply
remote staging, a real provider/Drive canary or production.

## Current lifecycle state

| State | Status |
| --- | --- |
| Phase 0 control package | Integrated by PR #17 at `d63fdd83`; governing review `t_a6d77f46` PASS with non-blocking reservations |
| Beta implementation | Integrated by PR #18 at `cc497bb`; final reviewed head `192310b6` |
| Beta G3 exact-head CI | 8/8 PASS |
| Beta G4 post-merge | 5/5 push workflows plus bounded 2/2 Beta journey PASS; cleanup complete |
| Compatibility ledger | Integrated by PR #19 at `0cafb80`; review `t_15f7252d` PASS; PR CI 8/8 and post-merge 5/5 PASS |
| Upstream recovery implementation | Not started; writers active: 0 |
| Local staging harness | Versioned; historical local smokes are not current remote proof |
| Remote staging | Not verified |
| Real Shared Drive canary | Blocked pending dedicated account/token/folder and authorization |
| Production | Not deployed or verified |

## Current blockers and risks

1. **Upstream recovery:** 278 upstream-only commits remain to be reconstructed or
   classified in executable Phase 2 slices.
2. **Schema reconciliation:** both lines substantially changed `backend/schema.sql`
   and migration semantics.
3. **Provider architecture:** upstream moved to Vercel AI SDK while LiTT added
   governed routes, BYOK and receipts on the previous adapter layer.
4. **Workflow architecture:** upstream moved workflows into a database-backed
   catalog; the Mexican playbook must be ported with provenance and hashes.
5. **Word add-in overlap:** upstream rewrote document chat/edit workflows while
   Beta added governed redline application.
6. **Retention decision:** product semantics for deleting projects/accounts while AI
   and audit records are append-only remain undefined for production.
7. **Operational evidence:** no remote staging, restore or real provider/Drive proof
   is current for the integrated baseline.
8. **Coverage debt:** backend and UI surfaces outside the Beta journey remain
    incompletely covered; existing coverage documents may lag the recovery result.

The actionable ledger is in [`TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md).

## Current decision and next gate

New product features remain paused. Phase 0, Phase 1 and the compatibility-ledger
gate are complete. The next engineering gate in
[`UPSTREAM_RECOVERY_PLAN.md`](UPSTREAM_RECOVERY_PLAN.md) is Phase 2 setup:

1. create the coordinator recovery worktree from pinned upstream
   `1b58c7aa0520ff185c44698cea1a9e0c96af50ab`;
2. establish the compiling RED contract scaffold, migration baseline and shared
   interfaces under coordinator ownership;
3. execute Slice A serially before any limited writer parallelism;
4. prove recovered parity through the Beta journey and release gates;
5. enter the permanent upstream policy only after the recovered candidate completes
   Phase 3 and is integrated.

No writer starts from this documentation transition, and no retention, egress,
tenancy or jurisdiction decision is inferred.

See [`RELEASE_GATES.md`](RELEASE_GATES.md) for what each PASS does and does not
authorize, and [`UPSTREAM_POLICY.md`](UPSTREAM_POLICY.md) for the steady-state rule.
