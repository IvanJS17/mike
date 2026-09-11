# LiTT Project Status

> Canonical operational status for this fork. Kanban cards are execution receipts,
> not the project roadmap or source of truth.

**Last reconciled:** 2026-09-09<br>
**Repository:** `IvanJS17/mike`<br>
**Upstream:** `Open-Legal-Products/mike`

## Executive status

Phase 2 recovery has been assembled on `recovery/upstream-1b58-phase2`, based on
the pinned MikeOSS core and ported LiTT invariants, not a monolithic upstream merge.
The final Phase 3 candidate includes DB-backed MX catalog content, removal of
CourtListener, governed evidence/review/approved artifacts, and an isolated
fake-provider/fake-Drive Beta plus populated backup/restore harness.

The current evidence and the 16 acceptance criteria are recorded in
[`PHASE3_RECOVERY_DECISION.md`](PHASE3_RECOVERY_DECISION.md). That package separates
code/test proof from the governing exact-tree review and publication receipts.
A historical PASS or a successful build does not approve this candidate.

Authorized close boundary: exact-snapshot Reviewer PASS, commit, recovery-only
push and independent remote readback. No new PR, merge, remote deployment, real
LLM/Drive canary or production promotion is authorized. Main remains the supported
`d9fa8380e63837b6441cef169cf5ef80dfb55e54` baseline observed at reconciliation.

## Current immutable input identities

| Input | Commit | Tree |
| --- | --- | --- |
| Last reviewed recovery parent | `f4dc9846eaa5fba2a97288c645112a59eaadba36` | `31262db2d54e11e4c35b7addaaabe81734f97f2e` |
| Pinned upstream target | `1b58c7aa0520ff185c44698cea1a9e0c96af50ab` | `ce8d7e1a6e4b5460258441a5568a353c52180162` |

The commit containing this document, its exact tree, Reviewer card/verdict and
published remote OID are recorded externally after freeze. This avoids
predeclaring a self-referential commit or editing documentation after approval.

## Historical immutable Git identities (2026-08-30)

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

Moving refs can change. Revalidate the recovery tuple before a new task; do not
advance the pinned upstream target during this recovery closeout.

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
| Upstream recovery implementation | Assembled on recovery; exact-candidate technical evidence in the Phase 3 package; main integration remains a separate gate |
| Local staging harness | Versioned; historical local smokes are not current remote proof |
| Remote staging | Not verified |
| Real Shared Drive canary | Blocked pending dedicated account/token/folder and authorization |
| Production | Not deployed or verified |

## Current blockers and risks

The former reconstruction blockers (schema, auth/tenancy, provider architecture,
workflow catalog and Word overlap) have candidate implementations and verification
receipts. Their governance and integration states must be read from the exact
Phase 3 receipt, not inferred from the older Beta evidence above.

Remaining release decisions/debt:

- production retention/erasure remains undefined; destructive evidence operations
  remain fail-closed and disposable test teardown is not a retention mechanism;
- real Word host compatibility, remote staging, real providers/Shared Drive,
  SMTP, backups, monitoring/DNS and production each need their own permission;
- representative load, global coverage, broader frontend scenarios, operational
  AGPL source offer and historical-worktree cleanup remain bounded follow-ups.

The actionable owner/exit ledger is in [`TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md).

## Current decision and next gate

Finish the candidate's 16 gates and consume one exact-snapshot Reviewer verdict.
Only after PASS may the already-authorized recovery-only publication occur.
The owner then decides PR authorization; exact-head CI, merge/post-merge, formal
G5, each G6 boundary and G7 production remain separate. A candidate restore is not
formal post-merge G5. Permanent Phase 4 intake is prepared, not activated, and the
upstream pin is unchanged. No cron or external automation is authorized here.

See [`RELEASE_GATES.md`](RELEASE_GATES.md) for what each PASS does and does not
authorize, and [`UPSTREAM_POLICY.md`](UPSTREAM_POLICY.md) for the steady-state rule.
