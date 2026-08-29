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

## D-012 — Kernel persistence stays under the Store schema authority
**Decision:** Persist canonical Evidence, Claim, Derivation, DAG nodes/edges and revocation events in append-only SQLite tables created and protected by `src/store/schema.ts`; `Store.epistemic()` exposes the same connection, while `ledger.ts` performs validated DML and replay checks only.
**Reason:** A second database or domain-owned DDL would split transaction and migration authority. Schema-owned triggers prevent update/delete/`INSERT OR REPLACE` bypasses, and exact JSON/digest replay keeps corrections additive and auditable.

## D-013 — Assumptions are named dependencies, not prose confidence
**Decision:** Add immutable Assumption nodes and optional `Claim.assumptionIds`; preserve existing human-readable assumption strings for compatibility, but only ID-linked assumptions enter the dependency graph and revocation closure.
**Reason:** A decision cannot explain or invalidate an opaque text list. Named nodes make assumptions queryable, scoped, time-qualified, evidence-linked and independently revocable without pretending they are a global confidence score.

## D-014 — Historical revocation is event-time bounded
**Decision:** Current revocation uses all retained events; an as-of projection includes only events recorded by the requested boundary and only nodes visible at that boundary.
**Reason:** Later knowledge must not leak backward into a historical decision replay. The rule preserves present correction while keeping “what did we know then?” reproducible.

## D-015 — Canonical bytes are part of the kernel contract
**Decision:** Evidence, Claim, Assumption and Derivation records serialize through sorted-key canonical JSON with SHA-256 envelopes; deserialization verifies kind, identity, schema/version, digest and canonical bytes before invoking the domain factory.
**Reason:** Hashing incidental object insertion order would make equivalent records incomparable and weaken replay/audit evidence. Unsupported values and cycles fail closed rather than being coerced.

## D-016 — Witnesses are first-class evidence-grounded registry records
**Decision:** A derivation witness is issued as an immutable, versioned Witness node with explicit kind, coordinates where applicable, grounding evidence IDs, issuance time and epistemic state. Stored Derivations must reference a matching registry record; the ledger persists evidence-to-witness and witness-to-claim edges and includes them in revocation/as-of projections.
**Reason:** An inline witness label can otherwise be invented, changed, or detached from the evidence that supposedly authorizes semantic strengthening. A first-class registry makes proof obligations replayable, revocable and inspectable without collapsing them into a trust bit or allowing a hidden bypass.

## D-017 — Billing enters the kernel through an explicit exact-money adapter
**Decision:** The validated operator billing import remains a compatibility read model, but its accepted lines can be issued as canonical provider Evidence and billed Claims through exact `Money`. Reconciliation claims preserve billed and local-estimate bases separately and represent the residual as a conservation-checked comparison; no provider line is allowed to affect request spend, budgets, RoI or recommendations.
**Reason:** The first product vertical must prove the kernel can carry useful financial semantics without silently converting legacy microdollar numbers, inventing provider authority, or collapsing unlike monetary bases. An explicit adapter makes migration resumable, observable and reversible at the compatibility boundary while leaving full provider-observation and subledger work visible.

## D-018 — Reconciliation claims are bound to their immutable run and basis
**Decision:** A persisted reconciliation Claim carries a unique reconciliation-run identity. Provider-side Money is `provider_observed` for a Costs snapshot and `billed` only for an explicitly imported billed line; local capture remains `estimated`, and the residual is a typed comparison that must satisfy exact provider-minus-local conservation.
**Reason:** Reusing an observation identity would make later recalculations collide with earlier decisions, while calling every provider number “billed” would erase the distinction between a Costs observation and an invoice. Explicit run identity and basis-aware arithmetic keep corrections additive and auditable.
