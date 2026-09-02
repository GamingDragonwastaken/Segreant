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
| `WP-C02` | Complete economic event-role and basis semantics | `NOT_STARTED` |  |
| `WP-C03` | FX integration and historical projection correctness | `NOT_STARTED` |  |
| `WP-C04` | Period close, allocation, supersession, and latest-as-of semantics | `NOT_STARTED` |  |
| `WP-C05` | Billing/FOCUS interoperability | `NOT_STARTED` |  |
| `WP-C06` | Receipts and team rollups: integrity is not truth | `NOT_STARTED` |  |
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
| `WP-R06` | Monetary Conservation | `NOT_STARTED` |  |
| `WP-R07` | Revocation Closure | `NOT_STARTED` |  |
| `WP-R08` | Decision-Certificate Soundness | `NOT_STARTED` |  |
| `WP-R09` | Minimal evidence acquisition | `NOT_STARTED` |  |
| `WP-R10` | Model pluralism | `NOT_STARTED` |  |
