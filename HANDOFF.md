# Handoff — Fiscus

**State:** active local development candidate. The package version is `0.1.0`,
and the isolated high-assurance branch has a fresh local release record, but no
npm publication, GitHub release, external deployment, or provider-billing
reconciliation has been verified. Treat [docs/RELEASE-GATE.md](docs/RELEASE-GATE.md)
as the release authority; the current record is bound to its named source SHA,
not inherited by later code changes.

**Current local checkpoint:** see the newest “Current local candidate record” in
[docs/RELEASE-GATE.md](docs/RELEASE-GATE.md). The source/package evidence head
is `dd09d07`, with the last code-bearing tree at `07855b8`; later branch tips
are documentation-only evidence and handoff follow-ups. The canonical `main`
checkout remains a separate dirty recovery source; do not reset, clean, or
merge it implicitly.

## Canonical checkout

- **Origin:** `https://github.com/GamingDragonwastaken/Fiscus.git`
- **Branch:** `main`
- **Working copy:** the maintainer's local checkout. The absolute path is kept in
  the untracked operations notes rather than here, so a published handoff does
  not carry a local filesystem path or account name.

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

Budget enforcement is fail-closed: malformed persisted budget/configuration is
refused at load, settings patches are bounded and strict, and a ledger read or
request-record failure stops subsequent provider forwarding until the local
state is repaired and Fiscus is restarted. This protects the control boundary;
it does not prevent a request already sent before a persistence failure from
having reached its configured provider.

The local candidate also has a non-destructive `backup --out` and
preview-first `restore --from/--out --apply` path. Snapshots use SQLite
`VACUUM INTO`, quick/foreign-key checks, a SHA-256/schema fingerprint, and a
redacted manifest; restore refuses corrupt, symlinked, or existing destinations
and never overwrites the active ledger. These are sensitive local recovery
artifacts, not encrypted backups, provider billing, or independent attestations.

Egress receipt verification retains the append-only chain but now streams it in
bounded chunks (with a 1 MiB individual-line refusal and capped error
diagnostics) instead of splitting the entire JSONL into memory. A new process
must validate the full chain before it can append; the persisted checkpoint is
informational only, so it cannot choose a forged predecessor. Fiscus does not
silently prune or restart a present history as genesis.

`fiscus diagnostics --json [--out <new-file>]` is a read-only, versioned,
redacted support bundle with correlation IDs, probe durations/error classes,
schema/migration, egress/pricing, and resource observations. It exports no
prompts, source, credentials, raw ledger rows, or absolute user paths and does
not send telemetry. `npm run benchmark` provides synthetic performance
observations across the documented scale ladder; it asserts no universal SLA.

The current local candidate also includes two bounded internal foundations: a
Store-owned independent causal-unit producer that derives identity from retained
Git/request scalars, and exact imported-billing project/account mapping coverage
shown on the Evidence surface. Both are reviewable local evidence only. The
producer does not qualify a causal result; operator mappings do not verify a
provider account or make imported dollars authoritative.

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
6. Run `npm run benchmark -- --scale=small,current,10x --iterations=3` and,
   where the machine can support it, the explicit `--stress` 100× case; retain
   the JSON with the source revision and machine profile.
7. Use `fiscus diagnostics --json` for a redacted handoff and exercise backup /
   restore preview/apply against a new destination before calling recovery
   ready.

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

The remaining local-candidate gates are intentionally visible: browser
screenshots/keyboard/WCAG runtime evidence is unavailable without a browser
connector; CI on a pushed exact head, provider-authoritative reconciliation, a
governed causal study/public qualification, real PostgreSQL/OIDC/TLS/team
deployment, registry publication, and customer evidence have not occurred.

## Compatibility

The environment overrides are `FISCUS_HOME`, `FISCUS_DB`, and `FISCUS_DEMO`.
There is no second family. The pre-rename spellings were removed rather than
deprecated, so setting one now has no effect at all — deliberately, because a
silently honoured alias is indistinguishable from a resolver that ignores your
override, and nothing has been published that could depend on the old names.

The on-disk home is `~/.fiscus` and the database is `fiscus.db`. An install
predating the rename keeps its old directory untouched on disk; copy it to the
new path and the ledger is carried over. The release-gate records below cite the
pre-rename variable because that is what those runs actually used, and rewriting
them would claim evidence that does not exist.
