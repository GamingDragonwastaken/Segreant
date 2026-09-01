# Active Execution

Executor: Claude Opus 5 (lead implementation engineer/verifier)
Branch: `gpt56/magnum-opus-reconstruction`
Remote head at the start of this session: `359e4b96771bc19c1f94b935727778238470bc29`
Current local head: see `git rev-parse HEAD`
Active packet: WP-B03 breadth (A01–A09, B01–B03 checkpointed and remotely green)
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

- **WP-B01 — the claim-issuance map, as code.** `src/epistemic/issuance-map.ts`
  declares all twelve boundaries at which this repository creates or
  strengthens a claim, each with one of five classes of authority.
  `test/issuance-map.test.ts` reads the map and the source tree together: a
  `canonical` boundary that stops calling the kernel fails, a non-canonical one
  that starts fails, and any file under `src/` that calls `claim({...})` while
  absent from the map fails. Each module states its own class in its own
  docblock. Three boundaries are classified `unmigrated_authority` —
  `causal.qualification`, `causal.estimate`, `decision.certificate` — and the
  test asserts that list is non-empty, so emptying it requires closing AII-036
  rather than editing a list. The sweep also surfaced an AII-020 overclaim in
  the receipt docstring ("trust the claim without trusting us"), now corrected.
  See D-063 and D-064.

- **WP-B02 — the GUI's collapsed boolean is gone (AII-014).** A claim layer now
  carries `support` on four named axes instead of `established: boolean`, and
  the call sites ask `claimIsSupported`, `claimShowsFigure` and
  `claimIsSupportedButUncosted` rather than one bit. Three visible defects fell
  out of the same collapse: a Realized band with matured, shipped units and no
  labour rate read "not established"; a reconciled Billed band rendered a bare
  em dash from `usd(null)`; and held-but-unreconciled provider records were
  indistinguishable from no provider evidence. The browser's axis unions mirror
  `src/epistemic/`, and `test/claim-support-axes.test.ts` fails on drift. No
  score replaces the boolean. See D-065.

- **WP-B03 — conflict survives the gate ladder (AII-003).** A gate fed by a
  passing CI run and a failing one used to report plain `fail`, discarding the
  fact that both were observed at the gate that decides whether work realized.
  `GateResult` now carries four-valued `polarity` beside the legacy `verdict`;
  `verdictFromPolarity` is the single projection and never maps `conflicted` to
  `pass`; `FunnelOutcome.conflicts` surfaces it; terminal realization is blocked
  by the conflict condition independently of the projection; kernel issuance
  refuses with its own message; the CLI shows `!` and `conflicted:<gate>` rather
  than `✗` and `died:<gate>`; the waste rollup and the GUI separate
  contradictions from failures. `classifySession` and the outcome contract were
  checked and were already conflict-preserving. See D-066.

- **Conflict lanes beyond coding realization, assessed.** `classifySession`,
  the outcome contract and billing reconciliation were each read and found
  already conflict-preserving — the third models cross-observation
  disagreement as `snapshotStability: changed_across_observations` with the
  unstable days listed. One lane was collapsing a real conflict:
  `witnessCovers` began `if (witness.state !== 'supported') return false`, so a
  witness explicitly asserting that a source did NOT completely cover a scope
  was discarded by the same line that discards an irrelevant one, and a
  contested completeness qualified an absence inference on the supporter alone.
  Fixed, with support and refutation using opposite containment tests.
  See D-067.

## Last verified commands

Run against the WP-B01 tree:

- `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` -> pass
- `node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json` -> pass
- `cd team-server && node ./node_modules/typescript/bin/tsc --noEmit` -> pass;
  `npm test` -> 62/62. **Run this pass whenever you touch `src/value/` or
  `src/team/`** — CI found two red heads this program because the root gates
  cannot see it.
- `node scripts/build.mjs` -> pass
- full `node --test test/*.test.ts` -> 1,187 tests / 1,183 pass / 0 fail / 4 skipped

## Known residuals

- `docs/RELEASE-GATE.md` keeps eleven historical `evidence_supported` mentions.
  They are commit-bound evidence rows recording what the packaged artifact showed
  and are scoped by exact count in the sweep, not rewritten.
- The launcher copies ~2.8 MB of `dist/` on every CLI invocation. That is the
  cost of the publication-race guarantee, not a defect, but it is unmeasured.
- `test/build-race.test.ts`'s concurrent-builders case flaked on Windows with
  `EBUSY` on `generated-contract.ts` — `sourceFingerprint` read a generated
  source while a concurrent build held it for writing, which Windows fails and
  POSIX does not. `scripts/build-integrity.mjs` now retries a transient
  `EBUSY`/`EPERM` open for up to two seconds. Seven consecutive runs pass where
  it previously failed roughly one in three; that is evidence the cause was
  identified, not proof the race is gone, and CI's Windows job is the place it
  would show up again.
- AII-009/025/027 moved OPEN -> PARTIAL, not closed: each still has a downstream
  consumer requirement (composite decision-fitness, control-path refusal of
  observational input, evidence-debt planner).

## Next exact action

- AII-002's remaining scope: negative claims outside the coding `clean`
  channels. `no off-path spend` is the load-bearing one — the residual in a
  billing reconciliation is presented as unexplained variance, and nothing
  requires a completeness witness before that residual is read as absence.
- Then carry the ClaimProfile axes to the wire (AII-014's remainder), and
  migrate the three `unmigrated_authority` boundaries named in
  `docs/program/ISSUANCE-MAP.md`.
