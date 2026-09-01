# Active Execution

Executor: Claude Opus 5 (lead implementation engineer/verifier)
Branch: `gpt56/magnum-opus-reconstruction`
Remote head at the start of this session: `359e4b96771bc19c1f94b935727778238470bc29`
Current local head: see `git rev-parse HEAD`
Active packet: WP-A08 (A01–A07 checkpointed)
Status: READY

## What this session found first

The inherited tip `359e4b9` was **red on CI** (run `33439468753`, `package-smoke`),
which the previous checkpoint did not record. Root cause was not in the A06 work:
`bin/fiscus.mjs` deleted the private runtime snapshot as soon as `cliCompletion`
resolved, but `fiscus start` resolves that promise the moment its sockets are
listening and then serves for hours. A live server therefore lost its module tree
and copied package resources — `/api/overview` answered ENOENT on its own pricing
card, `/app/main.js` 404'd. Reproduced locally before any fix, then repaired.

## Completed in this session

- **Launcher snapshot lifetime.** Cleanup moved to process exit; orphaned
  snapshots are reaped by owner liveness, never by pathname. New
  `bin/runtime-snapshot.mjs`. The package-surface test now derives the required
  tarball contents from the launcher's own local imports instead of naming one
  file. Commit `404a590`; CI run `33473535818` green across all eight jobs.
- **WP-A07 — legacy value-semantic corrections.** RoI Index retyped as a
  descriptive preference-dependent composite; `θ` correctly named the CES
  substitution parameter (σ = 1/(1−θ)); lens weights are disclosed preferences,
  not fitted output elasticities; zero-collapse is an aggregator property.
  `voi.ts` → `instrumentationSensitivity.ts`, stating it is not VoI. Frontier
  `evidence_supported` → `observational_separation`. `reliability()` →
  `localDataWeight()`, James–Stein dominance claim removed, exchangeability
  documented. Enforced by pattern in the existing `public-claims-contract` sweep,
  now covering the value modules. See D-058.

## Last verified commands

- `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` -> pass
- `node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json` -> pass
- `node scripts/build.mjs` -> pass
- full `node --test test/*.test.ts` -> 1,156 tests / 1,152 pass / 0 fail / 4 skipped
- packaged-launcher probe: live `fiscus start --demo` served `overview.demo=true`,
  `summary.requests=78`, `modelSwitches=1`, `/app/main.js` HTTP 200

## Known residuals

- `docs/RELEASE-GATE.md` keeps eleven historical `evidence_supported` mentions.
  They are commit-bound evidence rows recording what the packaged artifact showed
  and are scoped by exact count in the sweep, not rewritten.
- The launcher copies ~2.8 MB of `dist/` on every CLI invocation. That is the
  cost of the publication-race guarantee, not a defect, but it is unmeasured.
- `test/build-race.test.ts`'s concurrent-builders case flaked once on Windows
  with `EBUSY` on `generated-contract.ts` — two concurrent builds contend for a
  generated source file. Pre-existing, not introduced here, and unaddressed.
- AII-009/025/027 moved OPEN -> PARTIAL, not closed: each still has a downstream
  consumer requirement (composite decision-fitness, control-path refusal of
  observational input, evidence-debt planner).

## Next exact action

- WP-A08: finish the remaining legacy value-semantic corrections — Lift /
  counterfactual bound labelling, Impact's cardinal-utility mapping,
  `realizedValueUsd` terminology split, Budget advisor scenario labelling, and
  structural-drift vs Goodhart naming. Start by inventorying the live surfaces
  for each in `src/value/lift.ts`, `src/value/drift.ts` and `src/value/report.ts`.
