# WP-J03 Complexity Lab: Research-Only Admission Report

**Work Packet:** `WP-J03` — Complexity Lab  
**Status:** `COMPLETED` at the research-only boundary; **not production-promoted**  
**Controlling authority:** `docs/TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB.md` and `docs/ECONOMIC-CONTROL-FOUNDATION.md`.

## Current repository reality

Segreant now contains the narrow foundation the packet permits:
`src/research/complexity/profile.ts` defines an immutable, content-free
`ComplexityProfile` over structural and execution observables. It deliberately
does **not** expose a scalar complexity score, routing recommendation, budget
mutation, causal claim, calibrated uncertainty estimate, or production API/CLI.
The profile reports `uncalibrated_research`, null predictive/pool uncertainty,
no predicted-compute distribution, no model-performance dispersion, and a
digest-bound estimator identity. This is an admission surface for future
research, not a production decision feature.

The production boundary is mechanically guarded. `src/cli.ts` does not dispatch
`segreant lab` or top-level `segreant complexity`; dashboard contracts expose no
complexity route; the production benchmark does not claim a complexity
operation; and `src/value/frontier.ts` uses task type and changed-line size only
as observational conditioning/confounder dimensions rather than collapsing them
into a universal complexity scalar.

## Structural complexity observables

The research profile may record content-free structural features already
available at decision/review time when supplied by its caller: added/deleted
lines, files touched, context-token count, task type, and tool count. These are
observables, not a claim that any one of them *is* task complexity.

## Execution complexity observables

The profile may also record request count, total/reasoning tokens, duration and
retry count. Those values characterize an observed execution. Post-outcome
execution features must not be leaked backward into pre-action routing or
pretended to have been available at decision time.

## Promotion Rules

The packet is complete because the repository now has the narrow research
foundation and a hard refusal boundary. **All ten production promotion rules
remain unfulfilled; therefore the Complexity Lab is not a production estimator
or routing/control authority.** Completion of WP-J03 must not be confused with
production promotion.

| Rule | Requirement | Current state |
|---|---|---|
| Rule 1 | Target quantity precisely defined | **UNFULFILLED** — no production complexity estimand is established. |
| Rule 2 | Temporal separation of training/evaluation | **UNFULFILLED** — no prospective or temporal holdout dataset establishes generalization. |
| Rule 3 | Calibration error measured | **UNFULFILLED** — no calibrated prediction target/score exists. |
| Rule 4 | Simple baselines included | **UNFULFILLED** — no estimator competition has been run against declared simple baselines. |
| Rule 5 | Positive incremental decision value on held-out evaluation | **UNFULFILLED** — no held-out evidence shows complexity improves decisions. |
| Rule 6 | Distribution-shift robustness and abstention | **UNFULFILLED** — no validated shift model/abstention contract exists for complexity. |
| Rule 7 | Explicit privacy/data boundary | **UNFULFILLED for production promotion** — repository egress rules exist, but a promoted estimator would require its own declared feature/data contract. |
| Rule 8 | Features proven available at decision time without leakage | **UNFULFILLED** — several tempting realization/execution signals are post-outcome. |
| Rule 9 | Estimator uncertainty/coverage | **UNFULFILLED** — the research profile intentionally emits null uncertainty and `uncalibrated_research`. |
| Rule 10 | Rollback/fallback for promoted use | **UNFULFILLED** — there is no production complexity-driven action to roll back from. |

These promotion gates remain deliberately closed. A future research tranche may
define an estimand, prospective dataset, simple baselines, calibration and
uncertainty contracts, and then test whether any estimator has incremental
decision value. Until then, the correct production action is **no action**.

## What would be required for future promotion

Future promotion would require evidence, not merely more code: a precise target;
temporally valid evaluation; calibrated uncertainty; comparison with simple
baselines; positive held-out decision value; shift/abstention behavior; an
explicit privacy/feature contract; proof of decision-time feature availability;
and a rollback/fallback contract for any action consumer. Independent review of
the research methodology would remain valuable even after those repository-side
conditions exist.

## Terminal packet boundary

`WP-J03` is therefore `COMPLETED` as a **research-only admission boundary**.
The production promotion rules are explicitly unfulfilled and no production
surface may reinterpret that packet status as evidence that a complexity
estimator is validated, causal, decision-useful, or safe to automate.
