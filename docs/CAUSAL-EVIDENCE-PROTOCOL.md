# Causal Evidence Protocol

**Candidate-source review:** 2026-08-27, the Store-owned independent producer
is bound to `0fc647c`, identity regressions to `c31e1ea`/`25cb707`/`556b5d0`,
T-069 qualification behavior to `e3cef41`, and SQLite append-only trigger
hardening to `aa24764`. The branch now has an independently derived local
identity and ordinary-ledger adapter, but the asserted identity path remains
inconclusive rather than qualified until a governed real study passes every
causal gate.

This is the contract Fiscus must satisfy before it uses causal financial
language. It is intentionally stricter than the ordinary local ledger,
price model, realized-value pipeline, or RoI Index. Those tools remain
valuable; none can reconstruct the counterfactual by itself.

## Purpose and non-goal

Fiscus is building a local-first causal-evidence lane for two questions:

1. **Model or policy comparison** — did assignment to a candidate model/policy
   reduce direct operating cost while meeting a predeclared quality guardrail?
2. **AI versus incumbent workflow** — did assignment to an AI-enabled workflow
   create positive causal net benefit under a real economic outcome basis?

It is not a general productivity oracle. It does not prove future performance,
provider invoices, organisation-wide savings, external certification, or
independent audit status. A local hash chain makes a retained evidence package
reproducible against that package; it cannot prove that every possible copy of
local data was never altered.

## Evidence hierarchy

| Grade | Fiscus may say | Fiscus must not say |
| --- | --- | --- |
| accounted | Recorded cost and usage with the stated source | Saved, caused, same value, or ROI |
| modeled | Counterfactual price/model calculation under named assumptions | Realized savings or a guarantee |
| observed | Historic association or observed/manual-equivalent value scenario | The intervention caused the outcome |
| quasi-experimental | Assumption-dependent result with diagnostics and sensitivity | Randomized evidence or unconditional certainty |
| randomized causal | Scoped ITT causal estimate with protocol hash and interval | Universal or future ROI, certification, or a provider guarantee |

## Study lifecycle

    draft -> committed -> collecting -> data_locked -> analyzed
          -> qualified | inconclusive | invalid -> exported

Only a committed protocol may assign an eligible unit. Any change to
eligibility, an arm, randomisation, outcome, cost source, quality margin, or
analysis plan produces a new protocol hash and a new study version. The
previous protocol remains inspectable but cannot silently absorb the change.

## Required pre-registration

Before the first eligible exposure, a randomized protocol must pin:

- study owner, scope, eligible population, unit of assignment, exclusion rules,
  start/end or stopping rule, and protocol version;
- each arm's exact provider/model/configuration/prompt-policy/tool/fallback
  plan, represented by a content hash rather than raw prompt content;
- allocation method and non-zero probability for every eligible arm;
- primary cost outcome, currency, source classification, price lineage rule,
  and whether it is actual reconciled, actual observed, modeled price-card, or
  incomplete/unknown;
- primary quality/value outcome, its collection method, and the
  non-inferiority margin required before same-value language;
- the intention-to-treat estimand, confidence level, sample floor,
  missingness/attrition treatment, and predeclared exclusion policy;
- the data-minimized source list, retention choice, and any explicit egress
  receipt references; and
- claim templates for qualified, inconclusive, and invalid results.

Fiscus rejects raw prompt text, source text, credentials, URLs with secrets,
and open-ended free-text payloads in the protocol's structural context. The
protocol stores declared identifiers and hashes, not a hidden copy of sensitive
input material.

### Canonical estimand registry (WP-E01)

The bounded `src/causal/estimand.ts` registry currently defines one canonical
estimand: `randomized_itt`. It records the registered eligible population,
assigned-arm intervention and comparator, pre-registered primary outcome,
registered study window, difference-in-means contrast, and explicit missingness
treatment. The registry is immutable and descriptive; it does not replace
protocol validation, qualification, estimation, persistence, or claim issuance.
Additional estimands and integration into protocol decoding remain outside this
slice.

### Additive protocol version 2

Protocol v2 is a new canonical document; it does not reinterpret or silently
upgrade version 1. V1 hashes remain the original raw lowercase 64-hex SHA-256
values and retained v1 commitments remain inspectable, but they are ineligible
for new causal mutations. A v2 commitment uses the namespaced digest
`sha256:<64 lowercase hex>` over the exact draft material with the byte prefix
`fiscus.causal.protocol\n2\n`. Commitment-only fields are not hash material.

V2 requires namespaced IDs for study/series/version ownership and scope,
eligibility and explicit inclusion/exclusion rules, a study window and stopping
rule, exactly two ordered arms, actual observed/reconciled cost sources and
price-lineage policy, quality/economic collection methods, ITT/confidence/
sample/missingness/exclusion policy, minimized sources/retention/egress digest
references, and governed claim-template IDs. Exact-key decoders reject missing
or extra fields, malformed or uppercase digests, non-finite/unsafe timestamps,
sparse/duplicate/unsorted sets, URL/path/control/credential-shaped strings, and
unsupported enums before hashing or commitment. `local_ai_judge` is not a v2
quality or economic preregistration evidence class.

Public validation, hashing, commitment, and retained verification guard the
untrusted root and exact runtime version before dispatch. Public v2 hashing
validates the complete document before projecting canonical material, and v2
positive integer fields require `Number.isSafeInteger`; malformed roots and
unsupported versions fail closed as protocol errors rather than JavaScript type
errors.

## Event lineage

Every eligible unit must have local, hash-linked events in this order:

    committed protocol
      -> decision: candidate set, feasible set, randomized assigned arm, propensity
      -> execution: assigned versus actual plan, metered request references, cost lineage
      -> outcome: maturity, quality/value evidence, missing reason if absent
      -> locked analysis snapshot

The analysis must show assignment, completion, execution adherence, missingness,
and outcome availability by arm. An outcome before assignment, a plan mismatch,
a missing source class, or an unresolved/missing outcome cannot silently count
as favourable evidence.

## Qualification gates

A randomized result is qualified only when all applicable gates pass:

1. The immutable protocol is committed before first exposure and its hash
   matches every included event.
2. At least two arms have non-zero recorded assignment probability, and the
   decision ledger can reconstruct the assignment.
3. Each included unit is within the predeclared eligible population, uses the
   exact assigned plan, and has confirmed execution adherence.
4. Cost, price-version, outcome, and quality evidence have the required
   classification and lineage.
5. All enrolled units have a resolved maturity state; missingness/attrition is
   reported and does not violate the protocol's thresholds.
6. The study reaches its predeclared completed-sample floor and produces its
   stated interval.
7. A model/policy claim meets its predeclared quality non-inferiority gate.
8. No material protocol violation or unresolved conflict invalidates the run.

A model/policy result may then say: candidate cost was lower for the recorded
eligible population under this registered protocol, while the stated quality
guardrail passed. It may not say that the candidate is universally better.

An AI-paid-for-itself or causal net-benefit claim has three additional gates:

1. a no-AI or incumbent-workflow control arm;
2. full-cost accounting for both arms; and
3. a currency or measured-labour-cost outcome basis whose conservative lower
   confidence bound for causal net benefit is above zero.

The preferred output is causal net benefit: lower bound plus a currency amount
per eligible unit, not an unconstrained ROI multiplier.

## Analysis and decisions

The first supported design is a pre-specified, blocked randomized comparison
with an intention-to-treat headline. Every result must include the point
estimate, confidence interval, arm counts, completion/missingness/adherence
table, quality result, cost source classification, protocol hash, and exact
result state. Fiscus does not turn a p-value alone into a winner badge.

For the `model_cost_quality` conjunction, the registered analysis plan uses a
family-wise confidence level: the overall alpha is split equally across the cost
and quality endpoints with a Bonferroni rule, so a 95% study reports 97.5%
component bounds rather than incorrectly AND-ing two independent 95% intervals.
An explicit `analysis.jointInference` records the method, equal alpha allocation,
endpoint family/count, the exact non-inferiority margin, the minimum USD cost
superiority threshold, and whether secondary endpoints are absent or descriptive
only. Those values are committed with the protocol and cannot be changed after
outcomes exist. Older version-1 protocols retain their original hash and receive
the same deterministic version default, disclosed in the estimate. For
`ai_vs_incumbent_net_benefit`, the direct net-benefit estimand is the one endpoint
governing the causal claim; quality and cost are reported context, not silently
added to the family. The overall level, component level, allocation, endpoint
family/count, thresholds, secondary-endpoint treatment and rule source are
returned in the estimate, CLI and dashboard status. A passing cost or quality
endpoint alone never authorizes the conjunction.

Quasi-experimental designs may later be supported, but are not a default
shortcut. A difference-in-differences result must surface its parallel-trends,
no-anticipation, comparison-cohort, pre-period, sensitivity, staggered-adoption,
and cluster-inference assumptions. If those gates are absent, Fiscus reports an
observational comparison instead.

## Recommendation rule

Recommendations are evidence-aware and review-only:

- **Qualified recommendation** — matching qualified causal study, cost result,
  and quality guardrail; requires human review before routing changes.
- **Conditional candidate** — modeled or observed cost signal, but no qualified
  causal/value-parity evidence; Fiscus offers a study plan.
- **No recommendation** — insufficient coverage, no overlap, invalid design,
  or unresolved evidence conflict.

No study result changes a provider route, budget, or model automatically.

## Data minimisation, privacy, and export

The causal lane is local-first and stores the smallest reproducible facts:
pseudonymous study/unit IDs, assignment and actual arm, timestamps,
plan/provider/model hashes, metered cost/price lineage, quality/value result,
outcome evidence references, and missingness reason. Raw prompts, source,
credentials, and output content are not required inputs and must not be stored
by default.

An export defaults to an aggregate, redacted evidence pack. Any sensitive field
requires explicit operator selection. Fiscus must never silently upload a study,
its raw evidence, or a local evaluation to an LLM, analytics service, or hosted
evaluator. If an explicit controlled-cloud source is used, the egress receipt
chain is part of the evidence pack but does not prove recipient retention or
provider-side confidentiality.

## Revocation rule

Fiscus reverts a study to inconclusive or invalid when protocol validation,
assignment reconstruction, plan adherence, cost lineage, outcome maturation,
quality criteria, interval computation, or the local evidence manifest no
longer passes. The previous result must remain visible as superseded with the
reason; it must not survive in a recommendation card as a stale green claim.

## Implementation status

Task 3 Slice 1 implements the additive in-process protocol boundary:

- exact v2 TypeScript protocol/commitment declarations;
- strict v2 draft and retained-commitment validation;
- domain-separated v2 canonical hashing and immutable local commitment;
- explicit v1 hash isolation and v1 inspect-only mutation eligibility; and
- draft/commit rejection of `local_ai_judge` for both quality and economic
  preregistration.

Slice 2 adds the domain-separated, replayable v2 assignment formulas as an
internal algorithm checkpoint. Slice 3 adds the local Store boundary: additive
v2 tables and authenticated migration, Store-owned sequence allocation and
cryptographic entropy inside one transaction, global per-study unit uniqueness,
canonical retained rows, authoritative manifests, rollback without allocation
disclosure, and a package boundary that excludes test-only deterministic seams.
These Slice 3 changes were followed by reviewed Store-only execution,
terminal-outcome, follow-up-policy, clock-authority, qualification, and T-069
scalar-lineage increments. The internal records are authenticated and
deliberately not exposed as a public v2 projection or release statement. The
T-069 slice now validates and persists a scalar-only
  `causal_lineage_bindings_v2` envelope behind an exact, append-only schema;
  reloads authenticate the canonical JSON and duplicated identity columns. The
  realization join requires a separately retained nullable
  `causal_unit_id_digest` scalar to be present and equal to the assigned unit
  digest; it never derives identity from or selects realization `unit_json`.
  The Store-owned producer now derives that scalar from retained Git metadata
  and exact request evidence, while the ordinary realization pipeline remains
  a separate path that does not call it automatically. The derived identity is
  therefore independently reproducible local evidence, not an independently
  audited causal effect; equality is a necessary join invariant, not a
  sufficient claim of causation.
Retained execution and terminal-outcome text must also round-trip to the
canonical decoded record, and realization timestamps may not precede execution
completion. A matching scalar is retained as asserted evidence only: the
validator marks the realization-to-unit identity unverified, and qualification
  remains inconclusive until a governed study, provider/account scope, and every
  other causal gate passes, even when the Store producer has produced a ready
  local assessment.
Ordinary snapshots without the scalar remain unqualified. A cost-bearing V2
result still remains fail-closed when the sidecar is absent or invalid, the
  ordinary ledger verifier fails, or any request, realization, or outcome gate
  fails.

Legacy v1 protocol and assignment records remain decodable and replayable for
inspection. They are immutable evidence: production code cannot create a new v1
assignment, and both causal-assignment preview and apply refuse v1 with
`CAUSAL_LEGACY_INSPECT_ONLY` before reading a units file or allocating an arm.
V1 protocol registration is likewise refused for preview and apply. The CLI
does not yet expose v2 protocol registration or assignment: both forms of v2
registration refuse with `CAUSAL_V2_CLI_DEFERRED` before opening or mutating the
Store, and current status/inspect/verify plus the API/dashboard expose retained
v1 evidence only. Public v2 registration/assignment/execution projection,
lifecycle ownership and data locking, qualification snapshots as a public
result, full read-only API/dashboard projection,
redacted export, packaging approval, and release remain deferred to later
reviewed slices. The internal sidecar implementation is not itself release
evidence and makes no provider-invoice or causal customer claim.
No supported current causal command mutates study evidence, changes a provider
route, changes provider configuration, or changes a budget automatically.
Fiscus still has **no qualified causal customer
result** unless and until a real executed study passes every applicable gate.
