# Active Execution

**Resumption state, not history.** Historical decisions and commit-bound evidence live in `docs/program/DECISION-LOG.md` and `docs/program/EVIDENCE-INDEX.md`. This file exists to keep the next executor from repeating settled work, and it is rewritten rather than appended to.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` — never `main`, never force-pushed |
| Last CI-verified exact head | `866ca465c3e1e973e6070ad7893c5781ef052eef` — run `34087143458`, **success on all eight configured jobs** (`test` ×3, `team-server-test` ×3, `package-smoke`, `candidate-head`), inspected job by job, not by trusting the first green row |
| Code ahead of that head | `e3a27b9` (WP-D05 measurement backing) and `17fdadd` (WP-I05 boundary declaration and retention consequence), plus this records commit. Their CI must be read on the exact pushed SHA before either is called verified. |
| Local gates on the current tree | Root suite **1,599 total / 1,595 pass / 0 fail / 4 skipped**; team-server **67/67**; all three TypeScript domains clean (root `tsconfig.json`, `src/dashboard/web/app/tsconfig.json`, `team-server/`) |
| Dossier source | `FISCUS_EXECUTION_DOSSIER_III.md` is **not in this checkout and not in git history** — it was an owner-supplied input. `docs/program/PACKET-INVENTORY.md` is the surviving mechanical enumeration of all 76 packets and is authoritative here. Do not re-derive a packet count from anything else. |

## Packet accounting

76 packets. **11 COMPLETED, 38 PARTIAL, 27 NOT_STARTED, 0 IN_PROGRESS, 0 BLOCKED_EXTERNAL, 0 SUPERSEDED.** Regenerate rather than trust this line:

```bash
grep -oE '\| `(NOT_STARTED|IN_PROGRESS|PARTIAL|COMPLETED|BLOCKED_EXTERNAL|SUPERSEDED_WITH_REASON)` \|' docs/program/PACKET-INVENTORY.md | sort | uniq -c
```

`PARTIAL` is not a nearly-finished `COMPLETED`. Every PARTIAL row names its own remainder; read the row before assuming a packet is nearly done.

## Recently closed, do not redo

`WP-D06` both halves (drift silence and alert coverage, CLI and browser), `WP-H05` supply-chain audit script, `WP-I04` four accessibility defects, `WP-E06` inference ledger and precision planning, `WP-D05` measurement backing registry, `WP-I05` boundary declaration and retention consequence. D-140 through D-147 in the decision log carry the counterexample, the fix, and — in every case — what the fix does not establish.

One defect class ran through four of those: **absence of a result reported as a result.** A quiet drift e-process, six structurally dark alert channels, a validation field that passed by not matching one string, and a deleted receipt history all reported "nothing found" where the honest answer was "nothing could have been found." Expect more instances; search for the class, not the case.

## Next executable frontier

Highest value first, each stated as the boundary that is missing rather than as an area to look at:

1. **Enforce what WP-D05 only made possible.** `claim()` still accepts any non-null `measurementModelRef`; no production call site resolves one through `measurementRegistry`, and no registry of Fiscus's own models is assembled anywhere. The mechanism exists and nothing uses it.
2. **WP-E06's same gap.** The CLI, dashboard and store call `estimateCausalStudy` directly, so every multiplicity count is a lower bound and the ledger is an available discipline rather than an enforced one.
3. **AII-036's three `unmigrated_authority` boundaries** — `causal.qualification`, `causal.estimate`, `decision.certificate`. The first two are in the product import closure and can reach an operator today, which sets the order.
4. **AII-025's missing gate.** The observational frontier's label is honest; no surface yet refuses to accept an observational separation as an input to an action that changes spend.
5. **The remaining AII-002 negative claims** — no provider charge, no duplicate, no policy violation — still carry no completeness requirement, and nothing yet emits a refuting witness.

## Known blockers and standing constraints

- Publishing to a registry, deploying, tagging a release, merging to `main`, and any paid or public commitment are **owner-reserved**. A verification-only PR is never merged merely because it exists to trigger CI.
- Live Postgres execution and trust-anchor governance remain external for team rollups.
- `.codex/` and `.agent-worktrees/` are gitignored on purpose. Never publish either; neither is a release input.
- No credentials are retained; any encountered are `[REDACTED]`.
- `scripts/generate-plugin-contract.mjs` is untracked work in progress left by an earlier executor and has deliberately not been touched.
