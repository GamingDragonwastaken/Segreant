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

## Invariants

- Two nominal 95% endpoint intervals are never reported as a 95% joint claim.
- One passing endpoint cannot authorize a conjunction when the other fails.
- Unknown, collecting, invalid and inconclusive evidence cannot produce a causal
  claim or a decision-grade recommendation.
- A sequential result is not trusted after rehydration until its nested validity domain, interval calculation, stopping record, and provenance cross-fields validate; a digest alone is not semantic evidence.

## Verify

```bash
node --test --experimental-strip-types test/causal-core.test.ts
node --test --experimental-strip-types test/sequential-inference.test.ts
```
