# LiTT Project Status

> Canonical operational status for this fork. Kanban cards are execution receipts,
> not the project roadmap or source of truth.

**Last reconciled:** 2026-08-24<br>
**Repository:** `IvanJS17/mike`<br>
**Upstream:** `Open-Legal-Products/mike`

## Executive status

LiTT is a Mexican legal-practice adaptation of MikeOSS. The Beta Jurídica 0.1
vertical journey is implemented, locally verified and independently reviewed on a
candidate branch, but it is not merged into `origin/main`. Meanwhile, MikeOSS has
advanced materially. New feature work is paused until LiTT is consolidated and the
upstream recovery plan is executed.

This is not a production-readiness claim. No current remote staging or production
runtime was verified while producing this status.

## Immutable Git identities

The values below were read from Git after fetching `origin` and `upstream` on
2026-08-24.

| Line | Commit | Tree | Meaning |
| --- | --- | --- | --- |
| Common ancestor | `204d2d533a075c74fc69f8b283c70fb4e94ec104` | resolve from Git | Last shared baseline before the current divergence |
| LiTT `origin/main` | `4a00c115f8536a346279e03031c5633e8131f6da` | `18dfcd88850fc388ad2a6675493c3c46be65c404` | Integrated LiTT main before the full Beta journey |
| Beta candidate | `22cba89fe104b3c9df518762fb5a7170a5b16b03` | `4aba258495698862e5e77268beeefd5ca38ea459` | Reviewed Beta Jurídica 0.1 candidate |
| MikeOSS `upstream/main` | `54681b550d991f8c885f19f93dec762f1967ab3f` | `61c4fa3de4e75ffd8a332966d6e36f11d41a654b` | Upstream tip observed during the audit |

Git relations from the common ancestor:

- LiTT main has 16 fork-only commits and lacks 254 upstream commits.
- Beta has 28 fork-only commits and lacks the same 254 upstream commits.
- Beta is 12 commits ahead of LiTT main; LiTT main has no commit absent from Beta.
- Beta and upstream changed 104 common paths. A static merge simulation produced
  extensive manual conflicts; it was not executed as a real merge.

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

Candidate: `test/beta01-integrated-recovery@22cba89`.

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

No PR, merge or deploy is implied by that verdict.

## Current lifecycle state

| State | Status |
| --- | --- |
| Local Beta implementation | Complete on candidate branch |
| Focused verification | Passed for the candidate snapshot |
| Independent review | Passed with non-blocking reservations |
| Push | Candidate branch published to origin |
| PR | Not created |
| Merge to LiTT main | Not performed; requires separate authorization |
| Post-merge CI | Not applicable yet |
| Local staging harness | Versioned; historical local smokes are not current remote proof |
| Remote staging | Not verified |
| Real Shared Drive canary | Blocked pending dedicated account/token/folder and authorization |
| Production | Not deployed or verified |

## Current blockers and risks

1. **Upstream drift:** 254 upstream-only commits since the common ancestor.
2. **Internal branch drift:** the reviewed Beta candidate is not in LiTT main.
3. **Schema reconciliation:** both lines substantially changed `backend/schema.sql`
   and migration semantics.
4. **Provider architecture:** upstream moved to Vercel AI SDK while LiTT added
   governed routes, BYOK and receipts on the previous adapter layer.
5. **Workflow architecture:** upstream moved workflows into a database-backed
   catalog; the Mexican playbook must be ported with provenance and hashes.
6. **Word add-in overlap:** upstream rewrote document chat/edit workflows while
   Beta added governed redline application.
7. **Retention decision:** product semantics for deleting projects/accounts while AI
   and audit records are append-only remain undefined for production.
8. **Operational evidence:** no remote staging, restore or real provider/Drive proof
   is current for this candidate.
9. **Documentation drift:** prior status was spread across cards and README claims.
10. **Coverage debt:** backend and UI surfaces outside the Beta journey remain
    incompletely covered; existing coverage documents may lag the recovery result.

The actionable ledger is in [`TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md).

## Current decision and next gate

New product features are paused. The next authorized engineering program is the
[`UPSTREAM_RECOVERY_PLAN.md`](UPSTREAM_RECOVERY_PLAN.md):

1. publish this control package;
2. obtain explicit authorization to integrate the reviewed Beta snapshot into LiTT
   main as the internal baseline;
3. rebuild the adaptation layer on a pinned current upstream core in bounded slices;
4. prove parity through the Beta journey and release gates;
5. enter the permanent upstream policy.

See [`RELEASE_GATES.md`](RELEASE_GATES.md) for what each PASS does and does not
authorize, and [`UPSTREAM_POLICY.md`](UPSTREAM_POLICY.md) for the steady-state rule.
