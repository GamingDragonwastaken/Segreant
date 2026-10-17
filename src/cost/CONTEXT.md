# cost — current prices and explicit history corrections

Consumes the local rate card, declared prices, and Store request evidence. No
dashboard price operation refreshes the card or sends data off the machine.

`declarations.ts` owns the CLI/dashboard unresolved-model filter and exact-card
check for a `like` declaration. Recorded guessed-price cohorts are combined by
the provider/model tuple only after excluding models that the current card or
a declaration now prices exactly. Saving or removing a declaration changes no
recorded request amount.

`reprice.ts` is the single computation used by the CLI and dashboard.
`previewReprice(store)` reads estimated requests and returns the write plan,
counts, and per-model before/after totals with the new price's basis.
`applyReprice(store)` computes that same plan once, then passes its updates to
`Store.applyRepricedCosts` in one audited transaction. Rows that remain estimates
and rows already exactly priced stay untouched. The Store owns retained previous
amounts and value-snapshot synchronization. The internal write plan contains exact
money objects; dashboard JSON exposes only the report, not those objects.

The existing CLI output is a compatibility contract. Its historical rate-card
wording stays unchanged even when a declaration supplies the new price. The
dashboard labels each new amount as `list price` or `your price` instead.

Verify with `test/reprice-preview.test.ts`, `test/reprice.test.ts`,
`test/reprice-sync.test.ts`, `test/pricing-declare.test.ts`,
`test/price-overrides.test.ts`, and `test/dashboard-pricing-write.test.ts`.
