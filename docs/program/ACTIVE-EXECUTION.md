# Active Execution

**Resumption state, not history.** Historical decisions and commit-bound evidence live in `docs/program/DECISION-LOG.md` and `docs/program/EVIDENCE-INDEX.md`. This file exists to keep the next executor from repeating settled work, and it is rewritten rather than appended to.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` — never `main`, never force-pushed |
| Last CI-verified exact head | `6b913183ed1d95e9c440a076ffbddcfd378d8942` — run `34169977899`, **success on all eight configured jobs** (`test` ×3, `team-server-test` ×3, `package-smoke`, `candidate-head`), inspected job by job, not by trusting the first green row |
| Code ahead of that head | `f7c3a66` (WP-I05 receipt-chain coverage), `631558a` (WP-D07 surrogate bridges), `b8d0620` (WP-F05 decision assurance levels), `fb259f5` (WP-R01 evidence abstract interpretation), plus this records commit. None is verified remotely until its own exact SHA has a completed green run. |
| Local gates on the current tree | Root suite **1,654 total / 1,650 pass / 0 fail / 4 skipped**; team-server **67/67**; all three TypeScript domains clean (root `tsconfig.json`, `src/dashboard/web/app/tsconfig.json`, `team-server/`) |
| Dossier source | `FISCUS_EXECUTION_DOSSIER_III.md` is **not in this checkout and not in git history** — it was an owner-supplied input. `docs/program/PACKET-INVENTORY.md` is the surviving mechanical enumeration of all 76 packets and is authoritative here. Do not re-derive a packet count from anything else. |

## Packet accounting

76 packets. **11 COMPLETED, 41 PARTIAL, 24 NOT_STARTED, 0 IN_PROGRESS, 0 BLOCKED_EXTERNAL, 0 SUPERSEDED.** Regenerate rather than trust this line:

```bash
grep -oE '\| `(NOT_STARTED|IN_PROGRESS|PARTIAL|COMPLETED|BLOCKED_EXTERNAL|SUPERSEDED_WITH_REASON)` \|' docs/program/PACKET-INVENTORY.md | sort | uniq -c
```

`PARTIAL` is not a nearly-finished `COMPLETED`. Every PARTIAL row names its own remainder; read the row before assuming a packet is nearly done.

## Recently closed, do not redo

`WP-D06` both halves (drift silence and alert coverage, CLI and browser), `WP-H05` supply-chain audit script, `WP-I04` four accessibility defects, `WP-E06` inference ledger and precision planning, `WP-D05` measurement backing registry, `WP-I05` boundary declaration, retention consequence and receipt-chain coverage, `WP-D07` surrogate bridges, `WP-F05` decision assurance levels, `WP-R01` evidence abstract interpretation. D-140 through D-151 in the decision log carry the counterexample, the fix, and — in every case — what the fix does not establish.

One defect class now runs through six of those: **absence of a result reported as a result.** A quiet drift e-process; six structurally dark alert channels; a validation field that passed by not matching one string; a deleted receipt history; an empty receipt chain verifying vacuously and printed in green; a `proxy_validated` rung asserting a relationship nobody had recorded. Every one reported "nothing found" where the honest answer was "nothing could have been found." Expect more instances; search for the class, not the case.

The second recurring class is narrower, just as reliable, and now the dominant one: **a mechanism built and never wired.** `assessMeasurementFitness` had no caller before D-146. `measurementRegistry`, `surrogateBridgeRegistry`, `abstract.ts`, the WP-E06 inference ledger and the WP-F05 assurance gate still have none — and for the assurance gate the reason is sharper than oversight: `decision.certificate` has no production caller at all, so there is no surface to wire it to. A gate that no product path passes through is an available discipline, not an enforced one, and every record here says so explicitly rather than letting PARTIAL imply otherwise.

**This is now the highest-value work in the program.** Six packets have built rules that nothing runs. The next round should wire, not build.

## Next executable frontier

Highest value first, each stated as the boundary that is missing rather than as an area to look at:

1. **Enforce what WP-D05 and WP-D07 only made possible.** `claim()` still accepts any non-null `measurementModelRef`; no production call site resolves one through `measurementRegistry` or `surrogateBridgeRegistry`; no registry of Fiscus's own models is assembled anywhere; and no surrogate bridge is declared for the two `proxy_validated` claims `src/causal/epistemic.ts` actually issues. Those two claims are the concrete first target, because they are the repository's own strongest surrogate claims and the module was written with them in view.
2. **WP-E06's same gap.** The CLI, dashboard and store call `estimateCausalStudy` directly, so every multiplicity count is a lower bound and the ledger is an available discipline rather than an enforced one.
3. **AII-036's three `unmigrated_authority` boundaries** — `causal.qualification`, `causal.estimate`, `decision.certificate`. The first two are in the product import closure and can reach an operator today, which sets the order.
4. **AII-025's missing gate.** The observational frontier's label is honest; no surface yet refuses to accept an observational separation as an input to an action that changes spend.
5. **The remaining AII-002 negative claims** — no provider charge, no duplicate, no policy violation — still carry no completeness requirement, and nothing yet emits a refuting witness.
6. **The money axis has no derivation rule.** Measured at D-151: a derivation from `monetaryBasis: 'estimated'` to `'billed'` is `allowed: true` with zero required witnesses, and the ledger stores it, because `assessDerivationLegality` iterates `PROFILE_STRENGTH_AXES` and that axis has no ladder to appear in. `abstract.ts` refuses it and nothing calls `abstract.ts`. Wiring `analyzeDerivationChain` — or just the monetary check — into `appendDerivationWithinTransaction` is the single highest-leverage wiring available, because it closes the one collapse this repository's first line forbids.

## Known blockers and standing constraints

- Publishing to a registry, deploying, tagging a release, merging to `main`, and any paid or public commitment are **owner-reserved**. A verification-only PR is never merged merely because it exists to trigger CI.
- Live Postgres execution and trust-anchor governance remain external for team rollups.
- `.codex/` and `.agent-worktrees/` are gitignored on purpose. Never publish either; neither is a release input.
- No credentials are retained; any encountered are `[REDACTED]`.
- `scripts/generate-plugin-contract.mjs` is untracked work in progress left by an earlier executor and has deliberately not been touched.
- Five delegated lanes were cut off mid-packet by provider rate limits. Four have since been finished by the integrator and committed — WP-D07, WP-F05 and WP-R01 in full, each with its counterexample re-measured and its RED re-verified in this tree rather than taken on the lane's report. **WP-I01 remains open and its held output is two dashboard claim-inspector test files with NO implementation**; they are outside the repository and are not work that landed. WP-E02 produced nothing at all and is still `NOT_STARTED`.
