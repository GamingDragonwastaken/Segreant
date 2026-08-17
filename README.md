<div align="center">

<img src="web/assets/seal-256.png" alt="The Fiscus Minted Seal — a heraldic griffin engraved on a gold coin" width="112" />

# Fiscus

**Govern the spend. Not the developer.**

Local-first financial control and outcome evidence for AI coding-agent spend: a
proxy that meters configured traffic, assigns a local list-price estimate,
measures evidence of what that spend actually *returns* (Return on
Intelligence), and presents review-only within-task model trials with explicit
provider and operator-controlled egress boundaries.

`local-first` · `evidence-limited` · `explicit egress boundaries` · `MIT`

[![CI](https://github.com/GamingDragonwastaken/Fiscus/actions/workflows/ci.yml/badge.svg)](https://github.com/GamingDragonwastaken/Fiscus/actions/workflows/ci.yml)

</div>

> **Data boundary:** “local-first” means Fiscus has no hosted telemetry by
> default. Requests routed through the proxy still go to your configured AI
> provider. See [the complete data-boundary disclosure](docs/DATA-BOUNDARIES.md)
> before using sensitive material.

---

## Why

AI coding agents bill by the token now. An agent stuck in a loop overnight
doesn't send a warning — it sends an invoice. Traditional monitoring is blind to
this: a request that costs `$0.002` and a bloated loop that costs `$0.40` look
identical when you only measure latency and errors.

Fiscus sits in the path, assigns a local price estimate, and can cap further
proxy-routed usage before it grows. It has no Fiscus-hosted telemetry by default;
requests still travel to the AI provider configured by the operator.

But capping waste is only the floor. The question a budget owner actually has is
*"is this spend worth it?"* — and tokens alone never answer it. Fiscus measures
outcome evidence and offers conservative, review-only comparisons within the
same task type. It does not automatically reallocate budgets, route providers,
or present raw RoI rankings as causal allocation evidence.

It is deliberately **not** a surveillance tool. Personal dashboards are for
self-optimization; team views (when enabled) are aggregate-only; and the
architecture puts privacy and latency ahead of analytics, always.

---

## Quickstart

New here? Start with **[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**. For the
measurement in plain language (the CFO version) see
**[docs/METHODOLOGY.md](docs/METHODOLOGY.md)**; common questions are in
**[docs/FAQ.md](docs/FAQ.md)**.

Requires **Node.js >= 24**. A cloned checkout builds the distributable runtime
during `npm install`; the packaged runtime needs no build at use time and uses
only Node's built-in SQLite.

**See it work in ten seconds** — no API key, no setup:

```bash
npm install        # compiles the local CLI; Fiscus has zero runtime dependencies
npm run demo       # seeds labelled synthetic data and starts the local dashboard
```

That lights up spend, governance alerts, the RoI index and its four value
lenses, the model-by-task frontier, budget controls, and a review-only synthetic
model trial in an isolated `demo.db`. Clear it with `fiscus demo --clear`.

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
fiscus saved --repo <path>   Manual work-weeks reclaimed vs measured AI hours —
                                honestly banded, split by task type (--window D, --json)
fiscus frontier --repo <p>   Compare models on like tasks; lower-cost same-outcome trials + local headroom
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
fiscus budget --recommend    Evidence-limited cap recommendation from usage +
                                realized value (applies a cap only; no routing or
                                budget reallocation)
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
                                (--auto opts into a refresh check on start when stale)
fiscus pricing --coverage    Read-only per-model historical rate-card and match
                                evidence (--days N or --all; --json for automation)
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
                                project unalias <label>). --coverage reports how
                                each label was obtained — declared, path-inferred,
                                or never attributed at all
fiscus prune                 Prune old rows and compact the DB
fiscus demo                  Seed isolated, labeled synthetic data so every surface
                                populates with no API key (--serve starts the dashboard
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

**These labels are assertions, not verified identity.** Anything on this machine
that can reach the proxy can set them, so Fiscus records *how* each project label
was obtained alongside the label itself:

| Basis | Meaning |
| --- | --- |
| `client_declared` | An `X-Aegis-Project` header — or a `/fiscus/<project>/` base-URL prefix — on a proxied request. Self-asserted either way. |
| `tool_log_repo_resolved` | The tool recorded a working directory, and it resolved to a git repository on this machine. The label is that repository's root name. |
| `tool_log_inferred` | Derived from a working directory the tool recorded, which is not inside a git repository. |
| `tool_log_fallback` | The tool recorded no usable path, so its own name was used. Not a real project. |
| `unattributed` | The request declared no project. Stored under `default`, but it is not one. |
| `synthetic_demo` | Seeded demo data. |
| `legacy_unknown` | Recorded before attribution lineage existed. Never backfilled or guessed. |

**Imports resolve the repository, not the folder name.** Claude Code and Codex
record the working directory a session ran in, which is routinely a
subdirectory — so the old basename rule split one repository's spend across
`web`, `api`, `packages`, and merged unrelated repositories that share a common
leaf name. The importers now ask git for the working-tree root, which produces
the same label `fiscus realize` computes for that repo and records
`tool_log_repo_resolved`. Outside a repository it degrades to the previous
behaviour and says so. Existing rows are never rewritten, so an import that
relabels reports it and points at `fiscus project alias` — the ledger records
what it recorded.

**A client with no headers can still declare a project.** Antigravity's
custom-provider form has a base URL and no custom-headers field, so
`X-Aegis-Project` is simply unavailable to it. The proxy therefore also accepts
the project as a path prefix — `http://localhost:8090/fiscus/backend-api/v1` —
which it strips before forwarding, so the provider sees an unchanged request.
The header wins if both are sent. Fiscus offers the URL and will not configure
it: a provider entry is IDE-wide, so one baked-in project would mislabel every
other repository. It is your declaration, recorded as `client_declared`, and
never verified.

`fiscus connect opencode` sets the project header for you **only when the config
it edits is project-scoped** — an `opencode.json(c)` in the repo itself, which by
construction applies to that project alone. For a global config it deliberately
sets nothing and says so: one label baked into a config that governs every
directory would be wrong in all the others, and a confidently wrong project is
worse than an honest blank. To attribute a globally-configured tool, keep an
`opencode.json` in the repo and re-run connect there.

Inspect the split with `fiscus project --coverage` (`--json` for the full result);
it also appears under each bar of the dashboard's "By project" card and as an
`attributionBasis` column in the CSV export. Recording the basis changes no
totals — the same spend rolls up the same way. This is deliberately **not**
chargeback-grade attribution: that would require a verified collector identity,
which Fiscus does not have.

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

## Budget controls and model trials

**Current evidence boundary (supersedes the historic generic-allocation wording
below):** Fiscus does **not** issue a default reallocation instruction across
unlike task types or projects. Raw RoI cells are not causal or generally
comparable, so the CLI and dashboard withhold those actions. The current
actionable decision support is the within-task, review-only cheaper-model trial
below; any generic raw allocation arithmetic is retained only as an explicitly
`exploratory_raw` offline scenario, never a forecast or applied budget change.

Measuring RoI informs the controls and experiments below. It does not turn raw
historical rankings into a default budget-allocation action:

- **A value-aware cap** — `fiscus budget --recommend` derives a daily budget
  from real usage (p90 of active days, after at least seven active days),
  tightened when realized value is low, with projected monthly waste called
  out.
<!-- Historic raw-allocation description: deliberately withheld from all Fiscus
product surfaces because model/task and project cells can be unlike work. -->
<!--
- **Reallocation, quantified** — it re-weights the *same* budget toward the
  model × task-type contexts that return the most, and shows the projected
  realized-value gain of each move: *"move $2.77 from refactor·gpt-4o (RoI 0) to
  feature·opus (RoI 97) → ≈ +$2.77 realized value."* Not a vague "use less" — a
  concrete allocation, in the CLI and the dashboard.
-->
- **The budget owner's view** — because realized value is **persisted** (not
  recomputed live from a working copy), a manager's dashboard shows per-project
  RoI — *which team's AI spend is paying off* — without a single repository on
  their machine. The person who holds the budget finally gets to see whether it
  worked.
- **Cheaper-model trials** — `fiscus frontier` compares models only within the
  same task type. It surfaces a lower-cost candidate only when it has no worse
  observed realized-outcome rate across at least three mature units per model.
  Each model is priced by **its own attributed spend**, never by the whole
  attribution window it worked in: a unit whose window is more than 20% other
  models cannot price a single model, so it is excluded — and the excluded count
  is reported alongside the result rather than quietly shrinking the sample.
  A result is labelled **evidence-supported** only when the anytime-valid outcome
  bounds separate *and* that separation survives one outcome flipping the wrong
  way on each side; anything resting on a single observation stays a **trial**,
  not a proven switch. It never changes routing.
- **It says when a comparison is confounded.** Cost-per-unit is blind to how big
  each unit was, so if the two models' median changed lines differ by more than
  2×, "cheaper" may just mean "smaller work" — that is named on the result and
  caps it at a trial no matter how cleanly the statistics separate. Beyond
  flagging the size gap, the saving is **re-checked against work volume**: the
  same dollars are divided by changed lines as well as by commit count, and if
  the candidate is cheaper per commit but not per hundred lines, what was
  measured was smaller work rather than a cheaper model. Both figures are shown.
  A cohort is also capped when its commits come from **too few working
  sessions** — commits within eight hours of each other share an author, a task,
  a codebase state and one decision to use that model, so forty-eight commits
  from one sitting are not forty-eight trials. And because a price comparison is
  only meaningful between comparable prices, a result is capped when the two
  sides were **priced on different bases** (an exact list price against a
  fallback rate for an unrecognized model), when the sample **spans a rate-card
  revision** so pre- and post-change amounts pool into one per-unit cost, or
  when the pricing lineage was never recorded at all. The same applies when the
  two models were used in non-overlapping periods, which makes it an era
  comparison as much as a model one. Unclassified (`other`) work is never
  treated as a like-work cohort, and because every model pair scanned is another
  chance at a false positive, the 5% is split across all of them — three models
  in one task type is two comparisons, not one.
- **It ships the assumptions it cannot check** on every result: the intervals
  still treat each commit as an independent trial even though clustering now
  caps the label; the model was chosen by an operator, not assigned, so easier
  work may have gone to the cheaper one; and the pair under test was chosen by
  searching on the very outcome being tested, over a sliding window whose past
  verdicts can change on re-run, each of which weakens the anytime-valid
  guarantee the interval would otherwise carry.

Historical-equivalent headroom is disclosed as a local planning comparison, not
a forecast, provider-billed saving, or guarantee. It is computed from local
list-price estimates, so it is not provider-billed cost. The result must be
re-measured after any operator-led trial.

## How it works

```
IDE / Agent → ANTHROPIC_BASE_URL/OPENAI_BASE_URL → Fiscus proxy (:8090)
                                                       │ price locally, log to SQLite
                                                       ▼ forward, keys untouched
                                                  api.anthropic.com / api.openai.com
```

1. **Point your tools at it** — base-URL override. No certificate to install.
2. **Configured traffic is metered when usage is available** — the proxy reads
   usable upstream usage (streaming or not), assigns a local estimate from a
   versioned rate card, and logs it on-device. Prompt bodies are not stored by
   this metering path.
3. **Runaway spend is capped** — soft warnings, hard caps, and a velocity guard
   can halt a looping agent before further proxy-routed provider usage.

The rate card is a local list-price estimate. Every newly calculated ledger row
retains the exact rate-card SHA-256, source kind, and exact/family/fallback
match path that produced it; `fiscus reprice --apply` keeps an append-only
before/after event instead of silently overwriting the estimate. Tool-reported
and demo values are labelled separately. None of these labels claim
provider-invoiced, discounted, credited, taxed, or reconciled cost.

A reprice also moves the money that stored realized-value snapshots were built
from, so `--apply` re-attributes those snapshots in the same transaction, on the
basis each one recorded (its own project's spend, or the project-blind window
sum). Only the dollars are recomputed — gate verdicts, maturity, and realized
outcomes are independent of price and are never touched, so a reprice cannot
change whether work realized. Snapshots written before that basis was recorded
cannot be reproduced faithfully; rather than guess, they keep their original
amounts, are marked as carrying pre-reprice costs on the CLI and the dashboard,
and are excluded from cheaper-model comparison until `fiscus realize` recomputes
them. Seeded demo units are neither: their costs are asserted by the seed, not
summed from the ledger, so a ledger reprice leaves them alone.

The dashboard's **Rate-card health** panel shows the active card separately
from the historical, per-model evidence cohorts that produced the amounts in
the selected window. It never merges different card revisions or match paths,
and it never refreshes pricing or reprices history.

Full design in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Provider billing evidence (local import v1)

Fiscus can now retain a separate, immutable ledger of **operator-supplied
OpenAI provider-cost evidence**. This is the first step beyond a local price
card: it gives a finance owner a source digest, account reference, source
period, coverage declaration, and provider-declared positive/negative charge lines without
turning them into proxy requests.

```powershell
fiscus billing import --file .\openai-costs.fiscus.json       # validate/dry-run
fiscus billing import --file .\openai-costs.fiscus.json --apply
fiscus billing status
fiscus billing export --csv --out .\provider-cost-evidence.csv
```

If you operate the local proxy, you may additionally attach an **operator-declared,
unverified** account/project reference to future OpenAI-proxy rows that use the
exact configured upstream:

```powershell
fiscus billing scope set --account-ref finops-production --project-ref proj_123 # preview
fiscus billing scope set --account-ref finops-production --project-ref proj_123 --apply
```

It is local routing provenance, not provider authentication or reconciliation:
imports remain separate, historical rows are never backfilled, and a route-scope
declaration never changes caps, RoI, or `today` totals.

V1 is deliberately a strict local JSON contract, not a guessed CSV/PDF parser
or a credentialed provider sync. It does not overwrite metered estimates, add
provider totals to `today`, claim invoice accuracy, or calculate a variance:
local request rows do not yet have a verified provider billing-account binding.
See [BILLING-EVIDENCE-IMPORT.md](docs/BILLING-EVIDENCE-IMPORT.md) for the exact
schema, idempotency rules, retention model, and the gate before reconciliation.

### Optional OpenAI Costs observation (read-only, preview first)

With an active local declaration for the exact `https://api.openai.com` endpoint
and an exact OpenAI `proj_...` project reference, Fiscus can make one explicit,
read-only observation of the documented Organization Costs daily buckets:

```powershell
# Validates only — no credential lookup, no network request, no database write.
fiscus billing openai-costs preview --from 2026-01-01 --to 2026-01-08

# Dry pull is also a preview. --apply is required before any network call.
# The process-only OPENAI_ADMIN_API_KEY is never written to config or SQLite.
$env:OPENAI_ADMIN_API_KEY = '...'
fiscus billing openai-costs pull --from 2026-01-01 --to 2026-01-08 --apply
fiscus billing openai-costs status

# Reads only the newest complete local provider snapshot and local request ledger.
# It performs no network request, credential lookup, database write, or variance calculation.
fiscus billing openai-costs coverage
```

The connector uses only `GET https://api.openai.com/v1/organization/costs`, with
UTC daily `[from,to)` buckets, the declared project filter, and a maximum of 180
days. It retains a digest chain, allowed normalized daily project/line-item
observations, and successful or failed run metadata—never the API key or raw
response body. It is still a provider observation, **not reconciliation**: its
snapshots remain outside request totals, budgets, RoI, and model recommendations.
The coverage report can make local capture gaps visible by separating matching
declared-route proxy rows from imports, unscoped/legacy rows, another declared
route, and other providers. It does not sum provider line items or produce a
provider/request variance: a local route declaration is not provider-account
verification and cannot see off-path usage.

### Beyond Anthropic & OpenAI

The OpenAI route speaks the wire format most of the ecosystem now exposes, so
Fiscus can meter more than two vendors. The simplest way: point
`upstreams.openai` at any compatible base — **OpenRouter** (which itself fronts
Gemini, Claude, Llama, Mistral, DeepSeek, and more), **Ollama** and other local
model servers, **DeepSeek**, **Mistral** — and configured traffic is metered,
assigned a local estimate, and subject to proxy budget controls.

**Pricing follows the local rate card, not the wire format.** The cost engine
records whether a local estimate used an exact, family, or fallback match,
together with the card identity used at calculation time. It does not represent
that estimate as the configured upstream's billed, discounted, credited, taxed,
or reconciled amount.

Do **not** switch providers per request through a routing header. Configure one
trusted OpenAI-compatible upstream in Fiscus instead; use separate Fiscus
processes when you need separate upstreams. The legacy
`X-Aegis-OpenAI-Base` header is ignored on purpose: honoring a request-controlled
destination could forward provider authorization to an untrusted URL.

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

- Read the exact controls and outbound paths in **[docs/DATA-BOUNDARIES.md](docs/DATA-BOUNDARIES.md)**.
- Fiscus operates locally and sends no Fiscus telemetry or analytics by default.
- When you route a request through the proxy, your configured AI provider receives the normal provider request; Fiscus does not store provider API keys.
- Provider API keys pass through to the provider and are **never stored**.
- **Locally stored, not transmitted:** to detect First-Pass Acceptance (whether
  the AI's proposed edit matches what you actually committed), Fiscus
  temporarily stores the AI's proposed code **on your own disk**
  (`~/.aegisflow/aegis.db`) for up to `proposalRetentionDays` (default 30
  days) — long enough to correlate against a later git commit, never
  transmitted anywhere. Set `metadataOnly: true` in your config to disable
  this and store only token/cost metadata (Acceptance tracking turns off).
  `fiscus prune`, or the dashboard Settings page, purges it early on demand.
- All cost computation happens on-device against a local pricing table.
- The dashboard itself makes no third-party browser requests: no web fonts, CDNs,
  or Fiscus analytics. This does not remove the explicit provider and
  operator-configured outbound paths described in the data-boundary disclosure.
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
npm run build        # compile the distributable runtime into dist/
npm test             # node --test (cost, usage, proxy, budget, git)
npm run typecheck    # tsc --noEmit (strict)
```

Runtime dependencies: **none.** The `node_modules` directory holds only the dev
toolchain.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `typecheck` +
`test` on Linux, macOS, and Windows for every push and pull request to `main`.

---

## Status

> **Active local development candidate:** Fiscus is not verified as published
> to npm, externally deployed, or reconciled against provider invoices. Use a
> cloned checkout (`node bin/fiscus.mjs ...`) or a locally packed tarball until
> an authorized registry release and registry clean-install check have completed.
> See [RELEASE-GATE.md](docs/RELEASE-GATE.md) for the current evidence boundary.

Fiscus currently provides configured proxy metering, supported local-log import,
local list-price estimates with per-request rate-card lineage, an immutable
operator-supplied OpenAI provider-cost-evidence import, proxy budget controls,
outcome-evidence views, and review-only within-task cheaper-model trials.
Pricing refresh and all non-provider egress are operator-controlled.

Generic cross-task or cross-project allocation, provider billing reconciliation,
and automatic model routing are deliberately not product actions. The optional
[team server](team-server/README.md) is a separately gated, operator-run service;
it is not approved for an internet-facing production deployment. See
[EVIDENCE-PROVENANCE.md](docs/EVIDENCE-PROVENANCE.md) for what outcome signals do
and do not prove.

MIT licensed.
