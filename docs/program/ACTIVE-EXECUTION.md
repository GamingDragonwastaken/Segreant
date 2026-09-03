# Active Execution

**Resumption state, not history.** Everything that happened and why is in
`docs/program/DECISION-LOG.md` (D-001…) and `docs/program/EVIDENCE-INDEX.md`
(commit-bound rows with real CI outcomes). This file exists so a cold start can
answer six questions in one read and get to work. It grew into a narrative once;
that was the wrong shape, and the narrative was already recorded twice
elsewhere.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` |
| Last verified green head | `66ecebaa` — run `33775452465` **success, all eight jobs**, every `conclusion` read 2026-09-03 |
| Newer head | `89fd501` — run `33776671068` **failure** on `candidate-head` only, seven jobs green; a worker in the adversarial lock test was killed at the harness's 180s window, repaired at D-103 |
| Also verified green | `4eb5135` — run `33774300308` **success, all eight jobs**, which restored the base after `5e7d96b` |
| Preceding red head | `5e7d96b` — run `33760552077` **failure** on `candidate-head` and `test (windows-latest)`, six jobs green; diagnosed and repaired at D-097 |
| Next head | not yet pushed; record its run only after reading every job's `conclusion` |
| Working tree | `57d9e40` plus uncommitted WP-R05 direct-claim trust ceiling and six-test adversarial guard; not CI-verified |
| Executor | Claude Opus 5, lead implementation engineer/verifier |

`fb16a75` is the first fully green exact-head run on this branch: ubuntu, macOS
and Windows tests, three team-server jobs, package-smoke and candidate-head.
Before it the branch had been red on ubuntu for four consecutive heads.

`acd2d32` and `fb1a1ab` then failed on one test — `ordinary contention leaves no
lock residue`, killed at the harness's 180s window, on three jobs then two. Same
lock code as the green run, so it was an intermittent liveness race rather than a
regression from what either commit changed. D-085 made it deterministic and
closed it: the acquire loop's own-orphan guard was token-scoped, and the token is
minted per call, so a process could wait five minutes for a lock it had left
behind itself. `d917c33` is green on all eight jobs, including the two that had
been failing.

Four heads — `849ff91` (run `33757917634`), `d86519d` (run `33758622504`),
`a5384e2` (run `33759351886`) and `422bcd0` (run `33759829279`) — are each a
**success on all eight jobs**. `5e7d96b` then failed two of them, and on a test
this round added rather than on anything the commit changed: an empty quarantine
directory survived a sweeping acquisition because `reapOrphanQuarantines`
borrowed `lockIsStale`, whose ten-second grace for an owner-less directory
protects a creator that cannot exist at a quarantine pathname. D-097 gives the
reaper its own rule. The lock work has now cost three separate rounds — D-085,
D-092, D-097 — and all three were a rule that was correct for one state applied
to another; the protocol's states are worth reading before touching it again.

## Active packet

**WP-R05 — PARTIAL, newest uncommitted work.** Direct Claim persistence now
checks integrity, authenticity, and coverage against the weakest cited Evidence
at the unavoidable ledger boundary. Six adversarial tests cover refusal, weakest
evidence, permitted weaker claims, and idempotent replay. This is deliberately
not marked complete: completeness, construct/measurement, causality, finality,
and decision-fitness direct-claim ceilings still need a typed policy rather than
being inferred from unrelated Evidence fields.

**WP-C03 and WP-C04 — PARTIAL, and the preceding work (D-090, D-091).** One defect
class in three places: a property of a SET checked against a single member. Two
`fx_translated` events for one charge and target currency were summed by
`closeBalances` (EUR 17 for a USD 10.00 bill); `allocation_reversed` was bounded
per event so two $8.00 reversals of a $10.00 allocation closed at `allocated -6`;
and `test/build-race.test.ts` asserted the repository lock was absent, which
measured which other test file happened to hold it. All three repaired, the third
by strengthening the assertion rather than deleting it.

**WP-C02 — PARTIAL (D-089).** Adjustment kinds may no longer carry a basis no
charge can hold, so a credit cannot be recorded in a state where it nets against
nothing while the bill still reads full.

**WP-C01 — PARTIAL, audit only, no code change (D-087, corrected by D-088).**
Exact Money is a PARALLEL authority rather than the authority: thirteen
`SUM(cost_usd)` read paths answer the default surfaces and only three have exact
siblings. FX has since been audited under C03; `team-server/` and the export path
still have not been.

**WP-B05 — PARTIAL (D-086).** `admissibility.ts` and `claim-uses.ts` state bars as
per-axis predicates and return `incomparable` rather than inventing a rank. Three
of the five uses have no stated bar and are recorded as unexamined.

**WP-B04 — PARTIAL (D-084).** The countermodel engine reaches one claim: the
reconciliation residual. It reaches no other.

## Verification commands, and what each one does NOT cover

```bash
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json
cd team-server && node ./node_modules/typescript/bin/tsc --noEmit && npm test
npm test          # pretest runs the full build first
npm run build && npm pack
```

Three compilation domains; the root pass sees one. Run the team-server pass
whenever `src/value/`, `src/team/` or anything they export changes — CI has found
two red heads that way, and both times the local check had stopped at the root.

## Known blockers and open hazards

- **`/api/value` is bounded, not fast.** `gitScanBudgetMs` defaults to 20s and
  what it cannot reach reports `unknown` (D-083). On this repository that
  measures roughly one commit in forty, so the value surfaces here are mostly
  unknown — the honest state at that budget, not a fix. Caching survival per
  commit hash is the real answer. `safeRepo(null)` still falls back to the
  dashboard's launch directory, so the route mines whatever repository the
  dashboard was started in.
- **CI cannot see repository-scale defects.** `actions/checkout` is shallow, so
  a git-history cost that appears on a full clone never appears on a runner.
- **AII-036 is PARTIAL.** `decision.certificate` is still `unmigrated_authority`
  and still `unreached`; the causal pair closed at D-081.
- **AII-014 is PARTIAL.** Persisted records still carry collapsed status fields
  and no migration exists.
- The launcher copies ~2.8 MB of `dist/` per CLI invocation — the cost of the
  publication-race guarantee, unmeasured.
- One historical full-suite failure of `GUI sources: no HTML injection sink` was
  never diagnosed; four paired re-runs did not reproduce it. Publishing generated
  files by same-directory rename was tried and REVERTED (measured Windows
  `MoveFileEx` EPERM). If it is closed later the repair belongs on the reader.

## Next exact actions

1. **Finish WP-R05 from the current RED/GREEN slice.** Extend the direct-claim
   boundary only where the evidence and claim axes have a defensible typed
   relationship; do not treat monetary basis as a total-order ladder. Add RED
   tests before implementation, then run the full epistemic suite and record
   the exact result. After that, continue the C/R frontier at WP-C05 or the
   next dossier dependency, not another inventory exercise.
2. **Work the audit backlog, reproducing each finding before acting on it.** A
   parallel read-only audit produced ten probe-reproduced findings across six
   frontiers; its adversarial verifiers all died on a session limit, so NONE of
   them is independently confirmed. **All ten have now been reproduced here and
   repaired** (D-093 twice, D-094, D-095, D-096, D-098, D-099, D-100, D-101,
   D-102). Every one was probed against the running code before anything was
   changed, and three turned out to be worse than reported: the reopen defect
   bricks the ledger permanently rather than throwing once (D-100), the scoped
   push also drops `developerCount` and can hide a colleague's project behind a
   k-anonymity notice (D-101), and the cut-set contradiction errs toward
   overstating how hard a claim is to refute (D-098). The backlog from that audit
   is closed; new work needs new reproduction.
3. **Continue the C/R frontier.** `WP-C05` (billing/FOCUS interoperability) is
   the next unstarted C packet; `WP-C06` is now PARTIAL (D-095). On the R
   frontier `WP-R06` and `WP-R07` are PARTIAL (D-096, D-094) and `WP-R03`
   granularity and `WP-R04` negative-claim soundness are unstarted. `WP-R05`
   is now partial. All three state soundness properties that are
   directly falsifiable against code that already exists, which makes them
   cheaper to establish than the D/E/F frontiers that need new subsystems.
4. **C03/C04 remainders.** Neither `fx_translated` nor `price_corrected` has a
   supersession path, so a corrected rate cannot supersede a recorded translation.
   Nothing ties allocation totals to the charges they allocate. Adjustments are
   unbounded against the charge they adjust. Whether an FX translation of an
   already-corrected charge picks up the `price_corrected` delta is unexamined.
5. **WP-B05 remainder.** Three of the five uses have no stated requirement, and
   stating them is product policy rather than a derivation — `outcome_attribution`,
   `roi` and `model_recommendations` need an owner decision, not a guess.
