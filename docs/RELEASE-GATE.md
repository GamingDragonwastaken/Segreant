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

### Candidate record — commit `669cb3d`, 2026-08-17

Run against `669cb3d7d7285e713a885861873ecd3f1b0db9da`, worktree clean before and
after validation. **Nine rows pass; the CI row is pending at the time of
writing** — see below. This supersedes the `91b468b` record (which passed all ten)
because that candidate has been overtaken by a money-facing change: a record is
bound to one commit and is not inherited by its successors.

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
| Intended CI | **Pending.** The commit is being pushed with this record; the run for `669cb3d` must be inspected before this row may be marked passed. It is not inherited from CI #16 (`91b468b`) — a green run on an ancestor is not a run on this commit. |
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
