# Compatibility

What an integrator or contributor can build against without expecting it to
move under them, and how a change to it is supposed to happen. Pre-1.0
(`package.json` is `0.1.0`; there is no tagged release yet — see
`CHANGELOG.md`), so this is a stated intent for how stability will be handled,
not a SemVer promise this project has been through a cycle of yet.

## Stable

- **The CLI verb surface listed in the parity map**, `src/dashboard/web/app/core/registry.ts`.
  Every entry there is checked against `src/cli.ts`'s actual dispatch by
  `test/dashboard-parity-population.test.ts`, so the map cannot silently list
  a verb the CLI does not have (D-205 tightened this to verb, subcommand, and
  flag, not just the first word).
- **The GUI's local API routes**, declared once in `src/dashboard/contracts.ts`
  (path, methods, which methods require the `x-fiscus-local: 1` header, and
  response type) and consumed by both the server and the browser app.
- **The SQLite schema generation** produced by `migrate()` in
  `src/store/schema.ts`. `CURRENT_SCHEMA_VERSION` is checked on open: a
  database from a newer schema version refuses to open under an older binary
  rather than silently misreading it; an older database is migrated forward
  additively (`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT '<sentinel>'`,
  never a destructive rewrite — `CONTEXT.md`'s "Schema migrations are additive
  and guarded" rule).
- **The backup manifest format**, `src/store/backup.ts`. A manifest is
  `{ version: 1, kind: 'fiscus-ledger-backup', ... }`; restoring checks the
  version, kind, and a required-table contract against the paired SQLite
  artifact before trusting it, and refuses a manifest that does not match.

## Deprecation policy

A stable surface above that must change keeps both the old and new form
working for one minor version, with a printed notice on the old form naming
its replacement and removal version, before the old form is removed.

**This is a stated policy, not a claim that it has been exercised yet** —
nothing on the stable list above has needed a breaking change since this
document existed. One precedent from before this policy is worth being honest
about: an old environment-variable name for `FISCUS_HOME` was removed outright
— "not deprecated, not read, not warned about" (`src/config.ts`) — because
letting two spellings of one precedence-sensitive setting coexist had already
caused a real defect (an ambient value silently outranking the name tests used
to isolate themselves). That was a judgment call under the old, undocumented
practice; the policy above is what a future change to one of the four stable
surfaces is now held to.

## `legacy_unknown` is never backfilled

Provenance columns that predate a lineage feature carry the sentinel
`legacy_unknown` (`src/store/db.ts`, `src/store/billing.ts`,
`src/store/allocation.ts`) rather than a guessed value, permanently. A schema
migration adding a new provenance column must default existing rows to its
`legacy_unknown`-equivalent sentinel and must never infer history from
adjacent columns — this is `CLAUDE.md` rule 2, and it applies to migrations
specifically because a migration is exactly where the temptation to backfill
shows up.

## Not covered by this document

Internal module boundaries under `src/*/CONTEXT.md`, the demo dataset shape,
and anything under `docs/program/` (working state, not a public contract) can
change without notice. `team-server/`'s schema and API are pre-infrastructure-
gate (`RELEASE-GATE.md`'s separate team-server gate) and are not yet held to
this policy.
