# Research Register

Research status is separate from implementation status. No research object may be presented as production truth merely because code exists.

## Maturity scale

`CONJECTURE -> FORMALIZED -> UNIT_VERIFIED -> SIMULATION_VALIDATED -> BENCHMARK_VALIDATED -> FIELD_VALIDATED -> DECISION_VALIDATED -> PRODUCTION_QUALIFIED`

## Register

| ID | Research object | Current maturity | Prior art / benchmark | Fiscus-specific question | Promotion requirement |
| --- | --- | --- | --- | --- | --- |
| R-001 | Trusted Epistemic Kernel type/witness calculus | CONJECTURE | refinement types, abstract interpretation, provenance logics, Belnap-style evidence logics | Can heterogeneous AI-economic derivations be statically/dynamically prevented from strengthening evidence, grain, construct or trust without witnesses? | Formal semantics, counterexamples, soundness properties, reference implementation, conformance suite. |
| R-002 | No Evidence Laundering | CONJECTURE | provenance/formal methods/partial identification | Can every claim-strengthening step be represented as a witness-bearing refinement? | Define order/semantics and prove non-escalation for kernel transformations. |
| R-003 | No Granularity Laundering | CONJECTURE | statistical aggregation/disaggregation, provenance | Can grain refinement be made a first-class type obligation across billing, attribution and causal outcomes? | Formal grain lattice/order, sound refinement witnesses, adversarial tests. |
| R-004 | No Construct Laundering | CONJECTURE | metrology, construct validity, surrogate outcomes | Can measurement/surrogate validity be encoded so precision never substitutes for validity? | MeasurementModel semantics + benchmarked adapters. |
| R-005 | Four-valued claim state | FORMALIZED conceptually | Belnap-Dunn/bilattices | Does supported/refuted/conflicted/unknown compose usefully with evidence profiles and revocation? | Algebra/merge rules, conflict tests, UX proof that conflict is not hidden. |
| R-006 | Abstract-interpretation formulation of evidence state | CONJECTURE | Cousot & Cousot | Can admissible-world/evidence transformations use sound abstract domains without making the kernel unusably complex? | Prototype domain, soundness proof sketch, countermodel extraction, performance assessment. |
| R-007 | Realization terminal bounds | UNIT_VERIFIED legacy but semantically flawed | partial identification | What is the correct lower/upper bound when required predicates are unknown/conflicted and source completeness varies? | New OutcomeContract semantics, proofs/tests, simulation. |
| R-008 | Contribution attribution | CONJECTURE redesign | edit distance, tree/AST differencing, semantic similarity, provenance | Can Fiscus estimate AI contribution robustly across exact retention, rewrites, moves, replacements and ambiguity? | Labeled benchmark corpus, precision/recall/calibration, failure taxonomy. |
| R-009 | Bernoulli e-process confidence sequence | UNIT_VERIFIED under iid Bernoulli assumptions | sequential inference/e-values | How should dependence/cluster/adaptive contexts be handled before decision use? | Stated stochastic contract; cluster/adapted alternative; simulation under dependence. |
| R-010 | Structural-change e-process | UNIT_VERIFIED as rate-change detector | sequential change detection/e-values | Can it diagnose regime change without causal Goodhart claims? | Rename, calibration, multiplicity semantics if multiple streams. |
| R-011 | Reliability empirical-Bayes shrinkage | UNIT_VERIFIED implementation, theory claims under review | beta-binomial empirical Bayes | What guarantee and terminology are actually justified, especially at boundaries? | Correct theory, boundary regularization, simulation/coverage/calibration. |
| R-012 | Observational model frontier | UNIT_VERIFIED mechanics | observational comparison/OPE | Can useful historical signals be separated cleanly from causal routing claims? | New labels, confounding sensitivity, cluster-aware uncertainty; no causal promotion. |
| R-013 | Causal randomized-study lane | UNIT_VERIFIED infrastructure | randomized experiments/design-based inference | Can Fiscus produce valid cost/quality/net-benefit claims across blocked designs, missingness, interference and compliance? | Estimand registry; design-consistent estimator; joint inference; governed real study for field validation. |
| R-014 | Minimax-regret decision layer | CONJECTURE | robust decision theory/partial identification | Can evidence sets feed auditable decision certificates without hiding preferences? | Formal utility/constraint interfaces, property tests, simulations, benchmark decisions. |
| R-015 | True Value of Information | CONJECTURE | Bayesian/decision-theoretic VOI, experiment design | Can Fiscus recommend the cheapest/highest-value next evidence acquisition under explicit decision loss? | Decision model, measurement-cost model, simulations, benchmark against simple sensitivity. |
| R-016 | Preference-robust decisions | CONJECTURE | robust MCDA/set-valued utility | Can Fiscus identify decisions stable across a declared preference region rather than one hidden scalarization? | Preference-region representation, dominance/regret tests, user-facing explanation. |
| R-017 | Safe policy improvement | CONJECTURE | OPE/safe RL/sequential inference | Can routing/budget changes be enacted only with lower-bound improvement under constraints? | Valid OPE/experimental evidence, sequential guarantee, rollback/control protocol. |
| R-018 | Proof-carrying economic claims | CONJECTURE composition | W3C PROV, VC, in-toto/SLSA, SCITT, proof-carrying data | What Fiscus-specific predicate semantics are missing from existing envelopes? | Standards mapping, minimal predicate, interoperable verifier, external review. |
| R-019 | Economic subledger | FORMALIZED architecture | accounting ledgers, FOCUS cost semantics | What immutable postings/events are necessary without pretending Fiscus is a GAAP GL? | Exact Money core, conservation invariants, reconciliation/migration tests. |
| R-020 | Bitemporal economic knowledge | CONJECTURE | valid/transaction time, event sourcing | Can Fiscus answer both “what was true/effective?” and “what did we know then?” across repricing/reconciliation/revocation? | Data model, query semantics, migration/performance tests. |

## Novelty rule

The following are established prior art and must never be claimed as Fiscus inventions by themselves: partial identification, confidence sequences/e-processes, minimax regret, value of information, causal estimands, provenance DAGs, signed attestations, proof-carrying data, four-valued logics, abstract interpretation, FOCUS-like cost normalization, OpenTelemetry-style telemetry.

A possible original contribution must survive a targeted literature search, explicit comparison against closest prior art, counterexamples, reproducibility, and eventually external expert review. Until then use `possible original contribution`, never `novel theorem/framework` as a public claim.
