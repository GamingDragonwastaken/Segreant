# Fiscus Economic Control Foundation

> Research design, not yet product truth. This document proposes the mathematical and
> systems foundation for the next stage of Fiscus. A formula appearing here is not a
> release claim. Anything promoted into the product must acquire tests, provenance,
> calibration evidence, and the same withholding rules as the rest of Fiscus.

Status: research branch, 2026-08-18

## 0. Executive thesis

Fiscus should not try to win by being another AI-cost dashboard, another gateway with
budget caps, or another prompt router. All three categories now exist in the market.
The stronger product is an **evidence-constrained economic control plane for AI
execution**:

1. establish what was consumed and what it actually cost;
2. attribute that cost without collapsing financial bases;
3. define the candidate *execution plans* that could perform a use case;
4. learn organization-specific distributions of quality, cost, latency, risk, and
   realized outcome for those plans;
5. reject plans that cannot satisfy hard policy, quality, latency, residency, or
   budget constraints;
6. choose among the surviving plans using conservative economic bounds;
7. abstain or fall back when the evidence cannot support a change;
8. record the ex-ante decision, its alternatives, bounds, policy version, and
   propensity;
9. observe the ex-post outcome;
10. use off-policy evaluation and controlled exploration before allowing a learned
    policy to enforce itself.

The mathematical ambition belongs here: not complicated equations for their own sake,
but a system that can turn incomplete observations into bounded decisions **without
pretending that unknowns are measurements**.

The invariant remains:

```text
metered usage != provider-billed cost != allocated cost != realized value
```

This foundation extends it:

```text
observed association != causal effect != safe policy improvement != enforced policy
```

## 1. Why the original problem still matters, and why the moat must move

The original Fiscus problem was correct: AI expenditure can be volatile, distributed
across providers and teams, difficult to attribute, and weakly connected to business
outcomes. The FinOps Foundation's 2026 State of FinOps survey reports that 98% of its
respondents now manage AI spend and describes AI cost management as the top skill gap;
its framework increasingly emphasizes unit economics and value rather than historical
cost explanation alone.

But the market changed. Providers and gateways increasingly ship spend alerts, hard
limits, rate limits, conditional routing, canaries, multi-provider gateways, and cost
analytics. Amazon Bedrock has intelligent prompt routing. OpenAI exposes project spend
alerts, rate limits, a hard project spend-limit object, and organization cost APIs.
Portkey exposes budget limits, routing, fallbacks, canaries, and multi-provider gateway
controls.

Therefore these features are important integrations, not a defensible thesis by
themselves.

The gap Fiscus can own is the layer above them:

> **Given an organization's current evidence, workload, constraints, prices, and
> business outcomes, what AI execution policy is economically justified; how certain
> are we; what evidence would change the decision; and which parts can safely be
> enforced now?**

That question subsumes spend governance, model choice, harness choice, budget pacing,
value measurement, and automated control without collapsing them.

## 2. A route is an execution plan, not a model name

Selecting `gpt-X` versus `claude-Y` is too small an action space. In modern systems the
same model can behave very differently under different inference-time paradigms,
reasoning effort, retrieval configuration, tools, prompt versions, caching, batching,
and fallback policies. Recent work on paradigm routing reports that no single reasoning
paradigm dominates across tasks, reinforcing that the economically relevant object is
the execution plan rather than the model alone.

For request/task `t`, define context:

```text
x_t = {
  use_case,
  modality,
  customer_or_tier,
  data_sensitivity,
  region_or_residency,
  input_size_features,
  task_features,
  required_schema,
  deadline_and_SLA,
  quality_floor,
  business_outcome_definition,
  current_budget_state,
  policy_state
}
```

The context should default to structural, privacy-preserving features. Raw prompt or
output content is not required and should remain opt-in because content telemetry may
contain PII or other sensitive material.

Define an execution plan:

```text
a = (
  provider,
  model,
  endpoint_or_deployment,
  reasoning_or_agent_paradigm,
  prompt_version,
  retrieval_configuration,
  tool_policy,
  cache_or_batch_policy,
  reasoning_effort,
  output_limit,
  retry_policy,
  fallback_policy
)
```

For each context and plan, the unknown outcome is a vector, not a single score:

```text
Y_t(a) = (Q_t(a), C_t(a), L_t(a), R_t(a), V_t(a))
```

where:

- `Q` = use-case quality/goodput or task success;
- `C` = full economic cost;
- `L` = latency / time-to-result;
- `R` = policy, safety, reliability, compliance, or other risk dimensions;
- `V` = realized business value when that quantity is actually measurable.

Fiscus should estimate distributions or defensible intervals for these quantities,
not only point estimates.

## 3. Why "task complexity" cannot be the routing law

Task complexity can be a useful feature. It must not become the central decision
variable.

The optimal question is not "how hard is this task?" It is "what is the *marginal
advantage* of one execution plan over another for this context, after cost and
constraints?"

A simple counterexample is enough. Suppose a hard task has predicted success 0.45 on a
cheap plan and 0.46 on a plan costing ten times as much. The task is difficult, but the
expensive plan buys almost no capability. Escalating merely because the task is hard is
irrational. Conversely, a seemingly simple but high-consequence structured task may
score 0.92 on the cheap plan and 0.99 on the expensive one when the policy requires
0.98. The second task may deserve escalation despite being "simpler."

For two plans `a` and `b`, the useful signal is therefore closer to:

```text
Delta_Q(a,b|x) = E[Q(a)-Q(b) | x, D]
```

and, when value can be priced:

```text
Delta_NetValue(a,b|x) = E[V(a)-C(a) - (V(b)-C(b)) | x, D]
```

Recent RouteLMT work reaches a related conclusion in machine translation: marginal gain
from the expensive model is a better budget-allocation signal than absolute difficulty
or absolute quality prediction. This does not prove the Fiscus design, but it is strong
support for rejecting a one-dimensional complexity router.

Complexity remains in `x`; it does not become the objective.

## 4. Financial truth needs more than list price

Enterprise model selection on public list price alone is not financially correct.
Negotiated rates, prepaid commitments, credits, cached or batch pricing, provisioned
throughput, self-hosted compute, storage, retrieval, tool calls, evaluator calls,
retries, fallbacks, and human supervision may materially change the economic result.

FOCUS v1.3 already distinguishes concepts including List Cost, Contracted Cost, Billed
Cost, and Effective Cost. Fiscus should interoperate with that vocabulary rather than
inventing incompatible financial semantics.

A useful cost stack is:

```text
ListCost
ContractedCost
MeteredEstimatedCost
BilledCost
EffectiveCost
AllocatedCost
FullWorkflowCost
```

`FullWorkflowCost` for a task/agent run can be defined as:

```text
C_full =
    effective_inference_cost
  + retrieval_cost
  + external_tool_cost
  + evaluator_or_judge_cost
  + retry_and_fallback_cost
  + cache_storage_or_compute_cost
  + orchestration_cost
  + human_supervision_cost_if_instrumented
```

Every component carries its basis and provenance. If a component is unknown, Fiscus
does not silently replace it with zero. It may report a known lower bound and name the
missing terms.

This yields a second important rule:

> A route can be cheaper on list price and more expensive on effective or full-workflow
> cost. Recommendations must state which cost basis they optimize.

## 5. Universal economics, domain-specific outcomes

The universal object should be the **decision grammar**, not one universal definition of
quality or value.

A coding workflow, support assistant, document generator, image generator, chatbot, and
agent do not share the same objective outcome. Trying to force them into one raw metric
would reproduce the mistake Fiscus was created to avoid.

Instead, each use case supplies an `OutcomeAdapter`. Examples:

| Use case | Objective outcome candidates |
| --- | --- |
| coding | tests, merge, deployment, survival, revert/incident, review/rework |
| support | resolution, escalation, reopen, SLA, CSAT where available |
| document | accepted, published, downstream use, correction/rework |
| image/creative | accepted asset, revision count, publish/use, campaign outcome |
| chatbot | resolution, successful handoff, abandonment, repeat question |
| agent | goal completion, constraint compliance, interventions, durable downstream result |

The adapter emits common *evidence fields*, not a fake common meaning:

```text
OutcomeEvidence = {
  outcome_name,
  value_or_success_measure,
  evidence_grade,
  interval_or_bounds,
  observed_at,
  provenance,
  coverage,
  assumptions
}
```

The code realization funnel remains a strong coding adapter. It should not be presented
as proof that every modality has equivalent verification today.

## 6. Separate realization, causal value, and utility

Three ideas must not be collapsed:

1. **Realization**: did an output become a durable/useful observed outcome?
2. **Causal increment**: how much better was the world because this AI plan was used
   rather than the relevant alternative?
3. **Utility**: given organizational preferences and constraints, how desirable is the
   resulting outcome?

A merged and surviving commit is strong evidence that work realized. It is not by
itself evidence that AI *caused* productivity improvement. The fundamental
counterfactual remains missing.

Use an explicit evidence ladder for causal/value claims:

| Grade | Evidence class | Example |
| --- | --- | --- |
| A | randomized controlled comparison | task/request A/B with valid assignment |
| B | strong quasi-experimental design | valid diff-in-diff, discontinuity, synthetic control |
| C | adjusted observational / off-policy evaluation | adequate overlap + logged propensities + diagnostics |
| D | matched/before-after/reference baseline | useful but weaker counterfactual |
| E | model-derived/manual-equivalent/self-report | planning/supporting evidence, not causal proof |

The exact grade names are a Fiscus design decision; the hierarchy is what matters. A
claim such as `IncrementalValue = E[Y(1)-Y(0)]` should only be used when the design
supports that interpretation.

This matters because empirical AI-productivity evidence is heterogeneous. METR's 2025
randomized study of experienced open-source developers found a slowdown in its studied
setting. That result is valuable precisely because it warns against assuming AI use is
productive; it is not a universal theorem that AI makes developers slower. Fiscus
should learn each organization's result rather than import a preferred answer.

## 7. Keep the RoI score, but stop asking it to select policies

Fiscus's geometric composite can remain valuable as a **descriptive,
non-compensatory score** if its semantics are tightened. It should not be the universal
objective function for routing.

The current four lenses are useful dimensions. But treating them as literal sequential
conditional probabilities and saying the product is forced by the probability chain
rule is too strong unless each term is constructed as the corresponding conditional
event probability over a non-overlapping chain. Acceptance, Realization, Lift, and
Impact as currently measured are not automatically such a chain; they can overlap in
what they encode.

Therefore keep two explicitly different objects:

### A. RoI Score

A normalized score for descriptive comparison, with:

- explicit dimensions;
- geometric/non-compensatory aggregation as a policy choice;
- full-weight identification interval for missing dimensions;
- coverage;
- no claim that the score itself is dollars, causal effect, or a probability of value.

### B. Economic Return

Only where a defensible monetary value basis exists:

```text
GrossReturn = RealizedValue / FullEconomicCost

CausalReturn = IncrementalValue / FullEconomicCost
```

An alternative finance convention is `(IncrementalValue - FullEconomicCost) /
FullEconomicCost`; Fiscus must choose and name the convention rather than using "ROI"
ambiguously.

The decision engine should consume distributions/bounds and constraints directly. It
should not route by maximizing the RoI Score.

## 8. The Evidence-Constrained Frontier

For each candidate plan, maintain conservative summaries such as:

```text
z_a(x) = (
  LCB_delta(Q_a),
  UCB_delta(C_a),
  UCB_delta(L_a),
  UCB_delta(R_a),
  LCB_delta(V_a)
)
```

where `LCB`/`UCB` are lower/upper bounds at a declared level or otherwise clearly named
planning bounds.

Plan `b` evidence-dominates `a` only if it is no worse on all relevant conservative
bounds and strictly better on at least one. The non-dominated set is the
**Evidence-Constrained Frontier (ECF)**.

This is a better human-facing object than a single "best model" ranking. It can answer:

- cheapest plan that still clears the quality/SLA floor;
- fastest plan inside the budget;
- highest lower-bound value among compliant plans;
- which alternatives are currently indistinguishable;
- what evidence is missing before an alternative can dominate the incumbent.

## 9. Feasibility comes before optimization

Define the hard feasible set:

```text
F(x) = {
  a in A(x) :
    policy_allowed(a,x) = 1,
    P(Q_a < q_min | x,D) <= eps_Q,
    P(L_a > SLA | x,D) <= eps_L,
    P(C_a > c_cap | x,D) <= eps_C,
    residency_ok(a,x) = 1,
    security_ok(a,x) = 1
}
```

Not every constraint needs a probabilistic form. Provider allow/deny lists, data
residency, encryption requirements, tool restrictions, and schema compatibility may be
deterministic policy constraints.

Then optimize *inside* `F(x)`.

When business value is not established, a reasonable conservative objective is:

```text
a* = argmin_{a in F(x)} UCB_delta(C_full(a) | x)
```

That means: choose the cheapest plan only among plans for which the evidence says the
required quality/SLA/risk floor is likely to hold.

When business value is established:

```text
a* = argmax_{a in F(x)} LCB_delta(E[V(a)-C_full(a) | x])
```

This is intentionally conservative. An organization may choose different risk
preferences, but the preference must be explicit.

If `F(x)` is empty or evidence is too weak, the correct output is not a fabricated best
plan. It is abstention, fallback to a known baseline, or human review.

## 10. The budget is an online resource constraint, not only a cap

A yearly or monthly budget creates a sequential allocation problem. Spending a dollar
now changes the opportunity set later. This is naturally related to contextual bandits
with knapsack constraints: each request arrives with context, an action produces reward
and consumes budget/resources, and total consumption must remain within a global
constraint.

For horizon `T` and budget `B`:

```text
maximize    Sum_t E[r_t(a_t)]
subject to  Sum_t E[c_t(a_t)] <= B
```

A practical primal-dual controller can score feasible plans using a dynamic budget
price:

```text
a_t = argmax_a [ reward_LCB(x_t,a) - lambda_t * cost_UCB(x_t,a) ]
```

and update `lambda_t` as spend runs ahead of or behind the desired budget trajectory.

This gives Fiscus a mathematically legitimate **dual price of intelligence budget**:
`lambda` is the opportunity cost of consuming one more unit of constrained budget under
the stated optimization problem.

This is stronger than calling the derivative of an assumed fitted power-law curve a
universal shadow price. The older curve remains usable as an explicitly hypothetical
scenario model; the decision-grade dual should come from the actual constrained
control problem.

## 11. Tail risk: an average cost is not enough for agents

Agentic workflows can have retry loops, tool fan-out, fallback chains, and long output
variability. A mean cost can look safe while a small tail probability destroys the
budget.

Fiscus should therefore report a cost distribution or empirical scenario distribution:

```text
p50, p90, p99, max-observed, P(cost > cap), expected shortfall/CVaR
```

Conditional Value-at-Risk (CVaR) is useful because it measures the average loss in the
worst tail rather than only a threshold quantile. Rockafellar and Uryasev showed a
convenient optimization representation. For loss/cost `C` and confidence `alpha`:

```text
CVaR_alpha(C)
  = min_eta [ eta + 1/(1-alpha) * E[(C-eta)_+] ]
```

For Fiscus, the "loss" can be workflow cost or budget overrun. The practical point is
not financial jargon: an enterprise should be able to say "optimize normal cost, but do
not accept a routing policy whose worst 1% of agent runs has uncontrolled spend."

## 12. Forecast the budget as demand x unit economics, with uncertainty

The current p90-with-headroom recommendation is a useful guardrail heuristic, not a
forecasting engine.

A more rigorous forward model decomposes horizon spend by use case:

```text
Spend_H = Sum_j Sum_{t in H} N_{j,t} * C_{j,t}(A_t)
```

where uncertainty exists in:

- request/workflow volume;
- task mix;
- input/output/reasoning length;
- route selection;
- cache hit rate;
- retries/fallbacks;
- model/provider prices;
- negotiated commitments and credits;
- outcome-dependent follow-up work.

Use empirical bootstrap or Monte Carlo scenarios before imposing a parametric
distribution that the data cannot support. Emit:

```text
E[Spend]
p50 / p90 / p99 Spend
P(BudgetBreach)
CVaR of overrun
budget depletion date distribution
scenario contribution / sensitivity breakdown
```

Every forecast carries the price-card/contract versions and the policy version that
produced it. A routing policy change invalidates the previous spend distribution unless
explicitly modeled.

## 13. The Decision Ledger is the data asset the current frontier lacks

Historical model comparisons are confounded when operators chose which model to use.
A future policy cannot be evaluated honestly unless Fiscus records why and with what
probability each action was selected.

Introduce an immutable `DecisionRecord`:

```text
DecisionRecord = {
  id,
  context_features_or_hash,
  candidate_plans,
  chosen_plan,
  policy_id,
  policy_version,
  propensity_of_chosen_plan,
  estimates_and_bounds_at_decision_time,
  constraints_and_feasible_set,
  budget_state,
  rationale_codes,
  model_price_versions,
  created_at,
  resulting_outcome_ref
}
```

The ledger stores the minimum sufficient structural features by default, not raw prompt
or output content.

A deterministic incumbent policy can record propensity `1` for its chosen action, but
that makes the limitation obvious: alternatives with zero historical support cannot be
reliably evaluated from those rows. Fiscus should say `no overlap` rather than invent a
counterfactual.

This ledger also creates the product's strongest audit surface: a human can ask "why did
Fiscus spend $0.18 on this plan instead of $0.03 on that one?" and inspect the *ex-ante*
reason, not a story reconstructed after the result was known.

## 14. Safe learning: observe -> simulate -> recommend -> canary -> enforce

Automation should have maturity states:

```text
observe
simulate
recommend
canary
enforce
```

### Observe

Record decisions and outcomes. No routing change.

### Simulate

Use historical data to evaluate candidate policies. Report overlap, effective sample
size, estimator assumptions, and confidence bounds. No routing change.

### Recommend

Show the candidate and its evidence to a human. The human decides.

### Canary

Spend an explicit **exploration budget** on controlled low-risk traffic. Record
propensities. Never hide exploration inside normal traffic.

### Enforce

Only after a safe-improvement gate passes.

Off-policy confidence-sequence research is directly relevant: it provides
nonparametric, anytime-valid bounds for off-policy evaluation and has been demonstrated
for gated deployment of contextual-bandit systems. Fiscus already uses anytime-valid
thinking elsewhere; this is where that machinery can become operationally decisive.

## 15. Regret budgets: optimize savings without silently spending quality

A buyer rarely wants "minimize AI cost at any quality loss." The economically meaningful
contract is closer to:

> Save as much as possible while the evidence says degradation relative to the trusted
> baseline is no worse than the amount I am willing to tolerate.

Define quality regret relative to baseline policy `pi_0`:

```text
Regret_Q(pi) = E[ Q(pi_0) - Q(pi) ]
```

Require:

```text
UCB_delta(Regret_Q(pi)) <= tau_Q
```

and then minimize cost or maximize net value. Similar regret budgets may exist for
latency, reliability, or escalation rate.

This is more interpretable than an opaque cost-quality weight. An enterprise can set
`tau_Q = 0` for a high-risk workflow, or allow a small bounded trade for a low-risk
batch process.

A candidate policy that cannot demonstrate the regret bound stays in recommend/canary
mode.

## 16. Exploration is a budgeted activity

The current Fiscus planning curve assigns no budget to a context with no observed value.
That is safe against blind spending, but it also means an unseen plan can remain unseen
forever even if it is superior.

Separate exploitation budget from **exploration budget**.

For low-risk workloads, exploration may use constrained UCB/Thompson-style methods,
contextual-bandit methods, or simple randomized canaries. For high-risk workloads, use
shadow evaluation, offline benchmark replay, or human-approved A/B designs.

The key product rule is:

> Exploration must be declared, bounded, attributable, and reversible.

An enterprise should be able to see exactly how many dollars and requests were spent to
learn whether a new plan was better.

## 17. True Value of Information, and what Fiscus currently has

The current `src/value/instrumentationSensitivity.ts` is valuable sensitivity analysis but is not yet Value of
Information in the formal decision-theoretic sense. It inserts a disclosed reference
value (0.5 by default) for each missing lens and ranks the score movement. That answers:

> "Which unmeasured dimension could move this score most at this reference?"

It does not answer:

> "What is this measurement worth because it could change the decision?"

Rename the existing concept to something like **Instrumentation Sensitivity** or
**Measurement Exposure**.

If a defensible predictive distribution exists, expected value of sample information is:

```text
EVSI(M)
  = E_z[ max_a E[U(a) | D,z] ]
    - max_a E[U(a) | D]

NetVOI(M) = EVSI(M) - Cost(M)
```

where `M` is a possible measurement and `z` is its result.

Fiscus must not invent a probability distribution only to compute an elegant EVSI. When
priors/predictive distributions are not defensible, use a partial-identification /
minimax-regret formulation. Let `Theta(D)` be the parameter set consistent with current
evidence:

```text
Regret(a; Theta)
  = sup_{theta in Theta} [ U(a*(theta), theta) - U(a,theta) ]
```

Prefer the measurement that most reduces worst-case decision regret per unit of
measurement cost. This turns `unknown` into an economically useful object: uncertainty
has a price because resolving it can change an action.

## 18. Audit of existing mathematical components

### `src/value/anytime.ts` — keep, generalize carefully

The beta-mixture confidence-sequence construction is serious and appropriate for a
continuously viewed dashboard under its assumptions. The next concern is not the
algebra but the data-generating process: a global Bernoulli stream can become
nonstationary when task mix, model policy, team, or workflow changes. Stratify where
possible and re-certify after material policy/model changes.

### `src/value/drift.ts` — keep the e-process, weaken the causal label

The process can detect rate/regime drift. It cannot identify Goodhart gaming as the
cause. Rename the output toward `metric/regime drift` and make Goodhart one diagnostic
hypothesis among several.

### `src/value/reliability.ts` — keep shrinkage, rename "reliability"

Empirical-Bayes shrinkage is valuable for thin cells. But `n/(n+kappa)` is the weight
placed on cell-local evidence versus the prior under that model; it is not a probability
that the estimate is correct. Call it shrinkage weight/evidence weight. Avoid blanket
claims that this exact empirical-Bayes estimator is guaranteed by Stein's theorem to
beat raw estimates in every Fiscus setting.

### `src/value/frontier.ts` — strong evidence layer, not yet a policy learner

The frontier already does unusually good work exposing mixed attribution, stale
pricing, unit-size differences, session clustering, multiple comparisons, and operator
selection confounding. Preserve those disclosures. Add Decision Ledger + propensity
logging + off-policy evaluation before turning historical comparisons into automatic
routing.

### `src/value/marginal.ts` — retain as explicit scenario model

The water-filling derivation is mathematically correct *conditional on* the chosen
power-law value response:

```text
V_i(s) = a_i s^beta
```

The weak point is identification, not calculus. A single observed `(spend,value)` point
can fit `a_i` but cannot establish that changing spend causes movement along that curve.
Within-context window ratios still assume stable context quality and a causal
spend-value relation. A never-tried context receives zero fitted weight, preventing
exploration. Therefore expose the result as a scenario under `power_law_response`
rather than a decision-grade causal optimum. The future budget dual from the constrained
policy problem is the more defensible operational shadow price.

### `src/budget/recommend.ts` — keep as a heuristic guardrail, not a forecast

`p90 * headroom` is a transparent cap heuristic. The 0.5 realized-rate threshold and
headroom factors are policy choices. Label them accordingly. Replace "projected monthly
waste" with a scenario/heuristic name unless a forecast model is actually run.

### `src/budget/allocate.ts` — current `exploratory_raw` label is correct

Do not strengthen it until comparable marginal-return evidence exists. The code already
states that generic cells may be unlike work and are not actionable allocation evidence;
that restraint should become the design pattern for the entire allocator.

### `src/value/instrumentationSensitivity.ts` — repair immediately after current correctness work

Phase-1 already showed that an observed-lens score under weight renormalization is not a
universal ceiling: measuring a missing lens can move the observed score either way. Any
remaining stale text or logic based on the old monotone claim should be removed. Then rename
this module's output away from
formal Value of Information until EVSI/minimax decision value is implemented.

## 19. Calibration is a first-class gate

A router's probability estimate is not trustworthy merely because it is between zero and
one. For each use case / plan family, evaluate calibration with reliability diagrams and
proper scoring rules such as Brier score or log loss where appropriate.

A route may be accurate in aggregate and dangerously miscalibrated around the exact
quality threshold that controls escalation.

Therefore `RouteReadiness` should include at least:

```text
coverage
support / overlap
effective_sample_size
calibration
freshness
price_basis
outcome_evidence_grade
drift_state
constraint_test_status
```

Failure in a load-bearing component downgrades automation mode. A high average benchmark
score cannot compensate for no overlap or stale prices.

## 20. Model/judge scores are evidence sources, not truth

Some use cases need evaluators or LLM judges because objective outcomes arrive late or
are expensive. They can be useful surrogate rewards, but Fiscus must record:

```text
judge_model
judge_version
rubric_version
prompt_or_eval_hash
calibration_set
human_agreement_if_available
known_biases
```

A surrogate may accelerate learning but should not overwrite observed business outcomes
when those arrive. Recent contextual-bandit research explicitly studies using noisy or
misspecified surrogate rewards; the safe architectural lesson is to keep surrogate and
real outcomes separable so a bad judge cannot poison the truth layer invisibly.

## 21. Nonstationarity is normal

Models, prices, prompts, tools, customer mix, and organizational workflows change. A
policy trained on last quarter's model version is not automatically certified for this
quarter's replacement.

Version at least:

```text
provider_model_revision
execution_plan_version
prompt_version
retrieval/tool versions
pricing/rate-card version
contract version
outcome adapter version
policy version
calibration/evaluator version
```

A material version change creates a new evidence era. Historical rows remain immutable;
new estimates state what eras they pool and why pooling is defensible.

## 22. Interoperability instead of a private ontology

Use external standards where they improve portability:

- OpenTelemetry GenAI semantic conventions for provider/model/token/workflow telemetry
  and tracing vocabulary;
- FOCUS for financial cost/charge semantics, especially List/Contracted/Billed/Effective
  cost and commitments;
- provider-native cost APIs for reconciliation rather than treating local metering as an
  invoice.

Fiscus adds the decision/evidence layer on top. It should not fork common vocabulary for
things already standardized.

## 23. Architecture implied by the mathematics

```text
L0  Observation
    proxy/import/OTel/provider data; privacy-preserving raw facts

L1  Financial truth
    metered/list/contracted/billed/effective/reconciled cost + provenance

L2  Execution graph
    request -> tool/retrieval/retry/fallback spans -> full workflow cost

L3  Outcome evidence
    domain adapters, realization, delayed outcomes, causal evidence grades

L4  Statistical evidence
    distributions, confidence sequences, shrinkage, calibration, drift,
    partial-identification bounds, OPE diagnostics

L5  Decision engine
    feasible set, evidence-constrained frontier, forecast, regret budget,
    global budget dual, robust optimizer

L6  Enforcement
    observe / simulate / recommend / canary / enforce

L7  Audit and UI
    Claim Inspector + Decision Inspector + Route Readiness + provenance
```

The browser should expose why a number or decision exists, not only the result.

## 24. Two signature inspectors

### Claim Inspector

For any displayed number:

```text
value / interval
basis
provenance
scope
coverage
freshness
assumptions
missing evidence
what would change the claim
```

### Decision Inspector

For any route/budget/model recommendation:

```text
chosen plan
candidate plans
hard constraints
estimates and confidence bounds
budget state / dual price
why alternatives were eliminated
whether choice was exploratory
policy and estimator versions
ex-post outcome when available
```

This turns the core Fiscus thesis into an interface: important claims become inspectable
objects.

## 25. Implementation sequence

Do not start with an automatic smart router. Build the evidence required to know whether
a router is improving anything.

1. Finish existing correctness/Phase-2 remediation and freeze current truth semantics.
2. Add canonical economic types: cost basis, evidence grade, execution plan, constraint,
   outcome evidence, decision record, readiness.
3. Make financial vocabulary FOCUS-compatible where semantics match; preserve Fiscus's
   stricter unknown/provenance rules.
4. Add Decision Ledger in observe-only mode.
5. Extend proxy/import adapters to record plan identity and policy/propensity where
   available; do not store raw content by default.
6. Build the Evidence-Constrained Frontier over observed plans with conservative bounds;
   no automatic route changes.
7. Replace budget "forecast" language with either explicit heuristic or an empirical
   scenario forecast emitting breach probabilities and tail risk.
8. Add controlled experiment/canary infrastructure and explicit exploration budgets.
9. Implement off-policy evaluation with overlap and effective-sample-size diagnostics;
   add anytime lower/upper bounds where mathematically justified.
10. Add Route Readiness and safe-policy-improvement gates.
11. Enable recommendation mode.
12. Enable canary mode for opt-in low-risk workloads.
13. Enable enforcement only where evidence and policy gates pass.
14. Implement formal VOI/minimax-regret instrumentation selection once decisions and
    measurement costs exist.
15. Expand outcome adapters beyond coding, one domain at a time, without weakening the
    evidence contract.

## 26. Benchmark and falsification plan

The economic-control thesis must be falsifiable. Before calling the router superior,
benchmark it against simple baselines:

```text
always cheapest
always strongest
fixed organization default
simple prompt-length / token heuristic
simple task-type rule
static two-model threshold router
current operator policy
```

Measure on held-out or prospective traffic:

```text
quality/goodput
full cost
latency
constraint violations
budget breaches
tail cost (p99/CVaR)
calibration
abstention rate
realized outcome where mature
policy regret vs trusted baseline
```

The 2026 LLMRouterBench result is a warning worth institutionalizing: many sophisticated
routers do not reliably beat simple baselines under unified evaluation. Fiscus should
make `beats_simple_baseline` a release criterion for any claimed smart-routing
algorithm.

A complex method that fails this test is deleted or demoted, not defended because it is
interesting.

## 27. What may actually be novel

None of contextual bandits, OPE, confidence sequences, CVaR, FOCUS, Pareto frontiers,
causal inference, or VOI is new by itself. Fiscus must not claim mathematical novelty
merely for combining known results.

Potential research novelty may emerge from the integration and from specific algorithms,
for example:

- evidence-constrained plan frontiers that combine financial-basis provenance with
  statistical bounds and enforcement readiness;
- a safe policy-improvement gate that jointly budgets cost, quality regret, tail spend,
  and evidence overlap;
- minimax-regret instrumentation choice under Fiscus's explicit `unknown` semantics;
- multi-level delayed-outcome learning where cheap structural signals are surrogates for
  later verified realization/business outcomes;
- auditable ex-ante Decision Receipts linking a route to its candidate set, evidence,
  constraints, and later outcome;
- dynamic budget dual pricing combined with provider commitments and outcome value.

These are hypotheses. Novelty requires a proper literature search, formalization,
benchmarking, and preferably external review/publication. The product should be useful
even if every mathematical ingredient turns out to have prior art.

## 28. Nonclaims

Until the relevant evidence exists, Fiscus must not say:

- "this is the best model for the task" when it only saw historical operator selection;
- "this route saves X dollars" when X is only list-price arithmetic or a point scenario;
- "this plan preserves quality" without an explicit quality outcome and uncertainty;
- "this spend caused X value" from realization evidence alone;
- "the task is complex, therefore use a stronger model";
- "we know the counterfactual" without randomized/quasi-experimental/OPE support;
- "the router is intelligent" because it is more complicated than a baseline;
- "unknown cost/value is zero";
- "a drift alarm proves gaming";
- "a score is a probability" unless it was actually constructed and validated as one;
- "automatic" when the control is only proposed/observed.

The product's moat depends on refusing those sentences before competitors do.

## 29. Research references

Primary/authoritative sources used to shape this research direction:

- Agrawal, Devanur, Li (2016), *An efficient algorithm for contextual bandits with
  knapsacks, and an extension to concave objectives*, COLT / PMLR 49.
- Karampatziakis, Mineiro, Ramdas (2021), *Off-Policy Confidence Sequences*, ICML /
  PMLR 139.
- Rockafellar & Uryasev (2000), *Optimization of Conditional Value-at-Risk*, Journal of
  Risk 2(3).
- Ong et al. (2025), *RouteLLM: Learning to Route LLMs from Preference Data*, ICLR 2025.
- Li et al. (2026), *LLMRouterBench: A Massive Benchmark and Unified Framework for LLM
  Routing*, Findings of ACL 2026.
- Luo et al. (2026), *RouteLMT: Learned Sample Routing for Hybrid LLM Translation
  Deployment*, arXiv:2604.22520 (preprint; treat as such).
- Li, Gao, Lakshmanan (2026), *WISERouter: LLM Routing with Workload Budget Constraint*,
  arXiv:2607.23765 (preprint; treat as such).
- Zhou et al. (2026), *Select-then-Solve: Paradigm Routing as Inference-Time Optimization
  for LLM Agents*, arXiv:2604.06753 (preprint; treat as such).
- METR (2025/2026), randomized developer-productivity research and follow-up design
  notes.
- FinOps Foundation, *State of FinOps 2026*, Unit Economics capability, and FOCUS v1.3.
- OpenTelemetry GenAI semantic conventions.
- OpenAI API reference for project spend limits and organization Costs/Usage APIs.
- Amazon Bedrock documentation for Intelligent Prompt Routing.
- Portkey AI Gateway/Budget/Conditional Routing documentation.

## 30. Decision

The recommended foundation is not "make Fiscus a more complicated FinOps dashboard."
It is:

> **Fiscus becomes the evidence-constrained allocator and governor of AI economic
> decisions. It measures the money, learns the organization's actual outcome frontier,
> prices uncertainty and budget scarcity, refuses unsupported counterfactuals, and only
> graduates a recommendation into enforcement when the evidence can carry it.**

That direction preserves the original ambition—turn scattered AI usage into something
an enterprise can rationally govern—while giving the mathematics a job worthy of its
complexity.
