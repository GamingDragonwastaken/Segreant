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
| Packed artifact | `npm pack`; record the tarball digest and inspect that `bin`, compiled `dist`, pricing, baselines, and dashboard HTML are present |
| Clean installed CLI | Install the tarball with `--ignore-scripts` in a fresh directory and run `fiscus --help` |
| Packaged dashboard/API | Use an isolated `FISCUS_HOME` (records below that predate the rename cite the pre-rename variable, which is what those runs actually used); seed labelled demo data; start the installed dashboard; probe health, overview, value, and HTML; terminate it cleanly |
| Model-trial truthfulness | The packaged value payload must self-label `demo: true`; any seeded model switch must be `trial`, never evidence-supported; the **`/classic`** HTML must contain the labelled renderer. Check `/classic`, not `/`: `/` is the GUI shell and renders every figure in the browser, so fetching it proves only that a shell was served. Prove `/` separately by confirming it carries `id="app"` and its module entry, and that the entry resolves as JavaScript — a shell whose compiled app is missing from the tarball serves a 200 and a blank dashboard |
| Causal-evidence integrity | Run `test/causal-core.test.ts`, `test/causal-store.test.ts`, `test/causal-cli.test.ts`, and `test/causal-dashboard.test.ts`. In a clean installed artifact, prove `fiscus causal status --json` reports no publicly inspectable retained-v1 study/no causal result by default. Prove v1 registration and assignment preview/apply refuse with `CAUSAL_LEGACY_INSPECT_ONLY`; prove valid-v2 registration preview/apply refuse before Store open or mutation with `CAUSAL_V2_CLI_DEFERRED`; and prove Store-owned v2 assignment is atomic without implying that a v2 registration or assignment CLI exists. Retained v1 assignment replay still verifies. Current CLI/API/dashboard summaries expose retained v1 only; v2-only Store state remains bounded and non-500 rather than becoming the legacy projection. A no-outcome retained-v1 study remains `collecting`, not a causal claim. Verify `/api/causal` is GET/HEAD-only, redacts randomisation material, and exposes no mutation or automatic routing/budget action. This is release-gate evidence, not release approval; lifecycle, v2 execution/outcome, qualification snapshots, export, and full v2 public projection remain deferred. |
| Billing-boundary truthfulness | `fiscus billing scope set --account-ref <test-ref> --json` must remain a no-write, `operator_declared_unverified` preview; packaged demo `/api/billing` must self-label `demo: true`, retain `not_reconciled`, and show zero fabricated billing records |
| Direct-Costs connector boundary | A packaged local scope with `proj_…` must yield an OpenAI Costs **preview** with `networkAttempted: false` and `credentialRead: false`. It does not validate a provider account, authorize a live pull, or reconcile a provider amount. |
| Egress disclosure | Reconcile every newly introduced outbound path with DATA-BOUNDARIES.md; distinguish Fiscus-process enforcement, proxy-routed traffic coverage, browser behaviour, and any separately validated OS/network control. Do not project a process-level test into a workstation-wide or provider-privacy guarantee. |
| Intended CI | Inspect the CI jobs for the intended commit, not merely a workflow definition or an old run. If the candidate reached the remote inside a multi-commit push, CI ran on the tip; cite that run and record `git diff --stat <candidate> <tip>` so the delta is stated rather than assumed. A tip that differs only by this document does not need its own run — otherwise recording a result would forever require another commit |
| Visual check | Inspect the non-empty labelled packaged dashboard in a browser as a supplement to, not a substitute for, the HTTP/API proof |

This validates a local developer preview only. It does **not** validate a
provider billing statement, production customer data, an npm publication, an
external deployment, or the optional team service.

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

The local Fiscus product can advance independently. The team service remains a
separately gated deployment, not hidden technical debt inside a “ready” claim.
