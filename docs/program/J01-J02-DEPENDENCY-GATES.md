# J01/J02 dependency gates

These packets remain `NOT_STARTED` by design. The dossier places adaptive
experimentation/OPE after causal-v3 and places online control after a safe
decision/control architecture. A design note is not an implementation and must
not be counted as one.

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
They do not authorize online spend-changing or routing actions. Implementing an
online controller now would expand authority beyond the dossier's proven
boundary, so J02 remains not started.
