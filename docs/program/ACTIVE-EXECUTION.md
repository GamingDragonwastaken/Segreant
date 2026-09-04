# Active Execution

**Resumption state, not history.** Historical decisions and commit-bound evidence live in `docs/program/DECISION-LOG.md` and `docs/program/EVIDENCE-INDEX.md`. This file keeps the next agent from repeating settled work.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` |
| Current code checkpoint | `1698ed24102197a37cc89a30147b06c7cec6c783` — exact remote match; correction occurrence, value-claim, plugin, database-integrity and exact-reconciliation safeguards are included |
| Latest exact-code CI | Run `33919980843` — **success** across all eight configured jobs, head `1698ed24102197a37cc89a30147b06c7cec6c783`, observed 2026-09-04 |
| Latest code tranche | Correction chains now enforce occurrence-domain identity; value claims use typed persisted supersession; OutcomeAdapters have an allowlisted digest-checked registry and explicit invocation refusals; critical append-only triggers are checked; exact Money reaches Store billing reconciliation. Root lifecycle **1,464 total / 1,460 pass / 0 fail / 4 skips**, team-server **67/67**, root/browser TypeScript, build, and diff check passed |
| Working tree | The code checkpoint is pushed and remotely green; the program records below are the only pending follow-up |
| Operating policy | One bounded slice → focused verification → compiler/build gate → one accounting update → one checkpoint. Reuse green evidence; do not repeat full suites, cleanup, or unchanged reads without a new hypothesis. |

## Completed and reusable evidence

- Published safeguard tranche `72986ad`: root lifecycle **1,406 total / 1,402 pass / 0 fail / 4 skips**; CI run `33850043162` success across all eight jobs.
- Published exact-allocation checkpoint `110b3dc`: affected economic/allocation **84/84**; all three TypeScript domains, `npm run build`, and `git diff --check` passed; CI run `33854265175` success across all eight jobs.
- Packet accounting now records bounded PARTIAL states for D01/D02/D03/E01/F02/G02/G03/G05/H03/R02 and the C04/R06 allocation-lineage, finalized-close, and replay-order advances. Do not inflate any of these to COMPLETED.

## Active frontier

**WP-C02/C04/R06 — next economic slice.** Exact allocation persistence now has source conservation, finalized-close binding, and validated multi-hop correction-chain root resolution, replay ordering is pinned, `usage_observed` is refused as a monetary event/allocation source, local price corrections enforce source occurrence identity, and historical FX selection can be composed with corrected effective charges without changing raw close history. Remaining economic gaps are per-link basis agreement, role auditing, adjustment-to-charge conservation beyond the covered negative cases, provider FX authority, finalized-close policy for later corrections, receipt/team reconciliation, and recovery from the bricked ledger state.

**WP-B01/R04/R05 — parallel kernel frontier.** Generic negative claims now require complete cited Evidence over event type, target scope, and the entire interval. Direct Claim persistence has trust ceilings for integrity/authenticity/coverage. Remaining typed witness production and other negative-claim paths require new reproduction.

**WP-D/E/F/G/H — bounded foundations.** Artifact/contribution, randomized ITT registry, decision certificate, allowlisted OutcomeAdapter/plugin invocation, database trigger mutation, and preservation foundations are real but additive. Universal migration, executable hosts, runtime isolation, and external gates remain open.

## Next exact action

Investigate one remaining executable frontier: provider-authoritative FX/receipt dependency binding, signed `.fiscuspack` execution, or causal/decision-control migration. Write one RED test for the highest-value unsatisfied boundary, implement the smallest fail-closed change, rerun only the affected domains, then checkpoint and update these records once.

## Known blockers

- The initial usage-role implementation head `c023e913` failed cross-platform CI because of a stale fixture; corrective head `320bf064` is the exact remotely green code checkpoint.
- Live Postgres execution and trust-anchor governance remain external for team rollups.
- No credentials are retained; any credentials encountered are `[REDACTED]`.
- The dossier is not complete: remaining packets and external gates stay explicitly open.
