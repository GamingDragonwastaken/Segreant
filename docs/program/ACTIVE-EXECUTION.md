# Active Execution

**Resumption state, not history.** Historical decisions and commit-bound evidence live in `docs/program/DECISION-LOG.md` and `docs/program/EVIDENCE-INDEX.md`. This file keeps the next agent from repeating settled work.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` |
| Current code checkpoint | `7cb630d8cc97d1de286147594aeca1aead629efb` — exact remote match; the preceding usage-role correction and its stale-fixture repair remain preserved in history |
| Latest exact-code CI | Run `33890709112` — **success** across all configured jobs, head `7cb630d8cc97d1de286147594aeca1aead629efb`, observed 2026-09-04 |
| Latest code tranche | Economic price-correction chains: typed linear predecessor links, exact per-link deltas, append/read closure validation, as-of effective-chain projection, and raw-event tamper refusal; chain **2/2**, full economic glob **80/80**, root lifecycle **1,428 total / 1,424 pass / 0 fail / 4 skips**, team-server **67/67**, root/browser TypeScript, build, and diff check passed |
| Working tree | The chain checkpoint is pushed and remotely green; this program-record reconciliation is the only pending follow-up |
| Operating policy | One bounded slice → focused verification → compiler/build gate → one accounting update → one checkpoint. Reuse green evidence; do not repeat full suites, cleanup, or unchanged reads without a new hypothesis. |

## Completed and reusable evidence

- Published safeguard tranche `72986ad`: root lifecycle **1,406 total / 1,402 pass / 0 fail / 4 skips**; CI run `33850043162` success across all eight jobs.
- Published exact-allocation checkpoint `110b3dc`: affected economic/allocation **84/84**; all three TypeScript domains, `npm run build`, and `git diff --check` passed; CI run `33854265175` success across all eight jobs.
- Packet accounting now records bounded PARTIAL states for D01/D02/D03/E01/F02/G02/G03/G05/H03/R02 and the C04/R06 allocation-lineage, finalized-close, and replay-order advances. Do not inflate any of these to COMPLETED.

## Active frontier

**WP-C02/C04/R06 — next economic slice.** Exact allocation persistence now has source conservation and finalized-close binding, replay ordering is pinned, `usage_observed` is refused as a monetary event/allocation source, and local price corrections form a typed append-only chain. Remaining economic gaps are per-link basis agreement, role auditing, adjustment-to-charge conservation beyond the covered negative cases, FX-rate supersession and provenance, corrected-charge-to-FX composition, broader historical/as-of selection, finalized-close policy for later corrections, receipt/team reconciliation, and recovery from the bricked ledger state.

**WP-B01/R04/R05 — parallel kernel frontier.** Generic negative claims now require complete cited Evidence over event type, target scope, and the entire interval. Direct Claim persistence has trust ceilings for integrity/authenticity/coverage. Remaining typed witness production and other negative-claim paths require new reproduction.

**WP-D/E/F/G/H — bounded foundations.** Artifact/contribution, randomized ITT registry, decision certificate, plugin/pack, trigger mutation, and preservation foundations are real but additive. Universal migration, execution hosts, runtime isolation, and external gates remain open.

## Next exact action

Investigate and reproduce FX-rate provenance/as-of selection or per-link basis agreement at the ledger boundary. Write one RED test, verify the intended failure, implement the smallest boundary guard, rerun only the affected economic tranche and compiler domains, then checkpoint and update these records once.

## Known blockers

- The initial usage-role implementation head `c023e913` failed cross-platform CI because of a stale fixture; corrective head `320bf064` is the exact remotely green code checkpoint.
- Live Postgres execution and trust-anchor governance remain external for team rollups.
- No credentials are retained; any credentials encountered are `[REDACTED]`.
- The dossier is not complete: remaining packets and external gates stay explicitly open.
