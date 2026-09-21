# WP-I02 structured epistemic UX bundle

**Status:** `COMPLETED` at the repository-side, read-only structured UX
boundary.

`src/epistemic/ux.ts` composes the existing kernel/decision primitives into a
single operator-facing bundle:

- Trace-the-Dollar orders declared request/economic-event/correction/allocation
  nodes, validates exact Money identity and source edges, and withholds a trace
  with missing predecessors;
- support/countermodel presentation reuses the bounded minimal-invalidating-set
  algorithm, including its `truncated`, `inertAssumptions`, and empty-reason
  semantics;
- measure-next planning ranks declared evidence gaps by consequence only and
  refuses to invent a prior, probability, acquisition cost, or VoI score; and
- Preference Map output reuses `preferenceRobustness`, preserving ties and
  `preference_sensitive` status rather than forcing an action.

The bounded consumer is:

```text
fiscus evidence ux --options <file> --json
```

Focused RED-first coverage is 4/4 for the bundle/CLI path; root typecheck and
build pass. The bundle is read-only and cannot issue, strengthen, authorize,
or route a claim.

## Presentation boundary

This closes the semantic/structured UX contract. A future dashboard may bind
the same bundle to a richer visual route, but no browser surface is allowed to
invent a second support, trace, or preference authority. The bundle's
completeness is always over the supplied local nodes and declarations, not the
external world.

