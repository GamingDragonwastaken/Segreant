# Handoff — Fiscus

**State:** active local development candidate. The package version is `0.1.0`,
but no npm publication, GitHub release, external deployment, or provider-billing
reconciliation has been verified. Treat [docs/RELEASE-GATE.md](docs/RELEASE-GATE.md)
as the release authority; it must be refreshed against the exact final commit
before any public claim.

## Canonical checkout

- **Path:** `C:\Users\Null_\Documents\Projects & Learning\Fiscus`
- **Origin:** `https://github.com/GamingDragonwastaken/Fiscus.git`
- **Branch:** `main`

Before handoff, release, or debugging a new report, record `git rev-parse HEAD`
and `git status --short`. Do not infer GitHub publication or npm availability
from the local package version, a historical CI run, or an old handoff.

## Product boundary

Fiscus is a local-first FinOps and outcome-evidence tool for AI coding-agent
spend. It meters configured proxy traffic and selected local tool logs, assigns
local list-price estimates, applies local proxy budget controls, and presents
evidence-limited Return on Intelligence views.

It is not general AI financial services, financial advice, a compliance
certification, a provider invoice reconciler, a generic Vanta replacement, or
an automatic model-routing or budget-allocation system. The only current
action-like comparison is a review-only, within-task cheaper-model trial with
explicit evidence limits.

## Local evidence and release boundary

The current codebase includes source tests, a TypeScript check, a build, a clean
tarball install smoke, and a packaged demo-dashboard probe. Exact commands,
results, exclusions, and the commit-bound validation table belong in
[docs/RELEASE-GATE.md](docs/RELEASE-GATE.md), not in this handoff.

Local rate-card figures are not provider billing data. Newly locally priced rows
retain rate-card lineage; tool-reported, unpriced audit, synthetic-demo, and
pre-lineage values remain explicitly labelled. An explicit reprice is retained
as a before/after local-ledger event.

## Before a fresh local candidate claim

1. Record the exact final SHA and clean/known worktree state.
2. Run the source typecheck, full root test suite, and build.
3. Pack the artifact, inspect the file list and digest, clean-install it, then
   probe its CLI and labelled demo dashboard/API from an isolated Fiscus home.
4. Update [docs/RELEASE-GATE.md](docs/RELEASE-GATE.md) with only evidence from
   that exact candidate.
5. Keep all product copy aligned with
   [docs/DATA-BOUNDARIES.md](docs/DATA-BOUNDARIES.md) and the documented
   local-list-price limitation.

## Owner-authorized external actions

These actions require the repository/package owner; do not perform or claim
them from a local coding task:

1. Confirm npm package ownership/name, release version, changelog, support and
   security contacts, and license attribution.
2. Push the intended commit and verify the intended GitHub Actions jobs for that
   exact SHA.
3. Publish intentionally, then install the registry package into a clean
   directory and repeat the CLI/dashboard smoke.
4. Create tags/releases and announce availability only after the registry check
   succeeds.

## Separately gated team server

`team-server/` is an optional operator-run service. It is not approved for an
internet-facing or production deployment until a disposable environment proves
real PostgreSQL schema/transactions/replay policy, real OIDC authentication and
authorization, TLS, secrets/rotation, backups/restore, retention/incident
controls, and a complete synthetic client-to-server flow. See
[docs/RELEASE-GATE.md](docs/RELEASE-GATE.md).

## Compatibility

Historical local paths and controls retain the `aegisflow` / `AEGIS_*` names for
compatibility. They are not the canonical Fiscus product identity or evidence of
an earlier release state.
