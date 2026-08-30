# LiTT Release Gates

A PASS at one gate does not imply completion of a later gate. Every report must name
which gate it proves and which environments were untouched.

## Gate map

```text
G0 documented/frozen scope
  -> G1 focused implementation checks
  -> G2 immutable independent review
  -> G3 PR + exact-head CI
  -> G4 merge + post-merge verification
  -> G5 isolated local staging + restore
  -> G6 authorized external canaries / remote staging
  -> G7 explicit production promotion
```

## G0 — Documented scope and immutable baseline

Required:

- authoritative requirements and exclusions;
- exact base commit/tree and worktree;
- current upstream commit/tree when relevant;
- clean status;
- debt/decision ledger;
- no unresolved product decision hidden as an implementation detail.

Authorizes: implementation in an isolated worktree.<br>
Does not authorize: commit, push, PR, merge, external provider, staging or production.

## G1 — Focused implementation verification

Required as applicable:

- RED reproduction/contract;
- focused GREEN tests;
- type/lint/format/build checks;
- schema/migration checks;
- secret/diff checks;
- cleanup receipt;
- explicit real-provider call count/boundary.

Authorizes: freezing a candidate snapshot.<br>
Does not authorize: review bypass, PR, merge or deployment.

## G2 — Immutable independent review

Required:

- one Reviewer-profile task;
- exact commit/tree/base/changed paths;
- clean worktree;
- governing verdict `PASS` or approved non-blocking reservations;
- no timeout/silence/harness failure substituted for PASS.

Any changed byte invalidates the verdict.

Authorizes: requesting owner permission for publication/PR.<br>
Does not authorize: automatic push, PR, merge, staging or production.

## G3 — PR and exact-head CI

Required:

- separate owner authorization for push/PR when applicable;
- PR head equals reviewed commit;
- complete diff and declared scope match;
- exact-head CI exists and is green;
- empty/stale/cancelled checks are not green;
- deploy jobs absent or demonstrably skipped;
- PR metadata read back from the remote.

Authorizes: requesting merge approval.<br>
Does not authorize: merge or deployment.

## G4 — Merge and post-merge verification

Required:

- separate owner merge authorization;
- final PR head/check read-back;
- approved merge method and head-OID guard;
- resulting `origin/main` commit/tree recorded;
- post-merge CI on the resulting main commit;
- bounded acceptance smoke on the integrated bytes;
- status/debt/upstream ledger updated.

Authorizes: treating the capability as integrated into LiTT main.<br>
Does not authorize: staging or production.

## G5 — Isolated local staging and recovery

Required:

- versioned, synthetic, isolated environment;
- no production credentials/data/network target;
- fresh bootstrap and health checks;
- representative auth/project/document/Beta smoke;
- application-consistent backup;
- functional restore into a separate isolated stack;
- attributed teardown and zero residue;
- exact integrated commit/tree.

Authorizes: requesting remote staging or external-canary approval.<br>
Does not authorize: real provider/Drive, remote staging or production.

## G6 — Remote staging and external canaries

Each external system is a separate authorization:

- remote staging infrastructure;
- real AI provider;
- Google Shared Drive;
- SMTP/auth email;
- backup destination;
- monitoring/DNS.

Required:

- dedicated least-privilege credentials outside Git;
- explicit account/project/folder identities;
- synthetic data only unless separately authorized;
- bounded side effects and rollback;
- redacted receipt and verified cleanup;
- no inference from one external system to another.

Authorizes: production-readiness assessment for the proven boundary only.<br>
Does not authorize: production.

## G7 — Production promotion

Required:

- explicit production authorization bound to exact commit/tree/artifact;
- current production inventory and read-only preflight;
- secrets/account/DNS/server identities verified;
- approved migration and rollback procedure;
- encrypted backup and tested restore within accepted RPO/RTO;
- provider data-flow/retention/operator-access decisions;
- AGPL Corresponding Source package for the deployed version;
- monitoring and incident owner;
- post-deploy smoke and rollback triggers.

Production is never inferred from CI, local staging, a reviewer PASS, a historical
deploy receipt or an owner statement approving a different snapshot.

## Current Beta placement

Beta candidate `22cba89` has:

- G0: documented in this recovery package;
- G1: focused implementation evidence passed;
- G2: Reviewer-profile PASS with non-blocking reservations;
- G3: not started;
- G4–G7: not started/not authorized.

## Reporting template

```text
active_gate:
commit/tree:
what_passed:
what_failed:
environments_touched:
real_provider_calls:
cleanup:
review/CI:
what_this_authorizes:
what_remains_unauthorized:
next_owner_action:
```
