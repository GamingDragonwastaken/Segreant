# Decision Log

## D-001 — Reconstruction branch
**Decision:** Build on `gpt56/magnum-opus-reconstruction`, starting exactly from `31577d5...`.
**Reason:** Preserve PR #8/Luna work as a reviewed foundation while allowing constitutional migration without rewriting shared history.

## D-002 — Capability non-retreat
**Decision:** Existing competitor/standard capability is a benchmark/interoperability target, not an abandonment trigger.
**Reason:** Fiscus is intended as enduring, broadly useful public-interest software rather than a differentiation-minimized startup product.

## D-003 — Small truth core, broad capability edge
**Decision:** Introduce a Trusted Epistemic Kernel controlling evidence/claim/money/measurement/derivation/decision semantics. Feature modules remain broad but cannot mint stronger truth independently.
**Reason:** Prevent semantic debt from allowing respectable modules to compose into unsupported economic conclusions.

## D-004 — OIDC failure repair
**Decision:** Inject a verifier clock and test exact temporal boundaries against fixed time. Do not widen `nbf` test threshold as the primary repair.
**Reason:** Root cause is wall-clock drift during async JWKS work; deterministic time removes environmental nondeterminism and makes the 60-second contract testable.

## D-005 — Conservative decision primitives
**Decision:** Keep strict interval dominance as the only proof-level selection, and expose minimax regret and perfect-information VOI as explicitly named decision rules with assumptions and measurement cost. Overlap, missing competitors, invalid intervals, and malformed scenario sets remain non-certifiable.
**Reason:** A recommendation must not be relabelled as objective truth merely because an optimizer returned an action. The decision engine therefore separates proof (`proven_dominant`) from rule-based selection and preserves the uncertainty model in its output.

## D-006 — Revocation is additive graph closure
**Decision:** Represent revocation as a projected transitive closure over prerequisite-to-dependent edges; retain node history and independent siblings, tolerate cycles during traversal, reject duplicate edges, and make repeated revocation idempotent.
**Reason:** Deleting or last-write-wins replacement would erase the evidence path that explains why a descendant is no longer certifiable. The pure closure is the first executable kernel primitive; persistent DAG/event storage remains a later M1 slice.

## D-007 — Strict realization fixtures carry explicit lifecycle evidence
**Decision:** Update synthetic and integration fixtures to provide every declared coding predicate (`merged` and `shipped` included) when they claim terminal realization. Keep maturing/uninstrumented fixtures unresolved and preserve the strict production lower bound.
**Reason:** The old fixtures depended on unknown-as-pass. Making unknown gates pass would reverse the Audit II correction; supplying truthful synthetic evidence exercises the same production funnel without weakening it.

## D-008 — Evidence is an immutable envelope, not a trust bit
**Decision:** Canonical Evidence requires explicit source identity/class, scope/grain, acquisition time, separate integrity/authenticity/completeness, and schema/version metadata. Raw payloads are cloned/frozen JSON when retained; hash/reference-only evidence is supported for sensitive content. Unknown top-level fields, including `trusted`, are refused.
**Reason:** A well-formed or signed record can establish integrity without establishing authenticity, completeness, or proposition truth. The envelope makes those axes inspectable and prevents accidental field drift at the kernel boundary.

## D-009 — Claims retain their derivation and profile context
**Decision:** Canonical Claims require typed propositions, at least one evidence dependency, a derivation rule/version, explicit coordinates/time/uncertainty, and matching epistemic/causal profile axes. Monetary basis and finality aliases are copied from the profile and cannot diverge.
**Reason:** Claim consumers need a stable issued object without allowing `established:boolean` or duplicate semantic fields to erase uncertainty, provenance, or economic meaning. Persistence, derivation legality, and as-of replay are subsequent kernel slices.

## D-010 — Derivation strengthening is witness-gated
**Decision:** A canonical Derivation binds input/output claim identities and propositions, records coordinate changes and reproducibility metadata, and refuses any increase in grain, scope status, coverage, construct validity, causality, monetary finality, integrity, authenticity, epistemic information, or decision fitness without the corresponding witness kind.
**Reason:** Coordinate geometry and profile labels describe a change but do not authorize it. Keeping the legality assessment explicit makes unsupported semantic escalation machine-checkable and explainable.

## D-011 — DAG snapshots are immutable projections
**Decision:** Evidence/Claim/Assumption/Measurement/Decision dependencies are represented as validated immutable snapshots. Dependency edges are acyclic; supersession is not a dependency; as-of and revocation are projections with trace paths, never destructive updates.
**Reason:** The kernel must answer what was knowable and why a descendant became non-certifiable without erasing history. A pure snapshot API is safe to compose now; append-only persistence and event replay follow as a separate slice.
