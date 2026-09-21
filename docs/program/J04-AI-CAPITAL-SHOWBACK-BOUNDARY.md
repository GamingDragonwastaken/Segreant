# WP-J04 AI capital / showback boundary

**Status:** `COMPLETED` at the repository-side, review-only capital-account
boundary. No provider commitment authority, external chargeback, autonomous
capital action, causal attribution, no-causation guarantee, or business-value
claim is implied.

## What exists and is proven

- `src/store/allocation.ts` and `src/alloc/*` preserve exact allocation runs,
  unallocated buckets, rule versions, coverage and conservation.
- The dashboard and claim layers label allocation as `showback_only`; it does
  not settle money, enforce chargeback, establish causation, or establish
  business value.
- `src/value/marginal.ts` exposes a bounded shadow-price/marginal-return
  scenario model. It is not a capital ledger, provider commitment authority, or
  causal optimizer.
- Existing allocation/marginal/dashboard tests are the evidence for those
  boundaries; this packet adds no new financial authority by relabelling them.

## Implemented repository boundary (D-276)

`src/capital.ts` now defines a versioned, exact-money `CapitalAccountInput` and
`CapitalAccountResult`. `evaluateCapitalAccount()` validates a half-open
observation window and produces typed totals for:

- committed capacity, consumed capacity, reserved capacity and unused
  commitment;
- direct spend, allocated/showback spend, full spend, realized cash spend and
  avoidable spend; and
- an optional marginal scenario amount that is deliberately kept outside
  realized spend.

The evaluator rejects negative or cross-currency amounts, duplicate or invalid
observations, committed capacity below consumed-plus-reserved capacity, and
direct-plus-allocated totals that do not equal the realized cash amount. Those
checks are exact `Money` operations rather than floating-point arithmetic, so
an invoice cannot be counted again merely because it was allocated to a cost
centre.

The bounded operator consumer is:

```text
fiscus capital evaluate --options <file> --json
```

The options file is a local review snapshot. The command has no Store write,
provider credential, budget mutation, routing, payment or chargeback path.

The optional opportunity result compares observed consumption with an
explicitly declared target and is labelled `counterfactual_only`; it is not
spend, causal effect, or business value. The optional fairness result is a
descriptive max/min spread under a named policy and dimension, labelled
`policy_relative`/`descriptive_only`; it is not a causal, distributive-justice,
or business-value judgement. Focused RED-first coverage is 5/5 including the
CLI consumer, and root typecheck/build pass.

## Deliberate terminal boundaries

The result is a review model, not a durable provider-capital ledger: the
supplied snapshot is not independently proven to be complete, and the module
does not import invoices or reconcile them against local request rows. A later
product slice may add Store persistence only after an owner-approved source
identity, retention policy, and invoice/request reconciliation contract exists.
That is a new authority decision, not a reason to weaken this boundary.

The next implementation slice should begin with schemas and conservation tests,
not a dashboard or an optimizer. No provider commitment authority, external
chargeback, autonomous capital action, no-causation claim, or business-value
claim is implied here.
