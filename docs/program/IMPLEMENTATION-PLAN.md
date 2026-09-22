# Fiscus Constitutional Reconstruction Implementation Plan

> **For agentic workers:** execute task-by-task with test-first changes, frequent coherent commits, exact-SHA verification, and durable-state updates.

**Goal:** Reconstruct Fiscus so broad AI-economic capabilities sit on a small, machine-checkable epistemic/financial/measurement/decision foundation without discarding the high-assurance work already present.

**Architecture:** Preserve the current candidate as an adapter-rich operational foundation. Introduce a Trusted Epistemic Kernel beneath legacy value/reporting surfaces, migrate semantics dependency-first, and use compatibility translations rather than allowing old labels to weaken kernel invariants.

**Tech Stack:** TypeScript/Node 24, SQLite, built-in `node:test`, existing CLI/dashboard/team-server packages, GitHub Actions.

**Spec:** owner-approved `FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md`, SHA-256 `0092098ce085a63006bfcd6d63f5fca7f5dc2d25b4f7b112daa1dd0d8bdeb8cc`.

## Global constraints

- Never develop directly on `main`.
- Unknown is not pass; conflicted evidence is not unknown.
- No floating-point representation is authoritative for new accounting-core money.
- No causal claim without identification witness; no fine-grain claim from coarser evidence without attribution/disaggregation witness.
- No negative claim from absence without completeness witness.
- Raw evidence and issued claims are append-only/versioned; corrections do not erase history.
- Existing capabilities are preserved/migrated unless superseded by a demonstrably stronger solution.
- Every verification claim binds to an exact SHA.

---

### Task 1: Establish green deterministic baseline

**Files:** `team-server/test/oidc.test.ts`, `team-server/src/oidc.ts`, program registers.

**Invariant:** JWT temporal validation is a deterministic function of claims, skew policy, and verifier time; network/JWKS latency must not alter a boundary test's meaning.

Steps: add an explicit clock input to the config in the test first; verify the old implementation fails typecheck/test; implement minimal clock injection; assert inside/exact-boundary/outside cases; run team tests and full CI; record exact SHA.

### Task 2: Epistemic state primitive

**Create:** `src/epistemic/state.ts`; `test/epistemic-state.test.ts`.

**Interfaces:** `EvidencePolarity {support:boolean; refute:boolean}`, four-valued `EpistemicState`, truth/information joins, conflict-preserving aggregation.

**Invariant:** Adding refuting evidence to supported evidence yields `conflicted`, never `unknown` or silently `refuted`; absence of both is `unknown`.

### Task 3: Scope, grain, and time primitives

**Create:** `src/epistemic/scope.ts`, `src/epistemic/grain.ts`, `src/epistemic/time.ts`; tests.

**Invariant:** A derivation cannot claim strictly finer grain/scope without a declared refinement witness. Time interval containment and bitemporal observation/validity metadata are explicit.

### Task 4: Exact Money and Rate algebra

**Create:** `src/economics/money.ts`, `src/economics/rate.ts`; property/adversarial tests.

**Invariant:** canonical amounts use exact integer/decimal/rational representation; addition requires compatible currency/basis; conversion requires explicit rate and effective time; round-trip serialization is exact.

### Task 5: Claim/Evidence/Derivation core

**Create:** `src/epistemic/claim.ts`, `evidence.ts`, `derivation.ts`, `witness.ts`, `revocation.ts`; tests.

**Invariant:** derivation output cannot strengthen epistemic state, grain, measurement validity, causal status, monetary finality, or trust dimension without the corresponding witness. Revocation closes transitively over the dependency DAG.

### Task 6: MeasurementModel and CompletenessWitness

**Create:** `src/measurement/model.ts`, `completeness.ts`; tests.

**Invariant:** negative propositions requiring event absence cannot become supported unless completeness covers event type, scope, time, and source. Statistical precision cannot upgrade an unvalidated proxy construct.

### Task 7: WorkUnit/OutcomeContract migration

**Create:** `src/outcomes/*`; modify legacy realization adapter.

**Invariant:** confirmed outcome requires every required predicate supported; any required refutation fails; otherwise unresolved. Legacy Git commits map into WorkUnits but are not universal atoms.

### Task 8: Economic event subledger

Create/migrate typed immutable economic events for estimate/provider observation/billed/effective/credit/discount/tax/FX/allocation/adjustment/reversal/true-up.

**Invariant:** projections conserve declared monetary basis and preserve correction history.

### Task 9: Causal registry and estimator correction

Modify `src/causal/*`; archive/version older causal path.

**Invariant:** estimand/design/assignment/analysis are one registry; ITT primary semantics explicit; blocked design analyzed consistently; missingness/interference/multiplicity exposed.

### Task 10: Decision engine

Create utility intervals, dominance certificates, minimax regret, decision-theoretic VOI, decision fitness and constraints.

**Invariant:** no action certificate from merely descriptive/observational metric unless policy explicitly permits that evidence class.

### Task 11: Legacy value semantic migration

Rename misleading fields/labels, demote descriptive RoI composite, observational frontier and heuristic budget advice, preserve compatibility adapters.

### Task 12: Canonical contracts and conformance

Unify server/browser/CLI schemas and capability registry; add runtime validation and generated/checkable docs.

### Task 13: Security/reliability/supply chain

Bound all major buffers, review DB invariants, make the JOSE dependency decision, add CodeQL/dependency/SBOM/secret/provenance gates, fuzz/property/fault-injection harnesses.

### Task 14: Standards interoperability

FOCUS/OTel/PROV/attestation predicates and portable evidence pack without weakening Fiscus-specific semantics.

### Task 15: Final adversarial reconciliation

Reconcile every audit/master-plan item, run exact-head verification, attempt to falsify final claims, leave external gates explicit.
