# Return on Intelligence (RoI)

> The measure of how much you actually *get* from AI — across every kind of
> usage, not just coding. The number an enterprise can point at and say
> "that's the one we run AI by."

This is the top-level standard. [THE-STANDARD.md](THE-STANDARD.md) (the
Realization funnel) is one *substrate* underneath it — the part that verifies a
coding outcome is real. RoI is the whole instrument.

---

## 1. Why this exists (and why nothing today is it)

Enterprises spend tokens across **everything** — coding, chat, research, drafting,
support, analysis, agent runs. They can see the bill. They cannot see the
**return**. Two camps have tried and missed:

- **Developer-productivity frameworks (DORA, SPACE)** suffer, in their own
  literature's words, *"attribution blindness — metadata-only tools cannot see
  which lines came from AI vs humans"*, and they are coding-only. Output-volume
  metrics are now openly discredited ("AI easily inflates the volume of code").
- **Top-down ROI frameworks (Gartner Return-on-Employee / Return-on-Future)** and
  **study-based uplift work (METR)** rely on surveys and hand-run RCTs. METR
  found AI made experienced devs **19% slower** while they *believed* they were
  faster (self-report off by ~40 points), and that **task-substitution** inflates
  apparent value (people do low-value "nice-to-haves" with AI).

The unmet need, stated plainly: a measure of realized AI value that is
**measured from the wire (not surveyed), spans all usage, includes the human
effort it cost, and can't be gamed on one axis.** That is RoI.

---

## 2. The unit and the denominator

**Unit of work** — a *unit of AI usage*: an interaction, task, or session, in
**any modality**. Every AI usage, coding or not, has the same shape:

```
intent (prompt) → output (response) → acceptance (kept vs redone) → outcome (used / realized / mattered)
```

This shape is what makes RoI universal. Coding adds rich verification (git:
committed → tested → shipped → survived → clean). Non-coding usage uses the same
spine with its own outcome signals (a draft published, a ticket resolved, an
answer not re-asked). The first two stages — **intent and acceptance — are
modality-agnostic and visible to an in-path proxy for *every* token spent.**

**Denominator (total cost to get the result):**

```
cost = token_cost (real 4-rate $)  +  effort_tax
effort_tax = Σ  rework_fraction × est_minutes × fully_loaded_labor_rate
```

The **effort tax** is the term token-counting misses and the literature demands
(human review priced at fully-loaded labor cost; AI often *raises* review time).
Rework is observed, not guessed — from acceptance/edit-distance and correction
loops in the proxy path. When labor rate is unset, effort_tax = 0 and the
denominator is labeled *token-only*; we never invent it.

---

## 3. The four value lenses (each named, each measured, each different)

We do **not** pick one definition of "value." Each lens answers a different real
question; we report all four, then compose them (§4). Each is normalized to
0..1 and may be `uninstrumented` (null) — never faked.

| Lens | The question it answers | How it's measured | When it's the one you want |
|------|------------------------|-------------------|----------------------------|
| **Realization** | *Did the spend become something real and kept?* | Verified-outcome conversion (the funnel: shipped/survived/clean for code; used/not-redone for the rest) | The floor. Always on. Kills spend that produced nothing durable. |
| **Acceptance** *(Take Rate)* | *Did you keep what it gave you, first try?* | Edit-distance between what the AI proposed and what you kept; regeneration / re-ask rate. Modality-agnostic, **available in-session.** | Real-time coaching; raw output quality; any usage type. |
| **Lift** *(counterfactual)* | *Did it actually make you faster/able vs not using it — or vs a cheaper model?* | **Behavioral, never self-report** (`src/value/lift.ts`). METR's method: time-with-AI from 10-min concurrency windowing of session timestamps; a transcript/A-B TSF as a **soft upper bound**, then discounted for selection/substitution/concurrency to a **bounded range** via the ordering inequality `Lift_old ≤ Lift_value ≤ Lift_new ≈ TSF`. | Deciding what's worth it; model/approach choice. (Hardest; reported as a range, never a point.) |
| **Impact** | *Of what was realized, how much actually mattered?* | Objective weight: reached production, blast radius (files/callers touched), criticality, incident-freedom. | Portfolio / exec view. Counters the "nice-to-have" substitution bias. |

Why four and not one: a single numerator always hides a failure mode.
High Acceptance with zero Impact = you happily shipped things nobody needed.
High Realization with negative Lift = you kept code that AI made you *slower* to
produce. Only seeing them together tells the truth.

---

## 4. The composite — derived, not chosen

The four lenses are not four metrics we liked. They are the **four independent
ways raw output overstates value** — a spanning set of its failure modes. Each
lens, normalized to [0,1], is a *conditional survival rate* along the chain
**tokens → kept → caused → mattered**:

| Leak (how output lies about value) | Condition that closes it | Symbol |
|---|---|---|
| It didn't last | Realization | ρ |
| You had to rewrite it | Acceptance | α |
| You'd have done it anyway | Lift (counterfactual) | λ |
| It didn't matter | Impact | ι |

### 4.1 Why they MULTIPLY (and why that is Goodhart-proof)

These are *necessary conditions in series*. The probability a unit of spend
becomes real intelligence-value is the joint probability of clearing all of them,
and by the **chain rule of probability over a funnel of necessary conditions**,
the joint of a chain is the product:

```
π = ρ · α · λ · ι
```

Same mathematics as manufacturing yield through sequential quality gates, or the
reliability of a series system (R = ∏ Rᵢ). This *derives* Goodhart-resistance
rather than asserting it: pumping one axis to 1.0 while another sits at 0.05
leaves π ≤ 0.05 — **the score is hostage to its weakest link.** The arithmetic
mean every dashboard uses, (ρ+α+λ+ι)/4, has no such floor — a single pumped axis
lifts it regardless of a zero elsewhere. The product structure is *forced* by the
requirement "no single axis can be gamed."

### 4.2 Why the GEOMETRIC mean specifically (what is forced, and what is disclosed)

For a comparable 0–100 **Index** we need a mean M(ρ,α,λ,ι) on the same scale.
There are infinitely many means; the **form** is pinned down by one requirement
that value-composition demands — **multiplicative consistency**: the index of a
two-stage process equals the product of the stage indices, `M(x·y) = M(x)·M(y)`.

> **Kolmogorov–Nagumo–de Finetti (specialized).** Every quasi-arithmetic mean is
> `M_φ(x) = φ⁻¹(Σ wₖ φ(xₖ))` for a continuous strictly-monotone generator φ.
> The generator that makes the mean multiplicative — `M(x·y) = M(x)·M(y)` for all
> x,y — is **φ = log**, i.e. the (weighted) **geometric** form. Among *symmetric*
> means it is the unique multiplicative one.

So the **functional form is forced** — require quality to compose the way value
composes and you must use a weighted geometric mean. Equivalently it is a
**constant-returns-to-scale Cobb–Douglas** function whose exponents are the
lenses' **output elasticities** wₖ:

```
RoI Index = 100 · ρ^wρ · α^wα · λ^wλ · ι^wι ,   Σ wₖ = 1   (Cobb–Douglas, CRS)
```

Two things are **disclosed, not forced**, and we say so plainly:

1. **The weights.** wₖ is the elasticity of the Index w.r.t. lens k —
   `∂ln(Index)/∂ln(xₖ) = wₖ` — "a 1 % gain in lens k lifts the Index wₖ %." They
   are calibrated from the literature (§7), normalized to sum to 1. The
   implementation divides by Σw internally, so the raw defaults
   `{1.0, 0.7, 1.2, 1.0}` realize elasticities `{0.26, 0.18, 0.31, 0.26}`. Set
   them **equal** (0.25 each) and you recover the **symmetric axiomatic index** —
   the unique symmetric multiplicative mean — for a buyer who wants no editorial
   weighting at all (`weights: {1,1,1,1}`).
2. **The substitution θ** (§4.3): θ = 0 (geometric) is the distinguished neutral
   point, but the whole CES family is exposed.

What is *not* a taste choice is the multiplicativity itself: any zero lens
collapses the Index, no matter the weights. Proof: GM(x·y) = ∏(xₖyₖ)^wₖ =
∏xₖ^wₖ · ∏yₖ^wₖ = GM(x)·GM(y); the arithmetic mean fails it,
Σwₖxₖyₖ ≠ (Σwₖxₖ)(Σwₖyₖ). (Tested in `test/equation.test.ts`.)

### 4.3 The substitution knob (a principled family, one distinguished default)

The geometric mean is the θ→0 case of the **CES / power mean**
`M_θ(x) = (Σ wₖ xₖ^θ)^{1/θ}` (`weightedPowerMean` in `lenses.ts`):

| θ | mean | meaning |
|---|---|---|
| 1 | arithmetic | perfect substitutes — gameable; never the default |
| **→ 0** | **geometric** | unit elasticity of substitution; scale-free; multiplicative |
| → −∞ | minimum | Leontief, pure weakest-link |

θ is the elasticity of substitution between lenses — how much surplus on one axis
may compensate a deficit on another. Geometric (θ=0) is the distinguished neutral
point; a buyer who wants it even harder to game slides θ<0 toward the min.

### 4.4 RoI is an INTERVAL, not a number (the honest core)

Lift λ is causal: of the realized value, how much did the AI *cause* vs. what you
would have done anyway? The fundamental problem of causal inference says you
cannot observe both the with-AI and without-AI worlds for the same task, so **λ
is not point-identified.** Pretending it is would be the vagueness this product
exists to kill. The honest move is **partial identification** (Manski): bound it.
Selection biases λ up; substitution and concurrency bias measured savings —
yielding the ordering inequality `λ_old ≤ λ_value ≤ λ_new ≈ TSF`, hence an
interval, never a point. Because λ enters π multiplicatively and the aggregator
is monotone, the interval **propagates** — Return on Intelligence is itself
interval-valued:

```
RoI ∈ [RoI_low, RoI_high]      (point = interior estimate)
```

The interval's width is set by (a) counterfactual uncertainty and (b)
instrumentation coverage, and it **tightens monotonically as you wire more gates
and run controlled comparisons.** This turns the metric into a roadmap: *here is
your RoI bound, and here is exactly what to instrument to prove your spend's
worth.* A second honesty result falls out: since every unobserved necessary
condition is ≤ 1, a partially-instrumented Index is an **upper bound** on the
true conversion (`indexIsUpperBound`) — so more measurement makes the number more
honest (usually lower), never inflated. The exact opposite of the usual dashboard
incentive. (Lenses you haven't wired are excluded and **coverage** is reported —
unknown ≠ fault.)

### 4.5 The two faces (kept distinct on purpose)

The same evidence projects into two honest objects. The first is unitless and
comparable; the second is dollars and decides whether to keep paying.

**Face 1 — RoI Index (0–100 + coverage):** the weighted geometric mean above
(§4.2). Unitless, universal, the dashboard hero. (`roiIndex` in `lenses.ts`.)

**Face 2 — RoI return (the money number).** A real, dimensionless ratio,
computed *directly* as value ÷ cost (`returnRatio` in `lenses.ts`):

```
                Σ_realized  baselineMin(u) · (wage/60) · acceptance(u)
RoI_gross   =  ─────────────────────────────────────────────────────────
                  tokenCost   +   supervisionMin · (wage/60)

RoI_causal  =  RoI_gross · λ            (λ = the Lift lens, applied ONCE)
            ∈ [ RoI_gross·λ_low , RoI_gross·λ_high ]   (Manski interval, §4.4)
```

Every term is defended:

- **Numerator — realized, manual-equivalent value, net of rework.** Only work
  that *realized* (ρ) is counted, each priced at its **manual baseline** — what
  the kept output would have cost a human (`baselineMin × wage`, an auditable org
  input, never a self-reported speedup) — and discounted by first-pass
  **acceptance** α (reworked output is worth less). This is value measured in the
  worth of the work, not in the tokens it took (which would be circular).
- **Denominator — the *honest* cost of the intelligence.** Tokens **plus your
  measured time supervising the AI** (`supervisionMin`, METR 10-minute windowing
  over real request timestamps, §3), priced at the wage. Pricing your own time is
  what keeps the ratio real: token cost alone makes a \$4 feature look like a 100×
  return; adding the hour you actually spent driving it lands the number where the
  evidence does (METR's ~1.4–2× value, not the ~3× raw speed). The metric
  **refuses to print a dollar return** until supervision time is measured — it
  will not invent the denominator (`basis: 'none'`).
- **The counterfactual λ is applied exactly once.** `RoI_gross` is an honest
  **upper bound** on the causal return (it does not subtract what you'd have done
  anyway); multiplying by the Lift lens λ once yields `RoI_causal`. We do **not**
  also fold the speedup into a separate "leverage" term — that would count the
  time-savings twice (it already lives in the manual-vs-AI time ratio *and* in λ).
  Keeping the money number independent of the Index is what avoids the
  double-count. **RoI_causal ≥ 1 ⟺ the AI paid for itself**; METR's "19 % slower"
  is the RoI < 1 case, which the metric flags. (The `breakEven` helper is the
  RoI = 1 line.)

The two faces differ by Jensen's inequality (value sums dollars per-unit; the
Index composes lenses) — correct, because one is a sum of dollars and the other a
capability scorecard.

Alongside, **the frontier ("what's best for you")** breaks RoI Index and cost
down by model × task-type, so *"is Opus worth 5× Haiku for my refactors?"* is a
number, not a guess.

### 4.6 Risk — two named treatments (a return needs more than a mean)

A point estimate is not a decision. RoI prices risk twice, on purpose:

1. **Balance risk (cross-sectional).** The geometric mean is *already*
   risk-averse across lenses: by AM–GM, an imbalanced profile (0.9, 0.1) scores
   far below its arithmetic average, so the Index punishes fragility — a tool
   that's brilliant on one axis and broken on another cannot hide.
2. **Estimation risk (longitudinal).** How sure are we? The Index is partially
   identified (§4.4), so we expose a **certainty-equivalent** at a buyer's
   risk-aversion γ ∈ [0,1] (`certaintyEquivalent` in `lenses.ts`):

   ```
   CE(γ) = point − γ · (point − low)
   ```

   γ = 0 returns the interior point; γ = 1 returns the conservative lower bound
   (every un-instrumented necessary condition assumed adverse). It is coherent —
   monotone in γ, never exceeds the point, degenerates to the point when the
   interval is a point. "Even under conservative assumptions, RoI ≥ CE(γ)."

---

## 5. What is genuinely new here (honest)

The *components* are established mathematics — geometric mean, CES, Manski
partial-identification bounds, funnel chain-rule, proper-scoring honesty. **The
invention is the synthesis**, which has not been built:

1. **The four lenses as a spanning set.** Realization/Acceptance/Lift/Impact are
   *derived* as the four independent ways raw output overstates value (§4), not a
   convenient list — and Lift is what makes it return on *intelligence*, not on
   spend.
2. **Value-conversion as a necessary-condition chain ⟹ the aggregator is forced.**
   The funnel chain-rule makes value multiplicative; multiplicative consistency
   then forces the geometric mean via the Kolmogorov–Nagumo characterization
   (§4.2). The Goodhart-resistance is a theorem, not a hope.
3. **Interval-valued, honest-by-construction.** RoI is a bound, not a false
   point: its width is set by counterfactual uncertainty + coverage, and it
   tightens with evidence (§4.4). A partially-instrumented Index is an explicit
   upper bound — more measurement, more honest, never inflated.
4. **Cross-modality, measured from the wire.** The universal
   intent→acceptance→outcome spine measures value from *any* token spend (not just
   commits), from the proxy path — solving the "attribution blindness" DORA/SPACE
   name as their blocker and avoiding the self-report bias METR documents.
5. **A decision, not just a score.** The per-context frontier turns the metric
   into "what's best for *you*."
6. **A money number that can't be gamed by ignoring your time.** The RoI return
   prices the denominator as tokens **+ measured supervision time**, values the
   numerator at the work's manual-equivalent worth (not the tokens it cost), and
   credits the counterfactual exactly once — so it lands at the literature's
   ~1–2×, not a fantasy multiple, and refuses to print a dollar figure until your
   time is measured (§4.5). Paired with two explicit risk treatments — balance
   (the geometric mean) and estimation (the γ certainty-equivalent, §4.6).

What we are **not** claiming: that we invented the geometric mean, CES, or
partial identification (we did not — §4 cites them); that any single lens is novel
in isolation; that Lift is easy (it's the hardest, modeled, clearly labeled as an
interval); or that non-coding outcome capture is finished (the spine is universal;
the per-modality outcome hooks beyond code are the active build — see §6). Stating
exactly which bricks are standard is what makes the structure credible rather than
hand-wavy.

---

## 6. Honest scope / build order

- **Now**: lens math + the geometric-mean composite (RoI Index) + the money
  number (RoI return: realized manual-equivalent value over tokens + measured
  supervision time, counterfactually credited once) + the risk-adjusted
  certainty-equivalent, over the coding substrate (Realization funnel).
  (`src/value/lenses.ts`, `aegisflow roi [--labor-rate <w>] [--risk <γ>]`.)
- **Next**: the per-context frontier (model × task-type) from proposal→outcome
  linkage; behavioral Lift via model A/B on like tasks.
- **Then**: non-coding modality capture (chat/research/writing/agent outcome
  signals) through the same proxy + `report` spine, so RoI covers all token use.

Until a signal is wired, its lens reads `uninstrumented` and the index is honest
about coverage. The path to a higher, more trusted number is to wire more — never
to game one.

---

## 7. Grounding & provenance (why the defaults are what they are)

The design is calibrated to the empirical record, not invented:

- **Self-report is rejected.** METR's RCT (16 experienced devs, 246 real tasks on
  mature repos) found AI made them **19% slower** while they *believed* they were
  **24% faster** — a 43-point perception gap. So Lift is behavioral only.
- **TSF is an upper bound, hence the range.** METR's transcript analysis (5,305
  Claude Code transcripts) yields TSF ~1.5–13× but explicitly bounds *value*
  uplift below it via task-selection / substitution / concurrency biases. Their
  2026 survey shows a persistent ~3× *speed* vs ~1.4–2× *value* gap. We encode
  this as the ordering inequality + discount factors.
- **Throughput is discredited; quality/effort dominate.** "The Fast and Spurious"
  (arXiv 2510.24265) shows GenAI redistributes effort downstream (review burden,
  cognitive load) rather than eliminating it — frequent users report *higher*
  exhaustion. "Beyond the Commit" (arXiv 2602.03593) shows 86% satisfaction with
  <1 hr/week saved for most, and that commits are the wrong unit. This is why the
  lens weights favor Realization/Impact/Lift over raw Acceptance, and why the
  denominator includes the effort tax.
- **Tokens are mostly overhead.** Field data shows 85–95% of agentic tokens go to
  orientation / context re-send / retries — so token *volume* is a cost signal,
  never a value signal. RoI treats it accordingly.
- **The cautionary precedent.** In early 2026 Meta ("Claudeonomics") and Amazon
  ("KiroRank") ran internal token-consumption leaderboards; spend spiked ~10× with
  no output gain and they were shut down. RoI is the outcome-based answer to
  exactly that failure — and its geometric-mean composite is structurally immune
  to the single-axis gaming that sank those leaderboards.

**Sources:** METR RCT (arXiv:2507.09089); METR transcript analysis (metr.org,
Feb 2026); METR 2026 technical-worker survey; *The Fast and Spurious* (arXiv
2510.24265, HumanAISE@FSE'26); *Beyond the Commit* (arXiv 2602.03593,
ICSE-SEIP'26); SPACE (Forsgren et al. 2021); DORA AI insights. Full synthesis in
the project's research notes.

---

## 8. Reliability — trust in proportion to evidence (empirical Bayes)

A raw rate lies with confidence on thin data: **2 of 2 realized (100%)** out-ranks
**140 of 200 (70%)**, and the noisy small cell then captures budget and "best
model" recommendations. This is the batting-average fallacy, and unaddressed it is
the fastest way a skeptic discredits the whole tool.

The fix is the **James–Stein** result: an estimator that shrinks each cell's rate
toward the population mean strictly beats the raw rate in total squared error once
there are ≥ 3 cells. We model realized/total as **Beta–Binomial** — each context's
`k` of `n` outcomes has its own success probability drawn from a shared
`Beta(α, β)` prior — and report each context's **reliable rate** as the posterior
mean:

```
ρ̂ = (k + κ·μ) / (n + κ) ,   μ = α/(α+β) (population rate),  κ = α+β (prior strength)
```

A thin cell is pulled to μ; a data-rich cell barely moves. Crucially **κ is
estimated from the data, not chosen** (the *empirical* in empirical Bayes): by
method of moments on the beta-binomial's extra-binomial variation (Williams 1982),

```
ρ_icc = ( Σ(kᵢ − nᵢμ)² / [μ(1−μ)] − N ) / Σ nᵢ(nᵢ−1) ,   κ = 1/ρ_icc − 1.
```

Tightly-clustered cell rates ⟹ their spread is noise ⟹ large κ ⟹ heavy shrinkage;
genuinely spread rates ⟹ real differences ⟹ small κ ⟹ light shrinkage. Alongside
each shrunken figure we can show the **evidence weight** `n/(n+κ) ∈ [0,1]` — a
plain-language confidence. (`src/value/reliability.ts`, `test/reliability.test.ts`.)
This feeds the allocation optimum below so a 2-unit cell can't steer the budget.

---

## 9. The Shadow Price of Intelligence — the marginal dollar

Every FinOps tool reports where the money **went**; none says where the next dollar
should **go**, or whether it is worth spending at all. That is a constrained
optimization whose solution carries one decision-grade number.

Model each context's realized value as concave in the spend routed to it —
diminishing returns, the honest default (easy wins land first; contexts saturate):

```
Vᵢ(s) = aᵢ · s^β ,   0 < β < 1   (β disclosed; default 0.5),   aᵢ = Vᵢ / sᵢ^β  (fit)
```

Maximizing total realized value `Σ Vᵢ(sᵢ)` subject to a fixed budget `Σ sᵢ = B` is
a **water-filling** problem. Its Lagrangian `ℒ = Σ aᵢsᵢ^β − μ(Σsᵢ − B)` gives the
first-order condition `Vᵢ′(sᵢ) = μ` for every funded context — **at the optimum
every dollar earns the same marginal return μ**, the Lagrange multiplier. Because
the objective is homogeneous of degree β, Euler's theorem closes it in one line:

```
optimal split   sᵢ* = B · wᵢ / Σⱼ wⱼ ,   wᵢ = aᵢ^{1/(1−β)}
shadow price    μ  = β · V*(B) / B          (V* = total realized value at the optimum)
```

**μ is the headline.** `μ ≥ 1` ⟺ the next AI dollar returns more than a dollar of
realized value (under-invested — room to grow); `μ < 1` ⟺ the next dollar returns
less (past positive margin — cut, don't grow). This is the answer to *"what is one
more dollar of AI budget worth to me, right now?"* — a question the market cannot
otherwise answer. And because the split follows `aᵢ^{1/(1−β)}` rather than `aᵢ`,
**concavity forbids winner-take-all**: the best context gets more budget, never all
of it — the honest antidote to "pour everything into the top-scoring model." β is
disclosed like the Index's weights and θ; the concave shape is a planning
assumption that travels with the output. (`src/value/marginal.ts`,
`test/marginal.test.ts`; surfaced in `aegisflow budget --recommend`.)

### 9.1 β estimated from your own curvature (never silently assumed)

When history supports it, β is **estimated from the org's own data** rather than
assumed. The estimator is chosen for one property: it cannot be biased by context
quality. Comparing *different* contexts confounds β with quality (teams route more
spend where value is higher, so a pooled log-log regression inflates β). So we
never compare across contexts. Within one context observed in the window's two
halves, its quality `aᵢ` cancels exactly:

```
V₂/V₁ = aᵢs₂^β / aᵢs₁^β   ⟹   β = log(V₂/V₁) / log(s₂/s₁)
```

One slope per context; the estimate is the **median** across contexts, so a
minority whose quality genuinely shifted between halves can't drag it. Gates, all
disclosed in the output: positive spend and value in both halves; spend moved
≥10% (otherwise the slope is unidentified); ≥3 usable pairs; and the median must
land inside (0.05, 0.95) — a median at or above 1 means *no diminishing returns
were detected*, and the honest response is to keep the disclosed default and say
why, not to clamp an estimate the data rejects. β's provenance (estimated vs.
default, and from how many contexts) prints next to the shadow price.
(`estimateBetaFromPairs` in `src/value/marginal.ts`.)

## 10. Anytime-valid — the number you are allowed to watch

Every monitoring product ships intervals with a flaw its users never see: a
classical 95% interval is only valid if you look **once**, at a pre-registered
sample size. A dashboard invites the opposite — glance at every refresh, act the
moment the number looks good. Under that use the real error rate of a fixed-n
interval grows without bound (the *optional stopping* / "peeking" problem that
forces clinical trials into sequential designs). In our simulation, watching a
stream at every step, a classical 90% interval was wrong at some point in **~64%
of runs**. A product whose brand is "never a dishonest number" cannot show that.

The fix is a **confidence sequence**, built from an e-process. For a realization
stream `x₁..xₙ` and a candidate rate `p`, the mixture likelihood ratio

```
Mₙ(p) = ∫ q^k (1−q)^{n−k} dBeta(a,a)(q)  /  p^k (1−p)^{n−k}
```

is a nonnegative martingale with `E[M₀] = 1` when `p` is the true rate, so
**Ville's inequality** bounds it over *all* time at once: `P(∃n: Mₙ(p) ≥ 1/α) ≤ α`.
The interval at any moment is simply every rate not yet rejected:

```
CSₙ = { p : Mₙ(p) < 1/α }      — valid SIMULTANEOUSLY at every n
```

Peek whenever, stop whenever, act whenever: the guarantee holds. In the same
simulation the confidence sequence violated its 10% budget in **6.0%** of runs —
inside budget — while the classical interval failed in 63.8%.

Three honest notes. (1) The price is width: an anytime-valid interval is ~1.5–2×
wider than a fixed-n one. We show that cost instead of hiding it — a narrower
number would be a lie about how dashboards are used. (2) It is **display-only**:
it never feeds the Index or its partial-ID interval, so nothing about §4–§5
changes meaning. (3) The implementation needs no gamma function and no
dependency — the Beta ratio is built by the exact recurrence
`B(x+1,y) = B(x,y)·x/(x+y)`, and `log Mₙ(p)` is quasi-convex with its minimum at
`k/n`, so the interval falls out of bisection. (`src/value/anytime.ts`,
`test/anytime.test.ts` — including the simulated-peeking coverage test.)

## 11. The Goodhart alarm — detecting a bent metric

Goodhart's law is the fate of every metric: once a number is a target, people
optimize the number instead of the value it stood for. A gamed metric doesn't
announce itself — it shows up as the rate **drifting** (acceptance creeping up
while nothing else improves; realization sagging as easy wins get cherry-picked).
The alarm detects exactly that, with the same anytime-valid guarantee as §10,
reading **no content** — drift is visible in the 0/1 outcome stream alone.

The construction is **universal inference** (a running-MLE e-process). Race two
forecasters over the stream: a *predictive* alternative — a Krichevsky–Trofimov
estimator over a trailing window, which only ever sees the past and adapts when
the rate moves — against the best *constant* rate in hindsight (the composite
null's maximum likelihood, refit at every step):

```
Eₙ = Π qᵢ₋₁(xᵢ)  /  sup_p p^k (1−p)^{n−k}
```

Validity, in two lines: for any fixed rate p₀ in the null, `Π qᵢ₋₁(xᵢ)/p₀(xᵢ)`
is a nonnegative martingale (each factor has conditional expectation 1), and the
sup-denominator only makes Eₙ smaller — so Ville's inequality bounds the false-
alarm rate by α **over all of time, for every constant rate at once**. It is
deterministic (no randomization, unlike conformal martingales on binary data).
Measured: false alarms 0.2% against a 5% budget across three stable rates; an
abrupt regime collapse caught 100/100; slow Goodhart-style creep caught 93/100.

The honest framing travels with the output: the alarm detects that the rate
**moved**, not *why*. A genuine regime change (new model, new workflow) and a
gamed metric both trip it. Its job is to force the question no dashboard asks —
*did the work change, or did the measuring get bent?*
(`src/value/drift.ts`, `test/drift.test.ts`; the "Stability" line in
`aegisflow roi` and the dashboard.)

## 12. Value of Information — which measurement to buy next

The Index is an upper bound while lenses are missing (§5), but "wire more
lenses" is not a decision — "wire **this** lens next" is. For each
un-instrumented lens k, evaluate the composite with that lens hypothetically
measured at a **disclosed neutral reference** v = 0.5 (a midpoint, not a
prediction):

```
Index_k(v) = 100 · exp( (Σᵢ wᵢ ln xᵢ + w_k ln v) / (Σᵢ wᵢ + w_k) )
```

and rank by the size of the move. The arithmetic is fully transparent — no
hidden priors; a heavier, further-from-current lens moves the Index more, and
measuring can only make the number more honest. This completes the decision
calculus the instrument hands an organization:

| Question | Answer | Section |
|---|---|---|
| Where does the next **dollar** go? | the shadow price μ | §9 |
| Which **measurement** do I buy next? | instrumentation priority | §12 |
| When do I actually **know**? | the anytime-valid interval | §10 |
| Is the number being **bent**? | the Goodhart alarm | §11 |

(`src/value/voi.ts`, `test/voi.test.ts`; the "Instrument next" line in
`aegisflow roi` / `usage`.)
