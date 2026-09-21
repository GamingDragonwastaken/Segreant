# WP-J04 AI capital / showback boundary

**Status:** `PARTIAL` (existing showback and marginal-value foundations; no
capital-account or commitment engine admitted)

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

## Required remaining work

1. A typed AI-capital account model must distinguish committed capacity,
   consumed capacity, reserved/unused capacity, and realized cash spend without
   double counting provider invoices or local request events.
2. Showback must remain separate from punitive chargeback and must carry policy,
   allocation basis, coverage and fairness disclosures.
3. Direct, allocated, full, avoidable and marginal spend need explicit typed
   decompositions with conservation and currency/basis rules.
4. Opportunity gaps and unused commitments need a declared counterfactual,
   observation window, uncertainty, and no-causation label.
5. Any fairness analysis must be policy-relative and must not be presented as a
   business-value or causal judgment.

The next implementation slice should begin with schemas and conservation tests,
not a dashboard or an optimizer. No provider commitment authority, external
chargeback, autonomous capital action, or business-value claim is implied here.
