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

- **The residual says what it bounds (AII-002).** P = T + O, so
  R = P − L = O + (T − L), and `O ≤ R` holds exactly when the local rate-card
  estimate does not exceed the true on-path billed cost. R < 0 refutes that
  condition outright — local over-estimation has absorbed an unknown amount of
  off-path spend — yet the CLI printed `Unexplained -$3.10` and stopped, and a
  small number invites exactly one reading. `offPathBound` now travels on the
  run, in the CLI beneath the number, on the dashboard state line, and inside
  the issued Claim. See D-068.

- **The first completeness witness from a real source (AII-002).**
  `completenessWitnesses` was an option nothing but a test ever passed, so the
  machinery that lets absence become a negative claim was correct and entirely
  unexercised. Git can witness its own coverage, and the argument is exact: a
  revert is necessarily newer than what it reverts, so a scan that walked back
  from HEAD as far as a given commit has by construction seen every revert of
  it that exists in this history. The boundary is the oldest commit actually
  read — which is why a shallow clone does NOT impair this and a truncated scan
  window does. `computeRealization` now emits the witness when the caller
  supplies none. The `clean` gate is unchanged: `linked_incident` has no local
  source, so one witnessed channel out of two cannot pass it. See D-069.

- **The claim-support axes reach the wire (AII-014).** WP-B02 gave the GUI four
  named axes and left the JUDGEMENT in the browser, inferred from whatever
  collapsed field the payload carried. Every derivation was a two-branch
  ternary, so the four-valued axis could reach two values, and three defects
  followed: a reconciliation whose provider snapshots CHANGED between
  observations read as established, a window with no spend read as complete
  pricing coverage, and a residual bounding nothing (D-068) read as complete.
  All four routes now carry a required `claimSupport` derived server-side, and
  three fields the server was already sending — `snapshotStability`,
  `unstableDayStartMs`, `offPathBound` — are declared so the browser can read
  them. Making `conflicted` reachable made two existing sentences false, both
  fixed here: the spine called a contradiction "an absence of evidence", and the
  Evidence card's headline was keyed on a records-level constant that said "no
  observation run recorded" while describing one. See D-070.


- **Five repairs to one file, and the pattern is the finding (D-078).** CI at
  `0980721` failed on macOS with `EINVAL` thrown out of `renameForQuarantine`,
  killing the CLI. D-072 removed exactly this errno enumeration from the
  acquire loop and never asked where else the same mistake lived — it was three
  functions away, in the helper both paths call. The sequence is now D-071
  enumerate, D-072 replace with position (acquire path only), D-074 fix the
  self-wait D-072 introduced, D-077 the release path abandoning locks held,
  D-078 D-072's principle unapplied in the shared helper. Every repair was
  correct and every one was local. **The next thing this file needs is that
  question asked deliberately, not a sixth fix.**
- **A contention test encoded how fast the machine is (D-079).** The same run
  killed an ubuntu worker at the 90s window: eight workers at maximum rate is a
  thundering herd, and a deadline computed before spawning lets a slow child
  burn its budget on startup. Now four workers, each timing its own duration.
  Third time this session a test of mine asserted something about the hardware.
- **The release path was leaking held locks (D-077).** `releasePublicationLock`
  renames the owner record aside to claim the generation, then moves the
  directory; if that move failed it RETURNED, leaving the canonical directory
  in place carrying a token for a live PID. Nothing can recover that, so every
  contender waits `LOCK_WAIT_MS` and blames a build that finished minutes ago.
  Observed directly: the repo root held `.owner-quarantine.json` for a live PID
  across a minute while `build-race` timed out behind it at 300s, running alone.
  This is the defect D-071, D-072 and D-074 were each chasing from the acquire
  side — the process reporting the timeout was never the one that caused it.
- **`--web` had been broken for three weeks (D-076).** `node scripts/build.mjs
  --web` fails on every platform since `e00f7f9`, which put an ABSOLUTE path in
  a list `sourceFingerprint` joins onto the root. CI stayed green because
  nothing runs it: `pretest` moved to the full build at `d23245f`, and every
  other lifecycle hook was already the full build. Found by running the command
  `CLAUDE.md` claimed `pretest` used — a stale claim, now corrected. The guard
  went into `sourceFingerprint`, whose contract is what was unstated.
- **The lock waited on itself (D-074).** D-072 corrected D-071's errno list and
  introduced a worse defect in the same breath: concluding that pathname cleanup
  is unsound, it removed the created-branch cleanup entirely. But `inspectLock`
  deliberately recovers an owner from a `.owner-<token>.tmp`, so a publish that
  failed between the write and the rename left OUR token in OUR directory, and
  the next lap found an owner whose process was alive — this one — and waited
  five minutes for itself. CI `33507233437` went green on Windows and red on
  ubuntu, macOS and candidate-head with `timed out waiting for another Fiscus
  build (300000ms)`. Pathname and absence were wrong identities in opposite
  directions; the TOKEN is the right one. Three incomplete repairs of one defect
  in three commits, and the first to name an invariant instead of a symptom.
- **A residue test that measured the filesystem (D-075).** Instrumenting the
  module put a 115ms median and a 763ms maximum inside `renameForQuarantine`
  under contention, with the reaper and the recursive delete never exceeding
  50ms — so the eight-workers-by-twenty-five-cycles test was timing two hundred
  serialized critical sections, not its own claim. `896c093` measures the same,
  so it is not a regression. Now bounded by wall clock with a lap floor, and
  every child killed well below `LOCK_WAIT_MS` so a self-wait fails fast.
- **The lock decides by position, not by errno (D-071, corrected by D-072, then D-074).**
  D-071 listed the three codes Windows produces; CI then went green on Windows
  and red on macOS with a fourth, `EINVAL`. The list was a property of the
  kernel the job ran on. Once the directory is created, ANY failure to publish
  the owner record means the lock is not held — there is no error in that
  position that means otherwise — so the branch no longer inspects the code at
  all, bounded so a real permanent fault is still reported as itself. Two
  incomplete repairs in two commits, both reasoning from the error a log
  happened to show rather than from the invariant.
- **Reach is the issuance map's second axis (D-073).** Reading
  `src/decision/engine.ts` for a countermodel packet turned up that nothing
  imports it. So one of the three `unmigrated_authority` boundaries cannot reach
  an operator at all, which reorders the queue: the two causal boundaries are
  live and this one is latent. `reach` is declared on the map and checked
  against the import closure, so a boundary that gains a consumer fails until
  the map is corrected.
- **A lost lock is not a failed lock (D-071).** CI at `afca277` went red on
  Windows: `ENOENT` on `.fiscus-build.lock\.owner-<uuid>.tmp` thrown out of
  `acquirePublicationLock` and out of `bin/fiscus.mjs`, so `fiscus --help` died
  while two builds were publishing. The lock is made in two steps and carries no
  owner between them, which is indistinguishable from an abandoned one; a
  contender removing it in that window leaves the creator's write failing — and
  on Windows the same removal answers `EEXIST`, `EPERM` or `ENOENT` depending on
  exactly when the call lands. Only `EEXIST` was recognised. The pathname
  cleanup that ran afterwards was worse than the crash: it could take a fresh
  lock away from another process inside its own publish window. Both are gone.


## Last verified commands

Run against the D-077 tree:

- `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` -> pass
- `node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json` -> pass
- `cd team-server && node ./node_modules/typescript/bin/tsc --noEmit` -> pass;
  `npm test` -> 62/62. **Run this pass whenever you touch `src/value/` or
  `src/team/`** — CI found two red heads this program because the root gates
  cannot see it.
- `node scripts/build.mjs` -> pass
- root suite -> **1,219 tests / 1,215 pass / 0 fail / 4 skipped**, run as 160 files
  at default concurrency plus the 9 repo-root-lock-contending files one at a
  time. The concurrent whole-suite run is NOT a clean gate on this machine:
  `test/build-race.test.ts` runs real builds at the repo root holding the
  publication lock while four other files spawn the CLI and queue behind it,
  and at `81c20c6` that produced 8 failures locally. Splitting the run is a
  workaround for the harness, not a fix for the contention.
- `node scripts/build.mjs --web` -> exit 0 (broken since `e00f7f9`; see D-076)
- `npm pack` -> exit 0, 217 files
- `test/build-race.test.ts` 4/4 consecutive, 95-131s, no residue (it timed out
  at 369s before D-077)

## Known residuals

- `docs/RELEASE-GATE.md` keeps eleven historical `evidence_supported` mentions.
  They are commit-bound evidence rows recording what the packaged artifact showed
  and are scoped by exact count in the sweep, not rewritten.
- The launcher copies ~2.8 MB of `dist/` on every CLI invocation. That is the
  cost of the publication-race guarantee, not a defect, but it is unmeasured.
- `test/build-race.test.ts` has now failed on Windows twice, from two different
  causes. The `EBUSY` read of `generated-contract.ts` was fixed by a bounded
  retry in `scripts/build-integrity.mjs`; the `ENOENT`/`EPERM` lock crash was
  fixed in `bin/publication-lock.mjs` (D-071). Neither repair establishes what
  interleaving produced the condition — both were diagnosed from a signature in
  a CI log and reproduced by manufacturing the state directly. CI's Windows job
  remains the place a third cause would appear.
- One full-suite run failed `GUI sources: no HTML injection sink`, which walks
  `src/dashboard/web/app` while `build-race` rewrites generated files in that
  tree. Four paired re-runs did not reproduce it, and the failure was never
  diagnosed. **The window is still open.** Publishing the generated files by
  same-directory rename was tried and REVERTED: on Windows `MoveFileEx` with
  REPLACE_EXISTING fails `EPERM` while any process holds the destination open,
  so `build-race`'s two concurrent builders failed the build outright instead of
  occasionally reading a short file — measured on the first run, not predicted.
  A trade of a rare short read for a reliable hard failure is not a fix. If it
  is closed later the repair belongs on the READER, as it already does in
  `scripts/build-integrity.mjs`, whose bounded retry exists for this same tree;
  the one observed failure was a read that errored rather than one that was
  short.
- AII-009/025/027 moved OPEN -> PARTIAL, not closed: each still has a downstream
  consumer requirement (composite decision-fitness, control-path refusal of
  observational input, evidence-debt planner).

## Next exact action

- Migrate `causal.qualification`, then `causal.estimate`. They are the two
  `unmigrated_authority` boundaries the product actually reaches (D-073), and
  the first is the observational-to-causal boundary — the largest claim
  strengthening in the product. Closing it means the qualification issues a
  canonical Claim whose Derivation legality refuses causal strengthening
  without a committed protocol and an assignment witness, so that revoking the
  assignment evidence invalidates the result.
- WP-B04 (countermodels) should target a domain the product reaches. The
  decision engine does not qualify — nothing imports it. The live candidates
  are completeness gaps (`assessCompleteness` says an absence inference is
  unqualified without saying which period or scope is unwitnessed) and
  economic basis compatibility (`sourceBases` names the bases present but not
  which events carry them, and `unresolvedRequests` is a count with no list).
- WP-B05 needs a scoping decision first. The kernel is already per-axis:
  `assessDerivationLegality` requires a witness per axis and `mergeClaimProfiles`
  refuses to rank monetary bases. What is missing is a way to say two profiles
  are INCOMPARABLE and a claim-relative requirement predicate — neither of
  which has a consumer yet, so building them first would be motion.
- The wire carries FOUR of `ClaimProfile`'s nine axes, chosen because the GUI
  reads four. Decide whether it carries the full profile or whether four is
  the honest surface, and write the reason down either way.
- Persisted records still carry collapsed status fields, which is the
  remainder of AII-014 after D-070.
