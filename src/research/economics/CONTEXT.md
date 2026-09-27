# research/economics — economic-control research primitives

Self-contained implementations of the economic-control ideas designed in
`docs/ECONOMIC-CONTROL-FOUNDATION.md` and
`docs/TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB.md`. They were written on the August
`agent/truth-closure` lane (commit `bd43529`), never reached `main` during the
reconstruction, and were recovered here so the work is kept, compiled and
tested rather than living only on an archived branch.

**Research status.** No product surface, CLI verb, dashboard view, budget, or
recommendation imports these modules. They produce numbers for study, not
claims. Wiring any of them into a user-facing path is a product decision that
must first pass the promotion gates in `docs/program/WP-J03-COMPLEXITY-LAB-REPORT.md`
and be recorded in `docs/program/DECISION-LOG.md`.

## Contents

| File | What it computes |
|---|---|
| `decomposition.ts` | Exact Shapley decomposition of a spend change across drivers, plus a standardized spend diagnostic |
| `offPolicy.ts` | Self-normalized inverse-propensity and doubly-robust estimates from logged policy outcomes |
| `frontier.ts` | An evidence-constrained efficient frontier, with evidence dominance and stated exclusion reasons |
| `budgetRisk.ts` | Budget-risk summary over spend scenarios and a scarcity dual (shadow price) update |
| `promotion.ts` | Staged promotion decision from evidence: observe, simulate, recommend, canary, enforce |
| `metricSafety.ts` | Classifies a metric (resource accounting, process diagnostic, outcome measure, …) and assesses whether a proposed use of it is safe |
| `capital.ts` | Hierarchical AI-capital buckets and validated capital transactions |
| `execution.ts` | Canonical execution-plan keys and evidence grades |
| `decisionLedger.ts` | Append-only, hash-chained decision ledger on disk |

The production counterparts that `main` does use are separate and
authoritative: off-policy evaluation in `src/causal/ope.ts`, capital showback in
`src/capital.ts`, and exact money in `src/economics/money.ts`.

## Consumes

Plain numbers and records passed in by the caller. Only `decisionLedger.ts`
touches the filesystem, and only at the path it is given.

## Guarantees

- Deterministic for the same input.
- Covered by `test/research-economics.test.ts`.

## Must never

- Be imported by a product path without a recorded promotion decision.
- Present its output as billed cost, allocated cost, or causal value.
