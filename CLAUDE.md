# Fiscus — agent orientation

<!-- Layer 0: identity. Read this first, every session. Routing lives in CONTEXT.md. -->

Local-first **AI Financial Operations** layer: meter AI spend, control it,
allocate it, reconcile it against provider billing where the evidence allows, and
measure what it produced. The ledger and GUI are local by default; configured
provider traffic and other declared egress paths are governed by the
Fiscus-process boundary described in `docs/DATA-BOUNDARIES.md`. Product truth is
in [PRODUCT.md](PRODUCT.md); read it before designing anything user-facing.

## The one distinction the whole product is built on

```
metered usage  !=  provider-billed cost  !=  allocated cost  !=  realized value
```

Four different claims, four different evidence standards. **Never present one as
another.** Most defects in this repo have been a version of that collapse.

## Hard rules

1. **Every figure carries its basis.** A number that cannot say where it came
   from does not ship.
2. **Unknown stays unknown.** Provenance columns default to a sentinel
   (`legacy_unknown`) and are **never backfilled** from context — inferring
   provenance is the exact failure the column exists to prevent.
3. **Withhold rather than inflate.** State the limit in the same place as the
   result, before the user spends effort or a credential on it.
4. **Read-only by default.** Compute and preview; `--apply` persists. Preserve
   preview-then-commit as a visible step in any new surface.
5. **Budget enforcement fails closed.** Invalid persisted budget/configuration
   or an unreadable ledger must stop provider forwarding rather than silently
   becoming an unlimited or unmetered path. Dashboard settings are strict,
   bounded, and validated before persistence.
6. **Fiscus's own outbound paths are declared and policy-gated.** There is no
   hosted telemetry by default; configured provider forwarding, refreshes,
   webhooks, hosted judging, and team rollups are separate egress paths with
   explicit scope. The GUI talks to the local dashboard only — no CDN, fonts, or
   analytics — but this is not a machine-wide firewall or provider-retention
   guarantee.
7. **Zero runtime dependencies.** `typescript` and `@types/node` are the only
   devDependencies. Adding a runtime dependency is a decision, not a convenience.
8. **The repo is public.** Scan for credentials, personal data, and local
   filesystem paths before every push.

## Where the durable state lives

- `.codex/operations/PROJECT_STATE.md` — narrative state, decisions, live risks.
- `.codex/operations/TASK_LEDGER.md` — outcome-shaped tasks, `T-0NN`, with
  evidence and the stop condition for each.
- **`.codex/` is gitignored on purpose.** Never publish it. Never ship local
  orchestration state in a release.

Read both before starting substantive work. They are memory, not authority —
source files, user instruction, and verified runtime behaviour decide truth.

## Commands that matter

```bash
npm test          # node:test over test/*.test.ts — the suite is the safety net
npm run typecheck # the NODE pass only — see below
npm run build     # two compiler passes -> dist/, plus web assets
```

**There are three compilation domains and `npm run typecheck` checks one.**
`tsconfig.json` excludes `src/dashboard/web/app/**` (the browser app compiles
under its own config), and it does not see `team-server/` at all — that is a
separate npm project with its own `tsconfig.json`, its own `node_modules`, and
its own suite. Green on the root pass says nothing about the other two:

```bash
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json
cd team-server && node ./node_modules/typescript/bin/tsc --noEmit && npm test
```

`team-server/` imports root source directly (`../../src/team/rollup.ts`,
`../../src/value/receipt.ts`), so a rename anywhere in `src/team/` or
`src/value/` can break it while every root gate stays green. That has now
happened twice on CI — TS1294 at `31911cb`, sixteen TS2339/TS2353 errors at
`c1f7ac5` — both times because the local check stopped at the root. **Run the
team-server pass whenever you touch `src/value/`, `src/team/`, or anything they
export.** CI runs it on three operating systems; you should not be finding out
from CI.

`npx tsc` fails on this checkout's space-containing path. Use the explicit
`node ./node_modules/typescript/bin/tsc` form everywhere.

One file, or one test:

```bash
node --test --experimental-strip-types test/value.test.ts
node --test --experimental-strip-types --test-name-pattern="realized" test/value.test.ts
```

`npm test` runs `pretest` first (`scripts/build.mjs --web`, ~3s) because three
GUI tests read the emitted `dist/` tree rather than the source. Invoking
`node --test` on a single file skips that — rebuild first if it is one of them.

Exercising the CLI should not touch your own ledger:

```bash
# npm lifecycle hooks rebuild the checked-out dist/ before launch
FISCUS_HOME=/tmp/scratch npm run demo
FISCUS_HOME=/tmp/scratch npm run start -- --demo --dashboard-port 8621
```

`FISCUS_HOME`, `FISCUS_DB` and `FISCUS_DEMO` are the only overrides — there is
no second family and no fallback. Without one, `fiscus demo` regenerates the
real `~/.fiscus/demo.db`.

`bin/fiscus.mjs` imports `dist/cli.js`, **not** `src/`. A source edit is
invisible to it until `npm run build`. Probing a change you have not rebuilt is
the most reliable way to verify the wrong thing.

## Build and runtime topology

One compiler, two passes, no bundler (`scripts/build.mjs`):

- **node runtime** — `tsconfig.build.json` → `dist/`, which is what ships and
  what `bin/fiscus.mjs` runs.
- **browser app** — `src/dashboard/web/app/tsconfig.json`, DOM lib and no node
  types, so server code cannot reach a browser global or the reverse. Emitted
  import specifiers are rewritten to `.js`: `tsc` checks the source tree while
  the browser resolves the emitted one.

The consequence that has cost the most: **the browser app cannot import node
source, so it compiles against hand-written interfaces in
`src/dashboard/web/app/core/api.ts`.** A declaration that does not match what
the server actually sends type-checks perfectly and fails silently at runtime —
`reconciliation.runs` was declared a number while the server sends an array, so
`runs > 0` coerced through `NaN` and the Billed band of the spine could never
light up, however many reconciliations existed. Contract tests that assert
required fields are PRESENT do not catch this. When you touch a payload, check
the declaration against the wire, never against the other declaration.

Persistence is `node:sqlite` (`DatabaseSync`) directly — no ORM, no query
builder, which is what the zero-dependency rule costs and buys.

## Release discipline

`docs/RELEASE-GATE.md` holds **commit-bound** gate records: ten rows, each with
real evidence (artifact digest, test totals, observed CI run). A gate record is
worth exactly what its exact candidate commit proves. Write the CI row PENDING
and fill it after observing the run — never predict it.

**Push verified work without asking.** When a round's work is genuinely done —
suite green, build clean, nothing unresolved — pushing is part of finishing, not
a separate approval gate. Confirm the push landed by reading the remote ref
(`git ls-remote origin refs/heads/main`), not a zero exit code, and watch CI to
completion instead of assuming it. `gh run watch | tail` reports `tail`'s exit
status, so read the run's `conclusion` field.

Publishing to a registry, deploying, tagging a release, and purchasing still
need explicit authorization. So does anything genuinely uncertain: an unresolved
conflict, a failing test, or a decision that changes architecture or product
behaviour the owner has not weighed in on. Hold and flag those.

## Structure

This repository follows [interpretable context structure](CONTEXT.md): module
directories carry a `CONTEXT.md` contract stating what they consume, guarantee,
and must never break. When you add a module, give it a contract and update the
routing table — do not bolt new work into an existing folder because the folder
already exists.
