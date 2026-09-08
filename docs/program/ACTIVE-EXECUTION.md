# Active Execution

**Resumption state, not history.** Historical decisions and commit-bound evidence live in `docs/program/DECISION-LOG.md` and `docs/program/EVIDENCE-INDEX.md`. This file exists to keep the next executor from repeating settled work, and it is rewritten rather than appended to.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` — never `main`, never force-pushed |
| Last CI-verified exact head | `0ebb966ca91c711657a9e1ef96d840e8e91dc1d0` — run `34173069140`, **success on all eight configured jobs** (`test` ×3, `team-server-test` ×3, `package-smoke`, `candidate-head`), inspected job by job, not by trusting the first green row. `e0cd80f` (run `34172882201`), `dfcfc87` (run `34171128690`), `ac98395` (run `34170679364`) and `6b91318` (run `34169977899`) were each verified the same way before it. |
| Code ahead of that head | `0f0811d` (WP-E06 inference-ledger wiring) and this records commit. Not verified remotely until its own exact SHA has a completed green run. |
| Local gates on the current tree | Root suite **1,678 total / 1,674 pass / 0 fail / 4 skipped**; the last suite run made deliberately under six concurrent CPU-bound processes was 1,666 / 1,662 / 0 fail, which is the standard this program now holds itself to; team-server **67/67**; all three TypeScript domains clean (root `tsconfig.json`, `src/dashboard/web/app/tsconfig.json`, `team-server/`) |
| Dossier source | `FISCUS_EXECUTION_DOSSIER_III.md` is **not in this checkout and not in git history** — it was an owner-supplied input. `docs/program/PACKET-INVENTORY.md` is the surviving mechanical enumeration of all 76 packets and is authoritative here. Do not re-derive a packet count from anything else. |

## Packet accounting

76 packets. **11 COMPLETED, 41 PARTIAL, 24 NOT_STARTED, 0 IN_PROGRESS, 0 BLOCKED_EXTERNAL, 0 SUPERSEDED.** Regenerate rather than trust this line:

```bash
grep -oE '\| `(NOT_STARTED|IN_PROGRESS|PARTIAL|COMPLETED|BLOCKED_EXTERNAL|SUPERSEDED_WITH_REASON)` \|' docs/program/PACKET-INVENTORY.md | sort | uniq -c
```

`PARTIAL` is not a nearly-finished `COMPLETED`. Every PARTIAL row names its own remainder; read the row before assuming a packet is nearly done.

## The local suite is now a deterministic gate, and it was not before

Directive item 4. Two separate defects made a full local run non-deterministic, and both were found by reproducing rather than by reasoning:

- **`test/plugins-host.test.ts` had a load-sensitive deadline** (D-154). Its shared fixture allowed 250ms of child startup for tests that spawn a real `node` child. Under twelve concurrent CPU-bound processes it failed on demand — three runs at 2, 4 and 2 failures. Every intermittent full-suite failure previously observed in this program was this file, and each time it had been set aside as "local contention", which was a description and not a diagnosis.
- **Two tests contradicted each other about the repository artifact** (D-155). `test/build-race.test.ts` asserts that an isolated build does not republish this checkout's `dist/cli.js`, defended by a comment claiming nothing else in the suite builds at ROOT. `test/egress-guidance-launcher.test.ts` ran `npm run fiscus`, whose `prefiscus` hook is `npm run build`. Running those two files together failed EVERY time with no artificial load.

Neither fix weakened an assertion; in both cases the behavioural claim was kept and the incidental dependence on the harness schedule was removed. **A full run under six CPU-bound processes is now 1,666 / 1,662 / 0 fail / 4 skipped.** If a future run is red, treat it as a finding rather than as noise — that reflex is what let both of these survive.

## Recently closed, do not redo

`WP-D06` both halves (drift silence and alert coverage, CLI and browser), `WP-H05` supply-chain audit script, `WP-I04` four accessibility defects, `WP-E06` inference ledger and precision planning, `WP-D05` measurement backing registry, `WP-I05` boundary declaration, retention consequence and receipt-chain coverage, `WP-D07` surrogate bridges, `WP-F05` decision assurance levels, `WP-R01` evidence abstract interpretation. D-140 through D-151 in the decision log carry the counterexample, the fix, and — in every case — what the fix does not establish.

One defect class now runs through six of those: **absence of a result reported as a result.** A quiet drift e-process; six structurally dark alert channels; a validation field that passed by not matching one string; a deleted receipt history; an empty receipt chain verifying vacuously and printed in green; a `proxy_validated` rung asserting a relationship nobody had recorded. Every one reported "nothing found" where the honest answer was "nothing could have been found." Expect more instances; search for the class, not the case.

The second recurring class is narrower, just as reliable, and is the dominant one: **a mechanism built and never wired.** `assessMeasurementFitness` had no caller before D-146. `measurementRegistry`, `surrogateBridgeRegistry`, the WP-E06 inference ledger and the WP-F05 assurance gate still have none — and for the assurance gate the reason is sharper than oversight: `decision.certificate` has no production caller at all, so there is no surface to wire it to. A gate that no product path passes through is an available discipline, not an enforced one, and every record here says so explicitly rather than letting PARTIAL imply otherwise.

**This is the highest-value work in the program, and three rounds of it have now been done.** D-152 moved the money-axis half of `abstract.ts` into `assessDerivationLegality`, which is what `appendDerivationWithinTransaction` actually runs, so the one collapse this repository's first line forbids is refused at the boundary that persists. D-153 gave WP-D07 its first product boundary: `src/causal/epistemic.ts` now cites a resolvable measurement model through a declared surrogate bridge and takes its rung from what they earn, which moved Fiscus's own causal claims down from `proxy_validated` to `proxy_unvalidated`. D-157 gave WP-E06 its first callers at all: `causal_inference_acts` persists the act chain, `Store.reportCausalStudy()` is the reporting boundary, and both surfaces an operator reaches go through it, so a second reading of a study no longer presents itself as the first. All three were downward moves in what the product asserts — a weaker rung, a refused re-basing, a withheld conclusion — which is what wiring an honest rule to a real caller looks like. Wire, do not build.

Of the six unwired mechanisms this round began with, three now have callers. `measurementRegistry`/`surrogateBridgeRegistry` are reached only through `src/causal/measurement.ts` — one boundary resolving its own reference, not a repository-wide registry. `analyzeDerivationChain` and the WP-F05 assurance gate still have none, and for the assurance gate the reason is structural: `decision.certificate` has no production caller at all, so there is no surface to wire it to.

## Next executable frontier

Highest value first, each stated as the boundary that is missing rather than as an area to look at:

1. **Enforce what WP-D05 and WP-D07 only made possible — one boundary is done, the general rule is not.** The causal claims now resolve their own model and bridge (D-153), but `claim()` still accepts ANY non-null `measurementModelRef` without resolving it, so the kernel's own gate is still the honour system and any other issuance boundary can repeat exactly the defect D-153 fixed. That is the next target and it belongs in `claim()` or in the ledger append path, not in another adapter. No repository-wide registry of Fiscus's models is assembled anywhere.
2. **The estimator calls that remain outside the reporting boundary.** D-157 routed the two operator-facing surfaces through `Store.reportCausalStudy()`, but `issueCausalStudyToKernel` still calls `estimateCausalStudy` directly — that one is an issuance rather than a report, so it may be right that it does not count as a look, and nothing has decided which. `saveCausalAnalysis` also calls it, on a path that cannot succeed for any input: it refuses a version-1 protocol as inspect-only and then asks `causalStudyData` for a version-2 study, which returns null by design. That dead path is a separate defect, measured here and not fixed.
3. **AII-036's three `unmigrated_authority` boundaries** — `causal.qualification`, `causal.estimate`, `decision.certificate`. The first two are in the product import closure and can reach an operator today, which sets the order.
4. **AII-025's missing gate.** The observational frontier's label is honest; no surface yet refuses to accept an observational separation as an input to an action that changes spend.
5. **The remaining AII-002 negative claims** — no provider charge, no duplicate, no policy violation — still carry no completeness requirement, and nothing yet emits a refuting witness.
6. **The chain half of `abstract.ts` is still unwired.** The money axis is done — D-152 added a `monetary_rebasing` witness kind and `assessDerivationLegality` now requires it, so the estimated-to-billed re-basing is refused where derivations persist. `analyzeDerivationChain` is still called by nothing, so a conclusion several merges downstream of its leaves is still bounded by nothing, and `BASIS_DERIVATIONS` is still empty, so neither rule knows which re-basings are sound. The next step is a caller that bounds a whole chain, not another rule.
7. **DAL2 is unreachable for quality-based claims, and that is a finding rather than a bug.** `src/decision/assurance.ts` requires at least `proxy_validated`; after D-153 no Fiscus claim about quality earns it, because nothing in this repository records an empirical association between a quality metric and the quality construct. Registering one — an independent measurement of the construct, against which a metric can be compared — is the work that would change it. Lowering the bar is not.
8. **The new witness is a declaration, not a proof.** Nothing checks that a `monetary_rebasing` witness's evidence actually supports the re-basing it licenses, only that someone recorded one — the same gap the witness registry closes for other kinds, and the same one `surrogateBridgeRegistry` was built for and nothing calls.

## Known blockers and standing constraints

- Publishing to a registry, deploying, tagging a release, merging to `main`, and any paid or public commitment are **owner-reserved**. A verification-only PR is never merged merely because it exists to trigger CI.
- Live Postgres execution and trust-anchor governance remain external for team rollups.
- `.codex/` and `.agent-worktrees/` are gitignored on purpose. Never publish either; neither is a release input.
- No credentials are retained; any encountered are `[REDACTED]`.
- `scripts/generate-plugin-contract.mjs` is untracked work in progress left by an earlier executor and has deliberately not been touched.
- Five delegated lanes were cut off mid-packet by provider rate limits. Four have since been finished by the integrator and committed — WP-D07, WP-F05 and WP-R01 in full, each with its counterexample re-measured and its RED re-verified in this tree rather than taken on the lane's report. **WP-I01 remains open and its held output is two dashboard claim-inspector test files with NO implementation**; they are outside the repository and are not work that landed. WP-E02 produced nothing at all and is still `NOT_STARTED`.
