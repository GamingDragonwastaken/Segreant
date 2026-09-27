# research/complexity — Complexity Lab research code

Research-only. `profile.ts` is the falsifiable research profile from WP-J03.
`calibration.ts` (Brier score, expected calibration error, a calibration gate)
and `lab.ts` (logistic and item-response-theory difficulty models, interaction
models, distribution summaries) were recovered from the August
`agent/truth-closure` lane so the work is compiled and tested on `main`.

**Research status.** Nothing in the product uses a complexity score. The ten
promotion gates in `docs/program/WP-J03-COMPLEXITY-LAB-REPORT.md` stay closed
until they are met with real data, and any promotion is recorded in
`docs/program/DECISION-LOG.md`.

## Guarantees

- Deterministic for the same input.
- `calibration.ts` and `lab.ts` are covered by `test/research-economics.test.ts`.

## Must never

- Feed a budget, route, recommendation, or displayed score without a recorded
  promotion decision.
