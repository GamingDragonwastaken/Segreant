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
