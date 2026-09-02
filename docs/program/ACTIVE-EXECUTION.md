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
| Last verified head | `fb16a75193e83c228fef6c97fcabd9055f6cb3bf` |
| Its CI | run `33576780336` — **success, all eight jobs**, read 2026-09-02 |
| Newer head | `acd2d3274e4daa7714b4f15e0c44233509bda4ad` — run `33630894290` **failure** on ubuntu/macOS/candidate-head, one test, repaired at D-085 |
| Working tree | see `git status`; a head newer than the row above has not been CI-verified |
| Executor | Claude Opus 5, lead implementation engineer/verifier |

`fb16a75` is the first fully green exact-head run on this branch: ubuntu, macOS
and Windows tests, three team-server jobs, package-smoke and candidate-head.
Before it the branch had been red on ubuntu for four consecutive heads.

`acd2d32` then failed on one test — `ordinary contention leaves no lock residue`,
killed at the harness's 180s window on three jobs. Same lock code as the green
run, so it was an intermittent liveness race rather than a regression from what
that commit changed. D-085 made it deterministic and closed it: the acquire
loop's own-orphan guard was token-scoped, and the token is minted per call, so a
process could wait five minutes for a lock it had left behind itself.

## Active packet

**D-085 — the lock repair is the newest work and has not been CI-verified.**
Local: the lock file is 9/9 and `ordinary contention` fell from ~17-22s to 4.4s.
Watch the exact head; do not record a row before reading the run's `conclusion`.

**WP-B04 — PARTIAL.** The countermodel engine exists and the reconciliation
residual uses it: `fiscus billing reconcile` now says that four of its five
conditions can be closed by nothing Fiscus has, and reports a negative residual
as an ESTABLISHED broken condition rather than a small number (D-084). It
reaches no other claim.

Next in the frontier order: **WP-B05** (claim-relative evidence ordering), then
mechanically select C01 from `docs/program/PACKET-INVENTORY.md`.

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

1. **WP-B04 remainder, if it is taken further.** `assessAssumptionFragility`
   reaches one claim. The candidates identified and not taken: `assessCompleteness`
   says an absence inference is unqualified without saying which period or scope
   is unwitnessed; `sourceBases` names the bases present but not which events
   carry them, and `unresolvedRequests` is a count with no list.
2. **WP-B05 — claim-relative ordering.** Needs a scoping decision first. The
   kernel is already per-axis: `assessDerivationLegality` requires a witness per
   axis and `mergeClaimProfiles` refuses to rank monetary bases. Missing: a way
   to say two profiles are INCOMPARABLE, and a claim-relative requirement
   predicate. Neither has a consumer yet, so building them first would be motion.
3. **C01** — select mechanically from `PACKET-INVENTORY.md`, not by memory.
