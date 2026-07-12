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

Every dollar of AI spend has to survive four independent tests to become real value.
We score each one separately, then combine them:

| # | The question | Plain meaning |
|---|---|---|
| **ρ Realization** | Did it become something real and lasting? | Not reverted, still in the codebase, shipped. |
| **α Acceptance** | Did you keep it without rewriting? | How much of what the AI proposed actually got used. |
| **λ Lift** | Would you have done it anyway? | The honest counterfactual — did AI actually save time. |
| **ι Impact** | Did it matter? | Reached production, stuck, no incidents (not "how big"). |

## Why we *multiply* them (the part that can't be gamed)

These four are a chain: spend → kept → caused → mattered. To become value, a dollar
has to pass **all four** — so the odds are the four multiplied together, exactly like
a factory's yield through four quality checks, or a chain that's only as strong as
its weakest link:

> **RoI Index = ρ × α × λ × ι** (as a weighted geometric mean, scored 0–100)

This is the key honesty property: **you cannot fake the score by maxing one number.**
If any one of the four is near zero, the whole score collapses. A dashboard that just
*averages* things can be gamed by pumping a single metric — ours can't, by
construction. (This is a mathematical theorem, not a marketing claim; it's tested.)

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
   "not yet measured" — never counted as a pass or a fail. A partly-measured score is
   labeled an **upper bound**: wiring up more measurement can only move it *down*
   toward the truth, never inflate it. That's the opposite of every vanity dashboard.

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
instrument that measures AI's real return across any kind of usage, from your own
machine, and can't be gamed on a single axis. Stating exactly which parts are
standard is what makes the rest credible.

## Your data never leaves your machine

Everything is computed locally in a file-based database. No prompts, no code, no keys
are ever transmitted. The only optional outbound traffic is a public pricing-table
refresh (off by default) and alert webhooks you explicitly configure (which carry
alert titles only — never content).
