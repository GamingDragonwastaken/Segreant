# research/complexity — Complexity Lab research code

Research-only. `profile.ts` is the falsifiable research profile from WP-J03.
`calibration.ts` (Brier score, expected calibration error, a calibration gate)
and `lab.ts` (logistic and item-response-theory difficulty models, interaction
models, distribution summaries) were recovered from the August
`agent/truth-closure` lane so the work is compiled and tested on `main`.

**Research status.** Nothing in the product uses a complexity score. Promotion
requires real calibration data, independent validation, an explicit privacy
and authority review, and a public capability-contract update before any
user-facing claim or action is enabled.

## Guarantees

- Deterministic for the same input.
- `calibration.ts` and `lab.ts` are covered by `test/research-economics.test.ts`.

## Must never

- Feed a budget, route, recommendation, or displayed score without a recorded
  promotion decision.
