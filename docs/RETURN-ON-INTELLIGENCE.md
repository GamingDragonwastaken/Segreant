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

### 4.2 Why the GEOMETRIC mean specifically (a characterization theorem)

For a comparable 0–100 **Index** we need a mean M(ρ,α,λ,ι) on the same scale.
There are infinitely many means; the correct one is forced by one more
requirement that value-composition demands — **multiplicative consistency**: the
index of a two-stage process equals the product of the stage indices,
`M(x·y) = M(x)·M(y)`.

> **Kolmogorov–Nagumo–de Finetti (specialized).** Every quasi-arithmetic mean is
> `M_φ(x) = φ⁻¹(Σ wₖ φ(xₖ))` for a continuous strictly-monotone generator φ.
> Among the scale-homogeneous ones (the power means), the **geometric mean**
> (φ = log) is the *unique* one satisfying `M(x·y) = M(x)·M(y)`.

So the aggregator is not a taste choice. Require that quality composes the way
value composes, and the mathematics forces the **weighted geometric mean**:

```
RoI Index = 100 · ρ^wρ · α^wα · λ^wλ · ι^wι ,   Σ wₖ = 1
default weights: Realization 1.0 · Acceptance 0.7 · Lift 1.2 · Impact 1.0
```

Proof it holds: GM(x·y) = ∏(xₖyₖ)^wₖ = ∏xₖ^wₖ · ∏yₖ^wₖ = GM(x)·GM(y). The
arithmetic mean fails it: Σwₖxₖyₖ ≠ (Σwₖxₖ)(Σwₖyₖ). (Tested in
`test/equation.test.ts`.)

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

The same per-unit lens scores project into two honest objects:

- **RoI — the money number (interval-valued):**
  `RoI(E) = Σᵢ sᵢ·ρᵢαᵢλᵢιᵢ ⁄ Σᵢ [tokenᵢ + (1−αᵢ)·mᵢ·(w/60)]` — realized,
  counterfactual, impact-weighted value over total intelligence cost (tokens +
  effort tax at wage *w*). **RoI > 1 ⟺ the AI paid for itself.** The
  **break-even constraint** (`src/value/lift.ts` `breakEven`) is exactly the
  RoI = 1 line; METR's "19% slower" finding is the RoI < 1 case, which the metric
  correctly flags.
- **RoI Index — the comparability number (0–100 + coverage):** the forced
  weighted geometric mean above. Unitless, universal, the dashboard hero.

They differ by Jensen's inequality (per-unit-then-sum for dollars,
per-lens-then-compose for the scorecard) — correct, because one is a sum of
dollars and the other a capability scorecard.

Alongside, **the frontier ("what's best for you")** breaks RoI Index and cost
down by model × task-type, so *"is Opus worth 5× Haiku for my refactors?"* is a
number, not a guess.

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

What we are **not** claiming: that we invented the geometric mean, CES, or
partial identification (we did not — §4 cites them); that any single lens is novel
in isolation; that Lift is easy (it's the hardest, modeled, clearly labeled as an
interval); or that non-coding outcome capture is finished (the spine is universal;
the per-modality outcome hooks beyond code are the active build — see §6). Stating
exactly which bricks are standard is what makes the structure credible rather than
hand-wavy.

---

## 6. Honest scope / build order

- **Now**: lens math + the geometric-mean composite + return ratio, over the
  coding substrate (Realization funnel), with the effort-tax denominator.
  (`src/value/lenses.ts`, `aegisflow roi`.)
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
