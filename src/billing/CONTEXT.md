# billing — provider-side evidence and reconciliation

<!-- Layer 2 contract. The boundary between what we measured and what a provider billed. -->

## Consumes

- `src/store/db.ts` for observation runs, imports, and the request ledger.
- Operator-declared route scope (`scope.ts`) — a self-assertion, never verified.
- Either an authorized OpenAI Costs pull (`openaiCosts.ts`) or an
  operator-supplied export adopted from an import (`Store.adoptOpenAiCostsFromImport`).
- Exact imported-record mapping (`mapping.ts`) can attach a provider line to a
  local project/account, but only as an operator declaration.
- `epistemic.ts` issues the first vertical's provider-line Evidence and billed
  Claims through exact `Money`, and can issue a mixed-basis reconciliation Claim
  when both provider and local-capture evidence IDs are supplied.

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
- Mapping coverage is explicit: each imported line is `mapped_operator_declared`,
  `unmapped`, `stale_mapping`, or `ambiguous_mapping`; residual dollars remain
  visible and are never force-fitted.
- Kernel issuance keeps provider billed amounts and local estimated amounts as
  separate Money bases; a residual is a typed comparison, never a new basis or
  an attributable cause. Repeating issuance is idempotent through the kernel
  ledger.

## Invariants

- **Never create, request, store, or transmit a provider credential.** Previews
  make no network request and read no credential; both facts are asserted in the
  release gate.
- **A reconciled amount never reaches budgets, RoI, or model recommendations.**
- **A mapped imported amount never reaches budgets, RoI, or model recommendations
  while provider scope is operator-declared.** Mapping is versioned evidence, not
  provider verification; only a future explicit provider-verified authority can
  discharge this gate.
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
node --test --experimental-strip-types test/billing-epistemic.test.ts
```
