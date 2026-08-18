# store — the ledger and every derived record

<!-- Layer 2 contract. One file, ~3,400 lines: the single writer for all persisted state. -->

## Consumes

- `node:sqlite` `DatabaseSync` only. No ORM, no query builder, no runtime dependency.
- `src/config.ts` for the home directory (`AEGIS_HOME` overrides it — every test
  and every gate run uses an isolated home).

## Guarantees

- **Money is exact.** All amounts are integer microdollars. No float ever reaches
  a column.
- **One writer.** Every table is created and migrated here. No other module
  issues DDL.
- **Derived records are immutable.** `reconciliation runs`, `allocation_runs`,
  and `realization_units` are written once. Recompute by writing a new record.
- **Recorded labels are never rewritten.** Alias resolution happens at query
  time (`projectCanonical` beside the recorded `project`), so an export and a
  rollup total identically without either mutating a row.

## Invariants

- **`runScript` splits SQL on `;`.** The `SCHEMA` template literal must contain
  **no semicolons and no backticks**. Violating this silently truncates the
  schema.
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
