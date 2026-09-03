# Dossier packet inventory

Mechanically extracted from `FISCUS_EXECUTION_DOSSIER_III.md` — **76 packets**, not
the fourteen a previous round reported. That error came from grepping
`^## WP-[AB][0-9]{2}`, which filters to the A and B frontiers, and then reporting
the filter's output as the dossier's contents. Regenerate rather than edit by hand:

```bash
grep -cE '^## WP-[A-Z][0-9]{2}' FISCUS_EXECUTION_DOSSIER_III.md   # -> 76
```

States: `NOT_STARTED` `IN_PROGRESS` `PARTIAL` `COMPLETED` `BLOCKED_EXTERNAL`
`SUPERSEDED_WITH_REASON`. Every packet carries exactly one.

| Packet | Subject | State | Evidence / remainder |
|---|---|---|---|
| `WP-A01` | Make perfect-information VoI probabilistically coherent | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-A02` | Separate exact-head CI from synthetic merge-ref CI | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-A03` | Replace the coding `clean` closed-world inference with completeness-gated semantics | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-A04` | Bound every consequential proxy/capture buffer and make truncation epistemically visible | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-A05` | Make model attribution/ranking use one exact economic authority | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-A06` | Repair joint causal cost-quality inference | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-A07` | Correct remaining legacy RoI/frontier/reliability overclaims | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-A08` | Finish the remaining legacy value-semantic corrections | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-A09` | Reconcile program evidence after the corrective frontier | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-B01` | Universal issuance legality at claim-strengthening boundaries | `PARTIAL` | `assessDerivationLegality` is wired into `EpistemicLedger.appendDerivation`, and `causal.issuance` closed the two `product`-reaching boundaries: the causal pair is now `kernel_primitive` and the effect claim is bound by a Derivation to the randomization that identifies it (D-081). `decision.certificate` remains `unmigrated_authority`, and remains `unreached`. |
| `WP-B02` | Remove alternate `established:boolean` and trust-score semantics | `PARTIAL` | `established:boolean` removed; the wire now carries the whole ten-axis `ClaimProfilePayload` and the spine reads a projection of it, not a second opinion (D-082). No score, no derived boolean. Persisted records still carry collapsed status fields with no migration — the AII-014 remainder. |
| `WP-B03` | Conflict-preserving adapters everywhere | `COMPLETED` | Checkpointed and remotely green at or before `896c093`; see DECISION-LOG and EVIDENCE-INDEX. |
| `WP-B04` | Countermodel and assumption-fragility engine | `PARTIAL` | Engine built and applied to the reconciliation residual, which now states that four of its five conditions can be closed by nothing and reports a negative residual as an ESTABLISHED broken condition rather than a small number (D-084). It reaches no other claim: value gates, allocation runs and the ten-axis profiles still carry assumptions as inert prose. |
| `WP-B05` | Claim-relative evidence ordering instead of one global strength ladder | `PARTIAL` | `admissibility.ts` states bars as per-axis predicates and `compareForUse` returns `incomparable` rather than inventing a rank; `atLeast` on `monetaryBasis` is rejected at construction. `CLAIM_USES` replaces three disagreeing vocabularies and the dashboard now reads a reconciliation record's own exclusions instead of contradicting them (D-086). Three of the five uses have no stated bar and are recorded as unexamined rather than filled in; the persisted tuples are unmigrated and `compareForUse` has no product consumer yet. |
| `WP-C01` | End-to-end accounting-number authority audit | `PARTIAL` | Audited six money-bearing areas against AII-017 (D-087). The request, receipt and realization paths its remainder names are already migrated — `cost_usd` is a refused-if-lossy projection of an exact economic event, receipts validate the float against the exact `amountText`, and realization withholds cost/share for legacy coverage. What remains is structural: exact Money is a PARALLEL authority (`/api/economic`) beside thirteen `SUM(cost_usd)` read paths, and each migration re-implements the exact-vs-float preference locally and differently. `team-server/`, export and FX were NOT audited. |
| `WP-C02` | Complete economic event-role and basis semantics | `PARTIAL` | Adjustment kinds may no longer carry a basis no charge can hold, so a credit cannot be recorded in a state where it nets against nothing while the bill reads full (D-089). Verified RED across six kinds x three bases. `price_corrected` and `fx_translated` stay basis-open by design. Also closed under this heading: a reopened period accepted an in-period event recorded BEFORE the close it thereby falsified, after which `events()`, `periodCloseStatus`, `finalizePeriod` and `reopenPeriod` all threw permanently and the append-only ledger had no way back — a durable denial of service reachable through the documented API, and with budget enforcement failing closed on an unreadable ledger, a permanent stop on provider forwarding (D-100). Remaining: per-link basis agreement with the charge named in `sourceEventIds`, `usage_observed` still accepts a money amount, the role assignments themselves are unaudited, and a ledger already in the bricked state still has no recovery path. |
| `WP-C03` | FX integration and historical projection correctness | `PARTIAL` | A charge can no longer be translated into the same currency twice, which projected EUR 17 for a USD 10.00 bill through `closeBalances` (D-090). The guard lives in the closure check so a stored pair fails closed on read, and it is keyed on source + target currency so multi-currency reporting survives. Verified RED on the real `finalizePeriod` surface. Remaining: no supersession path for a corrected rate (shared with `price_corrected`), whether an FX translation of an already-corrected charge picks up the `price_corrected` delta is unexamined, and historical rate selection and as-of rate provenance were not audited. |
| `WP-C04` | Period close, allocation, supersession, and latest-as-of semantics | `PARTIAL` | Allocation reversals are now bounded in aggregate, not one at a time: two $8.00 reversals of a $10.00 allocation each passed the single-event bound and closed the period at `allocated -6` (D-091). Same defect class as D-090 — a set property checked against a single member — and the search that followed also found `test/build-race.test.ts` asserting the repository lock was absent, which measured the harness schedule rather than the build; that assertion was strengthened, not removed. Remaining: nothing ties allocations to the charge totals they allocate, adjustments are unbounded against the charge they adjust, supersession has no mechanism for any kind, and latest-as-of semantics were not audited. |
| `WP-C05` | Billing/FOCUS interoperability | `NOT_STARTED` |  |
| `WP-C06` | Receipts and team rollups: integrity is not truth | `PARTIAL` | The team server validated each project dollar figure and never compared them, so a correctly signed rollup could publish `realizedSpendShare: 100` — $1000 of realized spend inside $10 of total spend. Containment is now enforced at ingestion (D-095), the same rule the `strata` block already applied one field over. Remaining: `src/team/rollup.ts` does not apply it, so a push is refused by the server rather than never emitted; nothing checks a rollup against the ledger it summarises; a `--project`-scoped push is now refused rather than silently replacing a developer's complete snapshot and erasing their other projects from every team total — and, because `developerCount` fell with them, hiding a colleague's project behind a k-anonymity notice (D-101); and an exact EUR amount is no longer accepted as agreeing with a field named `costUsd` (D-096). Remaining: team totals carry no coverage on the wire, so any other client can misrepresent completeness the same way; member rollups with unequal self-chosen windows are still summed into one figure that states no window; and `validateRollupBody` still does not apply the containment the server enforces. |
| `WP-D01` | Canonical domain-neutral WorkUnit / OutcomeAdapter | `NOT_STARTED` |  |
| `WP-D02` | Reframe survival as artifact persistence, not quality | `NOT_STARTED` |  |
| `WP-D03` | Contribution attribution engine | `NOT_STARTED` |  |
| `WP-D04` | Adversarial contribution benchmark corpus | `NOT_STARTED` |  |
| `WP-D05` | MeasurementModel migration and construct-laundering prohibition | `NOT_STARTED` |  |
| `WP-D06` | CompletenessWitness migration beyond coding clean | `NOT_STARTED` |  |
| `WP-D07` | Surrogate bridges | `NOT_STARTED` |  |
| `WP-E01` | One EstimandDefinition registry | `NOT_STARTED` |  |
| `WP-E02` | One design/estimator registry; retire duplicate causal systems | `NOT_STARTED` |  |
| `WP-E03` | ITT primary, block-aware estimation, and noncompliance | `NOT_STARTED` |  |
| `WP-E04` | Missingness, attrition, and interference | `NOT_STARTED` |  |
| `WP-E05` | Treatment identity and transportability | `NOT_STARTED` |  |
| `WP-E06` | Inference ledger and precision planning | `NOT_STARTED` |  |
| `WP-E07` | Sequential/adaptive inference lane | `NOT_STARTED` |  |
| `WP-F01` | Robust utility and preference representation | `NOT_STARTED` |  |
| `WP-F02` | DecisionCertificate integration | `NOT_STARTED` |  |
| `WP-F03` | Preference robustness and value of waiting | `NOT_STARTED` |  |
| `WP-F04` | True VoI -> evidence-debt planner | `NOT_STARTED` |  |
| `WP-F05` | Decision Assurance Levels | `NOT_STARTED` |  |
| `WP-F06` | Recommendation -> policy proposal -> approval -> action | `NOT_STARTED` |  |
| `WP-F07` | Shadow, canary, TTL, and epistemic circuit breaker | `NOT_STARTED` |  |
| `WP-G01` | Finish CapabilitySpec and generated contracts | `NOT_STARTED` |  |
| `WP-G02` | Plugin contracts | `NOT_STARTED` |  |
| `WP-G03` | Plugin isolation | `NOT_STARTED` |  |
| `WP-G04` | Standards interoperability | `NOT_STARTED` |  |
| `WP-G05` | `.fiscuspack` | `NOT_STARTED` |  |
| `WP-G06` | Independent verifier | `NOT_STARTED` |  |
| `WP-H01` | Database integrity review | `NOT_STARTED` |  |
| `WP-H02` | OIDC/JOSE production-grade decision | `NOT_STARTED` |  |
| `WP-H03` | Fuzzing, mutation, and fault injection | `NOT_STARTED` |  |
| `WP-H04` | Backup/recovery and migration assurance | `NOT_STARTED` |  |
| `WP-H05` | Supply-chain assurance | `NOT_STARTED` |  |
| `WP-H06` | Performance and scale | `NOT_STARTED` |  |
| `WP-I01` | Claim Inspector as a real kernel viewer | `NOT_STARTED` |  |
| `WP-I02` | Additional epistemic UX surfaces | `NOT_STARTED` |  |
| `WP-I03` | Progressive disclosure and parity | `NOT_STARTED` |  |
| `WP-I04` | WCAG 2.2 AA and runtime accessibility | `NOT_STARTED` |  |
| `WP-I05` | Data inventory, privacy, retention, and evidence consequences | `NOT_STARTED` |  |
| `WP-I06` | Documentation truth and reproducibility | `NOT_STARTED` |  |
| `WP-J01` | Adaptive experimentation and provenance-aware OPE | `NOT_STARTED` |  |
| `WP-J02` | Constrained online control | `NOT_STARTED` |  |
| `WP-J03` | Complexity Lab | `NOT_STARTED` |  |
| `WP-J04` | AI capital, showback, spend decomposition, opportunity gaps | `NOT_STARTED` |  |
| `WP-J05` | Current-market capability matrix | `NOT_STARTED` |  |
| `WP-J06` | Originality, substitution, and complexity-theater review | `NOT_STARTED` |  |
| `WP-J07` | Public-interest/open-source launch readiness | `NOT_STARTED` |  |
| `WP-R01` | Evidence abstract interpretation | `NOT_STARTED` |  |
| `WP-R02` | Epistemic Preservation | `NOT_STARTED` |  |
| `WP-R03` | No Granularity Laundering | `NOT_STARTED` |  |
| `WP-R04` | Negative-Claim Soundness | `NOT_STARTED` |  |
| `WP-R05` | Trust Non-Escalation | `NOT_STARTED` |  |
| `WP-R06` | Monetary Conservation | `PARTIAL` | Three of four sites reconciling an exact amount against its USD-named float compared magnitudes only, so an exact EUR 100.00 agreed with `costUsd: 100` and was summed into `total_cost_usd` (D-096); one shared helper now performs that reconciliation and checks the unit, which `src/value/epistemic.ts` already did. Also under this heading: FX chains and disguised allocation reversals could both mint money that no rate or allocation produced (D-093), and adjustment kinds could carry a basis no charge can hold (D-089). Remaining: nothing ties allocation totals to the charges they allocate, adjustments are unbounded against the charge they adjust, the compatibility field still carries its unit in its name rather than on the wire, and nothing reconciles a receipt or rollup against the ledger it summarises. |
| `WP-R07` | Revocation Closure | `PARTIAL` | The closure itself was already correct; the three kernel-claim readers that serve `/api/billing` ignored it and returned revoked claims as `supported`/`verified` (D-094). They now apply the projection through one shared helper: the claim is still served, carries `revoked`, and its `epistemic` axis reads `unknown` while `integrity` is deliberately untouched. Two further contradictions in the same packet are closed: `minimalSupportingSets` read dependency edges as alternatives while the closure read them as prerequisites, so cut sets said an auditor must revoke both invoices to cut a claim that one revocation already cuts (D-098); and the `revocation` envelope that `Evidence` and `Claim` both carry was validated, stored and never projected, so a provider statement that said on its face it had been withdrawn read as live along with everything derived from it (D-099). Remaining: only one of the three readers is exercised end to end; these readers take no as-of boundary, so a revocation recorded today rewrites how every past read renders; `RevocationProjection` has no effective-time dimension, so a future-dated revocation cannot be represented as pending and is treated as current; an envelope's `eventId` is not checked against the event table in either direction; and neither set function has a caller outside its own module, so cut sets reach no user. |
| `WP-R08` | Decision-Certificate Soundness | `NOT_STARTED` |  |
| `WP-R09` | Minimal evidence acquisition | `NOT_STARTED` |  |
| `WP-R10` | Model pluralism | `NOT_STARTED` |  |
