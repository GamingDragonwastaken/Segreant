# Research Review — what I verified, corrected, and deferred

The product brief was a strong starting point, but you asked me not to treat it as confirmed knowledge. This document is the audit. Each item says what the research claimed, what's actually true, and what I did about it in the build.

Legend: ✅ verified · 🔧 corrected · ⚠️ unverifiable / illustrative · ⏭️ deferred by choice

---

## 1. Technical claims

### 🔧 "Transparent MITM proxy" with a root CA
The brief calls Fiscus a "transparent MITM proxy gateway" with a dynamically generated root CA, then *also* says developers set `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`. Those are two different architectures. MITM (install a CA, decrypt all TLS) is unnecessary here because the target tools already accept a base URL, and it carries real costs: corporate device policies forbid it, endpoint protection flags it, and it's the exact surveillance posture the brief elsewhere disavows.
**Build**: base-URL reverse proxy is the core. No CA, no TLS interception. MITM is, at most, a future opt-in "advanced mode."

### 🔧 The cost formula and "reasoning multiplier"
The brief's formula has a `T_logic × R_output × M_logic` term and the pricing schema has `reasoning_multiplier`. Neither Anthropic nor OpenAI bills reasoning/thinking tokens at a special multiplier: Anthropic counts them as ordinary **output** tokens; OpenAI counts them inside `completion_tokens`. The multiplier models a charge that doesn't exist.
**Build**: cost = input + output + cache-write + cache-read, each with its own rate. `reasoning_tokens` is stored for reporting only and never changes the price. Verified against live pricing.

### 🔧 Model id `claude-sonnet-4.6`
The brief's pricing YAML uses `claude-sonnet-4.6` (dotted). The real id is `claude-sonnet-4-6` (hyphens). A dotted id would 404 and silently fall to a fallback rate.
**Build**: pricing table uses correct hyphenated ids; unknown ids match by family substring and are flagged `estimated`.

### ✅ Sonnet 4.6 pricing ($3 in / $15 out)
The brief's numbers happen to be right. Verified.

### 🔧 "Sub-1ms P99 overhead" as a requirement (and Rust to achieve it)
True that a Rust async loop can route in microseconds. But this is a vanity metric for this workload: the proxy wraps a provider call that takes hundreds of ms to tens of seconds, so 0.3ms vs 3ms is invisible. The brief itself admits the hot path is dominated by the network round-trip.
**Build**: TypeScript on Node 24 (native TS execution + built-in SQLite). Same single-artifact story, runnable today, zero native deps. Rust is reserved for the day this becomes a shared high-concurrency gateway. (See ARCHITECTURE §5 D2.)

### ✅ OpenAI streaming needs `stream_options.include_usage`
Not stated in the brief, but real and load-bearing: without it, OpenAI streams emit no usage and cost reads $0. The proxy injects the flag and a test proves usage is then captured.

### ✅ SSE usage locations
Anthropic reports input/cache in `message_start` and cumulative output in `message_delta`; OpenAI reports usage in a trailing chunk before `[DONE]`. Verified and implemented in the accumulator.

### ⚠️ "SQLCipher / AES-256 encryption at rest"
Reasonable as a goal, but `node:sqlite` doesn't bundle SQLCipher, and adding it means a native dependency — which breaks the zero-build promise. The brief overstates this as shipped.
**Build**: not implemented in v1. The DB lives in the user's home dir under OS file permissions; honest about that. SQLCipher (or an encrypted volume) is a documented future option, not a current claim.

### ⚠️ Local proposal storage — a real trade-off, not a gap
First-Pass Acceptance (whether an AI's proposed edit survives into a real commit) requires comparing the AI's proposed code against the eventual git diff. That comparison needs the proposed code to still be on disk when the matching commit lands, which can be days later. So `proposals.files_json` stores the AI's literal proposed lines in the local SQLite database — not hashed, not transmitted, but genuinely present in cleartext on disk for a bounded window.
**Build**: `proposalRetentionDays` (default 30 days) bounds it; `fiscus prune` and the dashboard Settings page both purge it early on demand; `metadataOnly: true` disables the capture entirely at the cost of losing the Acceptance signal. This is an honest, disclosed trade-off, not a violation of "no prompt/code storage, ever" — that line describes non-transmission, not zero local persistence — but it went undocumented here until this pass. It's now called out in the README Privacy section and FAQ too.

### ⚠️ "Over 1,000 distinct models" / auto-updating community pricing DB
Aspirational. We ship a curated snapshot of the models that matter, clearly marking Anthropic as verified and OpenAI as community-maintained. Auto-update is listed as future work, not pretended-present.

---

## 2. Market & impact claims

### ⚠️ "Up to 85% cost reduction" / the comparison-matrix deltas (30% churn, 25% flow, etc.)
These are projections, not measured results. The actual reduction depends entirely on how wasteful a given baseline is. Stated as fact, they'd be the kind of overclaim that loses enterprise trust.
**Build**: the landing page frames these as *modeled* and adds an explicit disclaimer that Fiscus provides visibility and controls, not a guaranteed percentage.

### ⚠️ Named-company anecdotes (Uber exhausted its 2026 budget in 4 months; Meta/Microsoft/Shopify leaderboards; $2,100 on a $200 plan)
I could not verify any of these specific figures. The *mechanism* they illustrate is real and defensible — Goodhart's Law on token metrics, agentic loops compounding cost, usage-based billing removing the ceiling. So I kept the mechanism and dropped the unverifiable specifics from public-facing copy. The landing page argues from the dynamics, not from claimed invoices.

### ⚠️ "$71.1B enterprise LLM market by 2034", "API spend doubled late-2024→mid-2025"
Plausible analyst-style figures I can't independently confirm. Left out of the product surfaces; not load-bearing for the value proposition.

---

## 3. Metrics design — the positive measurement standard

This is the heart of the product: a *real* replacement for "tokens per developer" that measures whether AI spend produced good work, without recreating the metric it replaces.

### 🔧 The research's AES formula — right goal, wrong construction
The brief defines AES = (Δdiff × Q × U) / tokens, where **U is a "structural reusability factor graded between 0.1 and 2.0."** Two problems: (a) `U` is hand-graded — subjective and unauditable; and (b) a per-developer score on a leaderboard tied to incentives is itself a target, so it gets gamed exactly like tokens were. My first pass over-corrected and *deferred the whole idea* — which was also wrong, because "don't measure" is not a solution. The whole point is to give teams a trustworthy way to know they're using AI well.

**The resolution — and what's built.** Goodhart's Law doesn't forbid measurement; it forbids turning a fakeable activity-proxy into a high-stakes target. So the metric is rebuilt on three rules the AES formula violated:

1. **Anchor on durable outcomes, not activity or subjective grades.** The core signal is **code survival**: of the lines a commit added, how many are still in the codebase later (via `git blame`). Churn = rewritten/deleted code = low-quality output. Plus objective revert detection. All local, nothing to hand-grade.
2. **A basket with built-in tension.** Cost, survival, and revert move against each other — inflate line count and survival doesn't follow; write fast and sloppy and churn/revert rise. You can't win by gaming one axis.
3. **Coaching, not stack-rank.** Team trends and aggregates, never a per-developer ranking tied to comp.

The replacement standard that results (built in `src/git/quality.ts`, surfaced as `fiscus yield`):

- **AI Yield = surviving lines ÷ AI cost** — durable output per dollar. Where tokenmaxxing rewarded *spending more*, Yield rewards *shipping work that sticks, per dollar*.
- **Effective Spend Ratio** — the honest version of the brief's TER: % of AI spend that landed in code that survived. The brief's TER counted "tokens that preceded committed changes"; survival raises the bar from *committed* to *survived*, which is far harder to fake.
- **Honesty about time.** Survival needs time to elapse, so commits younger than the maturity window are flagged `maturing` and excluded from the headline aggregate. We never claim 10-minute-old code is durable.

Covered by tests (survival drops correctly when lines are rewritten; Yield = surviving ÷ cost). Test/CI pass-rate and incident-linkage are the natural next quality dimensions — they plug into the same basket but need a CI hook, so they're additive, not blocking. This is the single most important part of the product, and it now exists rather than being deferred.

### ✅ "Not a surveillance tool" governance rule + priority order
Genuinely good and kept verbatim as a design principle: security/privacy → latency → budget → UI/overrides, higher tier always wins. It's reflected in the fail-open behavior and the local-only model.

---

## 4. Things the brief got right and I kept

- Local-first, metadata-only privacy stance. ✅
- SQLite as the local store. ✅ (used Node's built-in instead of a separate dependency)
- `X-Aegis-*` custom headers for project/session/task attribution. ✅
- Soft + hard budget thresholds, runaway-loop guard. ✅
- Graceful passthrough on failure. ✅
- The CLI shape (`start`, daily summary, `audit`). ✅ (renamed/expanded)
- The core insight that APM is blind to per-request cost/value. ✅

---

## 5. Net

The brief's **diagnosis** is sound and its **privacy/governance instincts** are right. Its **technical specifics** needed correction (MITM→reverse proxy, cost formula, model ids, language choice), its **metrics** needed one removed for being self-defeating, and its **numbers** needed honest reframing from "facts" to "modeled projections." The product that resulted is smaller in claims and more defensible in every one it makes.
