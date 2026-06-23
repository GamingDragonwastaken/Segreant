<div align="center">

# AegisFlow

**Govern the spend. Not the developer.**

Value-aware financial management for AI spend: a local-first proxy that prices
every AI call, measures what that spend actually *returns* (Return on
Intelligence), and **allocates your budget toward what's worth it** — in real
time, without a single byte of your code leaving the machine.

`local-first` · `value-aware` · `zero data egress` · `no build step` · `MIT`

</div>

---

## Why

AI coding agents bill by the token now. An agent stuck in a loop overnight
doesn't send a warning — it sends an invoice. Traditional monitoring is blind to
this: a request that costs `$0.002` and a bloated loop that costs `$0.40` look
identical when you only measure latency and errors.

AegisFlow sits in the path, prices every call locally, and caps runaway spend
**before** the bill — while treating prompts and source code as things that never
leave your device.

But capping waste is only the floor. The question a budget owner actually has is
*"is this spend worth it, and where should the next dollar go?"* — and "tokens
consumed" never answered it. AegisFlow measures the return on every dollar of AI
spend and reallocates the budget toward the contexts that pay off. It's the
capital-allocation layer for AI, not another usage chart.

It is deliberately **not** a surveillance tool. Personal dashboards are for
self-optimization; team views (when enabled) are aggregate-only; and the
architecture puts privacy and latency ahead of analytics, always.

---

## Quickstart

Requires **Node.js ≥ 22.5** (Node 24 recommended). No build step, no native
modules — it runs the TypeScript directly and uses Node's built-in SQLite.

**See it work in ten seconds** — no API key, no setup:

```bash
npm install        # dev toolchain only (AegisFlow has zero runtime deps)
npm run demo       # seeds labeled synthetic data and opens the dashboard
```

That lights up every surface — spend, governance alerts, the RoI index and its
four value lenses, the per-model×task frontier, the budget allocator — all priced
by the real cost engine in an isolated `demo.db`. Clear it with `aegisflow demo --clear`.

**Then meter your real traffic:**

```bash
# from a clone
node bin/aegisflow.mjs start
# or, once published
npx aegisflow start
```

Then point your tools at it:

```powershell
# PowerShell
$env:ANTHROPIC_BASE_URL="http://localhost:8090"
$env:OPENAI_BASE_URL="http://localhost:8090/v1"
```

```bash
# bash / zsh
export ANTHROPIC_BASE_URL="http://localhost:8090"
export OPENAI_BASE_URL="http://localhost:8090/v1"
```

Run your agents as usual. Watch spend accrue in the terminal and at
**http://localhost:8091**.

To stop tracking, unset the variables — traffic routes straight to the provider
and AegisFlow is out of the path entirely.

---

## Commands

```
aegisflow start                 Start the proxy (:8090) + dashboard (:8091)
aegisflow today | week | month  Show spend for a window        (--json)
aegisflow roi --repo <path>     Return on Intelligence — four value lenses composed
                                into one index (--labor-rate $/hr, --tsf X, --json)
aegisflow frontier --repo <p>   What's best for you — RoI by model × task-type + routing
aegisflow usage                 RoI for non-coding usage (chat/research), from outcomes
aegisflow budget --recommend    Value-aware budget from usage + realized value (--apply)
aegisflow alerts                Governance alerts — spikes, throttling, runaway, value
                                craters (--repo for value; --json; exits 1 if critical).
                                Deliver to your webhook: --set-webhook <url>, then --notify
                                (cron it; metadata only — never prompts/code/keys)
aegisflow export                Export the request ledger for BI (--csv|--json, --days N|
                                --all, --out <file>); dashboard has a ↓ CSV button too
aegisflow realize --repo <path> Realization Standard — % of spend that became
                                verified durable outcomes      (--window D, --json)
aegisflow report --kind K       Wire an outcome gate: tested|merged|shipped|incident
                                --commit <hash> [--verdict pass|fail] [--detail "…"]
aegisflow receipt --repo <path> Emit signed value receipts (--pubkey to publish your
                                identity; --verify <file> --key-id <id> to verify + pin)
aegisflow yield --repo <path>   AI Yield (survival lens) — durable lines per $
aegisflow budget ...            Set caps (see below)
aegisflow audit --repo <path>   Cost per commit from git history (--limit N, --json)
aegisflow init                  Write default config + print setup steps
aegisflow doctor                First-run health check — config, DB, proxy, caps, pricing
aegisflow config                Show config and file paths      (--json)
aegisflow prune                 Prune old rows and compact the DB
aegisflow demo                  Seed isolated, labeled synthetic data so every surface
                                populates with no API key (--serve opens the dashboard
                                on it; --clear removes it). Append --demo to today,
                                alerts, usage, or start to view the demo data.
```

### Budgets

```bash
aegisflow budget --daily 25 --soft 18 --session 5 --runaway 2 --window 60
```

| Flag | Meaning |
|---|---|
| `--daily N` | Hard daily cap — requests are blocked once today's spend hits `N`. |
| `--soft N` | Soft daily threshold — a warning header is added past `N` (no block). |
| `--session N` | Hard per-session cap (`X-Aegis-Session-Id`). |
| `--runaway N` | Block when spend in the sliding window exceeds `N` (loop guard). |
| `--window S` | Runaway window length in seconds (default 60). |

Pass `off` to clear any cap (e.g. `--daily off`). Caps are opt-in; a fresh
install meters but never blocks.

### Attribution headers

Group spend by project, developer/team, session, or task by sending custom
headers (your agent or a wrapper script sets these):

```
X-Aegis-Project: backend-refactor
X-Aegis-User: alice@team          # per-developer / per-team FinOps
X-Aegis-Session-Id: <uuid>
X-Aegis-Task-Weight: 1.5
```

Spend then rolls up by user in `aegisflow today`, the dashboard's "By user"
card, and the CSV export. Unset → reported as `unassigned`. These headers are
stripped before the request is forwarded upstream — they never leave the device.

---

## The point: Return on Intelligence

Capping waste is the floor. The question that matters is **how much you actually
get from the AI** — and neither "tokens consumed" nor "lines of code" ever
answered it. AegisFlow's core is **Return on Intelligence (RoI)**: a measure of
realized AI value that works across *any* token usage (not just coding), is
measured from the request path instead of surveys, and composes four value
lenses into one index that can't be gamed on a single axis.

> **RoI Index** = geometric mean of **Realization · Acceptance · Lift · Impact** —
> if any one lens collapses, the index collapses. The denominator is **tokens +
> the human effort it cost** (priced at a labor rate), not tokens alone.

The four lenses, each answering a different real question (full definitions in
**[docs/RETURN-ON-INTELLIGENCE.md](docs/RETURN-ON-INTELLIGENCE.md)**):

| Lens | Question | 
|------|----------|
| **Realization** | Did the spend become something real and kept? |
| **Acceptance** | Did you keep what it gave you, first try? (edit-distance, in-session) |
| **Lift** | Was it worth it vs. not using it / a cheaper model? (behavioral, not self-report) |
| **Impact** | Of what was realized, how much actually mattered? |

A lens with no signal reads `uninstrumented` and is excluded — never faked — and
the report shows your lens coverage. The path to a higher number is to wire more
signal, not to game one. `aegisflow roi --repo .`

### The Realization substrate

Underneath RoI, the **Realization Standard** verifies that a coding outcome is
real. Each commit travels a funnel of eight objective gates — **Proposed →
Accepted → Committed → Tested → Merged → Shipped → Survived → Clean** — and a
unit is *realized* when it reaches the end with no failure. From that:

- **Realization Rate** *(production, dollar-free)* — share of work that reached
  verified durable value. The answer to "are we turning AI into real outcomes?"
- **Realized Value Rate** *(the money lens)* — share of *spend* that reached
  realized. Cost matched to outcome: an AI P&L. Money is a lens here, never the
  definition of production.
- **First-Pass Acceptance** *(collaboration)* — how much of what the AI
  *proposed* actually shipped, measured by edit-distance between the proposed
  diff (seen in the proxy path) and what was committed. This is the signal only
  an in-path tool can capture, and it's available in the same session.

What makes it a *standard* and not a dashboard: every realized unit emits a
**Value Receipt** — an ed25519-signed, portable record of `cost → gate verdicts →
outcome` that anyone can verify without access to your source (`aegisflow
receipt`). And `unknown` is never `fault`: a gate you haven't wired stays
`unknown` and the report shows your instrumentation coverage ("3 of 8 gates
wired"). The path to a higher number is to wire more gates — not to game one.

```bash
aegisflow realize --repo .            # the funnel + the three headline numbers
aegisflow report --kind tested --commit HEAD   # wire an outcome gate
aegisflow receipt --repo .            # emit signed value receipts
```

The full model is in **[docs/THE-STANDARD.md](docs/THE-STANDARD.md)**. The older
**AI Yield** (`aegisflow yield`) survives as one *lens* — durable lines per
dollar — but the Standard, not Yield, is the headline. The honest account of why
the research's "AI Efficiency Score" and our own first Yield-only attempt were
both rebuilt is in [docs/RESEARCH-REVIEW.md §3](docs/RESEARCH-REVIEW.md).

## Allocate by return

Measuring RoI is the core; **acting on it** is the point. AegisFlow turns the
measurement into budget decisions — the capital-allocation layer:

- **A value-aware cap** — `aegisflow budget --recommend` derives a daily budget
  from real usage (p90 of active days), tightened when realized value is low,
  with projected monthly waste called out.
- **Reallocation, quantified** — it re-weights the *same* budget toward the
  model × task-type contexts that return the most, and shows the projected
  realized-value gain of each move: *"move $2.77 from refactor·gpt-4o (RoI 0) to
  feature·opus (RoI 97) → ≈ +$2.77 realized value."* Not a vague "use less" — a
  concrete allocation, in the CLI and the dashboard.
- **The budget owner's view** — because realized value is **persisted** (not
  recomputed live from a working copy), a manager's dashboard shows per-project
  RoI — *which team's AI spend is paying off* — without a single repository on
  their machine. The person who holds the budget finally gets to see whether it
  worked.

Every projection states its assumption (it holds each context's realized-value
rate at the margin — a planning estimate, re-measured after you act), the same
way the lenses stay honest about coverage.

## How it works

```
IDE / Agent → ANTHROPIC_BASE_URL/OPENAI_BASE_URL → AegisFlow proxy (:8090)
                                                       │ price locally, log to SQLite
                                                       ▼ forward, keys untouched
                                                  api.anthropic.com / api.openai.com
```

1. **Point your tools at it** — base-URL override. No certificate to install.
2. **Every call is metered** — the proxy reads the exact usage each provider
   returns (streaming or not), prices it against a versioned rate card, and logs
   it on-device. Prompt bodies are parsed for nothing but never stored.
3. **Runaway spend is capped** — soft warnings, hard caps, and a velocity guard
   that halts a looping agent before the bill.

Full design in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Beyond Anthropic & OpenAI

The OpenAI route speaks the wire format most of the ecosystem now exposes, so
AegisFlow meters far more than two vendors. The simplest way: point
`upstreams.openai` at any compatible base — **OpenRouter** (which itself fronts
Gemini, Claude, Llama, Mistral, DeepSeek, and more), **Ollama** and other local
model servers, **DeepSeek**, **Mistral** — and every call is metered, priced, and
capped locally. No flag, nothing else to change.

Want to switch providers *per request* from one proxy? Enable
`allowOpenAIBaseOverride` in config, then send the base as a header:

```
X-Aegis-OpenAI-Base: https://openrouter.ai/api    # then call /v1/chat/completions as usual
```

It's **off by default on purpose**: that header would forward your provider auth
to the URL it names, so honoring it unconditionally could leak your key. The
header is stripped before forwarding upstream and never leaves the device.

---

## What's real, what's not

This project ships with an honest audit of its own premise in
**[docs/RESEARCH-REVIEW.md](docs/RESEARCH-REVIEW.md)** — what was verified,
what was corrected (the cost formula, the MITM design, model ids), and what was
deliberately left out (a per-developer "efficiency score" that would just
recreate the metric-gaming it's meant to stop).

Cost-reduction percentages depend on your baseline waste. AegisFlow's job is to
make that baseline visible and give you the controls to act — not to promise a
number.

---

## Privacy

- No prompt text, source code, or credentials are transmitted anywhere.
- Provider API keys pass through to the provider and are **never stored**.
- All cost computation happens on-device against a local pricing table.
- The dashboard itself makes **zero external requests** — no web fonts, no CDNs,
  no analytics. Open your browser's network tab and confirm it.
- The local store lives under `~/.aegisflow` (`%USERPROFILE%\.aegisflow` on
  Windows) under your OS file permissions.
- **The one thing that can leave the device is opt-in and metadata-only:** if you
  set an alert webhook (`aegisflow alerts --set-webhook <url>`), AegisFlow POSTs
  alert summaries — severity, title, a short metric like `$35.00 / $30.00` — to
  *your* endpoint. By construction it sends nothing else: no prompts, no code, no
  keys. Off by default.

---

## Development

```bash
npm install          # dev-only: typescript + @types/node
npm test             # node --test (cost, usage, proxy, budget, git)
npm run typecheck    # tsc --noEmit (strict)
```

Runtime dependencies: **none.** The `node_modules` directory holds only the dev
toolchain.

---

## Status

Working core: proxy (Anthropic, OpenAI, and **any OpenAI-compatible provider** via
`x-aegis-openai-base` — OpenRouter, Ollama, DeepSeek, Mistral, …), streaming +
non-streaming, with transparent fail-open on upstream errors. Cost engine, budget
enforcement + **value-aware allocation**, git correlation with **persisted,
repo-less realized-value** and a **per-project budget-owner view**. **Lift** now
derives from measured time-with-AI × configurable task baselines (no synthetic
constant in real use). Terminal + a **fully self-contained** web dashboard (zero
external requests). 90/90 tests, `tsc` clean. See
[docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md) for what comes next (cross-machine
team sync, native non-OpenAI APIs, auto-updating pricing).

MIT licensed.
