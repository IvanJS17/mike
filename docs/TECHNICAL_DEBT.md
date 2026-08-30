# LiTT Technical Debt Ledger

This is the actionable debt ledger. A debt item is closed only by its exit criterion,
not by a green nearby test or a Kanban status change.

Severity:

- **P0:** immediate security/data-loss/release stop;
- **P1:** blocks upstream recovery or a trustworthy release candidate;
- **P2:** important but deferrable after explicit classification;
- **P3:** maintenance/polish.

## Open ledger

| ID | Severity | Area | Debt / risk | Evidence | Exit criterion |
| --- | --- | --- | --- | --- | --- |
| TD-001 | P1 | Upstream | LiTT/Beta lacks 254 current upstream commits | Git relation `22cba89...54681b5` from common ancestor `204d2d5` | Recovery candidate integrates/classifies the pinned batch and records zero unclassified commits |
| TD-002 | P1 | Git lifecycle | Reviewed Beta is 12 commits ahead of LiTT main | `origin/main=4a00c11`, Beta=`22cba89` | Exact reviewed Beta semantics integrated into main with post-merge CI and acceptance receipt |
| TD-003 | P1 | Schema | LiTT and upstream both substantially changed fresh schema and migrations | 104 overlapping paths; `backend/schema.sql` changed on both lines | Fresh install and supported incremental upgrade converge to one fingerprint; reviewer PASS |
| TD-004 | P1 | Auth/tenancy | Upstream OAuth/onboarding/password flow is not reconciled with LiTT org/matter tenancy and MFA | concurrent changes in auth, user routes, schema and frontend contexts | Full identity/membership/revocation matrix passes on recovered core |
| TD-005 | P1 | Providers | Upstream AI SDK/router architecture is not reconciled with governed BYOK, egress and receipts | upstream replaced provider adapters; LiTT added governed routes | Provider matrix proves credential source, selected route/model, no silent fallback and correct receipt provenance |
| TD-006 | P1 | Workflows | Mexican playbook depends on pre-catalog workflow architecture | upstream removes `systemWorkflows.ts`; LiTT adds Civil/Mercantile playbook | Playbook lives in current catalog with id/version/source/hash and receipt tests |
| TD-007 | P1 | Word | Beta redline implementation overlaps a major upstream Word add-in rewrite | shared edits in Word API, edit cards, `useWordDoc`, redline and tests | Approved-redline contract passes on current upstream add-in without parallel legacy implementation |
| TD-008 | P1 | Retention | Deletion semantics for append-only AI/audit evidence are not approved for production | Beta needs disposable-stack cleanup; product DELETE can conflict with insert-only guards | Retention/erasure ADR, schema behavior, API response and tests are approved and implemented |
| TD-009 | P1 | Operations | No current remote staging and restore receipt for the candidate | only local/disposable evidence is current | Isolated staging deploy plus encrypted backup/functional restore receipt; production untouched |
| TD-010 | P2 | External | Real Shared Drive canary is blocked | Kanban `t_a278ffcf`; missing dedicated account/token/folder/authorization | One authorized synthetic canary proves upload/idempotence/download/delete/404 and zero residue |
| TD-011 | P2 | Testing | Backend coverage outside Beta remains incomplete and existing coverage report may be stale | `docs/testing-coverage.md` records low global coverage on an older snapshot | Re-measure on recovered core; risk-prioritized auth/storage/provider/workflow tests added; ratchets updated honestly |
| TD-012 | P2 | Frontend | Critical assistant/tabular/hooks surfaces remain incompletely tested | `docs/frontend-testing.md` TODO list | Current-core component/soft-navigation/stream state tests cover identified user-visible contracts |
| TD-014 | P2 | Governance | Project status was distributed across Kanban cards and branches | no prior canonical status/roadmap file | This control package is merged and maintained; Kanban only links to it |
| TD-015 | P2 | Worktrees | Historical worktree registrations and branches are numerous; some are prunable | `git worktree list --porcelain` inventory | Separate authorized lifecycle task classifies preserve/archive/remove; no global prune without inventory |
| TD-016 | P2 | License | Operational AGPL source-offer process for a hosted LiTT deployment is not documented | repository preserves AGPL notices but deployment package is undefined | Version-matched Corresponding Source procedure, notices and no-secret package are documented/tested |
| TD-017 | P2 | Performance | No representative concurrency/load baseline for recovered LiTT | upstream adds load testing; Beta is a functional smoke | Bounded representative assistant/tabular/Word benchmark with explicit hardware/provider boundary |
| TD-018 | P3 | Board hygiene | Historical Mike cards obscure current work | large completed/archived history | One active construction card per capability; current status derived from docs, not card census |

## Closed in this documentation transition

| ID | Area | Closure |
| --- | --- | --- |
| TD-013 | Documentation | Removed CourtListener from deployment prerequisites and First Run instructions; README now states one explicit unsupported-for-LiTT policy and requires a new reviewed design for any Mexican legal-research source. |

## Closure protocol

For every P0/P1 item:

1. identify one RED contract or deterministic reproduction;
2. implement the smallest compatible change on an isolated worktree;
3. run focused GREEN and applicable aggregate gates;
4. freeze commit/tree and clean status;
5. obtain one independent Reviewer-profile verdict;
6. update this ledger and `PROJECT_STATUS.md` in the same integrated transition.

A deferred P2/P3 item must record owner, rationale, next review date and the product
behavior accepted during deferral. `Deferred` without those fields is still open.

## Decisions required from owner/product architecture

These are not implementation details that an agent may invent:

- production retention/erasure semantics for AI and audit evidence;
- whether and when real Google Drive becomes a supported integration;
- production deployment/data-residency/operator-access model;
- any jurisdictional research source replacing CourtListener;
- acceptance of material upstream behavior that changes user journeys or legal review semantics.
