# Active Execution

**Resumption state, not history.** Historical decisions and commit-bound evidence live in `docs/program/DECISION-LOG.md` and `docs/program/EVIDENCE-INDEX.md`. This file keeps the next agent from repeating settled work.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` |
| Current code checkpoint | `657140f8dea01b3cbc0f12b2e0e039eb8a1c6141` — exact remote match; historical-rate selection and corrected-charge FX read-model integration are preserved in this checkpoint |
| Latest exact-code CI | Run `33899895572` — **success** across all configured jobs, head `657140f8dea01b3cbc0f12b2e0e039eb8a1c6141`, observed 2026-09-04 |
| Latest code tranche | Historical rate books now validate interval-covered observations, explicit supersession and deterministic as-of selection; corrected effective charges can be translated through a caller-supplied rate book without rewriting raw events or close digests; focused rate-selection/correction-FX-close **5/5**, full economic glob **89/89**, root lifecycle **1,437 total / 1,433 pass / 0 fail / 4 skips**, team-server **67/67**, root/browser TypeScript, build, and diff check passed |
| Working tree | The code checkpoint is pushed and remotely green; this program-record reconciliation is the only pending follow-up |
| Operating policy | One bounded slice → focused verification → compiler/build gate → one accounting update → one checkpoint. Reuse green evidence; do not repeat full suites, cleanup, or unchanged reads without a new hypothesis. |

## Completed and reusable evidence

- Published safeguard tranche `72986ad`: root lifecycle **1,406 total / 1,402 pass / 0 fail / 4 skips**; CI run `33850043162` success across all eight jobs.
- Published exact-allocation checkpoint `110b3dc`: affected economic/allocation **84/84**; all three TypeScript domains, `npm run build`, and `git diff --check` passed; CI run `33854265175` success across all eight jobs.
- Packet accounting now records bounded PARTIAL states for D01/D02/D03/E01/F02/G02/G03/G05/H03/R02 and the C04/R06 allocation-lineage, finalized-close, and replay-order advances. Do not inflate any of these to COMPLETED.

## Active frontier

**WP-C02/C04/R06 — next economic slice.** Exact allocation persistence now has source conservation and finalized-close binding, replay ordering is pinned, `usage_observed` is refused as a monetary event/allocation source, local price corrections form a typed append-only chain, and historical FX selection can be composed with corrected effective charges without changing raw close history. Remaining economic gaps are per-link basis agreement, role auditing, adjustment-to-charge conservation beyond the covered negative cases, persisted rate-registry/read-model integration, provider FX authority, finalized-close policy for later corrections, receipt/team reconciliation, and recovery from the bricked ledger state.

**WP-B01/R04/R05 — parallel kernel frontier.** Generic negative claims now require complete cited Evidence over event type, target scope, and the entire interval. Direct Claim persistence has trust ceilings for integrity/authenticity/coverage. Remaining typed witness production and other negative-claim paths require new reproduction.

**WP-D/E/F/G/H — bounded foundations.** Artifact/contribution, randomized ITT registry, decision certificate, plugin/pack, trigger mutation, and preservation foundations are real but additive. Universal migration, execution hosts, runtime isolation, and external gates remain open.

## Next exact action

Investigate persisted historical-rate ownership and downstream export/read-model consumers. Write one RED test for a rate-book persistence or export invariant that is genuinely absent, implement the smallest boundary integration, rerun only the affected economic and compiler domains, then checkpoint and update these records once.

## Known blockers

- The initial usage-role implementation head `c023e913` failed cross-platform CI because of a stale fixture; corrective head `320bf064` is the exact remotely green code checkpoint.
- Live Postgres execution and trust-anchor governance remain external for team rollups.
- No credentials are retained; any credentials encountered are `[REDACTED]`.
- The dossier is not complete: remaining packets and external gates stay explicitly open.
