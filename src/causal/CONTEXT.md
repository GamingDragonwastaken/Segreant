# causal — preregistered randomized evidence

## Consumes

- committed protocol/assignment/execution/outcome records;
- declared bounded cost, quality and economic outcome ranges;
- the retained protocol analysis plan and its confidence rule.

## Guarantees

- qualification remains structural and local; it never implies provider billing,
  universal ROI or future performance;
- the estimator reports a scoped ITT effect with finite-range bounds;
- a cost-quality conjunction uses one predeclared family-wise rule: Bonferroni
  allocation across both endpoints for `model_cost_quality`;
- an AI-versus-incumbent net-benefit result uses the direct net-benefit endpoint
  as its one-endpoint family rather than silently combining separate outcomes;
- the result discloses overall confidence, component endpoint confidence, alpha,
  endpoint family/count, equal allocation, the registered quality margin, cost
  superiority threshold, secondary-endpoint policy, and whether the rule came
  from the protocol or the deterministic legacy-version default;
- protocol changes to an explicit joint rule change the committed hash and are
  refused after commitment; old protocols retain byte-compatible hashes while
  receiving the disclosed version default.
- the sequential lane commits an explicit registered look schedule, hashes its protocol/observations/results, and returns an anytime-valid interval only for accumulated independent Bernoulli observations; unregistered stopping, clustering, sliding data, adaptive assignment, and post-hoc selection remain refused.
- the inference ledger records every reported look as one act per registered
  endpoint, chains the acts so a removed act is detectable, and puts the look
  count, endpoint count, slice count, union-bound family-wise error and
  simultaneous confidence on the reported result's own limitations;
- precision planning derives its half-width from the estimator's own
  `hoeffdingArmRadius`, so a projection cannot drift away from the interval the
  estimator will actually produce for the same range, per-arm n and alpha.

## Invariants

- A reported interval is never widened, re-levelled, or re-derived to absorb
  multiplicity. The single-look decision is reported unchanged and the ledger
  states separately whether it survives; nothing here converts a look count into
  a more favourable number.
- A family-wise error GUARANTEE requires a plan registered before the first act.
  Without one the ledger reports a union bound over exactly the acts it holds
  and says that is all it is; a Bonferroni denominator discovered after the
  looks were taken is not error control.
- Re-reading identical evidence (same estimand, endpoint, slice and evidence
  digest) is recorded as a look but spends no error budget; a new slice or new
  evidence always does.
- A claim that outran its registered family is withheld, never restated at an
  adjusted level.
- Precision planning is not a power calculation and exposes no probability of
  reaching a decision; it states the required observed difference as a necessary
  condition and prices evidence in units, never in provider cost.

- Two nominal 95% endpoint intervals are never reported as a 95% joint claim.
- One passing endpoint cannot authorize a conjunction when the other fails.
- Unknown, collecting, invalid and inconclusive evidence cannot produce a causal
  claim or a decision-grade recommendation.
- A sequential result is not trusted after rehydration until its nested validity domain, interval calculation, stopping record, and provenance cross-fields validate; a digest alone is not semantic evidence.

## Verify

```bash
node --test --experimental-strip-types test/causal-core.test.ts
node --test --experimental-strip-types test/sequential-inference.test.ts
node --test --experimental-strip-types test/causal-inference-ledger.test.ts
node --test --experimental-strip-types test/causal-precision.test.ts
```
