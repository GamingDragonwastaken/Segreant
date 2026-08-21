# Fiscus — agent orientation

<!-- Layer 0: identity. Read this first, every session. Routing lives in CONTEXT.md. -->

Local-first **AI Financial Operations** layer: meter AI spend, control it,
allocate it, reconcile it against provider billing where the evidence allows, and
measure what it produced. Runs entirely on the operator's machine. Product truth
is in [PRODUCT.md](PRODUCT.md); read it before designing anything user-facing.

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
5. **Nothing leaves the machine** without an explicit, informed action. No hidden
   telemetry, no egress, no credential forwarding. The GUI makes **zero external
   network requests** — no CDN, no fonts, no analytics.
6. **Zero runtime dependencies.** `typescript` and `@types/node` are the only
   devDependencies. Adding a runtime dependency is a decision, not a convenience.
7. **The repo is public.** Scan for credentials, personal data, and local
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

**`npm run typecheck` does not check the GUI.** `tsconfig.json` excludes
`src/dashboard/web/app/**`, because the browser app compiles under its own
config. A dashboard change needs both passes, and green on the first says
nothing about the second:

```bash
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json
```

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
FISCUS_HOME=/tmp/scratch node bin/fiscus.mjs demo
FISCUS_HOME=/tmp/scratch node bin/fiscus.mjs start --demo --dashboard-port 8621
```

`FISCUS_HOME`, `FISCUS_DB` and `FISCUS_DEMO` are the overrides (`AEGIS_*` are
legacy aliases, still honoured, outranked). Without one, `fiscus demo`
regenerates the real `~/.aegisflow/demo.db`.

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
