# Active Execution

**Resumption state, not history.** Historical decisions and commit-bound evidence live in `docs/program/DECISION-LOG.md` and `docs/program/EVIDENCE-INDEX.md`. This file keeps the next agent from repeating settled work.

## Where

| | |
| --- | --- |
| Branch | `gpt56/magnum-opus-reconstruction` |
| Current code checkpoint | `cba15357c42b0c83a836d147b37a01ede4945d92` — exact remote match; documentation reconciliation is the follow-up on this code head |
| Latest exact-code CI | Run `33876114608` — **success** across all eight jobs, head `cba15357c42b0c83a836d147b37a01ede4945d92`, observed 2026-09-04 |
| Latest code tranche | Economic replay-order property: direct correction-before-close and late correction after close/reopen/reclose preserve final close identity while keeping as-of/effective projections distinct; economic glob **76/76**, root/browser TypeScript, build, and diff check passed |
| Working tree | The replay test is checkpointed and pushed; this program-record reconciliation is the only pending follow-up |
| Operating policy | One bounded slice → focused verification → compiler/build gate → one accounting update → one checkpoint. Reuse green evidence; do not repeat full suites, cleanup, or unchanged reads without a new hypothesis. |

## Completed and reusable evidence

- Published safeguard tranche `72986ad`: root lifecycle **1,406 total / 1,402 pass / 0 fail / 4 skips**; CI run `33850043162` success across all eight jobs.
- Published exact-allocation checkpoint `110b3dc`: affected economic/allocation **84/84**; all three TypeScript domains, `npm run build`, and `git diff --check` passed; CI run `33854265175` success across all eight jobs.
- Packet accounting now records bounded PARTIAL states for D01/D02/D03/E01/F02/G02/G03/G05/H03/R02 and the C04/R06 allocation-lineage, finalized-close, and replay-order advances. Do not inflate any of these to COMPLETED.

## Active frontier

**WP-C02/C04/R06 — next economic slice.** Exact allocation persistence now has source conservation and finalized-close binding, and replay ordering is pinned for the existing additive one-correction model. Remaining economic gaps are adjustment source/basis legality, adjustment-to-charge conservation beyond the covered negative cases, correction/FX supersession and rate provenance, broader historical/as-of selection, and receipt/team reconciliation.

**WP-B01/R04/R05 — parallel kernel frontier.** Generic negative claims now require complete cited Evidence over event type, target scope, and the entire interval. Direct Claim persistence has trust ceilings for integrity/authenticity/coverage. Remaining typed witness production and other negative-claim paths require new reproduction.

**WP-D/E/F/G/H — bounded foundations.** Artifact/contribution, randomized ITT registry, decision certificate, plugin/pack, trigger mutation, and preservation foundations are real but additive. Universal migration, execution hosts, runtime isolation, and external gates remain open.

## Next exact action

Investigate and reproduce adjustment-to-charge conservation or correction/FX supersession at the ledger boundary. Write one RED test, verify the intended failure, implement the smallest boundary guard, rerun only the affected economic tranche and compiler domains, then checkpoint and update these records once.

## Known blockers

- Exact root CI for the current documentation-only follow-up is not needed; the code head is already exactly CI-verified.
- Live Postgres execution and trust-anchor governance remain external for team rollups.
- No credentials are retained; any credentials encountered are `[REDACTED]`.
- The dossier is not complete: remaining packets and external gates stay explicitly open.
