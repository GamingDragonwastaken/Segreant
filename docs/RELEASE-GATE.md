# Fiscus release gate

This is the operational boundary between a verified local release candidate and
an external release. Passing source tests is necessary but not a substitute for
registry ownership, production infrastructure, or customer evidence.

## Local CLI and dashboard candidate

The following checks were completed on 2026-08-11 against the recovered Fiscus
checkout:

- root typecheck passed;
- full root test suite passed: 380 pass, 1 expected platform-specific skip;
- the normal parallel run also passed after the focused evidence, runtime, and
  package changes;
- optional team package typecheck/tests passed: 46 pass;
- `npm pack` created a `fiscus@0.1.0` tarball containing compiled `dist`, the
  real bin entrypoint, pricing/baseline data, and dashboard HTML;
- a clean local tarball install successfully ran `fiscus --help`;
- an isolated packaged `demo --serve` process returned dashboard health, HTML,
  and overview JSON on localhost; and
- an HTTP integration test proved that a hard cap saved from the dashboard
  governs an already-running proxy.

This validates a local developer preview. It does **not** validate a provider's
billing statement, production customer data, an npm publication, an external
deployment, or the optional team service.

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
   GitHub CI artifact-smoke job on the intended commit.
4. Confirm public README/landing-page copy and all outbound data boundaries
   against the provider/optional-service configuration actually shipped.
5. Inspect the generated tarball one final time, publish intentionally, then
   install the registry package into a clean directory and smoke its CLI and
   dashboard.
6. Create a release/tag only after the registry install succeeds. Do not claim
   availability before that check.

## Separate gate: optional team server

`team-server/` is not approved for an internet-facing or production team
deployment. Its unit/API tests use a fake store; this workstation has no Docker
daemon or `psql`, so a real PostgreSQL schema/transaction test was not possible.
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
