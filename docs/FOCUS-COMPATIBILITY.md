# FOCUS compatibility projection

Fiscus provides a bounded, credential-free **FOCUS v1.4 compatibility projection** for immutable provider billing evidence. It is an interoperability-shaped read model, **not FOCUS conformance** and not an invoice validator.

`billingEvidenceToFocus()` in `src/export/focusBilling.ts` is a pure library adapter. It maps provider-declared OpenAI billing records to v1.4-shaped fields including `BillingAccountId`, billing/charge periods, `ChargeCategory`, `ServiceProviderName`, `ServiceName`, `SkuId`, `BillingCurrency`, and `BilledCost`.

The projection preserves the product's accounting distinctions:

- `BilledCost` is populated only from a record with `costBasis: provider_reported`.
- `EffectiveCost` and `AllocatedCost` are explicitly `null`, with Fiscus status fields set to `unmapped`; local estimates and allocations are never laundered into FOCUS cost metrics.
- `InvoiceIssuerName`, resource identity, account name, and allocation source remain `null` where the source record does not establish them.
- `FiscusSourceLineage` retains the immutable record ID, source record ID and SHA-256, import/export IDs, source system, and operator-supplied trust label.
- Unsupported monetary bases and unsupported charge types are refused rather than guessed.

The adapter performs no network access, credential lookup, persistence, mutation, reconciliation, allocation, or request-ledger update. FOCUS v1.4 definitions used here are the primary specification pages for [Billed Cost](https://focus.finops.org/docs/specification/v1-4/columns/cost-and-usage/billed-cost/), [Charge Category](https://focus.finops.org/docs/specification/v1-4/columns/cost-and-usage/charge-category/), and [Billing Account ID](https://focus.finops.org/docs/specification/v1-4/columns/cost-and-usage/billing-account-id/).
