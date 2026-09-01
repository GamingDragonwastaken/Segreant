# Active Execution

Executor: Claude Opus 5 (lead implementation engineer/verifier)
Branch: `gpt56/magnum-opus-reconstruction`
Remote head at the start of this session: `359e4b96771bc19c1f94b935727778238470bc29`
Current local head: see `git rev-parse HEAD`
Active packet: WP-A09 (A01–A08 checkpointed; A09 in flight)
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
- **WP-A08 — the remaining legacy value semantics.** Four arbitrary constants
  became declared, overridable models with a stated basis: `DECLARED_REACH_UTILITY`
  (AII-011) replaces an inline `shipped ? 1 : merged ? 0.75 : 0.5` ternary and now
  reports itself through `impactHow`; `DECLARED_LIFT_FLOOR_FRACTION` (AII-010) is
  named, and lift bounds carry `lowBasis` / `highBasis` so a partially identified
  set is never confused with a disclosed scenario band. The budget advisor is
  relabelled a heuristic scenario generator rather than an optimizer (AII-026).
  The rate-drift alarm no longer claims to detect Goodharting: it tests that a
  rate is not constant, and says so. See D-059.
- **WP-A08 tranche two — the `realizedValueUsd` split (AII-012).** One identifier
  named a cost on one payload branch and a value on the other, which is how the
  value spine came to render a cost as the fourth claim in
  `metered != billed != allocated != realized value` while every contract test
  passed. Now `spendOnRealizedUnitsUsd` / `acceptanceWeightedSpendUsd` /
  `totalSpendOnRealizedUnitsUsd` for cost and `manualEquivalentValueUsd` for
  value, with both old identifiers banned repo-wide in `src/` by a test that
  walks the tree. Commit `c1f7ac5`. See D-060.
- **WP-A07 — legacy value-semantic corrections.** RoI Index retyped as a
  descriptive preference-dependent composite; `θ` correctly named the CES
  substitution parameter (σ = 1/(1−θ)); lens weights are disclosed preferences,
  not fitted output elasticities; zero-collapse is an aggregator property.
  `voi.ts` → `instrumentationSensitivity.ts`, stating it is not VoI. Frontier
  `evidence_supported` → `observational_separation`. `reliability()` →
  `localDataWeight()`, James–Stein dominance claim removed, exchangeability
  documented. Enforced by pattern in the existing `public-claims-contract` sweep,
  now covering the value modules. See D-058.

- **WP-A09 — program evidence reconciled to the corrective frontier.** Read
  every GitHub Actions run identifier cited in `docs/program/` and
  `docs/RELEASE-GATE.md` and recorded its actual conclusion. Two checkpoints had
  described a gate in the future tense and never returned to it; **both of those
  runs had concluded FAILURE** (`33432485480` at WP-A04, `33433809771` at
  WP-A05, both the team-server TS1294). Every other cited run was verified
  success. `test/program-evidence-contract.test.ts` now requires a stated
  outcome beside every cited run and forbids predicting one. See D-061.
- **WP-A09 — the split crosses into `team-server/`.** CI at `c1f7ac5` was red:
  sixteen TS2339/TS2353 errors in a third compilation domain the root typecheck
  cannot see. The value/cost split now covers `team-server/` TypeScript, its SQL
  aliases and its two stored `rollup_projects` columns; the identifier ban walks
  `team-server/`; `CLAUDE.md` records the three-domain rule. See D-062.

## Last verified commands

Run against the WP-A08 tree, immediately before commit `c1f7ac5`:

- `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` -> pass
- `node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json` -> pass
- `node scripts/build.mjs` -> pass
- full `node --test test/*.test.ts` -> 1,159 tests / 1,155 pass / 0 fail / 4 skipped
- `npm pack --dry-run` -> exit 0
- live wire probe against `fiscus start --demo`, because `classic.html` is
  untyped and a declaration cannot prove what the server sends:
  `matured.spendOnRealizedUnitsUsd = 17.23`,
  `matured.acceptanceWeightedSpendUsd = 15.1052`,
  `returnRatio.manualEquivalentValueUsd = 3351.6`; zero occurrences of either
  banned identifier in the served payload, in `/classic` (179,442 bytes) or in
  `/app/core/claimLayers.js` beyond one explanatory comment.

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

- WP-A09 is closed: commit `0497b0e`, exact-head run `33478486392` concluded
  success across all eight jobs, and its `PENDING` evidence row was filled from
  the observed conclusion rather than left for the next reader.
- Frontier B in dependency order: WP-B01 universal issuance legality (in
  progress — the issuance map and its enforcement), then WP-B02 (remove
  `established:boolean`, AII-014).
