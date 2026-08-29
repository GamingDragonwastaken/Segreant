# Decision Log

This file records architecture decisions that materially constrain later implementation. Entries are append-only in spirit: later changes supersede earlier decisions explicitly rather than rewriting history.

## D-001 — Preserve the high-assurance candidate

**Decision:** Branch the reconstruction from `31577d5b112653e5aa4dff5a0bdaae9fd58a982c`; do not rewrite or merge PR #8 merely to simplify the new program.

**Why:** The candidate contains valuable causal, egress, backup, diagnostics, billing, package and release work. Foundational reconstruction should preserve evidence and history rather than erase it.

## D-002 — Large capability surface, small trusted truth boundary

**Decision:** Fiscus may remain extremely broad, but epistemic strengthening belongs to a small Trusted Epistemic Kernel.

**Consequences:** Feature modules may emit observations, measurements, candidate derivations and actions. They may not invent stronger claim semantics independently.

## D-003 — Existing capability is a benchmark, not a retreat signal

**Decision:** Competitor/standard existence does not justify dropping a useful capability. Choose native, interoperable, or both based on independence, correctness, evidence integrity, maintainability and user value.

## D-004 — Four-lens RoI is not constitutional truth

**Decision:** Realization, Acceptance, Lift and Impact are heterogeneous objects. The legacy composite may survive only as an explicitly normative/descriptive view with disclosed normalizations and preferences.

**Primary spine:** `Evidence -> Measurement -> Outcome -> Counterfactual Effect -> Utility -> Decision`.

## D-005 — Four financial truth boxes become a typed DAG

**Decision:** Preserve `metered != billed != allocated != value` as an anti-conflation principle, not as a sacred count of four layers. Introduce separate types for usage observation, estimated monetary cost, provider-observed/billed/effective cost, allocation, delivered outcome, causal contribution and economic utility.

## D-006 — Open-world evidence semantics

**Decision:** Absence of an adverse event cannot prove a negative claim without an explicit completeness witness for event type, scope and time. Required outcome predicates that are unknown cannot count as confirmed.

## D-007 — Contradiction is not failure or ignorance

**Decision:** Kernel claim state will evaluate a Belnap-compatible four-state model (`supported`, `refuted`, `conflicted`, `unknown`) rather than forcing contradictory evidence into pass/fail/unknown.

## D-008 — Exact monetary core

**Decision:** Canonical internal money/rate arithmetic must not depend on IEEE-754 binary floating point. Currency and scale are part of the type. Float USD remains a compatibility/presentation boundary until migrated.

## D-009 — Corrections are additive

**Decision:** Move toward immutable observations and issued claims, explicit correction/supersession/revocation events, and current-state projections. Do not destroy historical evidence to make current reads convenient.

## D-010 — Grain is part of truth

**Decision:** A claim finer than its source evidence requires an explicit allocation/attribution/disaggregation witness. Project-day evidence does not silently become request-level fact.

## D-011 — Construct validity is first-class

**Decision:** A statistically precise observable cannot become another construct without a MeasurementModel/validation witness. Line persistence, acceptance, deployment and business value remain distinct.

## D-012 — Causality has one registry

**Decision:** Causal protocol, estimand, design, estimator and inference contract must be explicit and shared. Legacy research paths cannot remain alternative truth machines with incompatible semantics.

## D-013 — Descriptive evidence cannot silently become policy

**Decision:** Observational frontier, heuristic budget and similar modules may inform analysis but automatic/consequential action requires a DecisionCertificate satisfying the declared evidence/risk policy.

## D-014 — Standards interoperability over proprietary envelopes

**Decision:** Use FOCUS for cost semantics where appropriate, OpenTelemetry for compatible telemetry, and existing provenance/attestation standards where they outperform bespoke equivalents. Fiscus innovation should live in AI-economic semantics and composition.

## D-015 — Deterministic time for time-boundary security tests

**Decision:** Security code that validates temporal claims must expose an explicit clock dependency or equivalent deterministic seam. Tests must not assert a one-second boundary using two independently sampled wall clocks separated by network/crypto work.

## D-016 — Public-interest software quality model

**Decision:** Optimize for durable independent usefulness rather than conventional SaaS differentiation. Funding/business model is owner-reserved and must not dictate technical truth.
