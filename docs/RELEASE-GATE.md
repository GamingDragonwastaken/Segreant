# Fiscus release gate

This is the operational boundary between a verified local release candidate and
an external release. Passing source tests is necessary but not a substitute for
registry ownership, production infrastructure, or customer evidence.

Every successful record below is historical evidence bound to its recorded candidate SHA and to the checklist/gate version in force at that time. A result cannot be inherited by a later SHA; a changed gate requires a fresh run. Superseded records remain unchanged as historical evidence rather than being rewritten into current authority.

## Local CLI and dashboard candidate

Historical check counts and screenshots are not release authority. Before making
a fresh local-candidate claim, record the exact candidate commit and the results
for this checklist against that source tree:

| Requirement | Required proof |
| --- | --- |
| Candidate identity | `git rev-parse HEAD` and `git status --short` recorded before and after validation |
| Capability/evidence contract | Review `docs/CAPABILITY-EVIDENCE-CONTRACT.md` against the exact candidate; record its revision/date, run `test/public-claims-contract.test.ts`, and confirm any new egress, pricing, performance, return, or recommendation claim names its scope, evidence tier, uncertainty, and revocation condition |
| Source validation | `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` with exact totals/results |
| Budget fail-closed integrity | Exercise malformed budget configuration, invalid/oversized dashboard settings, ledger-read failure, and request-persistence failure. Invalid state must be refused before provider dial; after an unpersisted response, the supported proxy circuit must refuse subsequent requests until restart/recovery. |
| Packed artifact | `npm pack`; record the tarball digest and inspect that `bin`, compiled `dist`, pricing, baselines, and dashboard HTML are present |
| Clean installed CLI | Install the tarball with `--ignore-scripts` in a fresh directory and run `fiscus --help` |
| Packaged dashboard/API | Use an isolated `FISCUS_HOME` (records below that predate the rename cite the pre-rename variable, which is what those runs actually used); seed labelled demo data; start the installed dashboard; probe health, overview, value, and HTML; terminate it cleanly |
| Model-trial truthfulness | The packaged value payload must self-label `demo: true`; any seeded model switch must be `trial`, never evidence-supported; the **`/classic`** HTML must contain the labelled renderer. Check `/classic`, not `/`: `/` is the GUI shell and renders every figure in the browser, so fetching it proves only that a shell was served. Prove `/` separately by confirming it carries `id="app"` and its module entry, and that the entry resolves as JavaScript — a shell whose compiled app is missing from the tarball serves a 200 and a blank dashboard |
| Causal-evidence integrity | Run `test/causal-core.test.ts`, `test/causal-store.test.ts`, `test/causal-cli.test.ts`, `test/causal-dashboard.test.ts`, and the Store-owned producer/ordinary-ledger cohort. In a clean installed artifact, prove `fiscus causal status --json` reports no publicly inspectable retained-v1 study/no causal result by default. Prove v1 registration and assignment preview/apply refuse with `CAUSAL_LEGACY_INSPECT_ONLY`; prove valid-v2 registration preview/apply refuse before Store open or mutation with `CAUSAL_V2_CLI_DEFERRED`; and prove Store-owned v2 assignment is atomic without implying that a v2 registration or assignment CLI exists. Retained v1 assignment replay still verifies. Current CLI/API/dashboard summaries expose retained v1 only; v2-only Store state remains bounded and non-500 rather than becoming the legacy projection. A no-outcome retained-v1 study remains `collecting`, not a causal claim. Verify `/api/causal` is GET/HEAD-only, redacts randomisation material, and exposes no mutation or automatic routing/budget action. This is release-gate evidence, not release approval. The branch now has a Store-owned independent scalar identity and ordinary-ledger adapter, but these are still internal local evidence, not a public result. Public v2 execution/outcome projection, qualification snapshots as a released result, export, and full v2 public projection remain deferred; cost-bearing internal qualification remains fail-closed unless the sidecar, independently derived identity, ordinary ledger evidence, provider/account scope where required, and every other causal gate are valid. |
| Billing-boundary truthfulness | `fiscus billing scope set --account-ref <test-ref> --json` must remain a no-write, `operator_declared_unverified` preview; packaged demo `/api/billing` must self-label `demo: true`, retain `not_reconciled`, show zero fabricated billing records, and expose exact mapping coverage without promoting operator declarations to provider authority |
| Direct-Costs connector boundary | A packaged local scope with `proj_…` must yield an OpenAI Costs **preview** with `networkAttempted: false` and `credentialRead: false`. It does not validate a provider account, authorize a live pull, or reconcile a provider amount. |
| Egress disclosure | Reconcile every newly introduced outbound path with DATA-BOUNDARIES.md; distinguish Fiscus-process enforcement, proxy-routed traffic coverage, browser behaviour, and any separately validated OS/network control. Verify corrupt-history refusal, redirect `Location` stripping, checkpoint fallback/full-scan behavior, streaming full-history verification/line bounds, and response-body release for status-only callers. Do not project a process-level test into a workstation-wide or provider-privacy guarantee. |
| Launcher/publication integrity | The supported launcher must propagate child spawn errors/signals and fail closed when the publication lock cannot be acquired; build/publication tests must exercise both conditions. Direct unmanaged `dist/*` readers and `npm pack` remain outside the supported reader lock unless separately proven. |
| Backup and recovery integrity | Exercise `backup --out` and `restore --from/--out` against the exact candidate. The snapshot must be created with SQLite `VACUUM INTO`, pass quick/foreign-key checks, emit a hash/schema manifest without ledger rows, reject corrupt or symlinked artifacts, refuse existing destinations, and prove preview is read-only. This is local recovery evidence only—not encryption, disaster-recovery availability, provider billing, or an independent attestation. |
| Reliability/performance observations | Run `npm run benchmark` on the candidate and retain the JSON plus machine profile. Cover small/current/10× and an explicit 100× stress case where meaningful; record startup, ingest, summary, value/frontier, API latency, memory, and compiled/package size observations. Do not turn a single local run into a universal SLA; choose a regression budget only after repeated runs on the intended release runner. |
| Redacted diagnostics | Run `fiscus diagnostics --json` and, when support handoff needs a file, `--out <new-file>`. The bundle must carry a correlation operation ID, bounded durations/error classes, runtime/config/database/migration/egress/pricing observations, and explicit no-network/no-credential/no-prompt/source/ledger-row-export boundaries without absolute user paths. Export refuses overwrite and does not mutate the active DB/config. |
| Intended CI | Inspect the CI jobs for the intended commit, not merely a workflow definition or an old run. If the candidate reached the remote inside a multi-commit push, CI ran on the tip; cite that run and record `git diff --stat <candidate> <tip>` so the delta is stated rather than assumed. A tip that differs only by this document does not need its own run — otherwise recording a result would forever require another commit |
| Visual check | Inspect the non-empty labelled packaged dashboard in a browser as a supplement to, not a substitute for, the HTTP/API proof; verify keyboard/focus, responsive, contrast, chart alternatives, and screen-reader status semantics on the exact candidate. Source/DOM contracts must not be reported as visual/WCAG runtime evidence. |

This validates a local developer preview only. It does **not** validate a
provider billing statement, production customer data, an npm publication, an
external deployment, or the optional team service.

**Current internal causal substrate.** The exact branch includes the
Store-internal V2 execution, terminal-outcome, follow-up-policy,
clock-authority, qualification, T-069 scalar lineage-validation, and
Store-owned independent producer code at source revisions `e3cef41` and
`0fc647c`, including the append-only `causal_lineage_bindings_v2` sidecar. The
producer authenticates the retained protocol, assignment, execution, matured
outcome, request set, declared scope, realization, and Git scalar rows; it
derives the unit identity independently from retained Git metadata and verifies
the exact local request ledger before an atomic append. The ordinary realization
pipeline still does not invoke that adapter automatically. These records are not
public CLI/API/dashboard evidence. Cost-bearing internal qualification remains
fail-closed unless the sidecar is present and valid, ordinary ledger evidence is
verified, provider/account scope is addressed where required, and every other
causal gate passes.
Commit `aa24764` enables recursive SQLite triggers for every operational and
migration-verification connection, so the physical append-only triggers also
cover `INSERT OR REPLACE` conflict resolution. The same branch also carries
the token-safe build publication/launcher read hardening at `3516e5a`.
The follow-up `4e8d387` records its exact supported-reader guarantee and the
remaining unmanaged-reader boundary. That build protocol adds a source-generation
fingerprint (captured before compilation and checked again inside the
publication gate), one bounded retry on source drift, and an exclusive reader
gate in the supported `bin/fiscus.mjs` launcher. Thus a build that started from
an older source generation cannot publish after a newer generation merely
because it finished compiling later, and the supported launcher cannot resolve
the file-by-file publication while it is in progress.

This guarantee is deliberately scoped. The package-compatible top-level
`dist/*` paths remain ordinary files, because replacing the non-empty `dist`
directory is not an atomic overwrite on Windows (and a POSIX remove/rename
sequence would introduce a reader gap). Direct module imports of `dist/*` and
tools such as `npm pack` do not acquire the Fiscus gate and therefore remain
outside the whole-tree reader guarantee; changing that would require a
generation-pointer or symlink/junction package-layout change that would break
the existing `dist/cli.js`/deep-import and package-surface contract. The
historical candidate rows below do not cover these later sources and must not
be reused as exact-head release evidence.

### Current local candidate record — source commit `6602288`, 2026-08-29

This record supersedes the `a5d1121` record above without rewriting it. The
exact candidate head is
`660228811361e58004f2a30ed5acfad5d79de69d` in the isolated
`codex/high-assurance-foundation` worktree. Its code-bearing parent is
`07855b8`; `dd09d07` refreshes the exact performance documentation,
`16e123b` records the first exact-head gate, `0f2840a` refreshes the root
handoff, `2e1ab4b` binds the release record, and `6602288` makes that handoff
checkpoint resilient. The full source suite was run against the code-bearing
tree, and the only deltas to this candidate are documentation. The source/package tree
was clean before and after the exact-head package/runtime validation below.
This remains a local developer candidate, not an external release: no push,
exact-head CI run, registry publication, deployment, provider credential, or
browser connector evidence exists.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` → `660228811361e58004f2a30ed5acfad5d79de69d`; the candidate worktree was clean before and after the exact-head validation. |
| Capability/evidence contract | **Pass.** The capability, causal-protocol, data-boundary, roadmap, handoff, and release-gate documents were reviewed against the candidate. The full suite includes public-claims, egress, causal, billing, backup, diagnostics, and package-surface contracts; no local estimate is promoted to provider billing, causal return, or automatic routing. |
| Source validation | **Pass.** Root `npm ci --ignore-scripts` → 4 packages, 0 vulnerabilities; `team-server` `npm ci --ignore-scripts` → 19 packages, 0 vulnerabilities; root, browser-app, and team-server typechecks exit 0. Full `npm test` → **911 tests, 908 pass, 0 fail, 3 intentional platform skips** on the immediately preceding code-bearing tree (`07855b8`); `dd09d07`, `16e123b`, `0f2840a`, `2e1ab4b`, and `6602288` have no source/test delta. `npm run build` exit 0; `npm run build -- --web` exit 0 with the CLI SHA-256 unchanged (`C427AB11B811360FC66950FE03B24F251FBE862D0DAABE3DC5EE8E56E81A2E6`). |
| Packed artifact | **Pass for the source/package evidence head `dd09d07`.** `npm pack --ignore-scripts` → **170 entries, 820,950 bytes**, SHA-256 `745DB03EF4BFD873DF57986159241170447059552CAAAB37E8E20D82E0A03A9B`. The later `16e123b`, `0f2840a`, `2e1ab4b`, and `6602288` documentation commits do not change compiled runtime paths; the package hash remains explicitly bound to `dd09d07`. Required launcher/publication-lock, compiled CLI/store/backup/diagnostics/dashboard, pricing, baselines, seal, and public docs are present; internal `.codex`/superpowers and research-only `dist/value/causalExperiment.js` paths are absent. |
| Clean installed CLI | **Pass.** The exact tarball was installed with scripts disabled into a fresh prefix. Packaged `fiscus --help` includes `backup` and `diagnostics`; isolated `demo --json`, active-ledger `today --json`, and `causal status --json` ran successfully. The causal status contained `studies: []`. |
| Packaged dashboard/API | **Pass.** From the exact tarball and isolated `FISCUS_HOME`, `start --demo --port 18190 --dashboard-port 18191` served HTTP 200 for `/api/health`, `/api/overview?range=all`, `/api/value?range=all`, `/api/causal`, `/api/billing`, `/`, `/classic`, and `/app/main.js`. Overview/value/causal/billing payloads self-labelled demo mode; `/` carried `id="app"`; `/classic` carried the labelled renderer; `/app/main.js` resolved as JavaScript; the process was stopped and both test ports were closed. |
| Model-trial truthfulness | **Pass for the local boundary.** Source and value/frontier contracts continue to require like-task evidence, minimum cohorts, and an anytime-valid separation before `evidence_supported`; the packaged demo remains synthetic and review-only (`trial`) with no automatic routing or provider-savings claim. |
| Causal-evidence integrity | **Pass for the local boundary, not a causal result.** The exact 911-test suite covers append-only V1/V2 state, scalar lineage, recursive-trigger conflict protection, replay, and collecting/no-outcome precedence. Packaged status reports no retained public study. A governed prospective study, independent outcomes, provider/account scope, and public qualification remain absent. |
| Billing-boundary truthfulness | **Pass.** Packaged `/api/billing` remains demo-labelled and `not_reconciled`. An isolated source run of `billing scope set --apply` preserved `operator_declared_unverified`; `billing openai-costs preview` returned `applied: false`, `networkAttempted: false`, and `credentialRead: false` for a `proj_gate_release` scope. No provider account or amount was validated. |
| Direct-Costs connector boundary | **Pass for preview only.** The preview above read no credential and made no network request; live collection and reconciliation remain owner-authorized external gates. |
| Egress disclosure | **Pass for the local process boundary.** Egress, redirect-`Location` stripping, response-body release, checkpoint, and streaming full-history tests pass. Receipt verification keeps the retained chain without materializing the entire JSONL; the documented scope remains Fiscus-process transport, not a machine-wide firewall or provider-retention guarantee. |
| Launcher/publication integrity | **Pass.** Spawn/signalled-child errors and publication-lock failures are nonzero/fatal in the supported launcher; build-race/source-fingerprint tests pass. Direct unmanaged `dist/*` readers and `npm pack` remain explicitly outside the whole-tree reader lock. |
| Backup and recovery integrity | **Pass.** The packaged CLI created a `VACUUM INTO` snapshot with `integrity: ok`, SHA-256/schema fingerprint, required `requests`/`sessions` contract, and a redacted manifest; restore preview reported `applied: false`, and `--apply` restored into a new path. Corrupt/tampered/existing-destination tests fail closed; no active ledger was overwritten. |
| Reliability/performance observations | **Pass as measurement, not SLA.** The exact-head harness (`sourceRevision: dd09d07`, Node `v24.18.0`, win32/x64, 12 CPUs) covered 100/1,000/10,000 rows with three samples and a 100,000-row one-sample stress case. The recorded medians are ingest 6.02/44.68/479.91/5,000.99 ms, overview 3.03/9.20/94.91/1,395.28 ms, frontier 0.59/1.42/14.75/331.08 ms, and API p95 8.32/12.06/106.88/1,379.76 ms; RSS deltas and compiled-dist size are recorded in `docs/RELIABILITY-PERFORMANCE.md`. No universal threshold is asserted. |
| Redacted diagnostics | **Pass.** The packaged command emitted a version-1 bundle and atomically exported it without leaking the isolated home path. Source tests prove operation IDs, finite probe durations/error classes, read-only schema/migration inspection, egress/pricing observations, overwrite refusal, and no prompt/source/credential/ledger-row export. |
| Intended CI | **Not satisfied.** No push was authorized and no CI run exists on this local candidate head. A workflow definition or historical run is not substituted for exact-head evidence. |
| Visual check | **Not satisfied in this environment.** Source/DOM contracts and packaged HTTP probes pass, but no browser connector is installed here; screenshot, keyboard traversal, contrast, screen-reader tree, and WCAG runtime evidence remain unverified. |

**What this candidate establishes.** This is a clean, locally verified,
reviewable high-assurance implementation checkpoint with fail-closed budgets and
egress, causal/evidence separation, exact billing provenance, accessible source
semantics, non-destructive backup/restore, bounded receipt verification,
reproducible performance observations, and a redacted support bundle. It does
not establish provider invoice finality, a qualified causal financial result,
machine-wide privacy, hosted team-server readiness, a production deployment, or
an external publication.

### Superseded record — source commit `a5d1121`, 2026-08-27

The record below is bound to source commit
`a5d112109b42872a206849cd4f8898743806b7c4` in the isolated
`codex/high-assurance-foundation` worktree. The source tree was clean before and
after validation. The release-gate document itself is the documentation-only
follow-up commit that records this evidence; under the rule above, that change
does not require rerunning source tests or inventing a new CI result. The local
candidate is strong enough for a reviewable developer preview, but it is **not
an external release**: no push was authorized, no exact-head CI run exists for
this branch, and no browser connector is available for visual/keyboard/WCAG
evidence.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` → `a5d112109b42872a206849cd4f8898743806b7c4`; `git status --short` was empty before and after the source/package validation. |
| Capability/evidence contract | **Pass.** `docs/CAPABILITY-EVIDENCE-CONTRACT.md`, `docs/CAUSAL-EVIDENCE-PROTOCOL.md`, `docs/CAUSAL-PRODUCER-CONTRACT.md`, the AI FinOps roadmap, and the handoff were reviewed against this source. The full suite includes the public-claims and egress-boundary checks. New producer and mapping claims are explicitly local, operator-declared, residual-bearing, and excluded from provider billing, causal, budget, and routing claims. |
| Source validation | **Pass.** `npm ci` → 4 packages, 0 vulnerabilities; root typecheck exit 0; browser-app typecheck exit 0; full `npm test` → **877 tests, 875 pass, 0 fail, 2 intentional platform skips**; `npm run build` exit 0; `npm run build -- --web` exit 0 with the CLI artifact hash unchanged. |
| Packed artifact | **Pass for source commit `a5d1121`.** `npm pack --ignore-scripts` → **164 entries, 803,487 bytes**, SHA-256 `2CC9DF3D722E3E5BD9085176C2523DC605EDB50D8A53B720604A5C3ED7DCEA48`; the artifact contains `bin/fiscus.mjs`, `bin/publication-lock.mjs`, compiled causal producer/ledger/store/dashboard code, pricing, baselines, and the reviewed public docs. The subsequent gate-record commit changes only this document. |
| Clean installed CLI | **Pass.** The tarball was installed offline with `--ignore-scripts` into a fresh prefix; packaged `fiscus --help`, `demo --json`, and `causal status --json` ran successfully. |
| Packaged dashboard/API | **Pass.** From the installed tarball and isolated `FISCUS_HOME`, `start --demo` served HTTP 200 for `/api/health`, `/api/overview?range=all`, `/api/value?range=all`, `/api/causal`, `/api/billing`, `/`, `/classic`, and `/app/main.js`. Overview, value, causal, and billing payloads self-labelled demo mode; causal status contained no public study; `/classic` carried the labelled demo renderer; `/` carried `id="app"`; `/app/main.js` resolved as JavaScript; the dashboard process terminated and the port was closed. |
| Model-trial truthfulness | **Pass.** The packaged value payload is demo-labelled and the synthetic same-task comparison remains review-only (`trial`), with no evidence-supported switch or automatic routing. The mapping panel is informational and has no write action. |
| Causal-evidence integrity | **Pass for the local boundary, not a causal result.** The causal ledger/producer/store cohort and the full suite pass. The packaged status command reports no publicly inspectable retained study/result. The Store-owned producer derives and atomically persists a scalar identity only when exact local request evidence passes; public v2 registration, lifecycle, qualification projection, export, and any causal customer claim remain deferred. |
| Billing-boundary truthfulness | **Pass.** Exact imported-record mapping is append-only and visible as mapped/residual coverage; demo `/api/billing` contains the mapping contract without fabricated provider records. An isolated packaged OpenAI scope was used only for the connector preview; the declaration remains `operator_declared_unverified` and imported/mapped evidence remains excluded from spend controls, RoI, and model advice. |
| Direct-Costs connector boundary | **Pass.** Packaged `billing openai-costs preview --from 2026-01-01 --to 2026-01-02 --json` returned `applied: false`, `networkAttempted: false`, and `credentialRead: false` for an isolated `proj_gate_test` scope. No provider account was validated and no live pull occurred. |
| Egress disclosure | **Pass.** The full egress and public-claims checks pass; the new mapping and producer paths perform no network calls. The documented process-scoped, rule-gated transport boundary and its non-claims remain unchanged. |
| Intended CI | **Not satisfied.** No push was authorized and there is no CI run on this exact local head. A workflow definition or historical run is not substituted for current evidence. |
| Visual check | **Not satisfied in this environment.** Source/DOM contract tests and packaged HTTP probes pass, but no browser connector is installed, so screenshot, keyboard interaction, and WCAG runtime evidence were not obtained. |

**What this candidate establishes.** This is a locally verified, reviewable
implementation checkpoint. The independent causal identity/ledger substrate and
exact billing mapping coverage are now implemented and tested. They do not
establish provider invoice finality, a qualified causal financial result,
machine-wide privacy, hosted multi-tenant readiness, or automatic model/budget/
routing actions. CI, browser interaction evidence, real PostgreSQL/OIDC/TLS/
backup validation, owner-authorized push, and registry publication remain
separate gates.

### Candidate record — commit `f2f3c9a`, 2026-08-21

Run against `f2f3c9acd50f4e7fd4c0f11a706a9b4b4307758f` in a throwaway worktree
with a real `npm ci`, worktree clean before and after validation (0 modified
paths either side, excluding the `npm pack` artifact). **All ten rows pass.**
Supersedes the `205fbcc` record, which predates the GUI rewrite landing in the
package, the security fixes, the Fiscus rebrand, and the dependency majors.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` → `f2f3c9acd50f4e7fd4c0f11a706a9b4b4307758f` before and after; `git status --short` empty both times. |
| Source validation | **Pass.** `npm ci` → 4 packages, 0 vulnerabilities. Typecheck run as BOTH passes, because the root config excludes the browser app and green on one says nothing about the other: node pass exit 0, `src/dashboard/web/app` pass exit 0. `npm test` → **613 tests, 612 pass, 0 fail, 1 skipped**. `npm run build` clean. Team-server, separately: typecheck 0, **55/55**. |
| Packed artifact | **Pass.** `npm pack` → **139 files**, SHA-256 `03ebe86e5883729eaac0e1ea9c3aaa91516ad8ba078274451f2238d42656bdfa`; all 6 key paths present. **35 more than `205fbcc`, 0 removed**, and the delta was enumerated rather than asserted: 26 are the compiled browser app now shipping in the tarball (`dist/dashboard/web/app/**`, `classic.html`, `styles/app.css`, `routes.js`, `static.js`), 7 are module extractions (`store/{allocation,billing,realization,rows,schema}.js`, `budget/enforceability.js`, `cost/coverage.js`, `value/report.js`, `billing/readiness.js`), and 2 are new docs. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts --no-package-lock` into a fresh directory; `fiscus --help` renders; `fiscus demo` seeds into an isolated home. |
| Packaged dashboard/API | **Pass.** Isolated `FISCUS_HOME`, seeded demo, packaged dashboard on :18191. `/api/health` → `{"ok":true,"service":"fiscus-dashboard"}`; `/api/overview?range=all` → `demo: true`, **552 requests, $89.66053895** — identical to every prior record, so the GUI rewrite and the rebrand moved no figure. Terminated cleanly (PID 27544, tree kill); :18190 and :18191 both confirmed closed afterwards. |
| Model-trial truthfulness | **Pass.** Packaged `/api/value` self-labels `demo: true`; exactly one switch under `frontier.modelSwitches`, `confidence: "trial"`, no `evidence_supported`; `allocation: null`. `/classic` contains all three labelled strings (`DEMO DATA`, `Cheaper model trials`, `NOT RECONCILED`), 169,272 bytes. `/` proved separately as the shell: carries `id="app"` and its `/app/main.js` entry, and that entry resolves **HTTP 200, `text/javascript`** — the check a shell-only fetch cannot make. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --account-ref gate-test-ref --json` → `applied: false`, `trust: "operator_declared_unverified"`, no write. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`, and `reconciliation.runs` an **array** of length 0 (the field whose declared type once disagreed with the wire). New this candidate: `readiness` is served here too — `ready: false`, coverage `$3.328845` imported across 44 requests and `$1.708766` proxy-off-scope across 45, so both uncountable buckets are exercised on the packaged artifact rather than only in unit tests. |
| Direct-Costs connector boundary | **Pass.** Packaged local scope with `proj_gate_test` applied, then `billing openai-costs preview --from 2026-01-01 --to 2026-01-02 --json` → **`networkAttempted: false`, `credentialRead: false`**, `applied: false`. No provider account validated, no live pull authorized, no provider amount reconciled. |
| Intended CI | **Pass, with no delta to state.** Run **CI #110** (`https://github.com/GamingDragonwastaken/Fiscus/actions/runs/32510582815`): status **Success**, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. Unlike the prior three records, CI ran on **the candidate commit itself**, not on a later tip, so there is no `git diff --stat` delta to record. |
| Visual check | **Pass.** Packaged dashboard, precise register. At 375×812 all five views — Spend, Evidence, Control, Value, Settings — report `scrollWidth 375` on `clientWidth 375`: **no view overflows**, including Evidence, which gained a panel this candidate. At 1280×800 Evidence is 1265/1265 and the new readiness panel renders `$5.037610 of local OpenAI spend cannot reconcile` with its per-bucket breakdown. No console errors on either size. Screenshots remain unavailable in this environment — the browser pane is not displayed, so the page composites no frames and `computer{action:"screenshot"}` times out — so this row rests on DOM and computed-style inspection and says so rather than implying a picture was reviewed. |

**What this candidate changes, and what it does not.** Reconciliation readiness
is now served on `/api/billing` and rendered in the GUI, from the same
`src/billing/readiness.ts` the CLI prints. That closes a gap where the terminal
could warn an operator that a provider pull would match nothing and the primary
surface could not. It does **not** make any reconciliation succeed.

**Still true, and unchanged by any of this:** no reconciliation has completed
against a real provider bill on this machine, and the negative real-data result
recorded under `205fbcc` was re-confirmed at this candidate rather than
softened. On the owner's real ledger all 9,499 OpenAI rows arrived by native
import; **all 115 Codex rollout logs were scanned and carry no OpenAI account,
project, or organization identifier at all** — the 18 files that matched such a
pattern contain MCP tool-schema definitions quoted inside conversation text, not
provider metadata. So this is a gap in the source data, not a matching bug, and
no matching logic can close it.

**One reserved decision was pre-empted and needs owner ratification.** Item 2 of
*Required before public npm/GitHub release* reserves LICENSE
ownership/attribution. During the rebrand the copyright line was changed on
instruction, from the pre-rename product name to `Fiscus contributors`. It is
recorded here rather than quietly kept: the owner should ratify or reverse it,
and this gate does not treat it as settled.

### Superseded record — commit `205fbcc`, 2026-08-18

Run against `205fbcc6735c6b3518a551f1b7fd472f78f9e5a4`, worktree clean before and
after validation. **All ten rows pass.** Supersedes the `916e1c3` record,
retained for history.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `205fbcc6735c6b3518a551f1b7fd472f78f9e5a4`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm run typecheck` clean, `npm test` **543 tests / 542 pass / 1 expected platform skip / 0 fail**, `npm run build` clean, `git diff --check` clean. |
| Packed artifact | **Pass.** `npm pack` → 104 files, SHA-256 `535f2f0e0756722235e96d8361b7cd3e106e9574c49f0b095933734b30b57f37`; all 6 key paths present. Same file count as `916e1c3` — this candidate changes existing modules and adds no packaged file. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders; `fiscus demo` seeds. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo (552 requests), packaged dashboard on :8109. `/api/health` → `{"ok":true,"service":"fiscus-dashboard"}`; `/api/overview?range=all` → `demo: true`, 552 requests, `$89.66053895`. Terminated cleanly (PID 4528, tree kill); :8090 and :8109 both confirmed closed afterwards. |
| Model-trial truthfulness | **Pass.** Packaged `/api/value` self-labels `demo: true`; one switch, `confidence: trial`, no `evidence_supported`; `allocation: null`. |
| Billing-boundary truthfulness | **Pass.** Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`. `/api/allocation` → `kind: derived_cost_allocation`, `basis: showback_only`, `reconciliation.everRun: false`. |
| Direct-Costs connector boundary | **Pass, and extended by the readiness row.** On the packaged artifact, adopt → reconcile still reports `providerSourceKind: operator_supplied_export`, **5 conditions**, provider side `21500000` micros, `trust: scope_conditional_reconciliation`. The new pre-credential coverage block returns `null` on a store holding no OpenAI rows rather than reporting a fabricated zero-coverage warning. |
| Intended CI | **Pass, with the delta stated** (per the rule in the checklist above). Run **CI #34** (`.../actions/runs/32091103510`): status **Success**, 1m 3s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. The run is for the pushed tip `c1912f5`; `git diff --stat 205fbcc c1912f5` is `docs/RELEASE-GATE.md` alone, 1 file changed — no source, no test, no packaged code. |
| Visual check | **Pass, and the previously stated gap is closed.** Packaged dashboard at 375×812: Overview, Billing, Allocation, Value and Settings all report `scrollWidth 375` on a `clientWidth 375` document — **no view overflows**, including Value, which was 483px at `916e1c3`. Desktop 1280 re-checked on the same packaged artifact: `.ihelp` still computes `position: relative`, the popover is 270px with its `::after` arrow shown, `.grid` is still two-column (`1.5fr 1fr`), and the allocation view renders its 3 cards. No console errors. Screenshots remain unavailable in this environment — the browser pane is not displayed, so the page composites no frames and `computer{action:"screenshot"}` times out — so this row rests on DOM and computed-style inspection and says so rather than implying a picture was reviewed. |

**The reconciliation was run against this machine's real ledger, and it
failed — which is the finding.** `fiscus import all` produced 18,422 real
requests totalling `$1,574.42`, of which `$832.33` across 9,499 requests is
OpenAI. None of it can reconcile. Every OpenAI row arrived by **native import**,
and reconciliation counts only proxy traffic carrying the declared scope. It has
to: an imported row records the model and the cost but nothing that ties it to
the declared provider project, so counting it would invent exactly the
attribution this layer refuses to invent. A real Costs pull against this ledger
would have reported the entire provider bill as unexplained residual —
arithmetically true and operationally useless.

**So the tool now says that before the credential step, not after.** Minting an
OpenAI Admin key is a real permission decision; discovering afterwards that
nothing would have counted is discovering it too late. `fiscus billing
reconcile` readiness now reports how much OpenAI spend would count, how much
arrived by import, and how much is proxy traffic predating the declaration. The
coverage query returns `null` — not a zero — when the ledger holds no OpenAI
rows at all, because "no coverage" and "no data" are different answers.

**Still true, and unchanged by any of this:** no reconciliation has completed
against a real provider bill on this machine. The gate's end-to-end exercise
still uses a **synthetic** export. What is new is that the real-data run was
attempted, and its negative result is recorded here rather than deferred.

**Team server at this tree:** typecheck clean, **55/55** — source validation
only. It moves none of the five infrastructure requirements in the separate gate
below.

### Superseded record — commit `916e1c3`, 2026-08-18

Run against `916e1c304a1aa9d036483e752dd68e7c5aa6c391`, worktree clean before and
after validation. **All ten rows pass.** Supersedes the `a9fc6b2` record,
retained for history.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `916e1c304a1aa9d036483e752dd68e7c5aa6c391`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm run typecheck` clean, `npm test` **542 tests / 541 pass / 1 expected platform skip / 0 fail**, `npm run build` clean, `git diff --check` clean. |
| Packed artifact | **Pass.** `npm pack` → 104 files, SHA-256 `c430a91df44bf4c520805747ca660432de6c648792a9ddcf329d48d7eaa59c2e`; all 6 key paths present. Same file count as `a9fc6b2` — this candidate changes existing modules rather than adding one. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo (552 requests), packaged dashboard on :8107. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`, 552 requests, `$89.66053895`. Terminated cleanly, both ports confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; one switch, `confidence: trial`, no `evidence_supported`; `allocation: null`. |
| Billing-boundary truthfulness | **Pass.** Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`, `reconciliation.runs: 0`. `/api/allocation` → `showback_only`, 0 runs, `reconciliation.everRun: false`. |
| Direct-Costs connector boundary | **Pass, and extended to the new route.** On the packaged artifact, `billing openai-costs adopt --import-id <id> --json` → `applied: false`, **`networkAttempted: false`, `credentialRead: false`**, `adoptable: true`, `matchedMicros: 21500000`, and the account-level credit reported as excluded at `-2000000` rather than dropped. After `--apply`, `billing reconcile --json` → `providerSourceKind: operator_supplied_export`, **5 conditions** including `provider_report_is_operator_supplied_and_unverified`, `trust: scope_conditional_reconciliation`. |
| Intended CI | **Pass, with the delta stated** (per the rule in the checklist above). Run **CI #32** (`.../actions/runs/32081199991`): status **Success**, 1m 15s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. The run is for the pushed tip `49a5f33`; `git diff --stat 916e1c3 49a5f33` is `docs/RELEASE-GATE.md` alone, 1 file changed — no source, no test, no packaged code. |
| Visual check | **Pass, with a stated gap.** Packaged dashboard at 375px: `header` computes `flex-wrap: wrap`, the view switcher sits inside the viewport, and Overview, Billing, Allocation and Settings no longer scroll sideways (375px document on a 375px viewport, down from ~890px). **Value still overflows to 483px** — diagnosed, not fixed, and recorded in the stylesheet: its 15 tooltip popovers are laid out while invisible, and a viewport-relative `max-width` cannot fix it because the viewport is itself widened by the overflow. No console errors. Screenshots remain unavailable in this environment (the browser pane is not displayed, so the page composites no frames), so this row rests on DOM and computed-style inspection and says so rather than implying a picture was reviewed. |

**The credential was the wrong blocker, and that is what this candidate
changes.** A read-only Costs pull needs an Admin key; minting one requires a
different permission than reading a bill. An owner who could export their costs
still could not reconcile. `openai-costs adopt` turns an already-imported
operator export into an observation at the same project-day grain, reading no
credential and making no network request.

**It is not sold as equivalent evidence.** Observations now carry a source kind;
the adopt path stamps `operator_supplied_export`, the pull path stamps
`provider_api_pull`, and rows written before the column existed stay
`legacy_unknown` — deliberately not backfilled to the pull even though the pull
was the only writer that could have produced them, because provenance asserted
from context rather than captured from evidence is the failure the column exists
to prevent. The stamp survives into the reconciliation and into the recorded
run, and produces a fifth permanent condition that the CLI and dashboard both
state in words.

**Adoption refuses what it cannot honestly observe** — anything not a whole UTC
day, anything outside the declared project, anything not single-currency USD —
and reports what it excluded with its money. A silently dropped account-level
credit would understate the provider side and reappear later as a residual that
never existed.

**Still true, and unchanged by any of this:** no reconciliation has been run
against a real provider bill on this machine. The end-to-end exercise above used
a **synthetic** export authored for the gate, and the local ledger it compared
against holds zero requests — which is why the packaged run reports
`no local capture` on every day. That is an honest first-run result, not a
validated reconciliation of real spend.

**Team server at this tree:** typecheck clean, **55/55** — source validation only.

### Superseded record — commit `a9fc6b2`, 2026-08-18

Run against `a9fc6b2e01869b7bd8d9f4e24ffb782c891c3a51`, worktree clean before and
after validation. **All ten rows pass.** Supersedes the `3ddf625` record,
retained for history.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `a9fc6b2e01869b7bd8d9f4e24ffb782c891c3a51`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm run typecheck` clean, `npm test` **535 tests / 534 pass / 1 expected platform skip / 0 fail**, `npm run build` clean, `git diff --check` clean. |
| Packed artifact | **Pass.** `npm pack` → 104 files, SHA-256 `e30737567d5b9f5cc90256a29efffd1aab235047f59fa696d5e46b41ebe55e54`; all 6 key paths present. Same file count as `3ddf625` — this candidate adds an API route and a view to files that already ship, not a new module. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo (552 requests, $89.66), packaged dashboard on :8105. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`, 552 requests, `$89.66053895`. Terminated cleanly, port confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; one switch, `confidence: trial`, no `evidence_supported`. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --json` → `applied: false`, preview `trust: operator_declared_unverified`, `reconciliationStatus: not_reconciled`. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`, `reconciliation.runs: 0`. |
| Direct-Costs connector boundary | **Pass.** With an applied `org_…`/`proj_…` scope, `billing openai-costs preview --json` → `networkAttempted: false`, `credentialRead: false`. |
| Intended CI | **Pass, with the delta stated** (per the rule in the checklist above). Run **CI #30** (`.../actions/runs/32077684444`): status **Success**, 1m 5s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. The run is for the pushed tip `f8348c5`; `git diff --stat a9fc6b2 f8348c5` is `docs/RELEASE-GATE.md` alone, 1 file changed — no source, no test, no packaged code. |
| Visual check | **Pass.** Packaged dashboard in the browser, Allocation view: 5 cards; header state `SHOWBACK · DERIVED FROM LOCAL ESTIMATES · RESIDUAL UNEXAMINED`; conservation line renders as `$51.43 allocated + $38.23 unallocated = $89.66 ledger total · exact`; the unallocated bucket names `web-frontend ($15.79), data-pipeline ($13.48), default ($8.94), codex ($0.01)`; the proportional rule reports `every directly-allocated centre`; the range picker is `display: none`; no horizontal page overflow; no console errors. Screenshots were unavailable (the browser pane was not displayed), so this row rests on DOM and computed-style inspection, as the preceding records do. |

**The new surface is a read path, and that was the point of checking it.**
`GET /api/allocation` serves recorded runs and never computes one; the packaged
probe returned `kind: derived_cost_allocation`, `trust:
derived_allocation_of_local_estimates`, `basis: showback_only`, a 4-entry
`excludedFrom`, `conserves: true`, and `sourceBases: [synthetic_demo, unpriced]`.
`/api/overview` still reports 552 requests and `$89.66053895` with no
`allocation` key, and `/api/value` still reports `allocation: null` and
`projectAllocation: null` — a recorded allocation reaches no control.

**Three display defects were found by rendering the page and are fixed here.**
A `proportional_to_direct` rule was showing its placeholder centre in a Targets
column the engine never reads; a rule version superseded at epoch 0 read as *in
force* because the state was chosen on truthiness; and the view switcher's
intent to hide the range picker had never worked, so Billing has been showing a
filter that does nothing. The first two are exactly the failure this layer
refuses elsewhere — presenting a number the engine discarded — and none of them
were reachable by the API tests, the typecheck, or the build.

**The caveat this page now states in its own header:** no reconciliation has run
against real provider data, so the residual beneath every allocated figure is
unexamined. That is unchanged by shipping a surface for it; the page says so
rather than letting a well-rendered bar chart imply otherwise.

**Team server at this tree:** typecheck clean, **55/55** — source validation only.

### Superseded record — commit `3ddf625`, 2026-08-18

Run against `3ddf6259c90cf7b6eeb42b8e2875aa2b967de367`, worktree clean before and
after validation. **All ten rows pass.** Supersedes the `b990c3d` record,
retained for history.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `3ddf6259c90cf7b6eeb42b8e2875aa2b967de367`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm run typecheck` clean, `npm test` **527 tests / 526 pass / 1 expected platform skip / 0 fail**, `npm run build` clean, `git diff --check` clean. |
| Packed artifact | **Pass.** `npm pack` → 104 files, SHA-256 `b048f11404729cf68555eeb6baeb72eebad437039d4e4c1df4f4302e37b6245c`; all 6 key paths present. Four more than `b990c3d`: `src/alloc/{rules,apply}.ts` and `src/cli/allocCmd.ts` compile into `dist`, plus `docs/ALLOCATION.md`. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo (552 requests), packaged dashboard on :8103. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`. Terminated cleanly, port confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; one switch, `confidence: trial`, no `evidence_supported`, zero confounders, 4 assumptions. Attribution coverage still returns all five bases with `demo: true`. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --json` → `applied: false`, `trust: operator_declared_unverified`, `reconciliationStatus: not_reconciled`. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`, `reconciliation.runs: 0`. `billing reconcile --json` → `status: not_ready` with both owner steps named. |
| Direct-Costs connector boundary | **Pass.** With an applied `org_…`/`proj_…` scope, `billing openai-costs preview --json` → `networkAttempted: false`, `credentialRead: false`. |
| Intended CI | **Pass, with the delta stated** (per the rule in the checklist above). Run **CI #28** (`.../actions/runs/32074341320`): status **Success**, 1m 4s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. The run is for the pushed tip `45e55be`; `git diff --stat 3ddf625 45e55be` is `docs/RELEASE-GATE.md` alone, 1 file changed — no source, no test, no packaged code. |
| Visual check | **Pass.** Packaged dashboard in the browser: DEMO banner; all five attribution bases including the two-basis `data-pipeline` split; exactly one rendered `TRIAL` badge and no `EVIDENCE` badge; Billing view renders the reconciliation card in its `NO RUN RECORDED` state. No console errors. |

**Allocation boundary, this candidate's new surface.** Exercised on the packaged
artifact against the seeded demo store: cost centres created, a `direct` and a
`fixed_split` rule authored, and a period run returning `conserves: true`,
`trust: derived_allocation_of_local_estimates`,
`allocated + unallocated === total` verified independently of the flag,
`unallocated` reasons present, and a 4-entry `excludedFrom`. A `fixed_split`
whose ratios sum to 1.4 was **refused with exit 1**, naming the sum.

**The honesty boundary this layer turns on was checked, not assumed.** Every run
carries the cost basis beneath it and self-labels as allocating *local
estimates*; on demo data that reads `synthetic_demo, unpriced`. Allocation
appears in no budget, RoI, or recommendation surface.

**Stated plainly, and recorded in `VISION-AUDIT.md` §3:** this layer was built
ahead of the sequencing that audit recommended. **No reconciliation has run
against real provider data**, so the residual remains unexamined and every
cost-centre figure is an estimate of unknown accuracy. The structural guards
(basis attached to the money, unallocated first-class, conservation enforced,
excluded from controls) are weaker than reconciling first, and are labelled as
such rather than presented as equivalent.

**Team server at this tree:** typecheck clean, **55/55** — source validation only.

### Superseded record — commit `b990c3d`, 2026-08-18

Run against `b990c3dba6e4332881002eba28a25db767b092ab`, worktree clean before and
after validation. **All ten rows pass.** Supersedes the `7bfb6dd` record,
retained for history.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `b990c3dba6e4332881002eba28a25db767b092ab`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm run typecheck` clean, `npm test` **510 tests / 509 pass / 1 expected platform skip / 0 fail**, `npm run build` clean, `git diff --check` clean. |
| Packed artifact | **Pass.** `npm pack` → 100 files, SHA-256 `f580cf2b53088ddb043da9639006290cc859eba8fc8388f165547a2786448abb`; all 6 key paths present. Two more files than `7bfb6dd`: `src/billing/reconcile.ts` compiles into `dist`, and `docs/PROVIDER-RECONCILIATION.md` ships with the other docs. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo (552 requests), packaged dashboard on :8099. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`. Terminated cleanly, port confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; one switch, `confidence: trial`, no `evidence_supported`, zero confounders, 4 assumptions, `costStaleUnits: 0`, `unitsExcludedStalePricing: 0`. Attribution coverage still returns all five bases with `demo: true`. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --json` → `applied: false`, `trust: operator_declared_unverified`, `reconciliationStatus: not_reconciled`. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`. |
| Direct-Costs connector boundary | **Pass.** With an applied `org_…`/`proj_…` scope, `billing openai-costs preview --json` → `networkAttempted: false`, `credentialRead: false`. |
| Intended CI | **Pass, with the delta stated** (per the rule in the checklist above). Run **CI #26** (`.../actions/runs/32071319078`): status **Success**, 1m 1s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. The run is for the pushed tip `0f2b328`; `git diff --stat b990c3d 0f2b328` is `docs/RELEASE-GATE.md` alone, 1 file changed — no source, no test, no packaged code. |
| Visual check | **Pass.** Packaged dashboard in the browser: DEMO banner; all five attribution bases on the By-project card including the two-basis `data-pipeline` split; exactly one rendered `TRIAL` badge and no `EVIDENCE` badge; Billing view renders the reconciliation card in its `NO RUN RECORDED` state with the owner-action wording. No console errors. |

**Reconciliation boundary, this candidate's new surface.** On the packaged
artifact with no provider snapshot, `billing reconcile --json` returns
`status: not_ready` and a readiness list marking `[here] declare the route
scope`, `[you] supply a least-privilege Admin credential`, `[you] observe a
closed period` — the two owner steps are named as owner steps and nothing is
attempted on their behalf. The dashboard's reconciliation card states the same
in its empty state. **No credential was created, requested, supplied, or read at
any point in this gate.**

The engine itself was exercised on a scratch home against a locally fabricated
snapshot (a harness artifact, stated as such — not provider data): $70.20
provider vs $66.60 metered, `+$3.60` residual, one material day and one
`no_local_capture` day, four conditions, `excludedFrom` intact, and the recorded
run round-tripping through `/api/billing`. The refusal paths, exact
microdollar summation, route filtering, and snapshot-stability comparison are
pinned by 15 tests in `test/reconcile.test.ts`.

**A dashboard-wide failure mode was found and closed during this candidate.** An
over-escaped apostrophe in a new tooltip string killed the entire inline script,
so no view rendered — while the typecheck, the build, and every HTTP/API test
stayed green. It was caught by hand. `test/dashboard-script.test.ts` now compiles
every inline script with `vm.Script` and asserts the page references no external
resource, so the highest-blast-radius failure this file has is a test failure
rather than a visual one.

**Team server at this tree:** typecheck clean, **55/55** — source validation only.

### Superseded record — commit `7bfb6dd`, 2026-08-17

Run against `7bfb6dda107a6f5f841915c54ff21ecbc07d64b7`, worktree clean before and
after validation. **All ten rows pass.** Supersedes the `1398fe3` record,
retained for history.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `7bfb6dda107a6f5f841915c54ff21ecbc07d64b7`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm run typecheck` clean, `npm test` **493 tests / 492 pass / 1 expected platform skip / 0 fail**, `npm run build` clean, `git diff --check` clean. |
| Packed artifact | **Pass.** `npm pack` → 98 files, SHA-256 `665ce684ca1d142cf431b46d404e1bd961d25f670422672b309636f1ced125f3`; all 6 key paths present. The file count rose by one against `1398fe3` because `docs/` ships with the package and this candidate adds `docs/VISION-AUDIT.md` — no new code path. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo (552 requests, $89.66), packaged dashboard on :8097. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`. Terminated cleanly, port confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; one switch, `confidence: trial`, no `evidence_supported`, zero confounders, 4 assumptions, `costStaleUnits: 0`, `unitsExcludedStalePricing: 0`; $0.20 vs $1.22 per 100 changed lines, 3 vs 3 sessions. Unchanged by this candidate — the rebalanced roster was not touched. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --account-ref org_gatecheck --project-ref proj_gatecheck --json` → `applied: false`, `trust: operator_declared_unverified`, `reconciliationStatus: not_reconciled`. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`, `excludedFrom` intact. |
| Direct-Costs connector boundary | **Pass.** With an applied `org_…`/`proj_…` scope, `billing openai-costs preview --from 2026-08-01 --to 2026-08-10 --json` → `networkAttempted: false`, `credentialRead: false`. |
| Intended CI | **Pass, with the delta stated** (per the rule in the checklist above). Run **CI #24** (`.../actions/runs/32044090132`): status **Success**, 1m 21s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. The run is for the pushed tip `bc745b8`; `git diff --stat 7bfb6dd bc745b8` is `docs/RELEASE-GATE.md` alone, 1 file changed — no source, no test, no packaged code. |
| Visual check | **Pass.** Packaged dashboard in the browser: DEMO banner; **all five attribution bases render on the By-project card**, including `data-pipeline` showing two bases with their dollar split (`self-declared ($10.18) · resolved to a git repository ($3.30)`), a `default` bar reading `unattributed — no project declared`, and the demo tooltip stating the bases are depicted rather than observed. Overview shows rate-card `STALE · 63d old` under its list-price boundary. Value renders exactly one rendered `TRIAL` badge and no `EVIDENCE` badge. |

**The demo now exercises the attribution paths, so they are no longer verified
only outside the packaged artifact.** The previous record had to test them on a
scratch home because every seeded row was `synthetic_demo`. The packaged
coverage surface now returns all five bases with `demo: true` and a boundary
string ending `DEMO DATA: these bases are DEPICTED by the seed, not observed.`
The live-import and live-proxy proofs from the `1398fe3` record still stand for
what the demo cannot do: a seeded row depicts a git resolution, it does not
perform one.

**Not covered by this candidate, deliberately:** the demo still fabricates no
provider billing evidence, so billing and reconciliation remain verified only
through their blocked/empty states above.

**Team server at this tree:** typecheck clean, **55/55** — source validation only.

### Superseded record — commit `1398fe3`, 2026-08-17

Run against `1398fe35d63d26c9f09592f71e51cc457d7b84bb`, worktree clean before and
after validation. **All ten rows pass**, the CI row with its commit delta stated.
Supersedes the `e3eb407` record, retained for history.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `1398fe35d63d26c9f09592f71e51cc457d7b84bb`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm ci` (3 packages, 0 vulnerabilities), `npm run typecheck` clean, `npm test` **489 tests / 488 pass / 1 expected platform skip / 0 fail**, `npm run build` clean. |
| Packed artifact | **Pass.** `npm pack` → 97 files, SHA-256 `8ff548e7497e2eb9a08683e6d0be89dd777c11867f5427613d94e66e7c7fec85`; all 6 key paths present. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo, packaged dashboard on :8099. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`, 77 requests, attribution evidence entirely `synthetic_demo`. Terminated cleanly, port confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; one switch, `confidence: trial`, no `evidence_supported`, zero confounders, `costStaleUnits: 0`; $0.20 vs $1.22 per 100 changed lines, 3 vs 3 sessions. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --account-ref … --json` → `applied: false`, `trust: operator_declared_unverified`, `reconciliationStatus: not_reconciled`. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`. |
| Direct-Costs connector boundary | **Pass.** With an applied `org_…`/`proj_…` scope, `billing openai-costs preview` → `networkAttempted: false`, `credentialRead: false`. |
| Intended CI | **Pass, with the delta stated** (per the rule in the checklist above). Run **CI #22** (`.../actions/runs/31991873049`): status **Success**, 59s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. The run is for the pushed tip `89e2c2c`; `git diff --stat 1398fe3 89e2c2c` is `docs/RELEASE-GATE.md` alone, 1 file changed — no source, no test, no packaged code. |
| Visual check | **Pass.** Packaged dashboard in the browser: DEMO banner, per-bar attribution basis, rate-card STALE, exactly one TRIAL card and no EVIDENCE card, no confounder warning, no pre-reprice badge. |

**Attribution paths were additionally exercised outside the packaged demo**, whose
rows are all `synthetic_demo` and therefore cannot exercise them. On a scratch
home: a Claude Code transcript recorded in `<repo>/packages/web` imported as
project `myrepo` with basis `tool_log_repo_resolved`, and the run reported the
`web → myrepo` relabel with the `fiscus project alias` remedy; a live proxy round
trip to `POST /fiscus/backend-api/v1/messages` stored `backend-api` as
`client_declared` while the mock upstream recorded being asked for
`/v1/messages`, proving the prefix never leaves the machine.

**Team server at this tree:** typecheck clean, **55/55** — source validation only.

### Superseded record — commit `e3eb407`, 2026-08-17

Run against `e3eb407858f20e6dae2e4dae3375b70bc7ed4771`, worktree clean before and
after validation. **All ten rows passed**, the CI row with its commit delta
stated. Superseded by the `1398fe3` record above; retained for history.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `e3eb407858f20e6dae2e4dae3375b70bc7ed4771`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm ci` (3 packages, 0 vulnerabilities), `npm run typecheck` clean, `npm test` **478 tests / 477 pass / 1 expected platform skip / 0 fail**, `npm run build` clean. |
| Packed artifact | **Pass.** `npm pack` → 97 files, SHA-256 `1a4ddf8923cd814b2e6fa8174180775d5f674237fb6d66f52403b72f5761aba8`; all 6 key paths present (`bin/fiscus.mjs`, `dist/cli.js`, `dist/store/db.js`, `dist/dashboard/web/index.html`, `pricing/models.json`, `baselines/lift-baselines.json`). |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo, packaged dashboard on :8099. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`, 77 requests. Terminated cleanly, port confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; exactly one switch, `confidence: trial`, no `evidence_supported`; `costStaleUnits: 0`. The demo cohort clears the new gates on its own merits rather than by exemption: **$0.20 vs $1.22 per 100 changed lines** (the saving survives normalizing by work volume), **3 vs 3 working sessions**, one recorded cost basis, no confounders, 4 assumptions, and the level split across **2** model-pair comparisons. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --account-ref … --json` → `applied: false`, `trust: operator_declared_unverified`, `reconciliationStatus: not_reconciled`. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`, 5 `excludedFrom` entries. |
| Direct-Costs connector boundary | **Pass.** With an applied `org_…`/`proj_…` scope, `billing openai-costs preview --from/--to --json` → `networkAttempted: false`, `credentialRead: false`. |
| Intended CI | **Pass, with the delta stated** (per the rule in the checklist above). Run **CI #20** (`.../actions/runs/31975450306`): status **Success**, 1m 11s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. The run is for the pushed tip `a367781`; `git diff --stat e3eb407 a367781` is `docs/RELEASE-GATE.md` alone, 1 file changed — no source, no test, no packaged code. |
| Visual check | **Pass.** Browser inspection of the packaged dashboard: DEMO banner present; By-project card shows the attribution basis per bar; rate-card health reads STALE; Value view renders exactly one TRIAL card, no EVIDENCE card, no confounder warning, no pre-reprice badge — and the card now carries both cost bases and the session counts. |

**Team server at this tree:** typecheck clean, **55/55**. Source validation only;
it moves none of the five infrastructure requirements in the separate gate below,
which remain unexecutable on this host (no container runtime, no PostgreSQL).

### Superseded record — commit `669cb3d`, 2026-08-17

Run against `669cb3d7d7285e713a885861873ecd3f1b0db9da`, worktree clean before and
after validation. **All ten rows passed**, with the CI row's commit delta stated
explicitly. Superseded by the `e3eb407` record above; retained for history. It in
turn superseded the `91b468b` record, because a record is bound to one commit and
is not inherited by its successors.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `669cb3d7d7285e713a885861873ecd3f1b0db9da`; `git status --short` empty before and after. |
| Source validation | **Pass.** `npm ci` (3 packages, 0 vulnerabilities), `npm run typecheck` clean, `npm test` **470 tests / 469 pass / 1 expected platform skip / 0 fail**, `npm run build` clean. |
| Packed artifact | **Pass.** `npm pack` → 97 files, SHA-256 `b3d401d2de694fda464bdc56635e957639010a0fefd95c413d6d6d74cfc87a50`. Listing confirms `package/bin/fiscus.mjs`, `package/dist/cli.js`, `package/dist/store/db.js`, `package/dist/dashboard/web/index.html`, `package/pricing/models.json`, `package/baselines/lift-baselines.json`. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo, packaged dashboard on :8095. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`, non-empty (77 requests at the default range, 552 over the full range after seeding). Terminated cleanly, port confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; exactly one model switch, `confidence: trial`, no `evidence_supported`; zero confounders, 4 disclosed assumptions, and `unitsExcludedStalePricing: 0` with `costStaleUnits: 0` (the demo is never repriced). HTML contains the labelled "Cheaper model trials" renderer. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --account-ref … --json` returned `applied: false` with `trust: operator_declared_unverified` and `reconciliationStatus: not_reconciled`. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`, `excludedFrom` = request spend, budget enforcement, outcome attribution, RoI, model recommendations. |
| Direct-Costs connector boundary | **Pass.** With an applied `org_…`/`proj_…` scope, `billing openai-costs preview --from/--to --json` returned `networkAttempted: false`, `credentialRead: false`. Without an exact `proj_…` reference it refuses outright rather than observing at a looser grain. |
| Intended CI | **Pass, with the delta stated.** Run **CI #18** (`.../actions/runs/31974003284`): status **Success**, 58s, 7 jobs — `package-smoke` plus the 3-job `test` and 3-job `team-server-test` matrices. That run is for `82a17c7`, not `669cb3d`: both commits went in one push and GitHub runs the tip. `git diff --stat 669cb3d 82a17c7` is **this file alone**, 1 file changed — no source, no test, no packaged code. Explicitly not inherited from CI #16 (`91b468b`), which is a different tree. |
| Visual check | **Pass.** Browser inspection of the packaged dashboard: DEMO banner present; By-project card shows the attribution basis under each bar; rate-card health reads STALE; Value view renders exactly one card tagged TRIAL, none tagged EVIDENCE, no confounder warning, and no pre-reprice badge. |

**Reprice/realized-value consistency** was additionally exercised outside the
packaged demo, because the demo deliberately never reprices: on a scratch store a
$3 → $5 reprice moved the request ledger and the persisted snapshot together
(both $5, per-model attribution re-derived, funnel byte-identical), and a store
holding a pre-provenance snapshot produced the stale warning on the CLI, a
`1 pre-reprice` badge on the dashboard's provenance line, and
`1 unit(s) excluded — pre-reprice cost` on the trial card.

**Standing exclusions for this candidate:** no npm publication, no GitHub release
or tag, no external deployment, no provider credential used, and no team-server
infrastructure validation. The team-server suites are clean at this tree
(typecheck, 55/55) — that is source validation only and moves none of the five
infrastructure requirements in the separate gate below.

**Repository visibility:** the GitHub repository is **public** (its Actions page
loads without authentication). Anything committed here is published on push, so
the pre-push check must include a scan for credentials, personal data, and local
filesystem paths. The absolute working-copy path was removed from `HANDOFF.md`
before the `91b468b` push for exactly that reason.

## Product claims allowed at this stage

Use the following precise language:

- Fiscus is a local-first FinOps and outcome-evidence tool for AI coding-agent
  spend.
- It meters configured proxy traffic and selected local tool logs, applies local
  budget controls, and presents Return on Intelligence as an evidence-limited
  measurement.
- Fiscus itself has no hosted telemetry by default. Proxy requests still travel
  to the AI provider configured by the operator.
- Outcome evidence has explicit classes: manual assertion, local command exit,
  or locally verified signed CI artifact. No class is a blanket claim of safety,
  deployment, or business value.

Do not call it a general AI-financial-services product, financial advice,
compliance certification, a Vanta replacement, “zero egress,” a verified
production deployment, or a published npm package.

## Required before public npm/GitHub release

An authorized repository/package owner must decide and perform the external
actions below. They are intentionally not automated from a local coding task.

1. Confirm the public package name/scope is available and that the publisher
   account is authorized to use it.
2. Choose the release version, changelog/release notes, and support/security
   contact. Verify LICENSE ownership/attribution before changing historical
   copyright text.
3. Re-run this document's local checks from a clean checkout and inspect the
   intended commit's GitHub CI jobs, including the packed-dashboard smoke.
4. Confirm public README/landing-page copy and all outbound data boundaries
   against the provider/optional-service configuration actually shipped.
5. Inspect the generated tarball one final time, publish intentionally, then
   install the registry package into a clean directory and smoke its CLI and
   dashboard.
6. Create a release/tag only after the registry install succeeds. Do not claim
   availability before that check.

## Separate gate: optional team server

`team-server/` is not approved for an internet-facing or production team
deployment. Its unit/API tests use a fake store; no real PostgreSQL
schema/transaction validation is recorded for this candidate. At commit
`669cb3d` its typecheck is clean and all 55 tests pass — which validates source
only, and moves none of the five infrastructure requirements below.

**Re-tested on 2026-08-17, still blocked at the environment level:** this host has
the `docker` CLI (29.6.2) but no daemon — Docker Desktop is not installed and
`com.docker.service` does not exist — and no `psql`, `pg_ctl`, or `initdb`. There
is no container runtime and no PostgreSQL here, so requirement 1 below cannot be
executed at all. That is a missing environment, not a passing check.
Before it is exposed, complete all of the following in a disposable environment:

1. Apply the exact schema to a real supported PostgreSQL version and exercise
   signed-rollup inserts, duplicate/replay policy, transactions, and rollbacks.
2. Test OIDC discovery, issuer/audience/time claims, authorization roles, and
   key rotation against the chosen identity provider. Authentication alone is
   not team-dashboard authorization.
3. Terminate TLS at a tested reverse proxy/load balancer; restrict database
   access; configure secrets, rotation, backups, restoration, and monitoring.
4. Reassess k-anonymity against repeated/differencing queries and document the
   operator's aggregation/query controls. Small-cohort suppression alone is not
   a general anonymization guarantee.
5. Test a full client-to-server-to-dashboard flow with synthetic accounts and
   no real developer or financial data. Confirm the actual retention/deletion
   policy and incident response path.

The source tier also now has bounded HTTPS/loopback-only OIDC discovery/JWKS
retrieval with no redirects, same-origin discovery checks, bounded response
bodies, generic async-route failure responses, a loopback listen default, and
normalized empty admin-token handling. These source-level hardening checks do
not replace the real infrastructure gate above.

The local Fiscus product can advance independently. The team service remains a
separately gated deployment, not hidden technical debt inside a “ready” claim.
