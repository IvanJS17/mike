# LiTT Upstream Recovery Plan

> **For Hermes:** Execute this plan through bounded worktrees and atomic snapshots.
> Use one governing Reviewer-profile verdict per immutable integration snapshot.

**Goal:** Move LiTT onto a current MikeOSS core without losing Mexican tenancy,
security, legal workflow, evidence, review, redline or Drive invariants, then establish
a permanent low-drift upstream process.

**Strategy:** Do not merge all of upstream directly into the current Beta branch.
Consolidate Beta as an internal reference baseline, create a recovery branch from a
freshly pinned upstream tip, and port LiTT capabilities in ordered slices. Treat Beta
as the no-regression acceptance contract rather than the architecture to preserve.

**Current identities:** See [`PROJECT_STATUS.md`](PROJECT_STATUS.md). Every execution
must fetch again and replace moving refs with full commit/tree OIDs before work.

## Non-negotiable constraints

- Never edit `main` directly; use a dedicated worktree per implementation slice.
- Do not weaken tenancy, RLS, revocation, private-matter, audit or AI evidence
  boundaries to resolve upstream conflicts.
- Do not re-enable CourtListener as a Mexican legal-research feature without a new,
  reviewed product decision and jurisdiction-specific source design.
- Keep provider credential, route, access token and refresh token semantics separate.
- Never contact real AI providers or Google from automated recovery tests.
- Fresh schema and incremental migrations must converge to the same supported state.
- A stale review, timeout or review of another tree is not PASS.
- Commit, push/PR, merge, staging and production remain separate authorization gates.
- Kanban executes this plan; it does not replace or silently rewrite it.

## Recovery architecture

```text
Reviewed LiTT/Beta baseline (behavioral reference)
                  |
                  | acceptance contracts and LiTT-only modules
                  v
Pinned current MikeOSS upstream core
                  |
       ordered LiTT adaptation slices
                  v
LiTT recovery candidate
                  |
         parity + release gates
                  v
new LiTT main baseline
                  |
       permanent upstream cadence
```

## Phase 0 — Control plane and freeze

### Objective

Stop unmanaged divergence and make status, debt, gates and upstream decisions
reproducible.

### Deliverables

- [`PROJECT_STATUS.md`](PROJECT_STATUS.md)
- this recovery plan;
- [`UPSTREAM_POLICY.md`](UPSTREAM_POLICY.md)
- [`TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md)
- [`RELEASE_GATES.md`](RELEASE_GATES.md)
- root README links to the control documents.

### Exit criteria

- all documents use the same commit/tree identities;
- no document claims PR/merge/staging/production that has not occurred;
- no product code changes;
- one documentation snapshot receives independent read-only review;
- new feature cards remain paused.

## Phase 1 — Consolidate the internal LiTT baseline

### Objective

Remove the internal `main` vs Beta split before recovery.

### Preconditions

- Phase 0 documentation merged;
- explicit owner authorization for PR/push/merge;
- Beta reviewer PASS remains bound to `22cba89` / `4aba258`;
- remote branch still points to that exact commit;
- no post-review changes.

### Procedure

1. Verify `origin/main`, Beta HEAD/tree, ancestry and clean worktree.
2. Open one PR from `test/beta01-integrated-recovery` to LiTT `main`.
3. Require exact-head CI; empty or stale checks are not green.
4. Re-read PR head, changed files, checks and no-deploy state.
5. Merge only with separate owner authorization and a head-OID match.
6. Verify resulting `origin/main` tree contains the approved Beta tree semantics.
7. Run post-merge CI and the bounded Beta acceptance gate once.
8. Record the resulting LiTT baseline OID in all control documents.

### Exit criteria

- one integrated LiTT main baseline;
- no floating product code unique to the Beta branch;
- post-merge verification green;
- no staging or production implied.

## Phase 2 — Rebuild LiTT on the current upstream core

### Objective

Create a current-core LiTT candidate by porting invariants in dependency order rather
than resolving a monolithic merge.

### Setup

1. Fetch upstream and pin the chosen full commit/tree.
2. Create one coordinator recovery worktree from that upstream commit.
3. Freeze a compatibility matrix: upstream capability, LiTT invariant, target module,
   migration impact, tests and disposition (`adopt`, `port`, `reject`, `defer`).
4. Establish compiling contract tests before parallel implementation begins.

### Slice A — Identity, tenancy and authorization

Port/reconcile:

- organization, workspace, matter and membership model;
- private matters and access lookup;
- RLS, service-role boundaries and authorization epochs;
- invitations, Google OAuth/onboarding, password recovery and MFA;
- insert-only audit policy and account/project deletion semantics.

Required evidence:

- cross-tenant 404/deny matrix;
- revocation during mutation;
- onboarding creates the intended initial organization/membership;
- email/password/OAuth flows cannot bypass tenancy or MFA;
- fresh schema and incremental migration checks.

Shared-file owner: coordinator for `backend/schema.sql`, migrations, auth middleware and
root route registration.

### Slice B — Documents and storage

Port/reconcile:

- private project/matter document access;
- download grants and tamper-evident hashes;
- upstream folder upload, conflict policy, multi-select and pagination;
- S3/R2 storage wrappers and object-prefix ownership;
- export/deletion boundaries.

Required evidence:

- object ownership and path confinement;
- single-use/expiry grants;
- upload conflict and bounded concurrency tests;
- account/project deletion contract against retained evidence.

### Slice C — Provider and model architecture

Adopt upstream Vercel AI SDK and current routers while preserving:

- governed BYOK;
- explicit provider/model route selection;
- credential source policy;
- no silent fallback for explicitly selected routes;
- egress and receipt provenance;
- fake-provider interception before any real network request.

Required evidence:

- provider matrix with env/user/router credentials;
- access token vs refresh token separation;
- model retirement and stale-selection behavior;
- no-provider/no-key fail-closed tests;
- receipts name the actual selected route/provider/model.

### Slice D — Workflow catalog and Mexican playbook

Adopt upstream database-backed workflow catalog, packs/add-ons and reference assets.
Port the Civil/Mercantile MX playbook as governed catalog content with:

- stable id/version;
- source and approval provenance;
- immutable content hash;
- R4/R6/R9 behavior;
- exact workflow hash in AI receipts;
- no dependency on retired `systemWorkflows.ts` architecture.

Required evidence:

- catalog sync idempotence;
- installed/default workflow behavior;
- playbook hash and version round-trip;
- edits cannot silently rewrite an executed receipt.

### Slice E — AI evidence and human review

Port/reconcile:

- executions, pages, outputs, receipts and citations;
- append-only triggers and integrity functions;
- reject/edit/accept and completion state machine;
- revocation/atomic write guards;
- approved DOCX and redline bundles;
- project/matter-scoped audit detail.

Required evidence:

- citation document/version/page/span/hash integrity;
- append-only negative tests;
- reviewer separation and revocation races;
- no pending item on approval;
- rejected finding excluded; edited/accepted findings included;
- production retention decision recorded before destructive endpoints are claimed.

### Slice F — Current Word add-in plus LiTT redline

Use upstream's current document-scoped chat, history, tracked edits, Direct/Review
mode and workflow UI. Port LiTT's approved-redline contract rather than preserving the
old add-in implementation wholesale.

Required evidence:

- reviewed bundle identity and revalidation before apply;
- multi-occurrence and whole-item edit rules;
- conflict/supersession behavior;
- Word web/desktop compatibility boundary;
- no unauthorized document/matter cross-use.

### Slice G — Drive, staging and recovery

Port/reconcile:

- approved DOCX publication;
- matter-bound folder configuration;
- upload verification, unknown outcome, bounded retry and cleanup;
- published-state rehydration;
- disposable local staging;
- fresh bootstrap, schema convergence and recovery.

Required evidence:

- fake Drive idempotence and zero real calls;
- authorization immediately before upload and record update;
- local staging smoke and zero residue;
- isolated backup/restore proof;
- real Drive canary remains a separate owner-authorized gate.

## Phase 3 — Parity and release candidate

### Objective

Prove that the recovered current-core LiTT preserves both upstream product behavior
and LiTT/Beta invariants.

### Required aggregate gates

1. backend typecheck/build/lint;
2. frontend typecheck/build/lint;
3. Word add-in build and bounded E2E;
4. fresh schema bootstrap;
5. ordered migration upgrade from supported LiTT baseline;
6. schema fingerprint convergence;
7. tenancy/RLS/auth integration tests;
8. provider/router/BYOK contract tests;
9. workflow catalog + Mexican playbook tests;
10. Beta integrated journey;
11. Word approved-redline journey;
12. fake Drive publication/rehydration;
13. staging smoke and mandatory cleanup;
14. isolated recovery/restore proof;
15. secret/history/diff checks;
16. one governing independent review of the exact candidate.

### Exit criteria

- zero open P0/P1 recovery blockers;
- all required gates have current exact-snapshot receipts;
- technical-debt ledger identifies every deferred non-blocker;
- no real external provider contact;
- owner receives a separate merge/staging decision package.

## Phase 4 — Permanent upstream operation

Phase 4 starts only after the recovered candidate is integrated. Its binding policy is
[`UPSTREAM_POLICY.md`](UPSTREAM_POLICY.md).

Exit criteria:

- current upstream OID recorded on every LiTT release candidate;
- weekly intake and biweekly bounded sync are operating;
- drift thresholds automatically block feature expansion;
- generic improvements are contributed upstream where practical;
- Mexican/legal governance remains modular and contract-tested.

## Fast execution model

### What can run in parallel

After the coordinator creates the compiling contract scaffold and freezes shared
interfaces:

- upstream capability inventory and compatibility classification;
- documents/storage analysis;
- provider/router analysis;
- workflow catalog/playbook analysis;
- Word add-in/redline analysis;
- test/CI/schema-gate design.

Implementation can parallelize only when workers own disjoint files/worktrees.

### What must be serialized

- `backend/schema.sql` and migration ordering;
- auth middleware and route registration;
- shared API types and `mikeApi` contracts;
- provider catalog/interfaces;
- workflow catalog schema;
- Word API contract;
- integration/cherry-pick into the coordinator branch;
- aggregate tests, final snapshot and governing review.

### Recommended orchestration

Do **not** use one unbounded goal-loop session to implement the whole recovery. The
surface is too large, and a long mutable session would recreate the same status and
review ambiguity.

Use one coordinator session with a bounded goal: finish one phase or one slice. Use
multiple parallel read-only analysis sessions first, then bounded implementation
sessions with disjoint ownership. The coordinator integrates sequentially and freezes
one snapshot per slice. Kanban should contain only the current slice plus its single
review, not the full historical graph.

Recommended concurrency:

- up to four read-only analysis lanes;
- at most two code-writing lanes once interfaces are frozen;
- one coordinator owning shared files and integration;
- one Reviewer-profile task per immutable integrated snapshot.

## Stop conditions

Stop and return `BLOCKED` when:

- upstream moves during an implementation slice without a pinned commit;
- a product decision changes retention, tenancy, provider egress or jurisdiction;
- a worker needs to edit a coordinator-owned shared file unexpectedly;
- schema fresh/migration final states diverge;
- Beta behavior can only pass by weakening an upstream or LiTT security invariant;
- external credentials or production access become necessary before their gate;
- two reviewed replacement snapshots fail in the same slice.

## Completion receipt

Every slice must report separately:

```text
base/upstream OID:
branch/worktree:
commit/tree:
changed paths:
focused tests:
integration tests:
schema/migration result:
real provider calls:
cleanup:
review verdict:
push/PR/merge:
staging:
production:
open debt:
next gate:
```
