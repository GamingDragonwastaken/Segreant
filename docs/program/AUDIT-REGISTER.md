# Audit Register

This register is the durable mapping from discovered issue to disposition. Severity reflects risk to truth, security, financial semantics, or release integrity rather than visual impact.

| ID | Severity | Finding | Source | Required disposition | Status |
| --- | --- | --- | --- | --- | --- |
| A-001 | P1 | Exact-head CI red on macOS team-server OIDC `nbf` test due wall-clock race at the 60-second tolerance boundary. | CI run 33222840344; `team-server/test/oidc.test.ts`; `team-server/src/oidc.ts` | Deterministic clock injection and fixed-boundary tests; exact-head CI green. | OPEN |
| A-002 | P0 conceptual | `realized` permits required lifecycle gates such as tested/merged/shipped to remain unknown while documentation describes verified shipped work. | `src/value/gates.ts`; `docs/THE-STANDARD.md` | OutcomeContract semantics: required unknown -> unresolved, never confirmed. | OPEN |
| A-003 | P1 conceptual | Mature `clean` may infer pass from absence of observed incident without completeness evidence. | `src/value/realization.ts` | CompletenessWitness/open-world semantics for negative claims. | OPEN |
| A-004 | P1 conceptual | `pass/fail/unknown` cannot represent conflicting evidence. | gate/signal model | Introduce supported/refuted/conflicted/unknown claim state in trusted kernel. | OPEN |
| A-005 | P1 math | Realization/Acceptance/Lift/Impact are heterogeneous object types forced into peer normalized scalars. | `src/value/lenses.ts` | Demote composite; separate contribution, outcome, causal effect, utility, decision. | OPEN |
| A-006 | P1 math | Geometric mean is described/tested as economically forced and non-compensatory beyond what axioms establish. | `src/value/lenses.ts`; `test/equation.test.ts` | Correct terminology and role; retain only as explicit normative descriptive composite if useful. | OPEN |
| A-007 | P1 math | Acceptance information enters multiple paths, risking mechanical double counting. | realization/lift/lenses paths | Separate contribution evidence from outcome and causal estimands. | OPEN |
| A-008 | P1 measurement | Acceptance is normalized exact-line multiset retention rather than edit distance/semantic contribution. | `src/value/proposals.ts` | Rename legacy metric and build benchmarked file/structure/semantic contribution architecture. | OPEN |
| A-009 | P1 measurement | Git-blame line survival is a narrow persistence observable, not general code quality. | `src/git/quality.ts` | Demote to measurement model observable; validate any construct mapping. | OPEN |
| A-010 | P1 attribution | Spend-to-commit mapping is primarily a temporal/project heuristic, not direct contribution evidence. | `src/git/correlate.ts` | Type as attribution method with grain/scope/confidence; do not silently upgrade to contribution proof. | OPEN |
| A-011 | P1 semantic | Fields named `realizedValueUsd` can mean spend on realized units and elsewhere manual-equivalent value. | realization/frontier/dashboard contracts | Rename internal semantic types; compatibility aliases only where necessary. | OPEN |
| A-012 | P1 math | Lift heuristic discounts/scenario bounds are over-described as partial-identification/Manski-style bounds. | `src/value/lift.ts` | Rename heuristic scenarios; causal/counterfactual estimands become primary. | OPEN |
| A-013 | P2 math | Stale TSF derivative commentary is incorrect for `B/T`. | `src/value/lift.ts` | Correct derivation/tests/docs. | OPEN |
| A-014 | P1 math | Current pseudo-VoI is sensitivity to plug-in lens value, not decision-theoretic information value. | `src/value/voi.ts` | Rename to instrumentation sensitivity; implement decision VoI later. | OPEN |
| A-015 | P1 math | Empirical-Bayes reliability overclaims Stein-style dominance and calls shrinkage weight confidence. | `src/value/reliability.ts` | Correct theory/terminology and boundary regularization. | OPEN |
| A-016 | P1 stats | Bernoulli anytime-valid confidence sequence guarantee is vulnerable if applied to clustered/dependent commits without matching assumptions. | `src/value/anytime.ts` | Declare stochastic contract; add cluster/adapted alternatives before decision-critical use. | OPEN |
| A-017 | P2 semantic | Drift e-process detects structural change, not Goodhart causation. | `src/value/drift.ts` | Rename statistical object; separate causal gaming hypothesis. | OPEN |
| A-018 | P1 policy | Observational model frontier can use overly strong `evidence_supported` language despite confounding, clustering, selection and sliding-window caveats. | `src/value/frontier.ts` | Observational-only labels; causal lane alone can qualify intervention claims. | OPEN |
| A-019 | P1 policy | Budget recommendation and Shadow Price are heuristic/observational planning models, not decision-grade causal economics. | budget/marginal modules | Reclassify; require decision certificates for automatic actions. | OPEN |
| A-020 | P1 money | Root operational ledger uses JS `number`/SQLite REAL money; microdollar exactness begins after float quantization. | store/pricing/allocation | Canonical exact Money/Rate algebra; float only at compatibility/presentation boundaries. | OPEN |
| A-021 | P1 persistence | Raw observations, mutable projections, price corrections and issued receipts have inconsistent mutability semantics. | store/realization/receipts | Immutable event/evidence model; corrections/supersession additive; projections derived. | OPEN |
| A-022 | P1 causal | Protocol labels estimand ITT while qualification behavior is closer to strict adherence/per-protocol eligibility. | causal protocol/qualification | Separate estimand definitions and compliance strategies. | OPEN |
| A-023 | P1 causal | Blocked randomization design is not fully reflected in pooled arm estimator. | causal assignment/estimate | Block/design-consistent estimator and inference. | OPEN |
| A-024 | P1 causal | Joint cost-quality authorization uses marginal intervals without explicit simultaneous coverage semantics. | causal estimate/qualification | Intersection-union/joint confidence or controlled alpha allocation. | OPEN |
| A-025 | P1 causal | Minimum completed per arm is a floor, not power/precision/decision-error design. | causal protocol | Add prospective design targets. | OPEN |
| A-026 | P1 causal | Interference and clustering assumptions are not first-class. | causal protocol | Interference declaration + analysis/design restrictions. | OPEN |
| A-027 | P1 research | Older `value/causalExperiment` and new causal subsystem can encode conflicting inference contracts. | causal research modules | Single estimand/design/estimator registry; archive/version superseded research. | OPEN |
| A-028 | P1 contract | Browser/server API types are manually duplicated and comments document prior schema drift bugs. | dashboard web API types | Canonical contract/schema and runtime validation. | OPEN |
| A-029 | P2 security | Proxy/body/proposal capture paths need global bounded-input semantics and explicit coverage loss on truncation. | proxy/server/stream proposal paths | Bounded readers and typed truncation evidence. | OPEN |
| A-030 | P2 assurance | Local receipt signing/key model lacks enterprise lifecycle, revocation and external trust-root semantics. | receipt/signing paths | Interoperate with mature attestation/trust standards; add key lifecycle only where justified. | OPEN |
| A-031 | P2 architecture | Architecture/capability docs can drift from executable contracts. | docs vs source | Mechanically generated/conformance-tested capability/schema/claim contracts. | OPEN |
| A-032 | P1 ontology | Four financial truth boxes are too coarse for usage estimate/provider observation/billed/effective/allocation/outcome/causal/utility DAG. | product/claim inspector | Replace constitutional four-box ontology with typed truth/economic DAG while preserving compatibility views. | OPEN |
| A-033 | P1 grain | Evidence grain is not universally encoded as a truth constraint. | reconciliation and attribution paths | No Granularity Laundering law in kernel. | OPEN |
| A-034 | P1 measurement | Statistical validity can exist while construct validity is absent. | value/outcome modules | MeasurementModel + Construct/Measurand/Surrogate validity witnesses. | OPEN |
| A-035 | P1 research | Novelty risk: partial identification, regret, proof-carrying data, provenance and experiment selection have strong prior art. | research audit | Novelty claims limited to demonstrated composition/system contribution after external review. | OPEN |
| A-036 | P2 product/public-interest | Competitive saturation was previously treated too strongly as a reason to retreat from useful capabilities. | prior planning | No Capability Abandonment Clause; native/interoperable/both decided technically. | POLICY FIXED |

## Closure rules

An item may be marked CLOSED only with exact code/doc evidence and verification appropriate to the claim. `SUPERSEDED` requires a stronger implemented solution. `EXTERNAL GATE` is allowed only when repository-internal implementation/protocol is complete and the remaining evidence genuinely requires an external system, real data, credential, deployment, user study, or independent reviewer.
