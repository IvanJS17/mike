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

The integrated Beta baseline has:

- G0: control package integrated by PR #17;
- G1: focused Beta implementation evidence passed on the historical reviewed
  `22cba89` / `4aba258` snapshot and the final Playwright selector delta;
- G2: governing review `t_6ad4f0c2` PASS with non-blocking reservations plus
  bounded delta review `t_b54d75b3` PASS for final head `192310b6` /
  `5fbf9968`;
- G3: PR #18 exact-head CI 8/8 PASS;
- G4: squash `cc497bb` / `60aba275`, post-merge push workflows 5/5 PASS,
  bounded integrated Beta journey 2/2 PASS and attributed cleanup complete;
- G5–G7: not started and not authorized.

## Current recovery-control placement

The compatibility-ledger transition has:

- G0: four immutable read-only analyses consolidated into one 25-row ownership
  ledger with seven bounded writer prompts;
- G2: exact-tree review `t_15f7252d` PASS with zero P1/P2;
- G3: PR #19 exact-head CI 8/8 PASS;
- G4: squash `0cafb80c85e8a0e75f7f78df744eb4806b7057d6` /
  `e2d87cd2e9712233c3fe409949986e0feee8f083` and post-merge push workflows
  CI, Stack tests, CodeQL, Secret scan and Scorecard 5/5 PASS;
- product acceptance was not rerun for the docs-only PR #19 because its merge tree
  equals the exact PR head tree and product bytes are unchanged from the already
  verified Beta G4 baseline;
- Phase 2 product implementation and G5–G7: not started and not authorized.

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
