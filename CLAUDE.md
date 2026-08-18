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
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/, plus web assets
```

`npx tsc` fails on this checkout's space-containing path. Use
`node ./node_modules/typescript/bin/tsc`.

## Release discipline

`docs/RELEASE-GATE.md` holds **commit-bound** gate records: ten rows, each with
real evidence (artifact digest, test totals, observed CI run). A gate record is
worth exactly what its exact candidate commit proves. Write the CI row PENDING
and fill it after observing the run — never predict it.

Do not push, publish, deploy, or purchase without explicit authorization. Local
work — commits, tests, docs, architecture, features — is expected.

## Structure

This repository follows [interpretable context structure](CONTEXT.md): module
directories carry a `CONTEXT.md` contract stating what they consume, guarantee,
and must never break. When you add a module, give it a contract and update the
routing table — do not bolt new work into an existing folder because the folder
already exists.
