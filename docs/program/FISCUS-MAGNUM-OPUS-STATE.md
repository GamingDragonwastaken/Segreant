# Fiscus Magnum Opus Program State

**Program:** Foundational Audit II reconstruction
**Owner authorization:** 2026-08-29
**Primary reconstruction lane:** `gpt56/magnum-opus-reconstruction`
**Sol integration lane:** `gpt56/sol-magnum-opus-integration`
**Reviewed foundation:** `31577d5b112653e5aa4dff5a0bdaae9fd58a982c`
**Main at authorization:** `cf4179f4571a81a2c2e12b45c4205baaf06a3eb7`
**Prior PR:** #8 (`codex/high-assurance-foundation` -> `main`), preserved and not merged.

## Governing mission

Raise Fiscus until it earns the quality bar; never lower the bar to fit the implementation. Fiscus is being developed as durable, broadly useful public-interest software with a large capability surface and a deliberately small trusted truth boundary.

The constitutional direction is:

`Evidence -> Measurement -> Claim -> Identification -> Utility -> Decision -> Authorized Action`

No feature module may silently strengthen the epistemic meaning of its inputs.

## North Star stack

- Mathematical decision foundations: von Neumann / Blackwell / Manski.
- Causal inference: Rubin / Imbens / Pearl / Bareinboim / Athey.
- Formal methods: Hoare / Dijkstra / Cousot & Cousot / Lamport.
- Evidence/information: Shannon / Belnap.
- Systems: Lampson plus SQLite/PostgreSQL-class engineering.
- Security: Saltzer & Schroeder / Ross Anderson.
- Scientific criticism: adversarial falsification and explicit separation of verified/observed/inferred/proposed/unknown.
- Public-interest software: Blender / SQLite.

Governing question: **If Fiscus were the last serious software project built by this program, what architecture would keep it technically respectable, useful, extensible, auditable, mathematically defensible, and maintainable twenty years later?**

## Concurrent execution model

The primary reconstruction lane advanced while this session was assembling its first checkpoint. GitHub correctly refused two stale non-fast-forward ref updates; no force update was used. The primary lane contains coherent authorized work and is treated as a parallel worker, not an adversary.

Observed primary-lane history at the point the Sol integration branch was created:

1. `34d8590a74b5c9bd847dbb86e023ea21120a66cd` — program bootstrap.
2. `85d63e4ad17616b6d04c70e048979d06ff6a369f` — test-first deterministic OIDC boundary specification.
3. `0411dc672b69be20989795203aad83bff4c41020` — deterministic OIDC verification context implementation.
4. `78abfbf2ccf80743185677f5577e22fa3d173f44` — test-first four-valued epistemic state specification.
5. `c521ee0b9f51d0b21bcf757026dd149f77731f5b` — conflict-preserving epistemic state implementation.

The Sol integration branch was forked from `c521ee0...` so all of that work is preserved. Future reconciliation must compare the two lanes and merge only reviewed non-conflicting work; never force one lane over the other.

## Baseline defect status

Starting exact-head CI run `33222840344` was red only because team-server macOS failed the `nbf` tolerance boundary test. Root cause: the test and verifier sampled independent wall clocks separated by asynchronous OIDC/JWKS work.

Current inherited source exposes `OidcVerificationContext` with `nowEpochSeconds?: () => number` and fixed-clock `nbf` tests. Status: **IMPLEMENTED, PENDING EXACT-HEAD CI VERIFICATION**.

Integration review notes before closing the issue:

- add deterministic exact-boundary tests for `iat` and `exp`, not only `nbf`;
- preserve/restore security-relevant explanatory comments removed incidentally by the implementation commit;
- verify the injected verification clock is not reused for JWKS cache TTLs or network timeouts;
- exact-head CI must be green.

## Workstream status

| ID | Workstream | Status | Exact next action |
| --- | --- | --- | --- |
| B0 | Durable authority/audit archive | IN PROGRESS | Commit lossless Audit II archive and reconciled registers on Sol integration lane. |
| B1 | Deterministic CI baseline | IMPLEMENTED_PENDING_VERIFICATION | Open draft PR for Sol lane, finish time-edge tests/comment restoration, obtain exact-head CI. |
| K1 | Trusted Epistemic Kernel | STARTED | Review inherited four-state algebra; extend with scope/grain and witness-bearing derivations. |
| M1 | Exact Money / Rate | QUEUED | Begin only after K1 interfaces and baseline CI are stable. |
| O1 | WorkUnit / OutcomeContract | QUEUED | Required unknown -> unresolved; commit ceases to be universal atom. |
| ME1 | MeasurementModel/completeness | QUEUED | Construct/measurand/completeness/surrogate validity. |
| C1 | Contribution attribution | QUEUED | Benchmarkable file/structure/semantic evidence hierarchy. |
| CA1 | Causal repairs | QUEUED | Estimand registry, block-aware inference, joint claims, missingness/interference. |
| D1 | Decision engine | QUEUED | Utility intervals, dominance, regret, real VoI. |
| P1 | Provenance interoperability | QUEUED | Standards mapping and Fiscus economic predicate. |
| A1 | Canonical contracts | QUEUED | Server/browser/runtime schema convergence. |
| S1 | Security/reliability | CONTINUOUS | Bounded inputs, auth, fault paths, supply chain. |
| UX1 | Evidence UX/parity | QUEUED | Multiaxial claim profile with progressive disclosure. |
| R1 | Research maturity | CONTINUOUS | Prior art and maturity remain explicit. |
| F1 | Final adversarial gate | BLOCKED | All internal dependencies + exact final evidence. |

## Non-negotiable program rules

1. Never modify `main` directly.
2. Never merge/publish/deploy/use real secrets without owner authorization.
3. Never force a shared ref to erase concurrent work.
4. Red-green-refactor for behavior changes where executable verification is available.
5. Exact-SHA evidence only; old green CI never proves a newer SHA.
6. External evidence is never fabricated.
7. Existing competitor capability is a benchmark, not an abandonment reason.
8. Research prototypes cannot silently become production truth.
9. Corrections/supersession should be additive and provenance-preserving.
10. Update this state before an active run ends.

## Current run

**Status:** ACTIVE

Execution order:

1. commit lossless Audit II archive + richer registers to Sol integration lane;
2. open a draft PR to enable exact-head CI;
3. finish deterministic OIDC edge coverage and review inherited epistemic algebra;
4. verify baseline via CI;
5. continue K1 with scope/grain and derivation witnesses;
6. reconcile useful commits arriving on primary reconstruction lane;
7. checkpoint exact SHA, evidence, blockers, and next action.
