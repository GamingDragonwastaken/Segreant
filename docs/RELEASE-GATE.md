# Fiscus release gate

This is the operational boundary between a verified local release candidate and
an external release. Passing source tests is necessary but not a substitute for
registry ownership, production infrastructure, or customer evidence.

## Local CLI and dashboard candidate

Historical check counts and screenshots are not release authority. Before making
a fresh local-candidate claim, record the exact candidate commit and the results
for this checklist against that source tree:

| Requirement | Required proof |
| --- | --- |
| Candidate identity | `git rev-parse HEAD` and `git status --short` recorded before and after validation |
| Source validation | `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` with exact totals/results |
| Packed artifact | `npm pack`; record the tarball digest and inspect that `bin`, compiled `dist`, pricing, baselines, and dashboard HTML are present |
| Clean installed CLI | Install the tarball with `--ignore-scripts` in a fresh directory and run `fiscus --help` |
| Packaged dashboard/API | Use an isolated `AEGIS_HOME`; seed labelled demo data; start the installed dashboard; probe health, overview, value, and HTML; terminate it cleanly |
| Model-trial truthfulness | The packaged value payload must self-label `demo: true`; any seeded model switch must be `trial`, never evidence-supported; HTML must contain the labelled renderer |
| Billing-boundary truthfulness | `fiscus billing scope set --account-ref <test-ref> --json` must remain a no-write, `operator_declared_unverified` preview; packaged demo `/api/billing` must self-label `demo: true`, retain `not_reconciled`, and show zero fabricated billing records |
| Direct-Costs connector boundary | A packaged local scope with `proj_…` must yield an OpenAI Costs **preview** with `networkAttempted: false` and `credentialRead: false`. It does not validate a provider account, authorize a live pull, or reconcile a provider amount. |
| Intended CI | Inspect the CI jobs for the intended commit, not merely a workflow definition or an old run |
| Visual check | Inspect the non-empty labelled packaged dashboard in a browser as a supplement to, not a substitute for, the HTTP/API proof |

This validates a local developer preview only. It does **not** validate a
provider billing statement, production customer data, an npm publication, an
external deployment, or the optional team service.

### Candidate record — commit `c9e08d7`, 2026-08-16

Run against `c9e08d792cc6afe08c1d1906c5ec5b35cd6f0db0`, worktree clean before and
after validation. **This candidate does not pass the gate**: the CI row cannot be
satisfied, because the commit is local-only. Every other row passed.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `git rev-parse HEAD` = `c9e08d792cc6afe08c1d1906c5ec5b35cd6f0db0`; `git status --short` empty before and after. 33 commits ahead of `origin/main`, unpushed. |
| Source validation | **Pass.** `npm ci` (3 packages, 0 vulnerabilities), `npm run typecheck` clean, `npm test` **460 tests / 459 pass / 1 expected platform skip / 0 fail**, `npm run build` clean. |
| Packed artifact | **Pass.** `npm pack` → 97 files, SHA-256 `5c78b320a73e279c77c2a4bb76d56685e06c67300ac33c9bb00e3a179a68f548`. Listing confirms `package/bin/fiscus.mjs`, `package/dist/cli.js`, `package/dist/store/db.js`, `package/dist/dashboard/web/index.html`, `package/pricing/models.json`, `package/baselines/lift-baselines.json`. |
| Clean installed CLI | **Pass.** Installed with `--ignore-scripts` into a fresh directory; `fiscus --help` renders. |
| Packaged dashboard/API | **Pass.** Isolated `AEGIS_HOME`, seeded demo, packaged dashboard on :8091. `/api/health` → `{"ok":true}`; `/api/overview` → `demo: true`, 101 requests, 3 attribution-evidence cohorts; HTML served. Terminated cleanly, port confirmed closed. |
| Model-trial truthfulness | **Pass.** `/api/value` self-labels `demo: true`; exactly one model switch, `confidence: trial`, no `evidence_supported`; it carries 1 confounder and 4 disclosed assumptions. HTML contains the labelled "Cheaper model trials" renderer. |
| Billing-boundary truthfulness | **Pass.** `billing scope set --account-ref … --json` returned `applied: false` with `trust: operator_declared_unverified` and `reconciliationStatus: not_reconciled`. Packaged `/api/billing` → `demo: true`, `not_reconciled`, `recordCount: 0`, `excludedFrom` = request spend, budget enforcement, outcome attribution, RoI, model recommendations. |
| Direct-Costs connector boundary | **Pass.** With an applied `proj_…` scope, `billing openai-costs preview --from/--to --json` returned `networkAttempted: false`, `credentialRead: false`. |
| Intended CI | **NOT SATISFIED.** `git branch -r --contains c9e08d7` is empty — the commit exists only locally, so no CI run exists to inspect. `.github/workflows/ci.yml` is present but a workflow definition is not a run. This row can only be closed after an authorized push. |
| Visual check | **Pass.** Browser inspection of the packaged dashboard: DEMO banner present; By-project card shows the attribution basis per bar; rate-card health reads STALE; Value view renders exactly one card tagged TRIAL, none tagged EVIDENCE, with the confounder warning visible. |

**Standing exclusions for this candidate:** no npm publication, no GitHub release
or tag, no external deployment, no provider credential used, and no team-server
infrastructure validation. The team-server suites were re-run at this tree
(typecheck clean, 55/55) — that is source validation only and does not touch the
separate gate below.

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
`c9e08d7` its typecheck is clean and all 55 tests pass — which validates source
only, and moves none of the five infrastructure requirements below.
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
