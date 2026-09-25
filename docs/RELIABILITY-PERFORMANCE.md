# Reliability and performance observations

This document is the M14 measurement checkpoint for Segreant. It is deliberately
not a service-level objective: budgets are chosen only after repeated runs on
the intended release machine, with its Node version, storage, and workload.
The harness uses synthetic in-memory ledgers, a loopback-only dashboard server,
and no provider credentials or external network requests.

## Reproduce

Build first, then run the default ladder:

```text
npm run build
npm run benchmark -- --scale=small,current,10x --iterations=3
```

The 100× stress case is explicit because it creates 100,000 ledger rows and
100,000 synthetic mature work units:

```text
npm run benchmark -- --scale=100x --stress --iterations=1
```

Each operation reports min/median/p95/max milliseconds. `overviewAssembly` is
the server-side payload composition used by the dashboard; `apiOverviewHttp`
adds a real loopback HTTP request and response read. `frontier` exercises the
same local model/value comparison engine used by the advisor. RSS is a process
delta, so it is an observation rather than a leak verdict.

## Epistemic issuance quality boundary

The `epistemicIssuance` operation exercises canonical Evidence and Claim
construction at every selected scale. It uses fixed timestamps, scope, grain,
and profile inputs so the workload is reproducible; it does not read provider
data, call a judge, or append to SQLite. Each case also publishes a quality
record with the requested count, Evidence and Claim counts, Evidence-to-Claim
link count, immutable-record count, and one deliberately invalid Claim refusal.
The benchmark contract test requires these counts to be non-zero and equal to
the requested workload, so a timing report cannot remain green after its truth
workload becomes empty or loses the dependency it claims to exercise.

This is the first H06 truth-boundary slice: canonical construction and
validation are measured, while persistent ledger append, graph replay/as-of,
revocation closure and `.segreantpack` verification are measured by the two
sections below. Exact projections, allocation, dashboard contract validation
and proxy streaming are not benchmarked; those are the four surfaces still
outside the harness, stated here so the list cannot pass for coverage. The
quality counts are correctness probes, not latency thresholds or release
budgets.

## Epistemic persistence and graph replay boundary

The `epistemicPersistence` operation exercises persistent SQLite storage and
hindsight-safe graph replay for canonical Evidence and Claims across the scale
ladder (`small: 25`, `current: 50`, `10x: 100`, `100x: 200` pairs). It operates
on an isolated in-memory Store handle without network egress or provider
credentials.

Each pair populates one synthetic Evidence record and one Claim citing that
Evidence inside an atomic SQLite transaction, creating stored DAG nodes and
citation edges. The workload then performs deterministic query and refusal checks:
1. `replayAsOf` at a boundary preceding acquisition verifies 0 historical nodes.
2. `replayAsOf` at a boundary following issuance reconstructs all persisted nodes and edges.
3. `latestClaims` verifies that all visible tip claims are accessible.
4. Idempotency check verifies that re-appending an identical record returns `'duplicate'`.
5. Integrity check verifies that re-appending a divergent record for an existing identity is refused.
6. Dependency check verifies that a Claim citing a missing Evidence ID is refused.

Every synthetic fixture explicitly declares `sourceIdentity: 'benchmark:synthetic'`,
`sourceClass: 'synthetic_fixture'`, and `completeness.method: 'deterministic_fixture'`,
preventing synthetic benchmark records from resembling production evidence. Sizing is
bounded across the scale ladder to maintain sub-second to low-second determinism under
full SQLite schema, digest, and DAG validation invariants. The published counts are
contract-tested quality gates, not latency budgets.

## Revocation closure and `.segreantpack` round-trip boundary

The `revocationClosure` and `segreantpackRoundTrip` operations (D-238) share
one ledger per scale: a fan-out graph of one shared root Evidence cited by
every Claim beside that Claim's own leaf Evidence (`small: 25` pairs, up to
`100x: 200`). Two revocations are recorded — one leaf and the shared root —
and the graph is built once so that what is timed is the READ:
`revocationProjection()` for closure, and `exportLedgerPack` →
`serializeSegreantPack` → `verifySegreantPack` for the pack. The quality block
requires the root's closure to reach every Claim and exactly one other leaf
(`nodesRevoked = pairs + 2`), no pending entries, the whole graph packed with
nothing omitted, and the verifier's own verdict `ok` with `integrity:
verified`. A timing over an empty or half-built graph therefore cannot pass
the contract test.

## Exact projection, allocation run and contract-walk boundary

`exactProjection`, `allocationRun` and `dashboardContractWalk` (D-253) run
over the same ingested window as the summary operations. Every benchmark row
now carries the exact list-price `economicAmount` the proxy path records
beside the float, so the projection resolves every row (`complete: true`,
`unresolvedRequests: 0`, `amountText` the exact sum) rather than timing an
unresolved join. The allocation run applies one direct rule per synthetic
project and must conserve to the microdollar with nothing unallocated. The
contract walk is the same `checkInterfaceShape` the browser runs on every
`/api/overview` response, against the generated field table, and must find
no problems. Proxy streaming is not benchmarked here: it needs an upstream,
and this harness attempts no network by contract. No latency budget is
asserted for any operation — that is a policy the release owner sets from
repeated runs on the release machine, not a number this file can supply.

## 2026-08-28 Windows baseline

Environment: Node `v24.18.0`, `win32/x64`, with the source revision recorded in
the benchmark JSON, compiled `dist/` **1,884,757 bytes**. The small/current/10×
rows used three timed samples; the 100× row used one timed sample to keep the
stress run bounded. Values are rounded from the exact-head JSON output of the
harness (`sourceRevision: a4b91a8`) and are not release thresholds.

| Scale | Rows | Ingest (ms) | Summary (ms) | Overview (ms) | Frontier (ms) | API p95 (ms) | RSS delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 100 | 7.14 | 0.05 | 3.94 | 0.67 | 8.17 | 1.70 MiB |
| current | 1,000 | 59.83 | 0.26 | 12.97 | 1.93 | 16.94 | 14.34 MiB |
| 10× | 10,000 | 604.77 | 4.44 | 126.74 | 21.86 | 147.87 | 126.95 MiB |
| 100× stress | 100,000 | 6,726.06 | 69.77 | 1,964.87 | 510.64 | 1,961.76 | 131.75 MiB |

The 100× result is meaningful as a stress observation: ingest remains finite,
the indexed summaries remain below a tenth of a second in this run, and the
full overview/API composition becomes the dominant cost. That points to a
future optimization target (payload/query decomposition or pagination), not a
claim that every machine or real workload meets a latency target.

## Boundaries and next measurement

- The harness creates and removes its own temporary `SEGREANT_HOME`, regardless of
  the caller's environment, and reports `isolatedHome: true`,
  `externalNetworkAttempted: false`, and `credentialRead: false` in its JSON.
- The receipt verifier has its own bounded-memory streaming path, capped error
  diagnostics, and a non-authoritative persisted checkpoint; receipt-log
  retention is intentionally not auto-pruned because deletion would alter audit
  history and needs an explicit archival policy.
- Tarball entry count, digest, clean installation, and packaged dashboard/API
  behavior remain release-gate evidence in `docs/RELEASE-GATE.md`; the harness's
  compiled-dist byte count is not a substitute for those checks.
- Before setting CI budgets, repeat the ladder at least three times on the
  release runner and add a deliberate regression margin to each selected
  operation. Record the machine profile and dataset generator revision with
  the chosen budgets.
- `segreant diagnostics --json` provides a separate redacted handoff bundle with
  operation IDs, probe durations/error classes, database/schema/egress/pricing
  state, and no-network/no-credential/no-prompt/source/ledger-row-export
  assertions. It is read-only;
  `--out` is an explicit atomic export and refuses an existing file.
