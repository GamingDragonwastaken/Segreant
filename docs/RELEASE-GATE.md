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
| Intended CI | Inspect the CI jobs for the intended commit, not merely a workflow definition or an old run |
| Visual check | Inspect the non-empty labelled packaged dashboard in a browser as a supplement to, not a substitute for, the HTTP/API proof |

This validates a local developer preview only. It does **not** validate a
provider billing statement, production customer data, an npm publication, an
external deployment, or the optional team service.

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
schema/transaction validation is recorded for this candidate.
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
