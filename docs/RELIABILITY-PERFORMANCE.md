# Reliability and performance observations

This document is the M14 measurement checkpoint for Fiscus. It is deliberately
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

## 2026-08-28 Windows baseline

Environment: Node `v24.18.0`, `win32/x64`, with the source revision recorded in
the benchmark JSON, compiled `dist/` **1,871,652 bytes**.
The small/current/10× rows used two timed samples; the 100× row used one timed
sample to keep the stress run bounded. Values are rounded from the JSON output
of the harness and are not release thresholds.

| Scale | Rows | Ingest (ms) | Summary (ms) | Overview (ms) | Frontier (ms) | API p95 (ms) | RSS delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 100 | 6.21 | 0.05 | 3.41 | 0.53 | 14.13 | 1.52 MiB |
| current | 1,000 | 55.30 | 0.28 | 10.31 | 1.46 | 13.04 | 13.72 MiB |
| 10× | 10,000 | 503.55 | 3.60 | 94.44 | 18.55 | 109.11 | 128.33 MiB |
| 100× stress | 100,000 | 5,312.66 | 58.76 | 1,576.00 | 371.57 | 1,628.06 | 203.15 MiB |

The 100× result is meaningful as a stress observation: ingest remains finite,
the indexed summaries remain below a tenth of a second in this run, and the
full overview/API composition becomes the dominant cost. That points to a
future optimization target (payload/query decomposition or pagination), not a
claim that every machine or real workload meets a latency target.

## Boundaries and next measurement

- The harness never opens the user's default Fiscus home and reports
  `externalNetworkAttempted: false` and `credentialRead: false` in its JSON.
- The receipt verifier has its own bounded-memory streaming path; receipt-log
  retention is intentionally not auto-pruned because deletion would alter audit
  history and needs an explicit archival policy.
- Tarball entry count, digest, clean installation, and packaged dashboard/API
  behavior remain release-gate evidence in `docs/RELEASE-GATE.md`; the harness's
  compiled-dist byte count is not a substitute for those checks.
- Before setting CI budgets, repeat the ladder at least three times on the
  release runner and add a deliberate regression margin to each selected
  operation. Record the machine profile and dataset generator revision with
  the chosen budgets.
- `fiscus diagnostics --json` provides a separate redacted handoff bundle with
  operation IDs, probe durations/error classes, database/schema/egress/pricing
  state, and no-network/no-credential/no-prompt/source/ledger-row-export
  assertions. It is read-only;
  `--out` is an explicit atomic export and refuses an existing file.
