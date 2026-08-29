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
