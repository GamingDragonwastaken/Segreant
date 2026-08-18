# How Fiscus measures Return on Intelligence — in plain language

*For anyone deciding whether this tool is trustworthy — no math background needed.
The full derivation lives in [RETURN-ON-INTELLIGENCE.md](RETURN-ON-INTELLIGENCE.md);
this is the version you can explain to your CFO.*

---

## The problem, in one sentence

Everyone can see their **AI bill**. Nobody can see their **AI return**. Fiscus
measures the return — honestly, from your own machine, without sending your prompts
or code anywhere.

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

Fiscus separates four questions that must not be collapsed into one number.
They are different evidentiary claims, not assumed statistically independent:

| # | The question | Plain meaning |
|---|---|---|
| **ρ Realization** | Did it become something real and lasting? | Not reverted, still in the codebase, shipped. |
| **α Acceptance** | Did you keep it without rewriting? | How much of what the AI proposed actually got used. |
| **λ Lift** | Would you have done it anyway? | The honest counterfactual — did AI actually save time. |
| **ι Impact** | Did it matter? | Orthogonal consequence/reach evidence. Coding Impact stays unknown until such evidence exists; it is not reconstructed from ship/survival gates. |

## Why we *multiply* them (the non-compensatory part)

These four are a chain: spend → kept → caused → mattered. To become value, a dollar
has to pass **all four** — so the odds are the four multiplied together, exactly like
a factory's yield through four quality checks, or a chain that's only as strong as
its weakest link:

> **RoI Index = ρ × α × λ × ι** (as a weighted geometric mean, scored 0–100)

This is the key non-compensation property: one strong lens cannot buy back a collapsed one.
That property is tested. It is **not** a proof against Goodhart effects in task selection,
instrumentation, baselines, or which outcomes an organization chooses to report.

## The number your CFO cares about: does it pay for itself?

Separately, we compute a plain dollar ratio:

> **RoI Return = (value of the work the AI actually produced) ÷ (what it truly cost)**

- **The value** = what that kept work would have cost a human to produce (priced from
  your own baselines — a cited population prior blended with your own git history,
  never a guess; see [RETURN-ON-INTELLIGENCE.md §7.1](RETURN-ON-INTELLIGENCE.md)) —
  not the tokens it burned.
- **The true cost** = the tokens **plus the time you spent supervising the AI**.
  Counting your own time is what keeps this honest: token cost alone makes a $4
  feature look like a 100× win; adding the hour you spent driving it lands the number
  where reality is (about 1–2×).
- **≥ 1 means it paid for itself.** Below 1 is the "19% slower" case — and we flag it.

We *refuse to print a dollar return* until your supervision time is measured. We will
not invent the denominator.

## Two things that make it undeniable

1. **It's honest about what it doesn't know.** Anything we can't observe is marked
   "not yet measured" — never counted as a pass or a fail. The observed-lens score
   is explicitly **not** called a bound: a newly measured lens can move it up or down.
   Fiscus instead reports a full-index identification interval that keeps missing
   dimensions in the fixed weight vector at their admissible endpoints.

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

## The decision it hands you: the Shadow Price of Intelligence

Beyond scoring the past, Fiscus answers *"what is one more dollar of AI budget
worth to me, right now, spent optimally?"* — a single number (**μ**). If μ ≥ $1 of
value per AI dollar, you have room to invest more. If μ < $1, the next dollar returns
less than it costs — cut before you grow. No other tool answers this.

## What we're NOT claiming

The building blocks (geometric mean, diminishing-returns optimization, statistical
shrinkage, partial-identification bounds) are established, well-understood mathematics
— we cite them plainly. **The invention is putting them together** into one honest
instrument whose mathematical shape can accept multiple AI modalities. Current
outcome instrumentation is deepest for coding-agent workflows; non-coding value
uses explicitly reported outcome adapters and is not claimed equally mature. The
index is single-axis resistant, not immune to metric gaming.

## Your data never leaves your machine

This historical heading means that Fiscus has no hosted collection or analytics
by default. It does not mean a request routed through the proxy bypasses your
configured AI provider. See **[DATA-BOUNDARIES.md](DATA-BOUNDARIES.md)** for the
current, complete disclosure of provider traffic, local proposal retention, and
each opt-in outbound feature.

The ledger and dashboard are local, but Fiscus is not an offline-only program.
Outbound paths are explicit and purpose-scoped: configured provider traffic through
the proxy; an applied OpenAI Costs pull using the operator's admin credential;
pricing or baseline refreshes; configured alert webhooks; hosted judging when the
operator enables it; and signed numeric team rollups when `team push` is invoked.
The canonical, maintained disclosure is [DATA-BOUNDARIES.md](DATA-BOUNDARIES.md);
this overview must not be used as a shorter substitute for that boundary document.
