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
- overlapping intervals remain `undetermined`;
- minimax regret and value of information identify their rule and assumptions;
- gross perfect-information value is non-negative under one coherent scenario
  mixture; measurement cost is applied only afterward;
- invalid, duplicate, non-finite, or mismatched inputs fail closed;
- ties are returned in deterministic action-identifier order.

## Invariants

- a rule-selected action is not labelled objectively best;
- regret assumes a rectangular interval uncertainty set;
- VOI scenarios are finite, exhaustive, mutually exclusive, and use one utility basis;
- measurement cost is subtracted from gross decision-loss reduction exactly once.

## Verify

```bash
node --test --experimental-strip-types test/decision-engine.test.ts
```
