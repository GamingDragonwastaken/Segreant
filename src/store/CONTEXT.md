# store — the ledger and every derived record

<!-- Layer 2 contract. The single writer for all persisted state. -->

## Layout

`db.ts` exports `Store` and is the **only** entry point any caller uses. It is a
facade: it owns the connection, the public method names, and the record shapes,
and delegates the body of each method to a domain module beside it. Callers
import `Store` and its types from `db.ts` and nothing else — a domain module is
an implementation detail, and moving a method between them must never be visible
above this directory.

| File | Owns |
| --- | --- |
| `db.ts` | the `Store` facade: connection, requests, sessions, projects/aliases, proposals, commits, gate signals, session units, maintenance |
| `schema.ts` | every `CREATE TABLE`, every guarded `ALTER`, kernel tables/triggers, and `runScript` |
| `billing.ts` | provider evidence imports, OpenAI Costs observations, provider scope declarations, reconciliation |
| `allocation.ts` | cost centres, the versioned rule book, allocation runs |
| `realization.ts` | realized-value snapshots, receipts, repricing and its re-attribution |
| `rows.ts` | row decoders shared by more than one domain |
| `backup.ts` | verified SQLite snapshot/restore-to-new-path helpers; never replaces the active ledger |

Domain modules take the `DatabaseSync` handle as their first argument and are
stateless. Where a domain needs a read that belongs to another one — allocation
and billing need `requestsInRange`, realization needs the alias family and the
window aggregates — the facade **passes it in** rather than the module
re-implementing it. Two implementations of one aggregate is how a total starts
disagreeing with itself.

A domain module may `import type` from `db.ts` (erased at runtime) but must
never import a value from it: that would make the graph circular. A helper with
two domain callers goes in `rows.ts`.

## Consumes

- `node:sqlite` `DatabaseSync` only. No ORM, no query builder, no runtime dependency.
- `src/config.ts` for the home directory (`FISCUS_HOME` overrides it — every
  test and every gate run uses an isolated home).

## Guarantees

- **Money is exact.** All amounts are integer microdollars. No float ever reaches
  a column.
- **One writer.** Every table is created and migrated in `schema.ts`. No other
  module — inside this directory or outside it — issues DDL.
- **Derived records are immutable.** `reconciliation runs`, `allocation_runs`,
  and `realization_units` are written once. Recompute by writing a new record.
- **Recorded labels are never rewritten.** Alias resolution happens at query
  time (`projectCanonical` beside the recorded `project`), so an export and a
  rollup total identically without either mutating a row.
- **Backups are additive and integrity-checked.** `Store.backupTo()` uses
  `VACUUM INTO`, quick/foreign-key checks, a schema fingerprint, and a redacted
  manifest. `Store.restoreBackup()` refuses existing destinations and never
  overwrites the active database path.
- **The epistemic ledger shares this connection.** `Store.epistemic()` exposes
  canonical Evidence/Claim/Derivation persistence on the same SQLite handle;
  its schema and append-only triggers are still owned by `schema.ts`.
- **The economic ledger shares this connection.** `Store.economic()` exposes
  exact-Money immutable events and deterministic basis-separated projections;
  event DDL and append-only triggers remain owned by `schema.ts`.
- **Exact request issuance is transactional.** A `RequestRow` carrying
  `economicAmount` writes one deterministic economic charge event through the
  same SQLite transaction. `economicAmountForRequest()` reads that exact event;
  rows without it remain legacy numeric compatibility records and are never
  silently reconstructed.
- **Billing kernel issuance is explicit and additive.** `issueBillingImportToKernel()`
  translates a validated operator export through exact `Money` into canonical
  Evidence and billed Claims; `issueOpenAiCostsObservationToKernel()` does the
  same for complete direct provider observations with a distinct
  `provider_observed` basis. Legacy billing rows remain the compatibility read
  model; `issueOpenAiReconciliationToKernel()` adds the exact local-capture and
  mixed residual Claim only after a reconciliation run is durably recorded, and
  repeated issuance is idempotent.

## Invariants

- **`runScript` splits SQL on `;`.** The `SCHEMA` template literal in
  `schema.ts` must contain **no semicolons and no backticks**. Violating this
  silently truncates the schema.
- **Control characters are written as escapes.** Composite keys built for
  grouping join their parts with `\u0000`; that must stay the six-character
  escape in source and never a literal NUL byte.
- **Migrations are additive and guarded**: `ALTER TABLE ... ADD COLUMN` inside
  `migrate()`, `TEXT NOT NULL DEFAULT '<sentinel>'`, wrapped so a re-run is a
  no-op.
- **No backfill, ever.** A row written before a provenance column existed reads
  `legacy_unknown` and stays there — even when only one writer could have
  produced it. Provenance asserted from context is the failure the column exists
  to prevent.
- SQLite binds `GROUP BY` against output aliases before source columns. Alias a
  computed column the same as a real one and the grouping silently changes; a
  test caught this once already.

## Verify

```bash
npm test -- --test-name-pattern="store|migration|provenance"
```

A schema change needs a test that fails against the pre-change behaviour, and a
second run of `migrate()` proving it is idempotent.
