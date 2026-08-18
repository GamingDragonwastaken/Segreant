# Token Governance, Internal AI Capital, and the Complexity Lab

> Research design only. This extends `ECONOMIC-CONTROL-FOUNDATION.md`; it does not
> change released product truth. The purpose is to preserve two original Fiscus
> ambitions that should not be lost during remediation: ending token-maxxing as a
> productivity culture, and maintaining a genuinely ambitious complexity engine as an
> inspectable experimental capability rather than deleting it because simpler decision
> rules are safer.

Status: research branch, 2026-08-19.

## 0. Executive decision

Two ideas are carried forward together:

1. **Tokens are capital consumed, never productivity produced.** Fiscus may meter,
   allocate, budget, forecast, benchmark, explain, and optimize token consumption. It
   must not convert raw token volume into an engineer-productivity score.
2. **Complexity remains a first-class research capability.** Fiscus should build an
   explicit Complexity Lab that may use sophisticated statistical, information-theoretic,
   psychometric, causal, and optimization models. The Lab is read-only/experimental by
   default. Its outputs become routing inputs only after prospective calibration shows
   incremental decision value over simpler baselines.

These are compatible. The anti-token-maxxing principle prevents resource consumption
from becoming a reward target; the Complexity Lab helps explain why some work rationally
consumes more resources than other work.

A useful extended invariant is:

```text
tokens consumed != work performed != productivity != realized outcome != causal value

raw spend difference != inefficiency

observed difficulty != marginal model advantage != optimal compute allocation
```

## 1. The token-maxxing problem is now empirically visible

The original Fiscus concern was not hypothetical. In 2026 reporting described internal
AI-usage leaderboards and AI-use signals entering performance discussions at technology
companies. The exact prevalence across all firms is not established, so Fiscus should
not claim that most enterprises grade engineers by token volume. The defensible claim is
narrower: **this incentive pattern exists, is visible enough to have become an industry
term, and creates a direct Goodhart risk.**

More useful than anecdotes is empirical efficiency evidence. Jellyfish reported an
analysis of 12,000 developers across 200 companies in Q1 2026. More token consumption
was associated with more merged PRs, but output did not rise proportionally: in its
joined subset, cost per merged PR rose dramatically at the highest usage levels. This
still does not establish causal productivity effects because task mix and developer
selection are confounded. It does establish that token volume is not a sufficient
measure of economic efficiency.

A 2026 agentic-coding study gives a stronger technical reason to reject token volume as
productivity: across repeated runs on the same SWE-bench Verified tasks, token
consumption could vary by up to 30x, higher token usage did not monotonically increase
accuracy, and human-rated task difficulty aligned only weakly with actual token cost.
This is exactly the kind of stochasticity Fiscus must model rather than reward.

The general developer-productivity literature is consistent with the design principle.
The SPACE framework explicitly rejects one-dimensional developer-productivity metrics
and warns against treating activity measures as complete productivity measures.

### Product consequence

Fiscus should surface a **Metric Safety Classification** for any people/team metric:

```text
resource_accounting
process_diagnostic
outcome_measure
causal_effect_estimate
incentive_unsafe
compensation_prohibited
```

`token_count`, `token_cost`, `request_count`, and raw AI-tool usage are always
`resource_accounting`; if somebody attempts to configure them as a performance ranking,
the system should mark that use `incentive_unsafe`.

Fiscus does not have to police an employer. It does have to refuse to make an invalid
measurement look scientifically endorsed.

## 2. The team feature should become an AI capital system, not a leaderboard

The existing team-tier architecture is a strong substrate: local-first machines produce
signed numeric rollups; the team server verifies registered keys; developer breakdowns
are opt-in and k-anonymized; raw prompts and request logs do not need to leave the
machine. Preserve that privacy boundary.

The next economic layer should model an internal hierarchy:

```text
organization
  -> business unit / cost centre
      -> product / project
          -> team
              -> workload
                  -> execution plan
                      -> developer or machine attribution (where policy permits)
```

The primary budget owner should normally be project/team/use-case, not individual
engineer. Individual attribution is useful for diagnosis and self-coaching, but tying a
personal quota directly to performance creates incentives to avoid experimentation,
hide expensive hard work, or optimize the visible measure.

### 2.1 AI Capital Account

For any account `i` and period `t`, keep separate ledgers:

```text
CapitalConsumed_i,t
  = effective AI cost actually attributable to the account

CapitalCommitted_i,t
  = prepaid / reserved / contract capacity economically assigned to the account

CapitalReserved_i,t
  = budget intentionally held for future work or incidents

ExplorationCapital_i,t
  = controlled budget allowed for learning new policies/models

OutcomeValue_i,t
  = realized or causal value on its stated evidence basis
```

Never collapse these into one number.

A team can then have an explicit budget identity:

```text
OpeningBudget
+ TransfersIn
- TransfersOut
- CapitalConsumed
= RemainingBudget
```

while realized outcomes are a separate account, not a credit that erases historical
spend.

### 2.2 Showback before chargeback

Current FinOps practice distinguishes showback from chargeback. Fiscus should support
both but default toward transparent showback during adoption: show the team what its AI
capital is doing before making the accounting punitive. Chargeback becomes an explicit
enterprise policy layer when the organization actually wants costs booked to unit
budgets.

This matters because internal capital markets have two faces. Central reallocation can
create value by moving scarce resources toward stronger opportunities, but research on
internal capital allocation also documents distortions from organizational power and
agency. Fiscus therefore needs transparent formulas, immutable decision records, and
appeal/review paths; it must not become an opaque algorithm that silently starves one
team.

## 3. What a manager should actually see

For each team/project/person scope that policy permits, the useful diagnostic is a
**vector**, not `tokens_used`:

```text
- metered tokens by class (input/output/cache/reasoning where available)
- metered estimated cost
- provider-billed/effective cost where reconciled
- attributable full-workflow cost where instrumented
- realized outcome count/rate/bounds
- cost per realized outcome
- first-pass acceptance / rework burden where valid
- quality/SLA outcomes for the workload
- current model/harness mix
- avoidable model premium (only where counterfactual evidence supports it)
- retry/fallback/tool overhead
- exploration spend vs production spend
- budget burn and breach risk
- evidence coverage and unknowns
```

The question becomes:

> Why did this scope consume this much AI capital, and did the consumption buy outcomes
> that justified it?

not:

> Who used the most AI?

## 4. Exact spend decomposition: explain differences before judging them

Suppose Engineer/Team A spent `$C_A` and B spent `$C_B`. A raw difference

```text
Delta C = C_A - C_B
```

is almost useless. A may have handled more work, harder work, larger contexts, a more
expensive region/provider, a different latency/quality SLA, more tool calls, or an
incident-heavy week.

Fiscus should decompose the difference into named drivers. Candidate factors:

```text
volume
workload_mix
structural_complexity
model_mix
reasoning_effort
prompt/context intensity
cache hit rate
tool/harness overhead
retry/fallback behavior
latency/SLA constraints
price/rate-card basis
contract/effective-cost effects
unexplained residual
```

### 4.1 Shapley decomposition

Let `f(z)` be the counterfactual cost model and `z` the vector of cost drivers. We want
an additive explanation:

```text
Delta C = sum_j phi_j
```

where `phi_j` is the Shapley contribution of driver `j`, averaged over the order in which
A's driver values replace B's. This avoids the arbitrary ordering problem in ordinary
waterfall decompositions.

For a set of drivers `N`:

```text
phi_j =
  sum_{S subset N\{j}}
    |S|! (|N|-|S|-1)! / |N|!
    * [ f(z_{S union {j}}) - f(z_S) ]
```

For a small fixed driver set the exact calculation is feasible. For a larger set use a
deterministic permutation approximation with an error estimate.

The output is then a falsifiable accounting statement such as:

```text
A spent $750 more than B.
  +$410  more workload volume
  +$160  harder workload mix
  +$105  higher-priced model mix
  +$48   retry/fallback overhead
  +$19   weaker cache utilization
  +$8    price-basis difference
   $0    residual after model
```

The numbers above are illustrative, never defaults.

### 4.2 Standardized spend residual

A second diagnostic compares actual cost with expected cost for the workload:

```text
ExpectedCost_i = E[C | workload features, constraints, policy, time]

SpendResidual_i = ActualCost_i - ExpectedCost_i

StandardizedSpendRatio_i = ActualCost_i / ExpectedCost_i
```

This is **not a productivity score**. It answers whether cost is unexpectedly high or
low after conditioning on observable work mix. The model must report uncertainty and
coverage; sparse scopes remain unscored.

### 4.3 Evidence-feasible opportunity gap

Once the Evidence-Constrained Frontier can identify cheaper plans that satisfy the same
quality/policy constraints, compute:

```text
OpportunityGap_i
  = ActualFullCost_i - CounterfactualFeasibleCost_i
```

This is the economically interesting part of “could this engineer/team have used a
cheaper model?” It should only be emitted when comparable alternatives are supported.
Otherwise the answer is `unknown`, not an accusatory savings estimate.

## 5. The internal AI capital market

The “mini economy” can be formalized without becoming a game.

Each budget scope owns scarce AI capital. Fiscus maintains a shadow price for scarce
budget, forecasts future demand, and proposes transfers toward workloads with stronger
marginal value evidence.

A team budget can be partitioned:

```text
B_total = B_base + B_experiment + B_reserve
```

- `B_base`: expected production workload;
- `B_experiment`: protected learning budget, preventing exploitation-only lock-in;
- `B_reserve`: tail-risk/incidents/unplanned work.

A reallocation proposal from scope `i` to `j` should satisfy at least:

```text
LCB( marginal_value_j - marginal_value_i ) > 0
```

under a stated evidence model, or remain a scenario rather than a recommendation.

### 5.1 Why exploration capital is mandatory

A pure “fund whoever had the best historical return” algorithm eventually starves new
projects/models of data. A plan with no history receives no budget, therefore never
produces history, therefore remains unfunded forever.

Reserve a bounded exploration budget:

```text
0 <= B_experiment <= epsilon * B_total
```

with enterprise-configured `epsilon`. Every exploratory allocation is labelled and its
outcome feeds the Decision Ledger.

### 5.2 Fairness and organizational power

Internal-capital-market research warns that powerful managers can obtain excess capital
and overinvest. Fiscus's answer should be procedural:

- decision records are immutable;
- the economic basis is inspectable;
- policy overrides are named and signed;
- manually protected strategic projects are visible as policy constraints, not hidden
  inside the optimizer;
- no algorithm may infer that low historical spend means low strategic value;
- new/sparse scopes receive explicit uncertainty/exploration treatment.

## 6. Preserve and expand the impossible ambition: the Complexity Lab

Do not remove complexity. Isolate it correctly.

Proposed product boundary:

```text
src/research/complexity/        # pure experimental mathematics
fiscus lab complexity ...       # read-only / local output
```

The main routing/control plane may consume a Complexity Lab output only after a named
calibration gate passes. Until then the Lab is inspectable research functionality.

The Lab should produce a **complexity profile**, not just one magic scalar.

```text
ComplexityProfile = {
  structural,
  informational,
  interaction,
  execution,
  epistemic,
  economic,
  model_sensitivity,
  predicted_compute,
  confidence,
  provenance
}
```

### 6.1 Structural complexity

Content-free or privacy-preserving observable features can include:

```text
input length / compressed length
number of files/entities/resources involved
dependency graph size/depth
number of tools allowed/required
schema size and constraint count
historical task-type features
context churn
required output structure
external-system count
```

The exact feature set is modality-specific.

### 6.2 Informational complexity

Where local content inspection is explicitly permitted, useful research features may
include entropy/compressibility, ambiguity proxies, retrieval dispersion, contradiction
counts, or semantic novelty relative to an organization's solved-work embedding store.
Raw content remains local unless an explicit external action says otherwise.

### 6.3 Execution complexity

Observed execution itself provides a second axis:

```text
agent steps
model turns
tool calls
branch/fanout depth
retry count
fallback count
context growth
wall-clock concurrency
```

This is measured after execution and is therefore useful for calibration, not solely
pre-route prediction.

### 6.4 Epistemic complexity

A task may be simple structurally but uncertain for the available model pool. Define
model-conditioned uncertainty rather than pretending complexity is intrinsic:

```text
U(x,a) = predictive uncertainty of plan a on context x
```

and a pool-level quantity:

```text
C_epistemic(x) = aggregate_a w_a * U(x,a)
```

This can use calibrated failure probabilities, ensemble disagreement, conformal sets,
or other methods as evidence supports.

### 6.5 Model sensitivity is more useful than absolute difficulty

Define:

```text
S_model(x)
  = dispersion_a E[Q(a)|x]
```

or pairwise marginal-gain surfaces:

```text
Delta_Q(a,b|x) = E[Q(a)-Q(b)|x]
```

A task for which every model performs similarly may be “complex” but economically
insensitive to model choice. A task with large performance separation is precisely the
one for which routing matters.

### 6.6 Predicted compute distribution

The 2026 agent-token study shows token demand is stochastic and self-predictions are
weak. Therefore the Lab should predict a **distribution**, not a number:

```text
C_tokens(x,a) ~ P(tokens | x,a,policy)
```

with summaries:

```text
p50, p90, p99, CVaR, interval/calibration diagnostics
```

The forecast is then directly usable by budget-risk controls if calibrated.

### 6.7 A deliberately ambitious interaction model

For research, allow nonlinear interactions rather than pretending every feature is
additive. One interpretable family is:

```text
eta(x,a) =
    beta_0
  + beta^T z
  + z^T M z
  + sum_{i<j<k} T_ijk z_i z_j z_k

P(failure | x,a) = sigmoid(eta(x,a))
```

where `z` is the normalized complexity feature vector, `M` captures pairwise
interactions, and sparse `T` captures selected third-order interactions. Regularization,
out-of-sample calibration, and ablations decide whether the added terms earn their
existence.

This is intentionally capable of becoming mathematically elaborate. The complexity is
not accepted merely because it looks impressive: every interaction term must improve a
held-out/calibration criterion or it is pruned.

### 6.8 Item Response Theory track

IRT-style routing is particularly aligned with the original ambition because it models
**task difficulty and model ability on the same latent scale**. A basic 2PL form is:

```text
P(success_{a,t})
  = sigmoid( discrimination_t * (ability_a - difficulty_t) )
```

A multidimensional extension can represent model skill niches:

```text
P(success_{a,t})
  = sigmoid( sum_k alpha_{t,k} * (theta_{a,k} - beta_{t,k}) )
```

This gives the Lab interpretable latent abilities and task requirements. It still does
not replace the economic decision engine: cost, latency, policy, and marginal advantage
remain separate.

### 6.9 Information-theoretic track

A second experimental family can ask how much uncertainty a plan is expected to remove
per dollar:

```text
InformationEfficiency(a|x)
  = ExpectedInformationGain(a|x) / ExpectedCost(a|x)
```

This is relevant for research/analysis agents where the value of the next call is
learning rather than immediately producing an artifact.

### 6.10 The Complex Intelligence Requirement object

If a single inspectable headline is desired, preserve it as an explicitly experimental
projection over the profile:

```text
CIR_theta(x)
  = g_theta(
      structural,
      informational,
      interaction,
      epistemic,
      model_sensitivity,
      predicted_compute,
      risk
    )
```

`g_theta` may be geometric/CES, learned monotone GAM, IRT latent score, or another
registered method. Fiscus should allow **multiple competing complexity estimators** and
benchmark them rather than canonize one forever.

This is the safe version of the original “impossibly complex equation” ambition: the
code exists, is public, inspectable, mathematically serious, and can grow. It simply
cannot silently acquire enforcement authority.

## 7. Complexity is also a cost-normalization control

One of the best uses of the Lab may be people/team accounting rather than routing.

When comparing two scopes, condition expected cost on the Complexity Profile. Then a
high-spend engineer doing systematically harder, high-SLA work is not penalized for
handling difficult assignments.

This yields three different statements that must remain distinct:

```text
RawSpendHigh
ExpectedSpendHighGivenWork
ResidualSpendHighAfterNormalization
```

Only the third is a genuine cost-efficiency anomaly, and even that is not proof of low
productivity.

## 8. Token efficiency should be a production function, not a trophy

For a comparable workload class `g`, estimate the relationship between resource use and
outcomes:

```text
Q_g(c) = expected quality/outcome at AI capital c
```

The economically important quantity is marginal return:

```text
dQ_g / dc
```

or, where value is monetized:

```text
dV_g / dc
```

A token-maxxing culture rewards `c`. Fiscus should reward neither `c` nor `1/c`; both
are gameable. Fiscus should estimate where marginal improvement saturates and where
additional compute becomes economically unjustified.

Recent work on test-time compute supports this framing: more reasoning can exhibit
diminishing returns or overthinking, and optimal compute length can vary by problem.
Other work formulates global reasoning-budget allocation using a shadow price. These are
research inputs for the Complexity Lab and economic controller, not claims that one
published algorithm is universally optimal.

## 9. A metric firewall for people analytics

Before any per-person metric can appear in a team dashboard, pass a `MetricFirewall`:

```text
MetricSpec = {
  name,
  mathematical_definition,
  unit,
  scope,
  evidence_basis,
  known_confounders,
  allowed_uses,
  prohibited_uses,
  aggregation_privacy,
  minimum_sample,
  uncertainty_required
}
```

Examples:

### `token_cost`

```text
allowed: accounting, anomaly diagnosis, budgeting, workload decomposition
prohibited: standalone productivity ranking, compensation score
```

### `cost_per_realized_unit`

```text
allowed: like-for-like operational efficiency diagnostic
prohibited: cross-team ranking without workload normalization/evidence coverage
```

### `causal_value_per_dollar`

```text
allowed: allocation only at evidence grades that support the causal claim
prohibited: pretending observational associations are causal return
```

This firewall turns the anti-token-maxxing philosophy into code.

## 10. Team privacy and identity implications

The current team server deliberately returns distributions rather than a named developer
leaderboard. Preserve that default.

Future modes can be layered:

```text
self_view
team_distribution
manager_named_cost_view
finance_chargeback_view
```

Each is an explicit enterprise policy with different privacy requirements. The missing
OIDC-subject-to-developer-key binding must be solved before a trustworthy `self_view` or
named authorization model exists.

If named manager views are eventually enabled, Fiscus should default to resource and
explanation fields, not a synthetic “developer score.” Audit logs should record who
queried named data and under which policy version.

## 11. The expanded execution plan

The original ten-item night-shift plan is preserved. This research adds another ten
workstreams; none of the earlier ideas are discarded.

### Foundation / remediation — first

1. **Finish Phase 2 correctly.** Separate the Postgres integration test from unit tests,
   run a real Postgres service lane, remove temporary remediation scaffolding only after
   the full gate passes.
2. **Make enforceability first-class.** Implement the typed states
   `enforced_in_path`, `provider_native`, `observed_only`, `proposed`, `unknown` across
   domain model, API, GUI, docs, and tests.
3. **Build the Claim Inspector.** Every Metered/Billed/Allocated/Realized claim becomes
   inspectable for basis, provenance, scope, freshness, coverage, enforceability,
   assumptions, and missing evidence.
4. **Burn down safe GUI parity.** Complete high-value read/preview workflows first;
   explicitly classify destructive/egress/command-execution operations instead of
   pursuing reckless parity.
5. **Make the release gate executable.** Exact-SHA, packed-artifact, clean-install,
   package/dashboard smoke, evidence artifact, and named external unproven gates.
6. **Run an adversarial route/security matrix.** HTTP method/CSRF/Host/CORS/path/MIME/CSP
   tests plus team-server auth/replay/transaction/database-failure cases.
7. **Add mathematical/property invariants.** Conservation, interval ordering,
   unknown-not-zero, attribution immutability, money-resolution, and counterexample
   tests rather than label-only assertions.
8. **Mechanize product truth.** Canonical capability/evidence manifests should drive or
   validate docs and UI status so prose cannot drift silently.
9. **Continue Store decomposition.** Extract domains behind a stable facade after
   correctness gates are green.
10. **Evolve the dashboard information architecture.** Keep the Minted Seal/Night Vault
    identity, but make provenance, uncertainty, enforceability and claim boundaries the
    visual grammar.

### Economic-control expansion

11. **Introduce canonical execution-plan and outcome-adapter types in observe-only
    mode.** No routing authority yet; only record what was actually chosen and what
    happened.
12. **Build the Decision Ledger.** Persist context fingerprint, candidate set, chosen
    action, policy/version, propensity where known, budget state, bounds, constraints,
    and ex-post outcome. This is the substrate for causal/off-policy evaluation.
13. **Build the Evidence-Constrained Frontier.** Cheapest feasible plan, dominated
    alternatives, uncertainty, and evidence gaps; recommendation only, not enforcement.
14. **Upgrade budget math.** Probabilistic horizon forecasting, tail risk, dynamic
    budget scarcity, exploration capital, and explicit reserve policies.
15. **Build policy evaluation / safe promotion.** Observe -> Simulate -> Recommend ->
    Canary -> Enforce, with baselines and prospective evidence gates.

### Anti-token-maxxing / internal AI economy

16. **Implement Metric Safety + the people-metric firewall.** Resource-use metrics can
    never masquerade as productivity metrics.
17. **Build AI Capital Accounts.** Hierarchical showback/chargeback, production,
    exploration and reserve budgets; keep consumption and outcome ledgers distinct.
18. **Build workload-normalized spend explanation.** Shapley driver decomposition,
    expected-cost residuals, and evidence-feasible opportunity gaps answering *why* a
    scope is expensive before anyone judges it.

### Impossible-complexity research track

19. **Build the Complexity Lab.** Multiple competing complexity estimators (structural,
    IRT, nonlinear interaction, uncertainty, model-sensitivity, compute-distribution),
    exposed through a read-only `fiscus lab complexity` surface with full provenance.
20. **Build the Fiscus Research Harness.** Every sophisticated algorithm must compete
    against simple baselines on held-out/prospective data. Track calibration, regret,
    cost, quality, latency, abstention, and distribution shift. A complex method earns
    production authority only when it measurably improves the actual decision.

## 12. Promotion rules for complex research

A Complexity Lab estimator may move into the production decision engine only when:

1. the target quantity is precisely defined;
2. training and evaluation sets are separated temporally or otherwise appropriately;
3. calibration error is measured;
4. simple baselines are included;
5. incremental decision value is positive on held-out/prospective evaluation;
6. performance is robust under plausible distribution shift or the shift detector
   forces abstention;
7. privacy/data-boundary behavior is explicit;
8. feature availability at decision time is proven (no leakage from future outcomes);
9. the model emits uncertainty/coverage;
10. a rollback/fallback exists.

This is how Fiscus can pursue impossible-looking mathematics without turning
mathematical ambition into unearned authority.

## 13. Research references

- Roose, K. (2026), New York Times, “More! More! More! Tech Workers Max Out Their A.I.
  Use.” https://www.nytimes.com/2026/03/20/technology/tokenmaxxing-ai-agents.html
- Arcolano, N. / Jellyfish (2026), “Is tokenmaxxing cost effective?”
  https://jellyfish.co/blog/is-tokenmaxxing-cost-effective-new-data-from-jellyfish-explains/
- Bai et al. (2026), “How Do AI Agents Spend Your Money? Analyzing and Predicting Token
  Consumption in Agentic Coding Tasks.” https://arxiv.org/abs/2604.22750
- Forsgren et al. (2021), “The SPACE of Developer Productivity.”
  https://doi.org/10.1145/3454122.3454124
- FinOps Foundation (2026), “Tokenomics: Managing AI Value in SaaS Model Token Costs.”
  https://www.finops.org/wg/token-economics-saas/
- Sengul, Costa & Gimeno (2019), “The Allocation of Capital within Firms.”
  https://doi.org/10.5465/annals.2017.0009
- Glaser, Lopez-de-Silanes & Sautner (2013), “Opening the Black Box: Internal Capital
  Markets and Managerial Power.” https://doi.org/10.1111/jofi.12046
- Ding et al. (2025), “BEST-Route: Adaptive LLM Routing with Test-Time Optimal Compute.”
  https://proceedings.mlr.press/v267/ding25d.html
- Song et al. (2025), “IRT-Router: Effective and Interpretable Multi-LLM Routing via Item
  Response Theory.” https://aclanthology.org/2025.acl-long.761/
- Zhou et al. (2026), “When More Thinking Hurts: Overthinking in LLM Test-Time Compute
  Scaling.” https://aclanthology.org/2026.findings-acl.1199/
- Wan et al. (2026), “The Shadow Price of Reasoning: Economic Perspective on Optimal
  Budget Allocation for LLMs.” https://arxiv.org/abs/2606.03092

## 14. Final research stance

The original ambition is retained, but its role is clarified.

Fiscus should be simple where a simple invariant is sufficient and extremely
sophisticated where the decision problem truly demands sophistication. The Complexity
Lab exists precisely so difficult ideas do not have to be discarded merely because they
are not yet safe enough to govern money.

The product can therefore pursue both goals at once:

```text
make the mathematics as powerful as evidence permits
AND
never let complexity outrun what the evidence proves
```

That is not a compromise between ambition and honesty. It is the mechanism that allows
both to coexist.
