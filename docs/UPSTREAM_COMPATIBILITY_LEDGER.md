# LiTT Upstream Compatibility Ledger

> **Integrated control artifact.** This file consolidates the four immutable,
> read-only recovery analyses and governs compatibility, interfaces and writer
> ownership together with the five canonical control documents. It does not by
> itself authorize a product writer, staging, external-provider contact or production.

## 1. Current gate

The Phase 0 control package, reviewed Beta baseline and this compatibility ledger
are integrated in `origin/main`. PR #18 merged the final reviewed Beta head
`192310b6930d430667d729ed943e15e8441a61b1` into commit
`cc497bbf8f2ca7407d19801c4750340636e46548` with tree
`60aba275013aa788bc6d57ddd32b20f5cca03afb`. PR #19 merged the reviewed ledger
head `33ea753368c70bf6b6edbe34d2a0f0f8e0c93b60` into the ledger-acceptance baseline
`0cafb80c85e8a0e75f7f78df744eb4806b7057d6` with tree
`e2d87cd2e9712233c3fe409949986e0feee8f083`.

G4 evidence is current:

- PR exact-head CI: 8/8 checks succeeded, including Playwright;
- post-merge push workflows on `cc497bb`: CI, Stack tests, CodeQL, Secret scan,
  and Scorecard all succeeded;
- bounded integrated Beta journey: 2/2 passed with fake provider/Drive and a
  disposable Supabase stack;
- the first harness attempt stopped before application execution because
  Turbopack rejected an external `frontend/node_modules` symlink; cleanup was
  complete, a physical dependency copy made the same production build pass,
  and the single corrected retry produced the 2/2 journey result;
- real AI calls: 0; real Google calls: 0;
- attributed cleanup: zero owned containers, volumes, networks, listeners,
  processes, or ignored files; the detached post-merge verification worktree
  and its synthetic failure evidence were removed.
- ledger review `t_15f7252d`: PASS with zero P1/P2 on exact tree `e2d87cd2`;
- PR #19 exact-head CI: 8/8 PASS; post-merge push workflows on `0cafb80`: 5/5 PASS.

The ledger review/integration gate is complete. No implementation writer may start
until the coordinator creates a compiling recovery scaffold, migration baseline and
shared interfaces from the pinned upstream core. This ledger and its closeout change
no product code.

## 2. Immutable evidence set

All four analyses used exactly this tuple. A future upstream intake does not move
this recovery batch; newer upstream commits belong to the next intake.

| Identity | Commit | Tree | Lifecycle meaning |
| --- | --- | --- | --- |
| Ledger-acceptance control/Beta/ledger baseline | `0cafb80c85e8a0e75f7f78df744eb4806b7057d6` | `e2d87cd2e9712233c3fe409949986e0feee8f083` | PR #19 squash; exact-head CI and post-merge workflows passed before the docs-only closeout |
| Integrated Beta G4 baseline | `cc497bbf8f2ca7407d19801c4750340636e46548` | `60aba275013aa788bc6d57ddd32b20f5cca03afb` | PR #18 squash; G4 CI, bounded Beta journey, and cleanup passed |
| Integrated control-package baseline | `d63fdd83dd1ccaaf07a23466b0e2fe540a4d973d` | `ac1a31ec4845ec6a2eedb50f6282297b00fce4a4` | PR #17; exact control tree used by all four analysis cards |
| LiTT/Beta analysis reference | `22cba89fe104b3c9df518762fb5a7170a5b16b03` | `4aba258495698862e5e77268beeefd5ca38ea459` | Original reviewed Beta behavior inspected by all four analysts |
| Final Beta PR head | `192310b6930d430667d729ed943e15e8441a61b1` | `5fbf99682e0e9592bfc53ff7a7cd7cdf3f8144d6` | Original Beta plus reviewed Playwright runner-selection delta (`t_b54d75b3`) |
| MikeOSS upstream core | `1b58c7aa0520ff185c44698cea1a9e0c96af50ab` | `ce8d7e1a6e4b5460258441a5568a353c52180162` | Core target for the recovery reconstruction |
| Common ancestor | `204d2d533a075c74fc69f8b283c70fb4e94ec104` | `0cf7a04ffbe325b005066d6783238ac872ce3b88` | Last shared lineage baseline |

Observed at dispatch:

| Comparison | Left-only commits | Right-only commits | Changed paths from ancestor | Overlap with upstream |
| --- | ---: | ---: | ---: | ---: |
| Beta vs upstream | 28 | 278 | Beta 258 / upstream 718 | 108 |
| Integrated control vs upstream | 17 | 278 | control 252 / upstream 718 | 108 |

Ledger-acceptance baseline against the same pinned upstream batch:

| Comparison | Left-only commits | Right-only commits | Changed paths from ancestor | Overlap with upstream |
| --- | ---: | ---: | ---: | ---: |
| `0cafb80` vs pinned upstream | 19 | 278 | LiTT 265 / upstream 718 | 108 |

The final Beta PR head and ledger-acceptance tree differ on exactly seven paths:
`README.md`, the five canonical control documents and this ledger. Before PR #19,
each of the first six blobs in the integrated Beta tree equaled the PR #17 control
baseline; PR #19 added only this ledger. No Beta product path was lost during
composition.

Canonical authority, in descending order:

1. integrated `docs/PROJECT_STATUS.md`, `docs/UPSTREAM_RECOVERY_PLAN.md`,
   `docs/UPSTREAM_POLICY.md`, `docs/TECHNICAL_DEBT.md`, and
   `docs/RELEASE_GATES.md`;
2. explicit decisions from Iván;
3. executable LiTT/Beta invariants;
4. upstream implementation;
5. analyst or writer recommendation.

## 3. Analysis receipts

| Lane | Kanban task | Status | Scope | Result use |
| --- | --- | --- | --- | --- |
| A | `t_769dd3c6` | `done` | schema, auth, tenancy, audit, deletion | Governs Slice A data/security constraints |
| B | `t_6402b72c` | `done` | providers, routing, credentials, workflows | Governs Slices C and D contracts |
| C | `t_f41446c2` | `done` | web frontend, Word, approved redline | Governs frontend scaffolding, Slices E and F |
| D | `t_06413920` | `done` | CI, schema gates, Beta parity, staging/recovery | Governs verification and Slice G |

All four echoed the same full commits and trees. Lane D decorated its `adopt` and
`port` headings rather than using the literal bare labels; the sections were
complete and unambiguous. No report was stale, silent, timed out, or tied to a
nearby snapshot.

## 4. Consolidated decisions and resolved analysis tensions

| Topic | Apparent tension | Resolution | Authority |
| --- | --- | --- | --- |
| Recovery strategy | Large two-way diff could invite a merge | Build on the pinned upstream core and port LiTT invariants in slices. Never merge Beta and upstream monolithically. | Recovery plan |
| Schema bootstrap | Beta E2E replays migrations fail-tolerantly; upstream supplies schema-fingerprint convergence | `backend/schema.sql` is the sole fresh bootstrap. A unique, ordered migration series must upgrade the supported integrated LiTT baseline to the same fingerprint. Fail-tolerant replay and blanket grants are rejected. | Recovery plan + A + D |
| Migration filenames | Both lines reuse stems such as `20260812_01`, `20260813_01`, `20260818_01`, `20260819_01`, and `20260820_10/11` for different SQL | Coordinator creates a new collision-free recovery series; no writer copies both directories together or renames migrations independently. | A |
| Browser database writes | Beta permits direct authenticated tenancy writes under RLS; upstream mediates through backend/service role | Target backend-mediated mutations with `requireAuth`, origin/MFA/epoch checks, and RLS as defense in depth. No broad browser write grants. | Canonical security invariants + A |
| Auth transport | Upstream is cookie/session-first and temporarily supports Bearer; Word needs a non-browser bridge | Web uses HttpOnly session cookies. Word uses the one-time auth handoff/current add-in contract. Any Bearer compatibility is restricted to named non-browser clients and cannot become a browser fallback. API key, access token, and refresh token remain distinct. | Recovery plan + A + B + C |
| Account/project deletion | Upstream cleanup deletes audit rows; LiTT audit and AI evidence are append-only | Adopt the cleanup orchestration except evidence deletion. Destructive endpoints fail closed until the retention/erasure ADR defines legal behavior and a privileged out-of-band mechanism, if any. | Canonical TD-008 + A |
| Provider runtime | Upstream uses Vercel AI SDK; Beta has governed provider adapters | Adopt upstream AI SDK/router implementation. Port `ModelRoute`, credential references, pinned chat routes, explicit request-path failure, egress provenance, receipts, and fake interception. Retire duplicate legacy provider adapters. | Recovery plan + B |
| Provider fallback | Some upstream preference paths fallback; LiTT forbids silent fallback for explicit routes | Fallback is permitted only when normalizing a stale saved preference and must be observable. An explicit request or pinned chat route fails closed. | Policy invariant + B |
| Real provider tests | Upstream may conditionally exercise LLM specs with a secret; LiTT requires zero real calls in default CI/local E2E | Default G0–G5 recovery gates use fakes/synthetic credentials only. Any real provider exercise moves to a separately authorized G6 canary and is not inferred from CI. | Upstream policy + release gates + D |
| Workflow source | Beta uses generated `systemWorkflows.ts`; upstream uses a DB-backed catalog | `mike_workflows` is the sole target catalog. Port the MX playbook as governed catalog content and retire the legacy generated registry after parity. | Recovery plan + B |
| CourtListener | Upstream still exposes US legal research/provider entries | Reject the surface and key type from LiTT. It remains absent unless a new jurisdiction-specific design and owner decision are reviewed. | Canonical policy + A + B + D |
| Word architecture | Beta has a legacy tabbed add-in; upstream has a document-scoped taskpane | Adopt upstream taskpane/chat/history/edit-card/Direct–Review architecture. Port only the approved-redline contract and UI integration; retire the Beta shell. | Recovery plan + C |
| Two redline modules | Upstream `redline.ts` parses streamed edits; Beta `redline.ts` validates approved bundles | Keep the upstream stream parser. Port the approved-bundle logic under the explicit new module name `approvedRedline.ts`; no parallel legacy add-in implementation and no ambiguous same-purpose module. | Coordinator architecture decision consistent with C |
| Approved bundle storage | Lane C deferred whether bundle state belongs in Word chat or a dedicated table | `ai_redline_bundles` remains the authoritative evidence store. Word chat/edit tables store interactive model edits only. The add-in fetches an approved bundle by API and never copies authority into Office settings. | LiTT executable invariant + coordinator architecture decision |
| Drive/staging | Fake Drive is part of Beta; real Drive and remote staging are external gates | Preserve fake Drive and local isolated staging. Real Drive, SMTP, remote staging, backup destination, monitoring, and DNS stay separate G6 authorizations. | Release gates + D |

## 5. Shared contracts frozen before writers

The coordinator must materialize these contracts in a compiling RED scaffold before
any writer that consumes them. Names describe the semantic contract; exact exported
TypeScript names are frozen in the coordinator snapshot handed to the writer.

| Contract | Required fields/behavior | Fail-closed rules | Coordinator owner |
| --- | --- | --- | --- |
| Request identity | authenticated `user_id`; transport is web session, one-time Word handoff/session, or explicitly allowed non-browser Bearer; assurance/MFA state | no provider secret in identity; untrusted cookie mutation origin is `403`; browser Bearer fallback prohibited | auth middleware and root auth registration |
| Tenancy scope | `organization_id`, optional `workspace_id`, required private `matter_id` where applicable, membership role, `authorization_epoch` | missing/inactive membership is generic deny/404; private matter needs explicit matter membership plus active org membership; stale epoch blocks mutation | schema, migrations, access/audit boundary |
| Provider route | `provider`, `model`, `credential_ref`; resolved credential source/version held only in memory | explicit/pinned route never silently falls back; disabled/rotated/missing credential returns typed failure; secrets never enter receipts/logs | `llm/types.ts`, `userApiKeys.ts`, chat streaming |
| Credential domains | membership identity; provider API key; OAuth access token; OAuth refresh token | no interchange between domains; refresh tokens encrypted and never stored in `user_api_keys` or chats | auth/provider shared files |
| Workflow identity | `workflow_key`, `version`, `content_hash`, `source_commit`, distribution/type, source and approval provenance | executed receipt pins the exact active hash; catalog edits do not rewrite prior receipts | catalog schema and shared API type |
| Execution provenance | tenant/matter/project/chat/document-version scope; input/output/citation hashes; provider route; workflow identity; status/error class | append-only evidence; actual route, not intended route; receipt sanitizer rejects secret/prompt/content fields except hashes | schema, receipt types, audit |
| Review state | item decision `accepted`, `rejected`, or `edited`; terminal review `approved` or `changes_requested`; reviewer separation and fresh authorization | approval requires no pending item; revoked reviewer cannot write; rejected findings excluded and edited values preserved | evidence schema/API contract |
| Approved redline | bundle id/SHA, review id/revision, source document/version/SHA, action spans and before/after hashes | fresh identity/hash/span revalidation before every write; ambiguity, overlap, supersession, Save-As, or document drift produces no partial write | Word API contract and `approvedRedline.ts` |
| Document/storage ownership | tenant/matter/project/document IDs, version hash, object prefix, download-grant id/expiry/use state | object prefix confinement; single-use/expiry; outsider non-disclosure; deletion waits for retention contract when evidence is implicated | schema/access/API boundary |
| Publication intent | matter folder identity, approved artifact hash, idempotency key, attempt/outcome, provider file id when known | fresh authorization before upload and DB update; unknown outcome reconciled before retry; no real Drive in default tests | Drive publication API/schema boundary |
| Resource cleanup | explicit owner/root labels or IDs, primary error plus cleanup errors, zero-residue assertion | never adopt foreign resources; cleanup cannot mask primary failure; no row-by-row deletion of append-only evidence | aggregate harness contract |

## 6. Coordinator-exclusive files

Writers must not edit these paths. If a slice needs one, it stops and returns an
interface/change request; the coordinator changes it in the integration worktree,
runs the shared RED/GREEN gate, and issues a new exact base.

```text
backend/schema.sql
backend/migrations/**
backend/src/app.ts
backend/src/middleware/auth.ts
backend/src/lib/access.ts
backend/src/lib/audit.ts
backend/src/lib/supabase.ts
backend/src/lib/userApiKeys.ts
backend/src/lib/userDataCleanup.ts
backend/src/lib/llm/types.ts
backend/src/lib/chat/streaming.ts
backend/src/lib/chat/tools/wordClientTools.ts
backend/src/routes/auth.ts
backend/src/routes/user.ts
backend/src/routes/projects.ts
backend/src/routes/documents.ts
backend/src/routes/downloads.ts
backend/scripts/schema-fingerprint.sql
backend/scripts/check-security-invariants.sh
frontend/src/app/lib/mikeApi.ts
frontend/src/app/contexts/AuthContext.tsx
frontend/src/app/contexts/UserProfileContext.tsx
frontend/src/app/contexts/ChatHistoryContext.tsx
frontend/src/app/hooks/useAssistantChat.ts
word-addin/package.json
word-addin/tsconfig.json
word-addin/src/taskpane/api/mikeApi.ts
word-addin/src/taskpane/hooks/useWordDoc.ts
word-addin/src/taskpane/lib/redline.ts
word-addin/src/taskpane/lib/approvedRedline.ts (new)
word-addin/e2e/support/**
.github/workflows/**
package.json
package-lock.json
docker-compose.yml
compose.staging.yml
```

The coordinator also owns every cherry-pick/conflict resolution, aggregate gate,
review snapshot, compatibility-ledger update, and change to this ownership list.

## 7. Compatibility matrix

| Capability | Upstream behavior | LiTT invariant | Disposition | Target architecture | Dependencies | Shared files | Writer ownership | Tests | Migration impact | Blocker/debt | Implementation order |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| Fresh schema and upgrades | Canonical fresh schema plus schema-drift fingerprint workflow | Fresh and supported incremental paths converge; security grants/policies preserved | adopt + port | One consolidated fresh schema and a new collision-free recovery migration series from the integrated LiTT baseline | Beta integration; coordinator scaffold | schema, migrations, fingerprint script | coordinator only | fresh bootstrap; supported upgrade; fingerprint equality; security invariants | high: divergent schemas and duplicate stems | TD-003 | 0 |
| Password/session auth | HttpOnly cookies, trusted-origin checks, session endpoints | MFA default-on and no tenancy bypass | adopt + port | Upstream auth stack with LiTT MFA/tenancy guards | schema/auth contract | middleware, auth/user routes, contexts | Slice A domain services/tests only | login/recovery/session/origin/MFA matrix | user profile/trigger convergence | TD-004 | 1 |
| Google OAuth and Word handoff | OAuth exchange plus single-use handoff tickets | onboarding creates exactly one initial organization with an active `org_owner` membership; no initial workspace/matter; tokens remain distinct | adopt + port | Cookie web flow and one-time Word handoff; idempotent organization provisioning shared by password and OAuth completion; no browser Bearer fallback | resolved owner decision in section 11 | auth schema/routes/client contexts | Slice A tests and non-shared onboarding service | one-use/expiry; OAuth/password cannot bypass MFA/tenancy; retry cannot duplicate tenant | auth tickets, profile triggers and organization membership transaction | none for initial defaults | 1 |
| Organizations/workspaces/matters | Upstream lacks LiTT’s complete private-tenancy model | org/workspace/matter roles, private matters, outsider 404 | port | Backend-mediated tenancy mutations; RLS defense in depth; invitations require an explicitly selected valid role and never infer one | schema scaffold | schema/access/audit/app | Slice A `tenancy.ts`, new domain services/routes excluding shared registration | cross-tenant matrix; private matter; explicit-role invitation/onboarding | new consolidated tables/policies/functions | none for invitation default semantics | 1 |
| Revocation and epochs | Ordinary current-session authorization | revocation effective during long mutations | port | Organization authorization epoch checked before every sensitive write | tenancy model | schema/access/audit | Slice A tenancy/AI access helpers and focused tests | stale epoch and revocation race negatives | epoch columns/functions/triggers | none after interface freeze | 1 |
| RLS and service role | Narrower backend-mediated posture but different grants | no browser bypass; insert-only evidence; least privilege | port + reject broad grants | Per-table grants plus RLS and backend authorization; no blanket post-migration grant | schema convergence | schema/migrations/security script | coordinator; Slice A tests | RLS coverage; service-role route guard; negative DML | substantial grant reconciliation | TD-003/004 | 1 |
| Audit | Mutable upstream audit table | insert-only, scoped, sanitized audit detail | port | One consolidated append-only `audit_events` model and one audit module | tenancy schema | schema/migrations/audit | Slice A callers/tests outside shared module | service-role UPDATE/DELETE denial; scoped detail | incompatible table definitions | retention ADR for erasure | 1 |
| Account/project deletion | Upstream cleanup removes user/project rows and audit | append-only evidence cannot be silently purged | adopt orchestration, defer evidence deletion | Fail-closed destructive API until retention ADR; cleanup non-evidence resources deterministically | retention decision | schema/userDataCleanup/shared routes | later coordinator integration; no writer policy invention | blocked destructive endpoint; retained-evidence matrix | deletion order and privileged path are not implementable before the retention ADR | TD-008 | before E completion |
| Document access/downloads | Folder upload, multi-select, pagination, storage wrappers | matter-private access, hashes, single-use grants | adopt + port | Upstream document UX/storage core behind LiTT tenancy and grant service | Slice A integrated | schema/access/shared project/document routes | Slice B document/storage services, components, tests | prefix confinement; expiry/single-use; conflict/bounded concurrency | grant/table reconciliation | deletion depends on retention | 2 (parallel lane 1) |
| Provider runtime | Vercel AI SDK, routers, streaming, tool batching | governed BYOK and actual-route provenance | adopt + port | Upstream AI SDK adapters with LiTT route resolution before dispatch | Slice A; provider interface scaffold | llm types, keys, chat streaming, schema | Slice C provider adapters, governed route resolver, tests | provider/model matrix; tool streaming; fail-closed errors | user keys/chat route columns | TD-005 | 2 (parallel lane 2) |
| Model selection and fallback | Explicit routers plus observable fallback for stale preferences | explicit/pinned requests never silently fallback | adopt + port | Throw on request-path invalid route; normalize only stale saved preference with warning | provider runtime | shared provider/API types | Slice C router/model modules/tests | retired model; stale preference; explicit invalid route | preference/profile columns | provider support decisions | 2 |
| Credentials | One user key/provider plus env/router keys; OAuth stores tokens separately | multiple versioned `credential_ref`; membership/API/access/refresh separation | port | Encrypted multi-credential store; declared env/user source; rotation invalidates old pin | schema scaffold | schema/userApiKeys/types | Slice C non-shared resolution modules/tests | rotation, disabled key, missing key, no secret leakage | user_api_keys consolidation | BYOK for Vercel/OpenCode decision | 2 |
| Egress/fakes | Provider SDK and model-catalog network paths | explicit allowlist/provenance; default CI makes zero real calls | port | One provider/network choke point; fake interception precedes every SDK fetch; unexpected host aborts | provider runtime | chat streaming/workflows | Slice C provider egress modules/tests | host allowlist; zero-call negative; catalog fetch doubles | none beyond provider schema | allowed real providers deferred to G6 | 2 |
| Workflow catalog | DB-backed versioned catalog, packs, add-ons, quick actions, reference assets | governed content and immutable executed hash | adopt | `mike_workflows` is sole catalog; atomic sync and content-addressed assets | provider interface; catalog schema scaffold | schema/app/API types | Slice D catalog/sync/routes/tests outside shared files | sync idempotence; install/default; asset hash | catalog tables/RPC | none | 3 (parallel lane 1) |
| Civil/Mercantile MX playbook | No LiTT playbook in current catalog | stable id/version/source/approval/hash; R4/R6/R9; no authority overclaim | port | Governed catalog row/content with MX provenance and receipt hash; retire `systemWorkflows.ts` | catalog | schema/API receipt type | Slice D playbook content/loader/tests | hash round-trip; source/version; executed receipt immutability | seed/catalog content | legal validation remains later gate | 3 |
| Web assistant and citations | Current assistant, streaming, history, shared UI | governed route display, verified citations, matter/document scope | adopt + port | Upstream UI shell/hooks with frozen LiTT API/provenance interfaces | Slices A/C/D interfaces | mikeApi, contexts, useAssistantChat | Slice E0 new AI/review UI scaffolding and non-shared components | soft navigation; mid-stream chat switch; late citation frames | none initially | cannot claim parity before E1 | 3 (parallel lane 2 scaffold only) |
| AI executions/receipts/citations | Upstream chat/workflow execution model | append-only pages/outputs/receipts, hashes, actual route/workflow provenance | port | LiTT evidence state machine on upstream provider/catalog contracts | A/C/D integrated; retention decision for destructive paths | schema/audit/API types | Slice E1 AI evidence libs/routes/tests outside shared files | hash/citation integrity; append-only negatives; revocation races | full `ai_*` reconciliation | TD-008 before deletion claims | 4 |
| Human review/approved DOCX | General UI/workflow review surfaces | different reviewer; reject/edit/accept; no pending item on approval | port | LiTT review state machine and approved artifact service on current web UI | execution evidence | schema/API client | Slice E1 review/report services, components, tests | reviewer separation; transitions; approved DOCX content | review/export tables | retention ADR for destructive path only | 4 |
| Word taskpane/chat/history | Document-scoped chat, history, Direct/Review, tracked edit persistence | no cross-document/matter use | adopt | Use upstream add-in wholesale as shell; current Word identity/settings and edit-card UI | frozen auth/provider/workflow APIs | Word API/useWordDoc/stream parser | Slice F taskpane UI/features/tests excluding shared paths | upstream Chromium/WebKit suite; document switch/history | upstream word tables retained | Word host matrix deferred beyond bounded gate | 5 |
| Approved redline apply | Upstream stream-edit parser and tracked edits | reviewed bundle identity, source hash, span revalidation, no partial write | port | Dedicated `approvedRedline.ts` contract plus panel integrated into upstream taskpane; authoritative bundle remains backend evidence | Slice E approved bundle API | schema/Word API/useWordDoc/new module | Slice F panel/UI and E2E; coordinator writes core module/hooks | tamper/scope/source/span/supersession/Save-As/multi-occurrence | bundle tables reconciled | TD-007 | 5 |
| Drive publication | Upstream storage capabilities; no LiTT governed publication journey | approved artifact only; fresh authorization; idempotence/unknown outcome/rehydration | port | Matter-bound publication service and state machine; fake first, real canary later | Slice E/F artifacts | schema/app/shared API | Slice G Drive services/settings UI/tests | fake upload once; retry/unknown outcome; rehydrate; outsider deny | publication tables/retry fields | TD-010 real canary | 6 |
| CI and schema gates | Rich CI, schema drift, stack, mutation, load, Word workflows | LiTT security checks, Beta parity, zero real calls | adopt + port | Coordinator composes workflows after each slice; mutation/load on-demand until parity | all slice contracts | workflows, root manifests, scripts | coordinator only; writers report focused commands | exact-head CI; schema convergence; security; Word; Beta | none | coverage/performance TD-011/12/17 | each integration + Phase 3 |
| Beta parity | Upstream has broader E2E but not LiTT vertical journey | owner/private matter → DOCX → fake AI → review → DOCX/redline → fake Drive → audit/404/cleanup | port as acceptance contract | Adapt the existing Beta journey to recovered architecture; do not preserve legacy internals | Slices A–G | aggregate harness config | coordinator runs; slice writers maintain owned fixtures/spec helpers only | one fake provider call, one fake Drive upload, zero residue/real calls | disposable schema must match candidate | G4 baseline proven at `cc497bb`; parity must be re-proven on the recovered candidate | Phase 3 |
| Staging/recovery/cleanup | Upstream CI/local stack plus load tooling | isolated fresh bootstrap, backup/restore, attributed cleanup | port | LiTT loopback-only staging and recovery harness updated to recovered core; separate restore stack | integrated candidate | compose/workflows/shared scripts | Slice G non-shared services/tests; coordinator composes root files | contract smoke; backup; functional restore; zero residue | fresh-only bootstrap plus supported upgrade proof | TD-009 remote staging later | 6 + G5 |
| Jurisdiction research | Upstream CourtListener US surface | no US source presented as Mexican authority | reject | Surface/routes/tools/tables/key catalog remain absent; future replacement requires new reviewed design | owner jurisdiction decision | schema/provider/catalog shared files | coordinator exclusion tests | absence/security invariant tests | drop/exclusion preserved | owner decision only for replacement | continuous |

## 8. Implementation sequence and concurrency

### Required pre-writer gates

Completed:

1. Exact reviewed Beta candidate integrated through authorized PR #18.
2. Exact-head CI, separately authorized merge, post-merge CI, bounded Beta smoke,
   composed-tree proof, and zero-residue cleanup completed on `cc497bb` / `60aba275`.
3. Exact-tree ledger review `t_15f7252d`, authorized PR #19, exact-head CI 8/8,
   merge `0cafb80` / `e2d87cd2`, and post-merge push workflows 5/5 completed.

Still required before the first writer:

1. Create the coordinator recovery worktree from upstream commit
   `1b58c7aa0520ff185c44698cea1a9e0c96af50ab`.
2. Coordinator creates a compiling RED contract scaffold and the first collision-free
   migration plan. No writer receives a non-compiling base.
3. Freeze the shared contracts and coordinator-exclusive path set in an exact commit.

### Serialized and parallel work

```text
Coordinator scaffold (serial)
  -> Slice A identity/tenancy/auth/schema (serial)
  -> coordinator integration + focused/aggregate gates + exact review
  -> [Slice B documents/storage || Slice C providers/models]
       only after shared schema/config contracts are materialized and paths are disjoint
  -> coordinator integrates B then C sequentially; no merge conflict is auto-resolved
  -> [Slice D workflow catalog/playbook || Slice E0 frontend scaffold]
       only after provider/workflow/evidence API shapes are frozen
  -> coordinator integrates D then E0 sequentially
  -> Slice E1 AI evidence/human review (serial)
  -> Slice F Word/redline (serial)
  -> Slice G Drive/staging/recovery (serial)
  -> Phase 3 aggregate gates and one governing exact-snapshot review
```

Safe writer pairs, conditional on an exact coordinator-issued base and disjoint
ownership:

1. Slice B with Slice C.
2. Slice D with Slice E0 frontend scaffolding only; not with full Slice E evidence
   implementation.

Everything else is serialized. At most two writers run concurrently. Writers never
copy files between worktrees. The coordinator cherry-picks atomic commits one at a
time and treats any conflict as a violated ownership/interface contract.

## 9. Writer slice ownership and acceptance

| Slice | Writer-owned implementation surface | Explicitly prohibited | Focused RED/GREEN acceptance | Handoff |
| --- | --- | --- | --- | --- |
| A — identity/tenancy/auth | tenancy/epoch service modules, new non-shared org/workspace/matter route modules, focused auth/tenancy tests | every coordinator-exclusive file; deletion policy; CourtListener | auth-state matrix, cross-tenant/private 404, revocation race, onboarding membership contract | one clean atomic commit; no push/PR/merge |
| B — documents/storage | document/storage service modules, upload/folder/pagination UI/services, domain tests | schema/migrations, shared access/routes/API client, retention policy | object confinement, single-use grants, conflict policy, bounded concurrency | one clean atomic commit |
| C — providers/models | AI SDK provider adapters, governed route resolver, router/model modules, provider tests | shared types/keys/chat streaming/schema/API client | explicit route fail-closed, key rotation, no-key, actual provenance, fake before egress | one clean atomic commit |
| D — workflow catalog/playbook | catalog source/sync modules, workflow routes outside root registration, MX playbook content/loader, tests | schema/migrations/app/API client/legacy parallel registry | sync idempotence, default/add-on behavior, content hash/source/version, receipt pin contract | one clean atomic commit |
| E — AI evidence/human review | evidence/review/report services and routes outside root registration, new web AI/review components, domain tests | schema/migrations/audit/shared API client/contexts; destructive retention behavior | citation/hash integrity, append-only negatives, revocation, review state machine, approved DOCX | E0 scaffold may parallelize; E1 is serial; one commit per bounded sub-slice |
| F — Word/redline | taskpane panels/components/history/workflow integration and bounded Word E2E | shared Word API/useWordDoc/redline core/package/tsconfig; legacy Beta shell | bundle tamper/scope/source/span, Save-As, no partial writes, upstream Chromium/WebKit suite | one clean atomic commit |
| G — Drive/staging/recovery | Drive publication services/settings, non-shared staging/recovery scripts and tests | schema/app/shared API/root compose/workflows; real external calls | fake idempotence, unknown outcome/reconcile, fresh auth, backup/restore, zero residue | one clean atomic commit; G6 canary excluded |

## 10. Future Kanban writer prompts

These are **templates, not active cards**. Before dispatch, the coordinator must add
an exact identity block containing: integrated LiTT baseline commit/tree, pinned
upstream commit/tree, coordinator recovery-base commit/tree, branch, worktree,
allowed paths, prohibited paths, and current ledger SHA-256. A prompt without that
block is invalid and must not start.

### Slice A — identity, tenancy, auth

```text
Profile: engineer. Implement only Slice A on the exact coordinator-issued recovery
base. Beta must already be integrated and the shared schema/auth/API scaffold must
compile. Read the five canonical control documents and
`docs/UPSTREAM_COMPATIBILITY_LEDGER.md` from the supplied base.

Behavioral goal: make the upstream auth stack preserve LiTT organization/workspace/
matter membership, private-matter 404, MFA, authorization-epoch revocation, and
append-only audit callers. Implement the resolved onboarding contract exactly: create
one initial organization with an active `org_owner` membership, create no workspace or
matter automatically, and require an explicitly selected valid role for every
invitation. Make organization provisioning idempotent across password and OAuth
completion. Add the smallest discriminating RED contracts first, then GREEN
implementation. Do not decide retention, egress, or jurisdiction.

You may edit only the coordinator-issued Slice A allowlist: tenancy/epoch service
modules, new non-shared org/workspace/matter route modules, and focused tests. Never
edit a coordinator-exclusive file. If one is required, stop `blocked` with the exact
interface change; do not patch around it. No unrelated cleanup, network, real
providers, Docker unless the card explicitly names a disposable focused gate, push,
PR, merge, deploy, or new Kanban cards.

Run the exact focused type/lint/tests supplied in the dispatch and leave one clean
atomic local commit only if the card explicitly authorizes that commit. Return base,
HEAD/tree, changed paths, RED/GREEN evidence, real-provider calls=0, cleanup, shared-
file requests, and blockers. Coordinator integrates; writer does not.
```

### Slice B — documents and storage

```text
Profile: engineer. Implement only Slice B from the exact post-Slice-A coordinator
base. Shared tenancy, document API, schema, and storage interfaces are frozen. Read
the canonical documents and compatibility ledger from that base.

Behavioral goal: combine upstream folder upload, conflict policy, multi-select,
pagination, and S3/R2 wrappers with LiTT private matter/project access, content hashes,
object-prefix ownership, and expiring single-use download grants. Begin with RED
contracts for object confinement, outsider non-disclosure, expiry/single use, upload
conflicts, and bounded concurrency; implement only enough GREEN behavior.

Edit only the dispatched document/storage services, components, and focused tests.
Do not edit schema/migrations, shared access, project/document/download routes,
`mikeApi`, root config, or any coordinator-exclusive path. Do not invent deletion or
retention semantics. Stop if the frozen interface is insufficient. No push/PR/merge,
deploy, real external storage, or new cards.

Return one atomic commit receipt when authorized: base, HEAD/tree, paths, focused and
integration results, storage calls/cleanup, shared-interface requests, and blockers.
```

### Slice C — providers and models

```text
Profile: engineer. Implement only Slice C from the exact post-Slice-A coordinator
base, optionally in parallel with Slice B only on the declared disjoint allowlist.
Read the canonical documents and compatibility ledger from the supplied base.

Behavioral goal: use upstream Vercel AI SDK/router/model selection while preserving
LiTT `ModelRoute {provider, model, credential_ref}`, encrypted/versioned BYOK,
pinned chat routes, explicit request-path failure, actual route/provider/model receipt
provenance, and fake interception before every egress. Keep membership, provider API
keys, OAuth access tokens, and refresh tokens separate. Retire duplicate legacy
provider adapters; never add a fallback for an explicit or pinned route.

Edit only provider adapters, governed-route/router/model modules, and focused tests
listed in the dispatch. Shared `llm/types.ts`, `userApiKeys.ts`, chat streaming,
schema/migrations, API client, root manifests, and workflows are coordinator-only.
No network or real provider calls. Stop if a new provider or BYOK policy needs an
owner decision. No push/PR/merge/deploy or child cards.

Return base, HEAD/tree, paths, RED/GREEN results, provider matrix, egress call count
(0 real), cleanup, interface requests, and one atomic commit when authorized.
```

### Slice D — workflow catalog and MX playbook

```text
Profile: engineer. Implement only Slice D on the exact coordinator-issued base after
provider and catalog interfaces are frozen. Read the canonical documents and ledger.

Behavioral goal: adopt the upstream DB-backed workflow catalog, packs, add-ons, quick
actions, reference assets, and atomic sync. Port Civil/Mercantile MX as governed
catalog content with stable key/version, source and approval provenance, immutable
content hash, R4/R6/R9 behavior, and exact executed-workflow hash in receipts. The
catalog is the sole runtime source; do not preserve `systemWorkflows.ts` as a parallel
registry.

Edit only catalog source/sync/domain routes, MX playbook content/loader, and focused
tests named by the dispatch. Schema/migrations, root route registration, shared API
clients/types, receipts, manifests, and CI are coordinator-only. Use no network; mock
catalog sources/assets. Do not make legal-authority claims beyond the frozen content.
No push/PR/merge/deploy or new cards.

Return base, HEAD/tree, paths, RED/GREEN catalog/hash tests, zero real egress, cleanup,
interface requests, blockers, and one atomic commit when authorized.
```

### Slice E — AI evidence and human review

```text
Profile: engineer. Implement Slice E only after Slices A/C/D and their shared
interfaces are integrated. The dispatch will state whether this is E0 frontend
scaffolding or E1 full evidence/review; never combine both implicitly. Read the
canonical documents and ledger from the exact base.

E0 goal: create only new web scaffolding/components against already frozen APIs; it
may parallelize with Slice D on disjoint files. E1 goal: port executions, pages,
outputs, receipts, citations, audit detail, review reject/edit/accept/completion,
approved DOCX, and approved-redline bundle production onto the upstream core.
Preserve actual-route/workflow provenance, append-only guards, reviewer separation,
revocation checks, and no-pending-item approval. Add RED contracts before GREEN.

Edit only the E0 or E1 allowlist in the card. Schema/migrations/audit/root app/shared
`mikeApi`/contexts and destructive cleanup are coordinator-only. Do not implement
account/project evidence deletion until the owner-approved retention ADR exists. No
real AI/Drive, push/PR/merge/deploy, or child cards.

Return exact identity, paths, RED/GREEN and integration results, evidence invariants,
real external calls=0, cleanup, interface requests, blockers, and one atomic commit
per dispatched bounded sub-slice when authorized.
```

### Slice F — Word and approved redline

```text
Profile: engineer. Implement only Slice F from the exact post-Slice-E coordinator
base. Adopt the current upstream document-scoped Word taskpane, chat/history,
Direct/Review, shared edit cards, tracked edits, workflows, and document identity.
Port only the approved-redline UI/integration contract; do not revive the Beta tabbed
add-in or create a second generic redline implementation.

Add RED contracts for bundle/review/document identity, tampering, source/scope/span
drift, Save-As, supersession, multi-occurrence rules, and zero partial writes; then
GREEN panel/taskpane behavior. Edit only the dispatched taskpane components and Word
E2E specs. Word API client, `useWordDoc`, upstream stream parser, coordinator
`approvedRedline.ts`, package/tsconfig, fixtures, schema, and backend registration are
exclusive to the coordinator. No real Word host/network unless a later explicit gate
names it; no push/PR/merge/deploy or new cards.

Return base, HEAD/tree, paths, focused and Chromium/WebKit results, document-identity
boundary, cleanup, interface requests, blockers, and one atomic commit when authorized.
```

### Slice G — Drive, staging, and recovery

```text
Profile: engineer. Implement only Slice G after approved DOCX/redline contracts are
integrated. Read the canonical documents and ledger from the exact base.

Behavioral goal: port approved-artifact publication to a matter-bound Drive folder
with fresh authorization, idempotency, upload verification, unknown-outcome
reconciliation, bounded retry, and published-state rehydration. Update the isolated
local staging/recovery implementation for fresh bootstrap, supported-upgrade
convergence, application-consistent backup, restore into a separate stack, attributed
cleanup, and zero residue. Default tests use fake Drive and synthetic local secrets;
real Drive/remote staging remain G6.

Edit only the Drive services/settings and non-shared staging/recovery scripts/tests in
the dispatch. Schema/migrations/root app/shared API, root Compose, workflows, and
manifests are coordinator-only. Never use production data/credentials or contact real
Google/providers. No push/PR/merge/deploy or child cards.

Return base, HEAD/tree, paths, fake-call counts, staging/restore evidence, cleanup and
zero-residue receipt, interface requests, blockers, and one atomic commit when
authorized.
```

## 11. Product decisions that implementation may not invent

### Resolved for Slice A

On 2026-09-02, Iván fixed the onboarding and invitation contract:

1. Successful onboarding provisions exactly one initial organization and one active
   membership for the authenticated user with role `org_owner`.
2. Onboarding provisions no workspace and no matter implicitly.
3. Password and Google OAuth completion use the same idempotent organization-
   provisioning boundary; retry must not create a second organization or membership.
4. Every invitation requires an explicitly selected role from the applicable closed
   role vocabulary. There is no default invitation role and no fallback grant.

This decision does not authorize retention/erasure behavior, provider egress,
jurisdictional sources, real Shared Drive, or production topology.

### Still pending

| Decision | Needed before | Fail-closed behavior until decided |
| --- | --- | --- |
| Retention/erasure of append-only audit and AI evidence, including storage residues | Any destructive account/project endpoint claimed complete; Slice E closeout | Evidence deletion disabled; endpoint returns a typed blocked/conflict result rather than weakening guards |
| User BYOK support and precedence for Vercel/OpenCode router credentials | Slice C completion for those routers | Unsupported user credential route is unavailable; no env/user silent substitution |
| Which real provider egress routes are supported | G6 canary planning | Default CI/local uses fakes; no real calls |
| Whether and when real Shared Drive becomes supported | G6 | Fake-only publication; no production support claim |
| Production data residency, operator access, and deployment topology | G7 | No production-readiness claim |
| Any Mexican jurisdictional research source replacing CourtListener | Separate reviewed product design | CourtListener and replacement surface remain absent |
| Material upstream UX/legal-review behavior that changes accepted journeys | Before the affected slice is frozen | Preserve executable LiTT invariant or defer the upstream behavior |

## 12. Verification and review lifecycle

For each implemented slice:

1. writer completes one bounded behavior in its own worktree and returns one atomic
   local commit only when authorized;
2. coordinator inspects the real diff and reruns focused verification;
3. coordinator integrates commits sequentially into the recovery worktree and changes
   shared files itself;
4. coordinator runs applicable type, lint, build, schema, integration, security,
   cleanup, and zero-real-call gates;
5. coordinator freezes exact HEAD/tree/paths and dispatches one governing
   Reviewer-profile task via Kanban;
6. timeout, silence, another tree, or incomplete receipt is not PASS;
7. push/PR, merge, G5, G6, and G7 remain separate owner gates.

Phase 4 starts only after the recovered candidate completes Phase 3, receives the
terminal governing review, is integrated, and the permanent cadence in
`UPSTREAM_POLICY.md` is activated.

## 13. Integrated ledger lifecycle

The candidate gate closed as follows:

- exact candidate tree: `e2d87cd2e9712233c3fe409949986e0feee8f083`;
- governing review: `t_15f7252d` PASS with zero P1/P2;
- local commit: `33ea753368c70bf6b6edbe34d2a0f0f8e0c93b60` with the approved tree;
- PR #19 exact-head CI: 8/8 PASS;
- integrated main: `0cafb80c85e8a0e75f7f78df744eb4806b7057d6` with the approved tree;
- post-merge push workflows: 5/5 PASS;
- this separate closeout transition reconciles the five canonical documents only
  after that acceptance, without changing product code or starting writers.
