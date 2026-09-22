# alloc — cost-centre allocation

<!-- Layer 2 contract. Showback only. Never chargeback-grade. -->

## Consumes

- `src/store/db.ts`: `cost_centres`, `allocation_rules`, `allocation_runs`, and
  the request ledger it allocates over.

## Guarantees

- Versioned, effective-dated, reversible rules over three methods: `direct`,
  `fixed_split`, `proportional_to_direct`.
- Rules are matched against **the instant the spend happened**, so a closed
  period never restates when a rule changes.
- Unallocated is a first-class output with a reason, a count, and its top project
  labels — not a silent remainder.
- Conservation is enforced to the microdollar; `saveAllocationRun` throws rather
  than persisting a run that does not balance.
- Every line records the rule **version** and the cost basis it allocated.
- The exact adapter in `exact.ts` projects canonical effective `Money` without
  float-to-micro conversion, partitions currency/basis identities, retains all
  source economic event IDs, and reports incomplete legacy request coverage.

## Invariants

- **`basis: 'showback_only'`.** An allocated amount never reaches budgets,
  enforcement, RoI, or model recommendations.
- **Never join allocation to the value layer to produce RoI-per-cost-centre.**
  That is the generic RoI reallocation this product already refused.
- Ratios are exact to six decimal places. An exact third is **refused**, with the
  remedy in the error text — not silently rounded.
- A `proportional_to_direct` rule takes ratio `0` and no explicit targets; it
  distributes across every directly-allocated centre.
- Everything here allocates **local estimates**. No reconciliation has completed
  against a real provider bill, so accuracy is unknown and the surfaces say so.
- Exact allocation runs persist through schema-owned canonical JSON/digest rows
  and per-line append-only source links; replay recomputes identity, lineage and
  conservation rather than trusting persisted flags. The legacy microdollar run
  remains a separate compatibility record and is never relabelled as exact.

## Verify

```bash
npm test -- --test-name-pattern="alloc"
```

Conservation and the refusal cases are the tests that matter; a change that
makes allocation "just work" on an input it used to refuse is a regression.
