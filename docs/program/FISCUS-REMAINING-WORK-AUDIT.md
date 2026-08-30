# Fiscus Remaining-Work Audit

**Status:** controlling post–Foundational Audit II remaining-work reconciliation  
**Date:** 2026-08-29  
**Repository:** `GamingDragonwastaken/Fiscus`  
**Reconstruction branch:** `gpt56/magnum-opus-reconstruction`  
**Code baseline reconciled:** `ec8e67ad79211389ba0b8caa5cf40ceb3ccb2872`
**Authority:** owner-approved `FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md` plus all still-valid requirements of the Magnum Opus Master Execution Plan.

## Purpose

This document records what is genuinely left after the first GPT-5.6 Sol implementation tranche. It is not another feature wishlist and it does not lower the definition of success. It reconciles completed primitives, partially closed Audit II findings, repository-internal remaining work, external evidence gates, and execution order.

The architectural thesis remains:

> Fiscus should be enormous at the capability boundary and extremely small at the truth boundary.

The trusted core should own evidence legality, claims, scope, grain, time, money, measurement, assumptions, uncertainty, revocation and decision certification. Broad FinOps capability should remain expansive through adapters, interoperable standards and first-party modules.

## Current state

The reconstruction branch began from the reviewed high-assurance candidate `31577d5b112653e5aa4dff5a0bdaae9fd58a982c`.

The original macOS OIDC time-boundary failure has been repaired through injected deterministic verifier time and exact skew-boundary tests. Team-server tests later passed on Windows, Ubuntu and macOS.

The latest local candidate extends the remote reconciliation checkpoint with the
economic-event foundation `5ef8b58`, canonicalization/replay hardening `5c8d9c6`,
exact decimal pricing `ad0b6a4`, atomic exact request issuance `ac0efa7`, bundled
exact-rate/live issuance `3763c9e`, role-aware projections/reversal constraints
`6285bcc`, normalized source links `8fcd262`, exact budget projection migration
`05f26e6`, exact economic CLI inspection `e3a280f`, and additive local price
correction lineage `2b81173`, historical exact FX lineage `11a9212`, and
effective correction projection/converged reprice integration `6059258`, and
exact-money allocation projection `d8d260f`, schema-owned exact allocation
persistence `3fa9a20`, adversarial replay/parity hardening `baee5c6`, and exact
economic export/CLI surface `c1f7ec4`, plus the read-only exact economic
dashboard/API projection `ccda34d` and coding value-attribution lineage
`3871b6f`, followed by grouped usage/cohort/model/series/budget migration
`5e54250`, exact frontier/time-reclaimed projections `3c71c51`, modern
Value-view disclosure `ebbc571`, exact receipt v2 `443c74d`, exact
team-rollup v2 `2d567c2`, and bounded classic Value/API exact-coverage
parity `16c5a15`. Local verification at this candidate is 1,086 root
tests (1,082 pass, 0 fail, 4 platform-conditional skips), team-server 61/61,
root/team typecheck, full Node/browser build, and npm pack dry-run.
These identities are not remote/CI evidence until the blocked push succeeds.

The coding value path now has a bounded exact seam: `3871b6f` adds a
Store-owned request read model with alias/live scope and strict dimensional
checks, carries effective Money/source lineage on coding WorkUnits and mature
rollups, and refreshes that lineage during transactional repricing. The
numeric fields remain compatibility projections; usage, cohort, frontier,
receipts and team-rollup consumers still require their own grouped migration.

The grouped migration at `5e54250` extends that seam to exact session, user,
provider/model and fixed-width time buckets. Usage, cohort and budget advice
now consume those groups and expose complete/partial/legacy coverage; numeric
fields remain compatibility projections, while frontier presentation, signed
receipts, refreshed-card provenance and period close remain open.

The frontier/time slice at `3c71c51` carries the same exact coverage into
model/task cells and manual-time strata, and the modern Value view checkpoint
`ebbc571` renders complete/partial/legacy status and unresolved counts beside
the spend figure. Signed receipts and team transport now have additive exact
v2 paths, and the classic Value view now discloses the same exact/partial/legacy
coverage for mature, usage, budget, project and team sections. Broader generated
dashboard/API contracts, refreshed-card provenance and period close remain open.

The receipt checkpoint at `443c74d` adds a strict v2 signed body for complete
exact-covered units, with canonical effective Money/source/correction lineage
and semantic verification; incomplete, legacy or oversized numeric projections
remain on v1. The follow-on team checkpoint `2d567c2` adds a signed v2 rollup
body carrying per-project exact lineage, validates it before server storage,
and retains the signed body plus additive `economic_json` JSONB columns.

The immediate recovery tranche is green at exact implementation SHA `685b14c57cccf078679a37a929f6234f00522abd`; M1 Evidence/Claim slices are green at `fa36cc380e6883cc868e2e5b46517ae118a038ae`; Derivation/DAG slices are green at `8928bb474ecb93477caa7605c6710b432653a631`; schema-owned persistence is green at `9d8d364013d22f37fc4c3548f57110a26a274b6a`; assumption/event-time/serialization slices are green at `5ab1440e7495a58dcf08083696591e7cf1747d07`; the canonical witness registry is green at `774658431739673183066f3c45dd9d01e84346a2`; hindsight-safe replay/conformance is green at `a7ef58946d941e0e035a38641f59f234b180a0b8`; the first billing kernel vertical is green at `9a0254ab0766057b53569b396f81c1d7c8dd96e2`; and persisted provider/local/residual reconciliation Claims are green at `ec8e67ad79211389ba0b8`. Root typecheck/tests, package smoke, and the configured cross-platform GitHub matrix pass. The broader kernel and product program remains partial/open as recorded below.

## Work already implemented and to preserve

The first tranche created durable program-control artifacts and implemented meaningful constitutional foundations:

- four-valued epistemic state: `unknown / supported / refuted / conflicted`, with conflict-preserving semilattice properties;
- canonical grain, scope and bitemporal coordinates;
- exact arbitrary-precision decimal `Money` with currency and economic-basis compatibility checks;
- exact rational `Rate` semantics and refusal of implicit non-terminating rounding;
- generic open-world `OutcomeContract`;
- `CompletenessWitness` for negative claims;
- witnessed scope/grain derivation primitives;
- multi-axis `ClaimProfile` separating epistemic support, integrity, authenticity, scope, coverage, measurement validity, causal status, monetary basis/finality and decision fitness;
- `MeasurementModel` construct-validity boundary;
- canonical immutable Evidence and Claim envelopes with explicit provenance, coordinates, profiles, uncertainty and lifecycle metadata;
- canonical Derivation/Witness legality and immutable Evidence/Claim DAG projections with as-of, supersession and revocation traces;
- first-class immutable Witness envelopes with persisted evidence grounding and enforced Derivation registry references;
- first billing vertical adapter: exact Money-backed provider Evidence/billed/provider-observed Claims, conservation-checked persisted reconciliation Claims, CLI replay and bounded API ClaimProfile summaries;
- provider/local/residual reconciliation issuance is bound to unique immutable reconciliation-run identities and retains separate billed/provider-observed and estimated bases;
- schema-owned SQLite persistence for canonical Evidence/Claim/Derivation/Witness nodes, edges and revocation events with digest/trigger protection;
- first-class Assumption IDs, event-time-aware revocation replay and canonical serialization/digest envelopes;
- strict legacy realization fix: unknown required gates no longer count toward the confirmed lower bound;
- first live removal of the universal-Git-commit assumption: non-coding outcomes now use a domain-neutral OutcomeContract rather than fake coding lifecycle gates.

A primitive existing is not the same thing as an audit finding being closed. Universal product migration remains the standard.

## Audit II reconciliation

Status vocabulary: `CLOSED`, `PARTIAL`, `OPEN`, `RED-SPEC`, `EXTERNAL-GATE`, `SUPERSEDED`, `OWNER-RESERVED`.

| ID | Current status | Remaining closure condition |
|---|---|---|
| AII-001 realization lower bound | PARTIAL | Core rule and affected fixtures now require every declared predicate. Migrate generalized WorkUnit adapters and prove universal terminal bounds. |
| AII-002 absence without completeness | PARTIAL | Completeness primitive exists; migrate `clean`, off-path-spend and all analogous negative claims. |
| AII-003 conflict collapsed | PARTIAL | Four-valued kernel exists; migrate legacy gates/claims/storage/API/UI. |
| AII-004 commit universal atom | PARTIAL | Non-coding decoupled; implement canonical WorkUnit/OutcomeAdapter and coding adapter. |
| AII-005 line survival called quality | OPEN | Retype as artifact persistence; build real quality measurement separately. |
| AII-006 spend→commit temporal attribution overclaim | OPEN | Typed temporal association/contribution uncertainty and witness. |
| AII-007 pooled line-retention acceptance | OPEN | Benchmark a richer contribution-attribution engine. |
| AII-008 four lenses treated as constitutional peers | OPEN | Separate contribution/outcome/causal/utility; demote old composite to descriptive compatibility surface. |
| AII-009 geometric mean economically forced | OPEN | Correct mathematical claims and preference interpretation. |
| AII-010 Lift heuristic bounds | OPEN | Explicit estimand/identified set/assumptions. |
| AII-011 workflow label → cardinal Impact | OPEN | Multidimensional outcomes plus explicit preferences/utility. |
| AII-012 `realizedValueUsd` sometimes spend | OPEN | Rename/schema migration distinguishing spend, scenario value and causal value. |
| AII-013 financial layers too coarse | PARTIAL | Money/Rate foundation, provider/local Evidence and persisted mixed-basis reconciliation Claims now exist; complete economic claim DAG and subledger remain. |
| AII-014 `established:boolean` | PARTIAL | ClaimProfile is now embedded in canonical Claim; persisted/API/UI migration and alternate-boolean removal remain. |
| AII-015 global evidence strength order | PARTIAL | Implement claim-relative admissibility/incomparable profiles. |
| AII-016 grain not a truth constraint | PARTIAL | Witness primitive exists; enforce in every derivation/aggregation. |
| AII-017 money not exact end-to-end | PARTIAL | Provider/local/reconciliation kernel paths, bundled exact decimal pricing, live proxy/import exact request issuance, complete-coverage exact budget enforcement, schema-owned exact allocation projection/persistence, exact economic export and the read-only exact economic API now use exact Money; migrate refreshed-card provenance and legacy request/DB/value authoritative paths and remove accounting-number authority. |
| AII-018 analytical economic subledger absent | PARTIAL | Immutable typed economic events, canonical exact pricing, role-aware append-only projections, one-source additive local price-correction lineage, historical exact FX translation, effective request-charge projection, exact allocation persistence, exact economic export and `/api/economic` now exist as a local candidate; complete event-role/conservation semantics, FX consumer integration, value/dashboard consumption, close state and product integration remain. |
| AII-019 immutability inconsistent | PARTIAL | Schema-owned SQLite persistence, digest/trigger checks, assumption/witness/source links, event-time dependency ordering, billing Claims, atomic exact request-charge issuance, validated additive price corrections, legacy-reprice convergence, schema-owned exact allocation lineage and read-only exact economic projections are implemented/tested; value read-model migration and complete event projections remain. |
| AII-020 receipt mistaken for truth | PARTIAL | Separate trust dimensions in product UX and interoperable attestation semantics. |
| AII-021 causal inference/design gaps | OPEN | ITT, blocks, joint inference, missingness, interference, precision and transportability. |
| AII-022 two causal systems | OPEN | One estimand/design/estimator registry; version/archive superseded path. |
| AII-023 anytime inference assumptions | OPEN/RESEARCH | Dependency/cluster/adaptivity-aware validation and disclosed assumptions. |
| AII-024 Goodhart naming | OPEN | Rename structural drift unless incentive gaming is evidenced. |
| AII-025 observational frontier `evidence_supported` | OPEN | Observational/statistical label only; causal lane owns causal claims. |
| AII-026 budget heuristic overclaim | OPEN | Keep scenario advisor; route action-grade choices through decision engine. |
| AII-027 pseudo-VoI | PARTIAL | Legacy sensitivity metric remains explicitly labelled; separate decision engine now implements perfect-information VOI net of measurement cost. |
| AII-028 shrinkage weight labelled confidence | OPEN | Correct terminology/assumptions and tests. |
| AII-029 docs/runtime drift | OPEN | Canonical CapabilitySpec and generated/conformance-tested docs. Economic CLI inspection and a typed `/api/economic` contract now exist, but universal generated contracts remain. |
| AII-030 browser/server schema drift | OPEN | Billing ClaimProfile summaries and the exact economic projection are now shared by bounded route/client contracts; one runtime schema source and generated/shared types remain. |
| AII-031 unbounded major buffers | OPEN | Bound ingress/SSE/tool args/proposals/responses with explicit coverage-loss semantics. |
| AII-032 DB integrity too application-managed | OPEN | Promote critical invariants to DB where sound. |
| AII-033 supply-chain assurance | OPEN | CodeQL, dependency review, secret scan, SBOM, provenance/signing. |
| AII-034 hand-rolled OIDC | PARTIAL | Clock fixed; JOSE-vs-custom decision, differential/reference tests, production validation. |
| AII-035 original exact-head macOS failure | CLOSED | Deterministic OIDC repair plus GitHub run `33253835881` is green across all seven configured jobs at exact SHA `685b14c`. |
| AII-036 derivation legality absent | PARTIAL | Canonical Derivation/Witness legality and a persisted evidence-grounded witness registry now exist; unavoidable integration at all consequential issuance boundaries remains. |

## Immediate execution tranche

**Checkpoint addendum (2026-08-30):** The exact receipt v2 and signed team-rollup
v2 paths are now implemented locally at `2d567c2`. They carry canonical
effective/source lineage and retain explicit compatibility projections; the
remaining AII-017--020 closure work is refreshed-card provenance, live remote
storage/trust-anchor governance, complete event-role/conservation semantics and
universal product integration. The older table wording above is historical
context and must be read with this addendum.

**Classic parity addendum (2026-08-30):** `16c5a15` closes the bounded
exact-coverage disclosure gap in the legacy Value renderer and adds the missing
project lineage to the browser Value contract. It does not close AII-029/030:
the universal generated capability/schema contract and all non-Value browser
surfaces remain future work.

The next worker should not start another design discussion.

**Execution-order override after `16c5a15`:** the versioned exact team-rollup
protocol/storage migration and bounded classic Value/API exact-coverage parity
are complete locally. Proceed next with the remaining generated dashboard/API
contract work, then refreshed-card provenance, then period-close semantics; live
Postgres execution and remote publication remain explicit gates.

1. **COMPLETED at `b27c0ef`:** Implement the RED robust decision module. Strict dominance is the only proof-level certificate; minimax regret and perfect-information VOI remain explicitly named rules with assumptions and cost.
2. **COMPLETED at `5647c67`:** Implement additive transitive revocation closure. Dependent descendants are invalidated while independent siblings remain outside the closure; cycles are safe, duplicate edges fail closed, and history is not deleted.
3. **COMPLETED at `685b14c`:** Restore root and browser typechecks, the full root suite, and package smoke after the fixture migration.
4. **COMPLETED at `685b14c`:** Migrate every affected realization/demo fixture to explicit required lifecycle evidence; no unknown gate is promoted to pass.
5. **COMPLETED at `685b14c`:** Observe GitHub Actions run `33253835881` as green on all configured jobs.
6. **COMPLETED in the following documentation checkpoint:** update program state, audit, decision, and evidence registers with exact implementation/CI identities.
7. **COMPLETED at `2d567c2`:** Add the versioned exact team-rollup protocol/storage migration. Complete exact-covered projects emit signed v2 lineage; v1 remains the compatibility fallback; the server validates v2 before insertion and stores additive `economic_json` JSONB alongside the signed raw body. Local root 1,084/1,080 and team-server 61/61 are green.
8. **COMPLETED (bounded) at `16c5a15`:** Make the legacy Value renderer and browser Value contract disclose exact/partial/legacy effective coverage for mature, usage, budget, project and team sections, with missing coverage rendered as `legacy_unknown`. The universal generated dashboard/schema contract remains open.
9. **NEXT:** Complete the remaining generated dashboard/API contract work, then add refreshed-card provenance and period-close semantics. Live Postgres execution, trust-anchor governance and GitHub publication remain explicit gates.

## Trusted Epistemic Kernel remaining work

Implement canonical immutable objects for `Evidence`, `Claim`, `Derivation`, `Assumption`, witnesses, supersession/revocation and dependency graphs.

A Claim must carry a typed proposition, subject, scope, grain, time coordinates, four-valued state, multi-axis ClaimProfile, evidence dependencies, MeasurementModel, assumptions, uncertainty/identified set, causal status, monetary basis/finality, derivation version and issuance/supersession state.

A Derivation checker must refuse any unsupported strengthening: finer grain without disaggregation witness, broader scope without coverage, stronger construct validity without bridge, stronger causality without identification witness, stronger monetary finality without financial evidence, stronger authenticity/integrity without attestation, or disappearance of conflict/unknown without legal evidence.

Build the Evidence/Claim DAG as a first-class structure supporting ancestors, descendants, assumption dependencies, conflicts, revocation closure, minimal supporting sets and minimal cut sets for decision invalidation.

Implement as-of epistemic reconstruction: `occurredAt`, validity, observation, recording, assertion, finalization, decision and action times must remain distinct where applicable. Fiscus must be able to answer “what did we know then?” without hindsight leakage.

Research countermodel-first auditing for tractable domains: construct a world consistent with evidence in which an important claim is false, or show extremal worlds producing numeric bounds.

## Exact economic foundation

Migrate authoritative monetary paths to exact Money/Rate: request metering, pricing, billing evidence, reconciliation, budgets, allocations, forecasts, model comparisons, team rollups, exports and database schemas. JavaScript numbers may remain presentation adapters, not accounting authority.

Expand cost basis semantics to distinguish list, contracted, metered-estimated, provider-observed, billed, effective, allocated, full-workflow, marginal, avoidable, committed, sunk and opportunity cost where data supports them.

Implement an immutable economic event subledger for usage, estimated/provider charges, bills, prices/corrections, credits, discounts, commitments, tax, FX, allocations/reversals, true-ups and write-offs. Current balances are deterministic projections, never history rewritten in place.

The current correction slice is intentionally bounded: `price_corrected` may
target exactly one locally estimated/list-price charge, records typed previous
and replacement Money, is additive and recorded after its source, and rejects a
second correction for the same source. Provider/billed restatements and a
multi-correction chain remain separate future semantics rather than being
silently conflated with local repricing.

The historical FX slice is likewise bounded: `fx_translated` retains one exact
monetary source, an exact positive rational source-to-target rate, rate
provenance, effective time and explicit `none` rounding. It preserves the
source basis, refuses same-currency or non-terminating conversions, and cannot
be recorded before or occur separately from its source. Provider FX policies,
quantized conversions and consumer integration remain open.

The effective request projection is now also explicit: a validated local price
correction is applied only to the `effective` control basis, retains source and
correction event IDs, and is emitted transactionally by `reprice --apply` when
an exact request event exists. Numeric-only repricing against exact history is
refused; allocation, value, export, API and dashboard consumers still require
the same convergence treatment.

The exact allocation adapter is a source-traced bridge over that projection. It
keeps every currency/basis identity separate, performs ratio arithmetic as exact
rational Money, carries all source event IDs, refuses non-terminating
proportional shares without a quantization policy, and marks legacy requests
unresolved instead of rounding them into the numeric run schema. Exact runs are
now persisted canonically with immutable per-line lineage, while the legacy
numeric run remains a distinct compatibility surface.

The allocation persistence boundary is hardened at `baee5c6`: proportional
pools ignore archived placeholder targets, result ordering is independent of
input row order, envelopes reject unknown/missing fields, and replay recomputes
identity, source lineage and conservation before a run is trusted.

Property-test conservation, compatible-basis arithmetic, reversal, reprice/reconciliation and replay.

Implement explicit historical FX with source, effective time, convention and rounding policy. No “current FX” may silently rewrite historical records.

Map appropriate billed/effective semantics to FOCUS while preserving Fiscus-specific assurance semantics.

## WorkUnit / outcome / contribution reconstruction

Create a canonical WorkUnit and OutcomeAdapter protocol. Coding remains a first-class adapter rather than the universal atom. Candidate future adapters include coding, support/resolution, documents/research, agent tasks, data-analysis and CI/release outcomes.

Migrate coding to an explicit versioned OutcomeContract. Required predicates may vary by contract; unknown predicates stay unresolved.

Replace closed-world `clean`: no linked incident observed is not support unless a CompletenessWitness proves relevant source coverage for the event/scope/time.

Retype line survival as artifact persistence. For adequate data, research survival/time-to-event models with censoring/competing risks rather than relying permanently on a fixed 14-day threshold.

Replace pooled line retention with a contribution engine handling file identity, rename/move, structural rewrites, generated/common content, competing proposals, human edits and ambiguous attribution. Benchmark against current line retention and simple diffs on adversarial fixtures.

## Measurement layer

Migrate consequential metrics to explicit MeasurementModels: contribution, persistence, tests, deployment, incidents, task completion, quality, customer impact, time with AI, labor-equivalent baselines, billing coverage and model outcomes.

Enforce No Construct Laundering: line persistence ≠ quality, acceptance ≠ productivity, test pass ≠ business value, shipped ≠ customer impact, spend on a successful unit ≠ economic value without an explicit bridge.

CompletenessWitness must govern negative claims such as no incident, no provider charge, no off-path spend, no duplicate, no policy violation or no security event.

Surrogate bridges need context, calibration, validation, uncertainty, transport conditions and validity period.

## Causal inference v3

Preserve the strong current causal subsystem while repairing its mathematics.

Create one EstimandDefinition registry and one design/estimator registry. Explicitly distinguish ITT, per-protocol and CACE/LATE where justified. Assignment-preserving ITT should normally be primary for randomized treatment.

Use blocked/paired/clustered design information in estimation rather than ignoring it. Joint claims such as “cheaper and non-inferior” require simultaneous/IUT/multiplicity-aware inference.

Formalize missingness, attrition, censoring and interference. Record transportability/treatment identity because model, version, prompt, tools, workflow, user/team, pricing and environment changes can invalidate transport.

Create an inference ledger recording preregistration, candidate estimands, planned/actual exclusions, analysis attempts, estimator/model versions, failed analyses and reported result.

Replace arbitrary minimum-N rules with target width, MDE, power, non-inferiority margin or decision-relevant precision when appropriate.

Keep time-uniform inference but state dependency/exchangeability assumptions and research clustered/adaptive alternatives.

## Decision theory / VoI / safe control

Build robust utility intervals and proof-level dominance certificates. Where dominance fails, support declared ambiguity rules such as minimax regret without relabelling them proof.

Expose preference robustness regions and break-even values instead of hiding every decision inside one composite weight vector.

Allow `wait / collect more evidence` as an action when irreversibility and uncertainty make option value material.

Rename existing `voi.ts` functionality as instrumentation/evidence-gap sensitivity. Implement genuine decision-theoretic Value of Information or robust regret-reduction analogues net of measurement cost. Evidence debt should be weighted by decision impact rather than missing-field count.

Implement Decision Assurance Levels from display-only through recommendation, shadow/canary, material automated policy and hard-to-reverse financial/security action. Evidence/freshness/rollback/human approval requirements increase with consequence.

Required control chain: `Observation -> Evidence -> Claim -> DecisionProblem -> DecisionCertificate -> PolicyProposal -> Assurance/Approval -> Action -> Outcome`.

Support shadow, canary, monitored expansion and rollback. Add policy TTL/epistemic circuit breakers when evidence becomes stale/conflicted, model/pricing/environment changes, instrumentation breaks or assumptions are revoked.

## Legacy value mathematics cleanup

Demote the four-lens RoI Index to an explicitly descriptive compatibility/exploration surface. Separate contribution, outcome evidence, causal effect and utility.

Correct geometric-mean/CES/compensability/continuity claims; retain aggregators only under explicit axioms/preferences.

Separate Lift/time-saving scenarios from causal treatment effects. Replace universal cardinal Impact with real outcome variables and explicit preferences.

Migrate misleading `realizedValueUsd` semantics into distinct spend-on-confirmed-outcome, scenario/manual-equivalent value and causal incremental value concepts.

Relabel observational frontier claims; preserve the capability but do not imply causality. Keep budget advice as scenario guidance until the decision engine qualifies stronger recommendations. Rename shrinkage weights to the statistical object they actually are.

## Capability architecture / adapters / standards

Generalize the current GUI registry/actions seed into a canonical CapabilitySpec defining input/output/preview schemas, consequence, authority, egress, credentials, reversibility, assurance level and CLI/API/GUI/docs bindings. Generate or conformance-test surfaces from it.

Unify browser/server/runtime schemas. Stable plugin interfaces should include UsageSource, BillingSource, PricingSource, IdentitySource, OutcomeSource, MeasurementAdapter, CausalProducer, DecisionPolicy, ControlTarget and AttestationPublisher. Plugins submit evidence; they do not mint truth directly. Add isolation/conformance for untrusted adapters.

Interoperate with OpenTelemetry, FOCUS, W3C PROV, VC/Data Integrity where useful, and in-toto/SLSA patterns rather than inventing isolated equivalents.

Define a versioned `.fiscuspack` portable audit bundle containing evidence, claims, derivations, assumptions, measurement models, decision receipts, attestations, hashes and selected references. Long-term target: an independent verifier with shared public conformance vectors.

## Security / reliability / supply chain

Bound all major ingress and accumulation paths: HTTP body, non-streaming response, SSE frames/total stream, tool-call args, proposals, transcripts, imports, receipt/evidence-pack elements. Truncation must explicitly reduce coverage; it cannot silently preserve completeness.

Review OIDC/JOSE strategy. A mature JOSE dependency is preferable if it materially reduces risk; if custom remains, differential-test against a reference implementation and add hostile JWT/JWKS/rotation/algorithm/type cases.

Review critical DB invariants for CHECK/UNIQUE/FK/trigger/append-only enforcement. Preserve strong backup/restore work and add interruption, disk-full, corruption and migration recovery tests.

Add CodeQL/static analysis, dependency review, secret scanning, SBOM, provenance/signing and exact-SHA release verification. Add fuzzing, fault injection and mutation testing, especially for money conservation, derivation legality, revocation, OIDC, causal qualification and decision certificates.

## UX / accessibility / performance

Use progressive disclosure: `answer -> evidence profile -> derivation -> assumptions -> uncertainty -> raw evidence`.

Build Claim Inspector 2.0, Trace the Dollar, Prove a Claim, What Did We Know Then, What Should We Measure Next, and Preference Map surfaces.

Make GUI/CLI/API parity mechanically checkable. Target WCAG 2.2 AA and later validate in real browsers/assistive technologies.

Benchmark claim issuance, derivation checking, DAG traversal, revocation, as-of reconstruction, economic projection and evidence-pack verification at deterministic scale tiers. Set performance budgets from measurements, not impressive-looking guesses.

## Still-valid broader master-plan workstreams

Do not lose these while rebuilding the constitution:

- living current-market capability matrix and competitor/standards benchmark; competitors are benchmarks, not strategic fences;
- distinction/non-substitutability review after baseline category completeness;
- brand/name collision review before major public launch;
- adaptive experimentation, exploration, provenance-aware off-policy evaluation, constrained online control and tail-risk handling;
- Complexity Lab, with sophistication admitted to production only when it improves calibration/robustness/decisions;
- AI-capital/showback/chargeback semantics, spend decomposition, opportunity gaps and allocation fairness without confusing allocation with causation;
- machine-readable data inventory, user controls, retention/privacy and evidence consequences of deletion;
- documentation truth audits, mathematical documentation, reproducible research bundles and eventually paper-quality artifacts;
- professional/public-interest launch readiness, contribution/governance/security/support/release documentation;
- originality audit, red-team substitution against standards/libraries/products, and periodic complexity-theater review.

## Testing architecture

Final assurance should span ten layers: schema/type validation, unit tests, property tests, metamorphic tests, differential/reference tests, simulation/calibration, fuzzing, fault injection, adversarial economic tests and release/artifact verification.

Mandatory adversaries include mixed cost bases, credits/FX/rate changes, ambiguous attribution, generated/renamed code, high-precision wrong proxies, missing completeness, Simpson's paradox, noncompliance, attrition, interference, clustering, optional stopping, preference reversals, irreversible weak-evidence actions, expired policies and incentive gaming.

## Research/theorem agenda

Maintain research maturity: `CONJECTURE -> FORMALIZED -> UNIT-VERIFIED -> SIMULATION-VALIDATED -> BENCHMARK-VALIDATED -> FIELD-VALIDATED -> DECISION-VALIDATED -> PRODUCTION-QUALIFIED`.

Research directions include abstract interpretation for economic evidence, Epistemic Preservation, No Granularity Laundering, Negative-Claim Soundness, Trust Non-Escalation, Monetary Conservation, Revocation Closure, Decision-Certificate Soundness, minimal evidence acquisition, provenance-aware OPE, surrogate/business transport and proof-carrying economic claims.

Established mathematics must not be relabelled as Fiscus invention. Potential originality lies in a genuinely new integrated AI-economic semantics/verifier only if independent scrutiny supports that claim.

## External gates

Repository engineering cannot fabricate:

- real provider-authorized invoice reconciliation;
- real causal-study outcomes;
- production team-server qualification on real infrastructure/IdP;
- real browser/assistive-technology accessibility qualification;
- design-partner/user validation;
- independent security review;
- independent scholarly/novelty review;
- long-term adoption or industry-standard status.

For each external gate, repository work must leave an executable protocol, required data, acceptance criterion, tooling and explicit blocker.

## Milestone calibration

- M0 stabilize reconstruction: COMPLETE at implementation SHA `685b14c`; CI run `33253835881` green.
- M1 constitutional specification/TEK: PARTIAL.
- M2 exact money/economic events: PARTIAL foundation.
- M3 evidence kernel v1: PARTIAL.
- M4 coding OutcomeAdapter: PARTIAL.
- M5 measurement layer: PARTIAL primitive.
- M6 financial interoperability: OPEN/PARTIAL.
- M7 telemetry/integration: operational foundation exists; constitutional migration open.
- M8 causal v3: strong v2 foundation; mathematical migration open.
- M9 decision subsystem: PARTIAL foundation (`src/decision/engine.ts`); integration, assurance levels and policy chain remain.
- M10 VoI/evidence planner: PARTIAL foundation (decision-theoretic VOI exists; evidence-debt planner remains OPEN).
- M11 safe control: OPEN.
- M12 attestation/`.fiscuspack`/verifier: OPEN.
- M13 epistemic UX: OPEN on top of strong existing GUI foundation.
- M14 security/reliability/supply-chain: strong partial foundation.
- M15 mathematical research validation: conjecture/formalization seeds.
- M16 public standard/conformance: OPEN.
- M17 public-interest release readiness: OPEN.
- M18 external validation: EXTERNAL-GATE.

## Exact next queue

1. **COMPLETED at `c89d95d`:** TDD canonical Evidence envelope and immutable issuance boundary.
2. **COMPLETED at `fa36cc3`:** TDD canonical Claim with ClaimProfile, uncertainty and typed basis aliases.
3. **COMPLETED at `c457b95`:** TDD canonical Derivation/Witness and illegal-strengthening checks.
4. **COMPLETED at `7746584`:** Persisted canonical Witness registry with evidence grounding, serialization, append-only protection, Derivation-reference enforcement and transitive revocation edges.
5. **COMPLETED at `a7ef589`:** Add one immutable replay projection and table-driven as-of/revocation conformance vectors.
6. **COMPLETED kernel path at `ec8e67a`:** Issue provider-line and provider-observation Evidence, billed/provider-observed Claims, local-capture Evidence and unique mixed-basis reconciliation Claims through exact Money with CLI/API ClaimProfile routing and conservation checks.
7. migrate remaining legacy accounting paths to exact Money/Rate and complete the immutable economic-event subledger; local candidate foundations now include exact events, replay hardening, decimal pricing, atomic issuance, bundled/live integration, role/source/budget/CLI projections, bounded correction/FX lineage and effective reprice convergence through `6059258`, but are not remote checkpoints;
8. build contribution attribution and adversarial benchmark corpus;
9. unify causal estimand/design/estimator registry and inference ledger;
10. integrate DecisionCertificate/true VoI/evidence debt/assurance levels into the control chain;
11. CapabilitySpec, canonical schemas, plugins, standards and `.fiscuspack` verifier;
12. resource bounds, fuzzing, DB/JOSE/supply-chain controls;
13. epistemic UX, accessibility and performance budgets;
14. final adversarial reconciliation and explicit external-gate handoff.

## Completion standard

No completion claim until every still-valid Audit II/master-plan item is `CLOSED`, demonstrably `SUPERSEDED` by a stronger solution, an explicit `EXTERNAL-GATE` with repository-side protocol ready, or rejected for a documented technical reason showing implementation would reduce correctness/security/interoperability/usefulness.

“Too difficult”, “competitor already has it”, “requires refactoring”, “math is complicated”, “tests are green”, or “the session is ending” are not valid rejection reasons.

The final internal act must be an adversarial audit performed as if the reviewer did not write the system. It must attempt to falsify exactness, evidence legality, measurement validity, causal identification, decision certification, security, compatibility and the completion claim itself.

The intended destination remains:

> A complete practical AI FinOps system, economic ledger, measurement system, causal inference platform, robust decision engine, safe-control layer, evidence/provenance protocol, and extensible public-interest reference implementation—held together by a small trusted epistemic kernel that refuses to claim more than the evidence warrants.
