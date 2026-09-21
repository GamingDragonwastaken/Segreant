# J01/J02 dependency gates

J01 is now `COMPLETED` at the review-only OPE boundary; J02 is
`BLOCKED_EXTERNAL` at its explicit safety/authority gate. The authority directive
permits implementation under bounded delegated policy, but a design note is
not an implementation and an OPE estimator is not an online controller.

## J01 — adaptive experimentation / provenance-aware OPE

Required prerequisites before code:

- a committed causal-v3 protocol/evidence root with treatment identity and
  policy-version semantics;
- action-level propensity/logging records retained before outcomes, with
  context, policy version, treatment identity, budget/risk constraints and
  overlap checks;
- a safe evaluation contract that refuses missing propensities, missing
  treatment identity, unsupported overlap, and post-treatment leakage;
- a documented estimator/assumption choice for importance, doubly robust, and
  clipped/tail-risk trade-offs.

The current repository does not satisfy those prerequisites. Ordinary
retrospective model comparisons remain observational comparisons, not OPE.

The repository-side J01 implementation exists in `src/causal/ope.ts`:
`evaluateOpe()` accepts only action-level logs with treatment identity,
pre-treatment context timing, target/logging policy digests and probabilities;
it implements unnormalized IPS, self-normalized IPS and doubly robust estimates
with explicit overlap, clipping and tail-risk reports. RED-first coverage is
13/13 across the OPE, Store, CLI and dependency tests. The result is deliberately a pure evidence
boundary: it does not infer an unrecorded propensity or authorize execution.
The Store owns an append-only `ope_action_observations` log with digest replay
and idempotent writes, `fiscus causal ope --options <file>` is the bounded
review-only product consumer, and the typed exploration/budget/tail-risk policy
declaration is bound to the target policy identity. Online action execution and
routing remain outside J01 and belong to J02.

## J02 — constrained online control

Required prerequisites before code:

- a product control target and operator-approved action authority;
- durable policy versions, rollback, audit trail, circuit breaker and safe
  baseline fallback;
- budget, non-degradation, exploration-cap and tail-risk constraints with
  runtime evidence and a no-action default;
- a live route whose action semantics are proven, not merely an in-memory
  rollout enum.

The current control and decision modules are review-only/no-action foundations.
They do not authorize online spend-changing or routing actions. J02 remains
`BLOCKED_EXTERNAL` until a bounded runtime action adapter, safe baseline,
durable rollback/circuit-breaker evidence and an explicit no-action default are
wired under owner-approved authority. No repository-only implementation can
prove that external gate.
