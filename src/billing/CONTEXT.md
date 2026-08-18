# billing — provider-side evidence and reconciliation

<!-- Layer 2 contract. The boundary between what we measured and what a provider billed. -->

## Consumes

- `src/store/db.ts` for observation runs, imports, and the request ledger.
- Operator-declared route scope (`scope.ts`) — a self-assertion, never verified.
- Either an authorized OpenAI Costs pull (`openaiCosts.ts`) or an
  operator-supplied export adopted from an import (`Store.adoptOpenAiCostsFromImport`).

## Guarantees

- Reconciliation compares at **project-day total** grain — the only compatible
  join, because provider line items map to neither models nor requests.
- Status is `reconciled_with_residual`, **never** `reconciled`. The residual is
  an upper bound on off-path spend, not a measurement.
- Every run carries `providerSourceKind` (`provider_api_pull` /
  `operator_supplied_export` / `legacy_unknown`) and its conditions. The
  operator-supplied route adds a fifth condition and is never presented as
  equivalent evidence to a pull.
- Refuses rather than softens: a period ending within 48h, non-USD or mixed
  currency, non-whole-UTC-day input, and out-of-project records are refused with
  the excluded money reported.

## Invariants

- **Never create, request, store, or transmit a provider credential.** Previews
  make no network request and read no credential; both facts are asserted in the
  release gate.
- **A reconciled amount never reaches budgets, RoI, or model recommendations.**
- `isOnDeclaredRoute` counts only `provider === 'openai' && via === 'proxy'`
  carrying the declared scope id. **Imported rows are excluded and must stay
  excluded** — an imported row has the model and the cost but nothing tying it to
  the declared provider project. Counting it would invent the attribution this
  module exists to refuse. On the owner's real ledger this excludes 100% of
  OpenAI spend, which is why readiness reports coverage *before* the credential
  step.

## Verify

```bash
npm test -- --test-name-pattern="reconcile|adopt|coverage|scope"
```
