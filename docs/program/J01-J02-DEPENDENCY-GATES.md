# J01/J02 dependency gates

J01 and J02 are now `COMPLETED` at the repository boundary. The distinction
between evidence, authorization and action remains explicit: J01 evaluates a
retained policy/action log and never authorizes an action; J02 adds a separate,
operator-delegated control policy for one real product target,
`budget.dailyUsd`. A DecisionCertificate alone still cannot mutate anything.

## J01 — adaptive experimentation / provenance-aware OPE

The repository-side J01 implementation lives in `src/causal/ope.ts`,
`src/store/ope.ts` and the causal CLI. `evaluateOpe()` requires action-level
treatment identity, pre-treatment context timing, logging propensity,
target/logging policy version and digest, explicit overlap constraints and
bounded reward semantics. It implements IPS, self-normalized IPS and doubly
robust estimates with explicit clipping and tail-risk disclosure. The Store owns
an append-only, digest-authenticated action-observation log and
`fiscus causal ope --options <file>` is a bounded review-only product consumer.
Retrospective model comparisons without action-level propensity/treatment
provenance remain observational and are refused as OPE.

## J02 — constrained online control

The owner has explicitly delegated bounded autonomous online action. The first
implemented target is deliberately narrow: Fiscus may change its own hard daily
proxy cap, `budget.dailyUsd`, through `fiscus budget --control --policy
<file.json> [--apply]`. This reuses the exact-money BudgetGuard and the existing
budget DecisionCertificate/DAL path instead of creating a second spend authority.

The runtime contract is:

- **default no action:** without `--apply`, the route is a pure preview; with
  ordinary observational Fiscus inputs the spend-change assurance gate remains
  below DAL-3, so even `--apply` makes no spend mutation;
- **separate delegated authority:** a versioned control policy names the target,
  safe baseline, min/max cap envelope, maximum relative step, expiry,
  tail-risk/runaway bound and whether the policy is enabled. The policy has its
  own digest and is not inferred from a DecisionCertificate;
- **quality/non-degradation gate:** an autonomous tightening requires a
  `proven_dominant` cap certificate, DAL-3 spend-change fitness and an
  `apply_recommended` action that remains optimal across the declared
  admissible preference set. If those conditions disappear while the controller
  owns the cap, the safe action is rollback;
- **exploration cap:** controller v1 is deterministic and requires
  `explorationRateCap = 0`. J01 records/evaluates policy exploration, but J02
  does not manufacture live exploration merely to satisfy the packet;
- **tail-risk monitoring and circuit breaker:** the live BudgetGuard runaway
  configuration must exist and be at least as strict as the delegated policy.
  A tripped runaway guard causes rollback to the safe baseline;
- **safe baseline / human override:** the controller can arm only while the live
  cap equals the policy's declared safe baseline. Once controlling, it may
  rollback only a cap it can prove it last wrote. Any other live cap is treated
  as an operator/external override and autonomous mutation stops;
- **rollback:** expired/disabled policy, lost decision fitness, preference
  instability, unavailable/loosened tail-risk guard or a tripped circuit breaker
  rolls a controller-owned cap back to the declared safe baseline. A rolled-back
  policy version cannot re-arm; the operator must issue a new version;
- **audit trail:** each applied/control evaluation receives a transaction id and
  enters a SHA-256 hash chain. Tampering is detected. Spend-changing mutations
  use a durable write-ahead pending record so a process crash between config,
  state and audit writes is reconciled on the next invocation as committed,
  aborted or conflicted rather than silently losing provenance;
- **action semantics proven at the product route:** the CLI exercises the real
  Fiscus config persistence path, so the target is not an in-memory rollout enum.
  A high-assurance synthetic DAL-3 test proves the mutation path can open; a CLI
  integration test over ordinary runtime evidence proves the live product path
  fails closed and leaves the cap unchanged.

This closes J02 as an implementation packet. It does **not** claim that ordinary
current Fiscus evidence already earns DAL-3, that an autonomous policy has been
operated in a real organization, or that retrospective OPE is causal. Those are
evidence/field-use questions, not missing controller architecture.
