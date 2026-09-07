# Active Execution

**Resumption state, not history.** Historical decisions and commit-bound evidence live in `docs/program/DECISION-LOG.md` and `docs/program/EVIDENCE-INDEX.md`. This file exists to keep the next executor from repeating settled work, and it is rewritten rather than appended to.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` — never `main`, never force-pushed |
| Last CI-verified exact head | `c9971527b00d8364ac3ed345826fb9b3e7f4c43f` — run `34110313902`, **success on all eight configured jobs** (`test` ×3, `team-server-test` ×3, `package-smoke`, `candidate-head`), inspected job by job, not by trusting the first green row |
| Code ahead of that head | `f7c3a66` (WP-I05 receipt-chain coverage) and `631558a` (WP-D07 surrogate bridges), plus this records commit. Their CI must be read on the exact pushed SHA before any of them is called verified. |
| Local gates on the current tree | Root suite **1,635 total / 1,631 pass / 0 fail / 4 skipped**; team-server **67/67**; all three TypeScript domains clean (root `tsconfig.json`, `src/dashboard/web/app/tsconfig.json`, `team-server/`) |
| Dossier source | `FISCUS_EXECUTION_DOSSIER_III.md` is **not in this checkout and not in git history** — it was an owner-supplied input. `docs/program/PACKET-INVENTORY.md` is the surviving mechanical enumeration of all 76 packets and is authoritative here. Do not re-derive a packet count from anything else. |

## Packet accounting

76 packets. **11 COMPLETED, 39 PARTIAL, 26 NOT_STARTED, 0 IN_PROGRESS, 0 BLOCKED_EXTERNAL, 0 SUPERSEDED.** Regenerate rather than trust this line:

```bash
grep -oE '\| `(NOT_STARTED|IN_PROGRESS|PARTIAL|COMPLETED|BLOCKED_EXTERNAL|SUPERSEDED_WITH_REASON)` \|' docs/program/PACKET-INVENTORY.md | sort | uniq -c
```

`PARTIAL` is not a nearly-finished `COMPLETED`. Every PARTIAL row names its own remainder; read the row before assuming a packet is nearly done.

## Recently closed, do not redo

`WP-D06` both halves (drift silence and alert coverage, CLI and browser), `WP-H05` supply-chain audit script, `WP-I04` four accessibility defects, `WP-E06` inference ledger and precision planning, `WP-D05` measurement backing registry, `WP-I05` boundary declaration, retention consequence and receipt-chain coverage, `WP-D07` surrogate bridges. D-140 through D-149 in the decision log carry the counterexample, the fix, and — in every case — what the fix does not establish.

One defect class now runs through six of those: **absence of a result reported as a result.** A quiet drift e-process; six structurally dark alert channels; a validation field that passed by not matching one string; a deleted receipt history; an empty receipt chain verifying vacuously and printed in green; a `proxy_validated` rung asserting a relationship nobody had recorded. Every one reported "nothing found" where the honest answer was "nothing could have been found." Expect more instances; search for the class, not the case.

The second recurring class is narrower and just as reliable: **a mechanism built and never wired.** `assessMeasurementFitness` had no caller before D-146. `measurementRegistry`, `surrogate.ts`, and the WP-E06 inference ledger still have none. A gate that no product path passes through is an available discipline, not an enforced one, and every record here says so explicitly rather than letting PARTIAL imply otherwise.

## Next executable frontier

Highest value first, each stated as the boundary that is missing rather than as an area to look at:

1. **Enforce what WP-D05 and WP-D07 only made possible.** `claim()` still accepts any non-null `measurementModelRef`; no production call site resolves one through `measurementRegistry` or `surrogateBridgeRegistry`; no registry of Fiscus's own models is assembled anywhere; and no surrogate bridge is declared for the two `proxy_validated` claims `src/causal/epistemic.ts` actually issues. Those two claims are the concrete first target, because they are the repository's own strongest surrogate claims and the module was written with them in view.
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
- Four delegated lanes were cut off mid-packet by provider rate limits. Their partial output is held OUTSIDE the repository, not committed, because none of it had passing tests at the point it stopped: WP-F05 (`src/decision/assurance.ts`, 530 lines, complete-looking, plus a 2-test file, needing only the `assurance` field wired into `DecisionKernelIssuanceInput`), WP-R01 (`src/epistemic/abstract.ts`, 540 lines, **no test file at all**), and WP-I01 (two dashboard claim-inspector test files with **no implementation**). WP-E02 produced nothing. WP-D07's baseline was finished by the integrator and IS committed. Treat the held files as evidence to verify, never as work that landed.
