# J01/J02 dependency gates

J01 is now `PARTIAL`; J02 remains `NOT_STARTED`. The authority directive
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

The first repository-side J01 slice now exists in `src/causal/ope.ts`:
`evaluateOpe()` accepts only action-level logs with treatment identity,
pre-treatment context timing, target/logging policy digests and probabilities;
it implements unnormalized IPS, self-normalized IPS and doubly robust estimates
with explicit overlap, clipping and tail-risk reports. RED-first coverage is
9/9 in `test/causal-ope.test.ts`. The result is deliberately a pure evidence
boundary: it does not persist a policy/action log, infer an unrecorded
propensity, or authorize execution. The remaining J01 work is a Store-owned
append-only logging schema, policy-version/action provenance at the real
decision boundary, replay/idempotence and a bounded product consumer.

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
`NOT_STARTED` until a bounded runtime action adapter, safe baseline, durable
rollback/circuit-breaker evidence and an explicit no-action default are wired.
