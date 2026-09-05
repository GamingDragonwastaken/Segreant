# decision — conservative utility and evidence-acquisition rules

## Consumes

- finite utility intervals supplied by a caller's evidence/measurement layer;
- finite posterior scenario probabilities and conditional expected utilities;
- an explicitly declared measurement cost.

`currentExpectedUtilities` is an optional compatibility assertion only. The
scenario mixture is the sole authority for the prior: each action's prior
expectation is derived as the probability-weighted sum of its conditional
scenario utilities, and a supplied compatibility map must agree within the
documented tolerance. Utility magnitudes above `Number.MAX_SAFE_INTEGER` are
rejected so expected-value arithmetic cannot silently lose materially relevant
precision.

## Guarantees

- strict robust dominance is certified only when one action's lower bound clears every rival's upper bound;
- `decisionCountermodels` emits one explicit, actionable witness for each declared interval-certificate assumption; live witnesses withhold certification rather than becoming a recommendation;
- overlapping intervals remain `undetermined`;
- minimax regret and value of information identify their rule and assumptions;
- `buildDecisionKernelIssuance` is a side-effect-free preview; `issueDecisionToKernel` persists an explicit certificate bundle as immutable kernel Evidence with the decision-problem identity/version, action set, dependency IDs, rule, assumptions, dominance result, and validity/revalidation metadata;
- `readDecisionCertificateBundle` revalidates the stored bundle, checks its recorded dependencies, and applies the ledger's as-of revocation projection; a revoked prerequisite returns `invalidated` without deleting history;
- every persisted bundle has explicit `actionSemantics.mode: 'no_action'`, `permitted: false`, and a read result with `canAutoAct: false`; persistence and reads never execute, approve, route, or change a provider/model/budget;
- gross perfect-information value is non-negative under one coherent scenario
  mixture; measurement cost is applied only afterward;
- invalid, duplicate, non-finite, or mismatched inputs fail closed;
- ties are returned in deterministic action-identifier order.
- `control.ts` models shadow → simulated effect → canary → monitored expansion → full rollout and rollback as an immutable, preview-then-commit, revision-checked state machine; it never executes, authorizes, or persists an external action.

## Invariants

- a rule-selected action is not labelled objectively best;
- a proven dominance result is decision fitness under the declared interval rule, not authorization to execute the selected action;
- expiry and revalidation are read-time statuses; the adapter records conditions but does not evaluate them or silently renew a certificate;
- regret assumes a rectangular interval uncertainty set;
- VOI scenarios are finite, exhaustive, mutually exclusive, and use one utility basis;
- measurement cost is subtracted from gross decision-loss reduction exactly once.
- control transitions fail closed on stale/revoked/conflicted/incomplete evidence, changed treatment/model/pricing/environment regime, degraded completeness, broken measurement, harmful or unobservable outcomes, and expired policy TTL; a rollback is terminal and idempotent.

## Verify

```bash
node --test --experimental-strip-types test/decision-engine.test.ts
node --test --experimental-strip-types test/decision-control.test.ts
```
