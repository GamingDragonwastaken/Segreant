# Routing

<!-- Layer 1: given what you want to do, where do you go? Identity is CLAUDE.md. -->

Find your task, read the listed files, ignore the rest. Nothing here needs the
whole tree loaded.

## Task routing

| Working on | Start at | Also read |
|---|---|---|
| Metering a request, proxy behaviour | `src/proxy/` | `src/cost/`, `src/store/CONTEXT.md` |
| Where a row's project label came from | `src/store/CONTEXT.md` | `docs/EVIDENCE-PROVENANCE.md` |
| Prices, rate cards, repricing | `src/cost/` | `pricing/`, `docs/METHODOLOGY.md` |
| Budgets, caps, alerts | `src/budget/`, `src/alerts/` | — |
| Importing tool logs | `src/connect/`, `src/cli/importCmd.ts` | `docs/INTEGRATIONS.md` |
| Provider billing, reconciliation | `src/billing/CONTEXT.md` | `docs/PROVIDER-RECONCILIATION.md` |
| Cost centres, allocation rules | `src/alloc/CONTEXT.md` | `docs/ALLOCATION.md` |
| RoI, realized value, model trials | `src/value/CONTEXT.md` | `docs/RETURN-ON-INTELLIGENCE.md`, `docs/METHODOLOGY.md` |
| The web GUI | `src/dashboard/CONTEXT.md` | `PRODUCT.md`, `docs/DESIGN-DIRECTION.md` |
| A CLI verb | `src/cli/` | `src/cli.ts` (dispatch) |
| Team rollups | `src/team/`, `team-server/` | `docs/TEAM-TIER-DESIGN.md` |
| Releasing | `docs/RELEASE-GATE.md` | `CLAUDE.md` |
| Backup/restore and recovery | `src/store/backup.ts` | `src/store/CONTEXT.md`, `docs/RELEASE-GATE.md` |
| Reliability/performance evidence | `scripts/benchmark.mjs` | `docs/RELIABILITY-PERFORMANCE.md` |

## Layer 3 — reference (stable; internalize as constraints)

Read these as rules, not as input. They change rarely and they bind everything.

| File | What it constrains |
|---|---|
| `CLAUDE.md` | The hard rules. Non-negotiable. |
| `PRODUCT.md` | Product truth: users, purpose, capabilities, principles. |
| `docs/CAPABILITY-EVIDENCE-CONTRACT.md` | Current capability/evidence status and permitted product claims. |
| `docs/DATA-BOUNDARIES.md` | What may leave the machine, and under what action. |
| `docs/EVIDENCE-PROVENANCE.md` | What each provenance label means and may claim. |
| `docs/METHODOLOGY.md` | How measurements are computed and what they do not prove. |
| `docs/THE-STANDARD.md` | The claim standard the product holds itself to. |
| `docs/ARCHITECTURE.md` | How the pieces fit. |
| `docs/DESIGN-DIRECTION.md` | The GUI's visual and interaction system. |

Runtime/source and an exact revision-bound release gate decide shipped
behaviour. PRODUCT.md is the vision and requirement source; the capability
contract is the current claim source; the roadmap is direction; vision audits
and dated release-gate rows are historical evidence at their named revision.

## Layer 4 — working artifacts (change constantly; process as input)

The ledger (`~/.fiscus/fiscus.db`, and `demo.db` beside it), imported
transcripts, provider exports, gate evidence, demo seeds. Never treated as
reference — a value in the ledger is evidence about one machine, not a rule.

## Shared invariants

These hold across every module. Violating one is a defect regardless of local
correctness.

- **Money is integer microdollars.** Never floats. Distribution uses
  largest-remainder so totals conserve exactly.
- **Derived records are immutable.** Reconciliation runs, allocation runs, and
  realization snapshots are written once and read forever. Recompute by writing a
  new record, never by mutating an old one.
- **Schema migrations are additive and guarded.** `ALTER TABLE ... ADD COLUMN`
  inside `migrate()`, with a `NOT NULL DEFAULT '<sentinel>'`. No backfill.
- **`runScript` splits SQL on `;`.** No semicolons and no backticks inside the
  `SCHEMA` template literal in `src/store/schema.ts`.
- **Demo data self-identifies.** Every payload derived from a demo seed carries
  `demo: true`. The seed may depict; it may never fabricate provider billing.

## Adding a module

1. New directory under `src/`, one job.
2. A `CONTEXT.md` stating **Consumes / Guarantees / Invariants / Verify**.
3. A row in the task-routing table above.
4. Tests in `test/`. A module with a non-obvious invariant gets a test that
   fails against the pre-fix behaviour.

Write a `CONTEXT.md` when the module has an invariant a cold reader would break.
Do not write one that restates its filenames — that costs tokens and teaches
nothing.
