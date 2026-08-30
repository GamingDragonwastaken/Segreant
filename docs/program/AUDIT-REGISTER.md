# Audit Register

Status vocabulary: `OPEN`, `PARTIAL`, `IN_PROGRESS`, `COMPLETED`, `SUPERSEDED`, `EXTERNAL_GATE`, `REJECTED_WITH_REASON`.

| ID | Severity | Finding | Status | Acceptance condition |
|---|---|---|---|---|
| AII-001 | P0 | Realization lower bound counts units with unknown required gates as realized | PARTIAL | Core rule and affected fixtures now require every declared predicate; generalized WorkUnit adapters and universal terminal-bound migration remain |
| AII-002 | P0 | Negative claims infer absence from missing observations without completeness witness | OPEN | Completeness witness required for `no incident`, `no off-path spend`, and analogous negative claims |
| AII-003 | P0 | Pass/fail/unknown collapses evidence conflict | OPEN | Kernel supports supported/refuted/conflicted/unknown with conflict-preserving aggregation |
| AII-004 | P1 | Git commit is treated as universal work atom | OPEN | General WorkUnit/OutcomeContract adapter architecture; coding is one adapter |
| AII-005 | P1 | Line survival overclaims code quality | OPEN | Rename/retype to literal artifact persistence; remove quality implication |
| AII-006 | P1 | Spend-to-commit correlation is temporal heuristic presented too strongly | OPEN | Typed temporal attribution with uncertainty; no contribution-proof implication |
| AII-007 | P1 | Acceptance is pooled normalized-line retention | OPEN | Contribution engine benchmarked for file identity, moves, rewrites, structure/semantics, unresolved cases |
| AII-008 | P0 | Four RoI lenses are treated as commensurable constitutional peers | OPEN | Retype contribution, outcome evidence, causal estimand, utility; old composite explicitly descriptive only |
| AII-009 | P1 | Geometric mean described as economically forced/non-compensatory | OPEN | Correct mathematical claims and labels; retain only under explicit axioms/preferences |
| AII-010 | P0 | Lift uses arbitrary defaults/fallback bounds | OPEN | Counterfactual estimand + identified set + declared assumptions; no arbitrary Manski-like labels |
| AII-011 | P0 | Impact maps workflow labels to universal cardinal value | OPEN | Multidimensional outcomes + explicit utility/preferences |
| AII-012 | P0 | `realizedValueUsd` sometimes names attributed spend | OPEN | Monetary semantic rename/migration; reserve value for outcome/economic value |
| AII-013 | P0 | Four financial truth layers are too coarse/linear | PARTIAL | Exact Money/Rate, provider/local Evidence and persisted mixed-basis reconciliation Claims now exist; complete typed economic claim DAG and subledger remain |
| AII-014 | P0 | `established:boolean` collapses trust/evidence dimensions | PARTIAL | Canonical Claim now embeds ClaimProfile and profile-derived aliases; migrate persisted/API/UI consumers and remove alternate booleans |
| AII-015 | P1 | Evidence strength treated as global total order | OPEN | Claim-relative partial ordering/evidence predicates |
| AII-016 | P0 | Grain is not a type-level truth constraint | OPEN | No Granularity Laundering enforced in derivations |
| AII-017 | P0 | Money not exact end-to-end | PARTIAL | Provider/local/reconciliation kernel paths, bundled exact decimal pricing, live proxy/import exact request issuance, complete-coverage exact budget enforcement/advice, schema-owned exact allocation projection/persistence, exact economic export, read-only exact economic API, coding value-attribution lineage, grouped usage/cohort/model/series reads and frontier/time-reclaimed projections now use exact Money and canonical coefficients; migrate refreshed-card provenance and legacy request/DB/frontier/receipt/team authoritative paths and remove accounting-number authority |
| AII-018 | P1 | Missing analytical economic subledger | PARTIAL | Immutable EconomicEvent foundation, exact decimal pricing boundary, role-aware append-only persistence, deterministic projections, bounded one-source additive price corrections, historical exact FX lineage, effective request-charge projection, exact allocation persistence, exact economic export, `/api/economic`, coding realization rollups, grouped usage/cohort/budget reads, frontier/time-reclaimed projections and strict exact receipt v2 now exist as a local candidate; complete event-role/conservation semantics, FX consumer integration beyond grouped requests, signed remote-rollup storage, close state and product integration remain |
| AII-019 | P0 | Immutability model inconsistent | PARTIAL | SQLite-backed immutable Evidence/Assumption/Claim/Derivation/Witness/DAG records, economic digests/triggers/source links, event-time dependency ordering, billing Claims, atomic exact request issuance, validated additive price corrections, legacy-reprice convergence, schema-owned exact allocation lineage, read-only exact economic projections, exact coding/usage snapshot lineage and semantically verified receipt v2 now exist; signed remote-rollup persistence and complete event projections remain |
| AII-020 | P0 | Signed receipt may be read as proving claim truth | PARTIAL | Exact receipt v2 separates integrity/signature from semantic exact-coverage validation and retains explicit effective/source lineage; interoperable attestation semantics and remote trust-anchor governance remain |
| AII-021 | P0 | Causal subsystem inference/design gaps | OPEN | Joint inference, ITT semantics, blocks, missingness, interference, power/precision corrected |
| AII-022 | P1 | Two causal systems coexist | OPEN | Single estimand/design/estimator registry; superseded method versioned/archived |
| AII-023 | P1 | Anytime inference not cluster/adaptive enough for real workflows | OPEN | Dependency-aware/adaptive research lane; assumptions surfaced |
| AII-024 | P1 | Structural drift labelled Goodhart | OPEN | Rename to structural/metric drift; Goodhart only with additional evidence |
| AII-025 | P0 | Observational frontier can say `evidence_supported` | OPEN | Observational/statistical label only; causal lane owns causal decision claims |
| AII-026 | P1 | Budget recommendation heuristic overclaims decision quality | OPEN | Scenario label now; later risk/utility/constraint-aware decision engine |
| AII-027 | P1 | Current VOI is instrumentation sensitivity, not VOI | PARTIAL | Legacy `src/value/voi.ts` remains sensitivity-labelled; separate `src/decision/engine.ts` now implements explicit perfect-information VOI with measurement cost |
| AII-028 | P1 | Reliability shrinkage weight labelled confidence; theorem overclaim | OPEN | Rename/local-data weight, regularize boundaries, document exchangeability |
| AII-029 | P0 | Documentation/runtime contract drift | OPEN | Generated/conformance-tested capability/schema/claim/egress contracts; economic CLI inspection, typed `/api/economic` and exact coding/usage/cohort/budget payload fields now exist but do not replace the universal generated contract |
| AII-030 | P0 | Browser/server schemas can drift | PARTIAL | Billing ClaimProfile summaries, exact economic projection and exact coding/usage/cohort/budget fields now cross bounded route/client contracts; canonical runtime schema and generated/shared types remain |
| AII-031 | P0 | Root proxy/body and proposal buffering lacks universal caps | OPEN | Bounded inbound/capture/frame/tool-arg/response buffers + truncation/coverage semantics |
| AII-032 | P1 | DB relies heavily on application-managed integrity | OPEN | Review and push critical invariants into DB where sound |
| AII-033 | P1 | Supply-chain assurance below target | OPEN | CodeQL/static security, dependency review, SBOM, provenance/signing, secret scanning |
| AII-034 | P1 | Hand-rolled OIDC requires production-grade scrutiny | IN_PROGRESS | Deterministic clock semantics now; later mature JOSE-vs-custom decision and production validation |
| AII-035 | P0 | Exact-head CI red on macOS OIDC time-boundary race | COMPLETED | OIDC clock repair plus exact-SHA GitHub run `33253835881` green across root Ubuntu/macOS/Windows, package-smoke, and team-server Ubuntu/macOS/Windows |
| AII-036 | P0 | No universal formal legality of evidence derivations | PARTIAL | Canonical Derivation/Witness legality, evidence-grounded persistent witness registry and soundness tests now exist; universal issuance integration and all product consumers remain |
