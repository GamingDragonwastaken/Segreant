<div align="center">

<img src="web/assets/seal-256.png" alt="The Fiscus Minted Seal — a heraldic griffin engraved on a gold coin" width="112" />

# Fiscus

**Govern the spend. Not the developer.**

Value-aware financial management for AI spend: a local-first proxy that prices
every AI call, measures what that spend actually *returns* (Return on
Intelligence), and **allocates your budget toward what's worth it** — in real
time, without a single byte of your code leaving the machine.

`local-first` · `value-aware` · `zero data egress` · `no build step` · `MIT`

[![CI](https://github.com/GamingDragonwastaken/aegisflow/actions/workflows/ci.yml/badge.svg)](https://github.com/GamingDragonwastaken/aegisflow/actions/workflows/ci.yml)

</div>

---

## Why

AI coding agents bill by the token now. An agent stuck in a loop overnight
doesn't send a warning — it sends an invoice. Traditional monitoring is blind to
this: a request that costs `$0.002` and a bloated loop that costs `$0.40` look
identical when you only measure latency and errors.

Fiscus sits in the path, prices every call locally, and caps runaway spend
**before** the bill — while treating prompts and source code as things that never
leave your device.

But capping waste is only the floor. The question a budget owner actually has is
*"is this spend worth it, and where should the next dollar go?"* — and "tokens
consumed" never answered it. Fiscus measures the return on every dollar of AI
spend and reallocates the budget toward the contexts that pay off. It's the
capital-allocation layer for AI, not another usage chart.

It is deliberately **not** a surveillance tool. Personal dashboards are for
self-optimization; team views (when enabled) are aggregate-only; and the
architecture puts privacy and latency ahead of analytics, always.

---

## Quickstart

New here? Start with **[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**. For the
measurement in plain language (the CFO version) see
**[docs/METHODOLOGY.md](docs/METHODOLOGY.md)**; common questions are in
**[docs/FAQ.md](docs/FAQ.md)**.

Requires **Node.js ≥ 24**. No build step, no native modules — it runs the
TypeScript directly via Node's built-in type stripping and uses Node's built-in
SQLite.

**See it work in ten seconds** — no API key, no setup:

```bash
npm install        # dev toolchain only (Fiscus has zero runtime deps)
npm run demo       # seeds labeled synthetic data and opens the dashboard
```

That lights up every surface — spend, governance alerts, the RoI index and its
four value lenses, the per-model×task frontier, the budget allocator — all priced
by the real cost engine in an isolated `demo.db`. Clear it with `fiscus demo --clear`.

**Then meter your real traffic:**

```bash
# from a clone
node bin/fiscus.mjs start
# or, once published
npx fiscus start
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

Per-tool recipes (opencode, aider, Cursor, Antigravity, your own SDK scripts) and
the **$0 Gemini free-tier test** are in **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**.

To stop tracking, unset the variables — traffic routes straight to the provider
and Fiscus is out of the path entirely.

---

## Commands

Onboarding — where you are, and how spend gets in with no wiring at all:

```
fiscus guide                 Where you are + the single next step, read from your
                                real state — also what bare `fiscus` shows  (--json)
fiscus scan [path]           One-command setup: find the AI tools + git repos on
                                this machine, preview a plan (read-only). --setup
                                imports every detected tool and correlates every repo
                                into per-project RoI, plus a read-only inventory of
                                other AI tools seen (not yet imported). --deep widens
                                the walk.
fiscus import <tool|all>     NATIVE metering, no routing — reads the usage a tool
                                already logs locally (works on subscriptions the proxy
                                can never see). Tools: claude-code, opencode, codex.
                                Idempotent; --watch keeps it live.  (--days N, --json)
fiscus discover              Correlate already-imported projects into per-project
                                RoI without re-importing — `scan --setup`'s other half
fiscus connect <tool>        Wire a tool through the proxy as a connected source
                                (opencode, antigravity, or any OpenAI-compatible API)
fiscus sources                Spend by connected source, at its honest depth
                                (--all for all-time, --json)
```

Metering, governance, and value:

```
fiscus start                 Start the proxy (:8090) + dashboard (:8091)
fiscus today | week | month  Show spend for a window        (--json)
fiscus roi --repo <path>     Return on Intelligence — four value lenses composed
                                into one index (--labor-rate $/hr, --tsf X, --json)
fiscus frontier --repo <p>   What's best for you — RoI by model × task-type + routing
fiscus usage                 RoI for usage without code signals (chat/research),
                                scored from reported outcomes
fiscus judge                 Score a real session's AI-assisted efficiency —
                                algorithmic by default; opt into a local/hosted LLM
                                judge via config.judge.*. Full-content tiers read
                                the session's own on-disk transcript ephemerally
                                (Claude Code, opencode, Codex — bounded excerpt,
                                nothing persisted)
                                (--session <id>, --window D, --project <name>, --json)
fiscus team                  Per-user value extraction — opt-in, distribution-only,
                                k-anonymous (--me <user> for your own view, --json)
fiscus team push --url <u>   Cross-machine: sign + push this window's per-project
                                value/RoI to a team server YOU run (Fiscus hosts
                                nothing). --dry-run to preview, --pubkey to publish
                                this machine's rollup identity (--window D, --project
                                <name>, --json)
fiscus budget --recommend    Value-aware budget from usage + realized value (--apply)
fiscus alerts                Governance alerts — spikes, throttling, runaway, value
                                craters (--repo for value; --json; exits 1 if critical).
                                Deliver to your webhook: --set-webhook <url>, then --notify
                                (cron it; metadata only — never prompts/code/keys)
fiscus export                Export the request ledger for BI (--csv|--json, --days N|
                                --all, --out <file>); dashboard has a ↓ CSV button too
fiscus realize --repo <path> Realization Standard — % of spend that became
                                verified durable outcomes      (--window D, --json)
fiscus report --kind K       Wire an outcome gate: tested|merged|shipped|incident
                                --commit <hash> [--verdict pass|fail] [--detail "…"]
fiscus exec -- <command>     AMBIENT outcome capture — wrap a command once (e.g.
                                `npm test`); every run reports its own exit code
fiscus receipt --repo <path> Emit signed value receipts (--pubkey to publish your
                                identity; --verify <file> --key-id <id> to verify + pin)
fiscus yield --repo <path>   AI Yield (survival lens) — durable lines per $
fiscus budget ...            Set caps (see below)
fiscus audit --repo <path>   Cost per commit from git history (--limit N, --json)
```

Operations:

```
fiscus init                  Write default config + print setup steps
fiscus doctor                First-run health check — config, DB, proxy, caps, pricing
fiscus config                Show config and file paths      (--json)
fiscus pricing --refresh     Update the rate card from the community price feed
                                (--auto to self-refresh on start when stale)
fiscus reprice               Re-cost estimated rows against the current rate card
                                (only rows the card now resolves exactly; dry-run
                                by default, --apply writes)
fiscus baseline              Show the Lift manual-minutes population prior: source,
                                age, task-type count (--json). Update it: baseline
                                --refresh --url <manifest> — no default source exists;
                                unlike pricing, METR publishes research, not a feed
fiscus project               Spend by project with aliases applied (--json). Tool
                                launch dirs fragment one real project across labels;
                                merge them: project merge <label...> --into <name>
                                (query-time only, raw rows untouched — undo with
                                project unalias <label>)
fiscus prune                 Prune old rows and compact the DB
fiscus demo                  Seed isolated, labeled synthetic data so every surface
                                populates with no API key (--serve opens the dashboard
                                on it; --clear removes it). Append --demo to today,
                                alerts, usage, or start to view the demo data.
```

### Budgets

```bash
fiscus budget --daily 25 --soft 18 --session 5 --runaway 2 --window 60
```

By default the cap enforces on **live proxy spend only** — the traffic it can
actually block. Imported subscription usage (Claude Code/opencode/codex logs) is
metered and shown everywhere, but doesn't trip the cap: it's sunk cost observed
after the fact, and letting it block live traffic froze a proxy that had spent
almost nothing. Prefer one cap over total observed spend?
`fiscus budget --include-imported on`.

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

Spend then rolls up by user in `fiscus today`, the dashboard's "By user"
card, and the CSV export. Unset → reported as `unassigned`. These headers are
stripped before the request is forwarded upstream — they never leave the device.

---

## The point: Return on Intelligence

Capping waste is the floor. The question that matters is **how much you actually
get from the AI** — and neither "tokens consumed" nor "lines of code" ever
answered it. Fiscus's core is **Return on Intelligence (RoI)**: a measure of
realized AI value that works across *any* token usage (not just coding), is
measured from the request path instead of surveys, and composes four value
lenses into one index that can't be gamed on a single axis.

> **RoI Index** = geometric mean of **Realization · Acceptance · Lift · Impact** —
> if any one lens collapses, the index collapses. The denominator is **tokens +
> the human effort it cost** (priced at a labor rate), not tokens alone.

That index is unitless on purpose — it answers *"how well is the intelligence
working, across every axis at once?"*, and a geometric mean resists gaming because
one weak lens drags the whole number down. But a budget owner also asks a blunter
question: **did it pay for itself, in dollars?** So RoI has a second, independent
face:

> **RoI Return** ℛ = **realized value ÷ honest cost**. Value is the manual time
> the realized work would otherwise have taken, priced at your labor rate and
> discounted by first-pass acceptance; cost is **tokens + the measured supervision
> time** it took to get there. **ℛ ≥ 1 ⟺ the spend paid for itself.** It's
> reported as an *interval*, because the counterfactual — "how much faster than
> doing it without AI?" — is honestly a range, not a point.

The two faces are deliberately **never multiplied**. The dollar return already
*is* a speedup, and so is the Lift lens inside the index — combining them would
square the same effect. The index tells you *how well* the intelligence works; the
return tells you *whether it was worth it*. And because the measured supervision
time sits in the denominator, the return lands in the **empirically-documented
~1–2× range** for real coding work — not the fantasy 100× you get from counting
tokens alone. Fiscus refuses to print a dollar return at all until it has
measured supervision time to divide by; an honest "not yet" beats a flattering
lie.

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
signal, not to game one. `fiscus roi --repo .`

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
outcome` that anyone can verify without access to your source (`fiscus
receipt`). And `unknown` is never `fault`: a gate you haven't wired stays
`unknown` and the report shows your instrumentation coverage ("3 of 8 gates
wired"). The path to a higher number is to wire more gates — not to game one.

```bash
fiscus realize --repo .            # the funnel + the three headline numbers
fiscus report --kind tested --commit HEAD   # wire an outcome gate
fiscus receipt --repo .            # emit signed value receipts
```

The full model is in **[docs/THE-STANDARD.md](docs/THE-STANDARD.md)**. The older
**AI Yield** (`fiscus yield`) survives as one *lens* — durable lines per
dollar — but the Standard, not Yield, is the headline. The honest account of why
the research's "AI Efficiency Score" and our own first Yield-only attempt were
both rebuilt is in [docs/RESEARCH-REVIEW.md §3](docs/RESEARCH-REVIEW.md).

## Allocate by return

Measuring RoI is the core; **acting on it** is the point. Fiscus turns the
measurement into budget decisions — the capital-allocation layer:

- **A value-aware cap** — `fiscus budget --recommend` derives a daily budget
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
IDE / Agent → ANTHROPIC_BASE_URL/OPENAI_BASE_URL → Fiscus proxy (:8090)
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
Fiscus meters far more than two vendors. The simplest way: point
`upstreams.openai` at any compatible base — **OpenRouter** (which itself fronts
Gemini, Claude, Llama, Mistral, DeepSeek, and more), **Ollama** and other local
model servers, **DeepSeek**, **Mistral** — and every call is metered, priced, and
capped locally. No flag, nothing else to change.

**Pricing follows the model, not the wire.** The cost engine resolves a rate by
model family *across* providers, so a `gemini-*` model carried over the
OpenAI-compatible path is billed at Google's real published rate — Gemini is a
first-class, verified entry in the rate card, not a generic fallback. That also
makes it the easiest **zero-cost way to meter a live agent**: point
`upstreams.openai` at Google's free-tier OpenAI-compatible endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai/`), run any tool through
Fiscus with a `gemini-2.5-flash` model, and watch a real RoI accrue without
spending a cent.

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

Cost-reduction percentages depend on your baseline waste. Fiscus's job is to
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
  set an alert webhook (`fiscus alerts --set-webhook <url>`), Fiscus POSTs
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

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `typecheck` +
`test` on Linux, macOS, and Windows for every push and pull request to `main`.

---

## Status

**Two ways in, and they cross-correlate.** *Proxy* metering (Anthropic, OpenAI
(Chat Completions and Responses API), **natively-priced Gemini**, and **any
OpenAI-compatible provider** via `x-aegis-openai-base` — OpenRouter, Ollama,
DeepSeek, Mistral, …) covers anything
you point at it live, with transparent fail-open on upstream errors and a
connect/TTFB timeout so a hung provider can't hang you. **Native import** (`fiscus
import` — Claude Code, opencode, Codex CLI) reads what those tools already log
locally, with **zero base-URL wiring**. `fiscus scan` finds both the tools and the
git repos on your machine — plus a wider, read-only inventory of other AI coding
tools it sees installed (Cursor, Windsurf, Aider, Continue, Zed) but doesn't import
from yet — and can set the whole thing up in one command; `discover` auto-correlates
whatever it finds into **per-project Return on Intelligence**, tagged with which tool
coded it — no `--repo` needed either way.

Cost engine with **cross-provider, model-family pricing** that **self-refreshes**
from a community feed, budget enforcement + **value-aware allocation**, persisted
repo-less realized-value with a **per-project budget-owner view**, and **opt-in,
k-anonymous per-user value**. **Lift** derives from measured time-with-AI × task
baselines that blend a cited population prior (METR's published human-timed task
scale) with your own pre-tracking git history via empirical-Bayes shrinkage — no
synthetic constant, no unsourced table. A state-aware `fiscus guide` (and bare
`fiscus`) tells you the single next step from your actual data. Terminal + a
**fully self-contained** web dashboard (zero external requests) mirror every
surface.

**335/336 tests (1 skipped — POSIX-only permission semantics), `tsc` clean, CI on
Linux/macOS/Windows.** Installable via `npx fiscus`. See [docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md) for what's
deliberately still open — `fiscus team push` can sign and push a numeric-only
project rollup to [`team-server/`](team-server/README.md), a separate,
optional, BYO-Postgres server an operator runs themselves (Fiscus hosts
nothing; its own `package.json` keeps `pg` out of the main CLI's dependency
tree). The server verifies and stores what's pushed, verifies a human's SSO
login via OIDC (`node:crypto` only, RS256/ES256), and now serves a real,
OIDC-gated aggregate dashboard API back out — team-wide spend/RoI by project,
and an opt-in, k-anonymized distribution by developer, never a named list
(team-server's own 46-test suite). Still out of scope: a rendered dashboard UI
over that API, and linking an OIDC identity to a specific developer for a
self-view.

MIT licensed.
