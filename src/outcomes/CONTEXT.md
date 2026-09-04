# outcomes — domain-neutral work and outcome adapters

## Consumes

- `src/epistemic/state.ts` for four-valued predicate state.
- `src/outcomes/contract.ts` for required-predicate evaluation.
- Adapter-owned context for domain-specific observations; the generic layer never interprets prompt or source content.

## Guarantees

- A `WorkUnit` identifies a bounded unit of work without assuming that the unit is a Git commit.
- An `OutcomeAdapter` supplies the domain contract and resolves predicates; it does not directly declare value or cost.
- `adaptOutcome()` preserves `confirmed`, `failed`, `unresolved`, and `conflicted` states and exposes adapter provenance and coverage.
- Optional measures remain observations attached to the adapted outcome, not proof of business value or causal effect.

## Invariants

- Required predicates are evaluated conjunctively by the shared `OutcomeContract`.
- Unknown evidence never becomes confirmation; conflict never becomes confirmation.
- Work-unit identity and interval validation occur before adapter evaluation.
- Domain-specific adapters may be added without changing the generic contract or inventing coding lifecycle gates for non-coding work.

## Verify

```bash
node --test --experimental-strip-types test/outcome-contract.test.ts test/work-unit-outcome-adapter.test.ts test/outcome-adapter-integration.test.ts
```
