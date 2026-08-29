# How Fiscus measures Return on Intelligence — in plain language

*For anyone deciding whether this tool is trustworthy — no math background needed.
The full derivation lives in [RETURN-ON-INTELLIGENCE.md](RETURN-ON-INTELLIGENCE.md);
this is the version you can explain to your CFO.*

---

## The problem, in one sentence

Everyone can see their **AI bill**. Nobody can see their **AI return**. Fiscus
computes an evidence-limited return from records and calculations kept on the
operator's machine. A request intentionally routed through its proxy still goes
to the configured AI provider; read
[DATA-BOUNDARIES.md](DATA-BOUNDARIES.md) before routing sensitive material.

## Why the usual numbers lie

- **"Tokens used" / "lines of code written"** reward *volume*, and AI inflates
  volume effortlessly. More tokens or more lines is not more value. (This is why we
  refuse to use lines of code anywhere in the score.)
- **"Developers say it made them faster"** is unreliable: in a controlled study,
  experienced developers were actually **19% slower** with AI while *believing* they
  were 24% faster. So we never use self-report.

Fiscus only counts things it can **observe**: did the AI's output get kept, ship,
survive, and matter — measured from the wire and from your git history.

## The four questions we score (each 0–100%)

Every dollar of AI spend has to survive four independent tests to become real value.
We score each one separately, then combine them:

| # | The question | Plain meaning |
|---|---|---|
| **ρ Realization** | Did it become something real and lasting? | Not reverted, still in the codebase, shipped. |
| **α Acceptance** | Did you keep it without rewriting? | How much of what the AI proposed actually got used. |
| **λ Lift** | Would you have done it anyway? | The honest counterfactual — did AI actually save time. |
| **ι Impact** | Did it matter? | Reached production, stuck, no incidents (not "how big"). |

## Why we *multiply* them (the one-axis guardrail)

These four are a chain: spend → kept → caused → mattered. To become value, a dollar
has to pass **all four** — so the odds are the four multiplied together, exactly like
a factory's yield through four quality checks, or a chain that's only as strong as
its weakest link:

> **RoI Index = ρ × α × λ × ι** (as a weighted geometric mean, scored 0–100)

This is the key honesty property: a high observed value on one lens cannot
compensate for a near-zero observed value on another. A dashboard that simply
averages lenses can hide a weak necessary condition; this composite cannot.
That does not make the whole measurement immune to bad instrumentation, so
Fiscus also reports coverage, assumptions, and unknown lenses.

## The value scenario a CFO can inspect

Separately, we compute a plain dollar ratio:

> **Observed value scenario = (manual-equivalent value of work that realized) ÷
> (recorded AI and supervision cost)**

- **The value** = what that kept work would have cost a human to produce (priced from
  your own baselines — a cited population prior blended with your own git history,
  never a guess; see [RETURN-ON-INTELLIGENCE.md §7.1](RETURN-ON-INTELLIGENCE.md)) —
  not the tokens it burned.
- **The true cost** = the tokens **plus the time you spent supervising the AI**.
  Counting your own time is what keeps this honest: token cost alone makes a $4
  feature look like a 100× win; adding the hour you spent driving it lands the number
  where reality is (about 1–2×).
- A ratio above or below 1 describes the recorded value scenario under its
  stated baseline, labor-rate, realization, and supervision-time assumptions.
  It does not identify a causal effect or show what the same work would have
  produced without AI.

We *refuse to print a dollar scenario* until your supervision time is measured.
We will not invent the denominator.

## Evidence grades: scenario versus causal study

Fiscus deliberately keeps five grades separate:

1. **Accounted** — provider/request cost and usage with their recorded source.
2. **Modeled** — a price-card or counterfactual model under named assumptions.
3. **Observed** — historic association or an observed/manual-equivalent value
   scenario.
4. **Quasi-experimental** — an assumption-dependent design such as
   difference-in-differences, with diagnostics and sensitivity analysis.
5. **Randomized causal** — a pre-registered, randomized, protocol-qualified
   study of a stated eligible population.

Only the fifth grade can support Fiscus's strongest causal language. The
randomized-study contract requires a frozen intervention/control definition,
assignment before exposure, actual execution and cost lineage, outcome and
quality evidence, a missingness/attrition account, and conservative intervals.
The required claim gates are defined in
[CAUSAL-EVIDENCE-PROTOCOL.md](CAUSAL-EVIDENCE-PROTOCOL.md). Until a real study
passes those gates, Fiscus renders a value scenario, never a causal break-even
or a promise that a model preserves value.

## Two things that make it undeniable

1. **It's honest about what it doesn't know.** Anything we cannot observe is
   marked "not yet measured" — never counted as a pass or a fail. A
   partly-instrumented index is accompanied by a full-instrumentation range:
   unknown necessary lenses are evaluated at admissible endpoints, while the
   observed-only score stays visibly separate. Wiring more measurement can move
   the observed-only score in either direction; it narrows what has to be
   assumed rather than flattering the result.

2. **It's trustworthy on small samples.** A model that "won" on 2 tasks isn't treated
   like one that won on 200. We shrink thin, noisy results toward the average until
   there's enough evidence — so recommendations don't chase luck. (See "reliability"
   in the technical doc.)

3. **It's valid while you watch it.** Ordinary statistics are only guaranteed if you
   check the number once; a live dashboard gets checked constantly, which quietly
   breaks the guarantee (checked continuously, a "90% sure" range is wrong at some
   point in about two-thirds of cases). Fiscus's headline rate uses **anytime-valid**
   math instead: the range stays honest at every glance, so acting the moment it
   looks good is statistically safe. The trade — a slightly wider range — is shown,
   not hidden. (See §10 in the technical doc.)

## The research model: the Shadow Price of Intelligence

Beyond scoring the past, the Fiscus research model can calculate a hypothetical
power-law response curve and its shadow price, μ. It is useful for examining
assumptions, not a current forecast, routing instruction, budget recommendation,
or automatic action. A decision-grade marginal-value claim requires a
within-task controlled allocation contract and independent validation; see
[ECONOMIC-CONTROL-FOUNDATION.md](ECONOMIC-CONTROL-FOUNDATION.md).

## What we're NOT claiming

The building blocks (geometric mean, diminishing-returns optimization, statistical
shrinkage, partial-identification bounds) are established, well-understood mathematics
— we cite them plainly. **The invention is putting them together** into one
inspectable instrument whose current evidence is strongest for instrumented coding
workflows. A strong observed lens cannot compensate for a weak necessary lens,
but instrumentation and counterfactual assumptions remain visible rather than
being mistaken for proof. Stating exactly which parts are standard is what makes
the rest credible.

## Fiscus-hosted data collection is off by default

This historical heading means that Fiscus has no hosted collection or analytics
by default. It does not mean a request routed through the proxy bypasses your
configured AI provider. See **[DATA-BOUNDARIES.md](DATA-BOUNDARIES.md)** for the
current, complete disclosure of provider traffic, local proposal retention, and
each opt-in outbound feature.

The local ledger and calculations live in a file-based database, and Fiscus has
no Fiscus-hosted product analytics or telemetry by default. That does **not**
mean proxy-routed requests stay offline: they travel to the configured AI
provider and may include prompts, source snippets, tool payloads, and provider
credentials. Optional outbound paths also include pricing refresh, configured
alert webhooks, an explicitly selected hosted judge, a deliberate OpenAI Costs
pull, and an opt-in numeric team rollup. The complete, current list and each
retention control are in [DATA-BOUNDARIES.md](DATA-BOUNDARIES.md).

New installations run Fiscus-process HTTP(S) in `local_locked` mode. A
controlled-cloud action needs an exact purpose/data/method/origin/path rule and
creates a redacted local receipt trail. This strengthens the Fiscus boundary;
it does not establish machine-wide egress control or a provider-side privacy
guarantee.
