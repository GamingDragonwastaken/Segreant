# AegisFlow — Architecture

This document records what AegisFlow is, how it's built, and — just as important — what it deliberately is **not**. It reflects the system as actually implemented, not an aspirational spec.

---

## 1. Requirements

### Functional
- Sit in the path of outbound LLM API calls from coding agents and meter each one.
- Compute exact cost per request from provider-reported token usage (input, output, cache-read, cache-write).
- Support Anthropic and OpenAI request/response shapes, streaming (SSE) and non-streaming.
- Persist every request locally so history survives even if the agent deletes its own logs.
- Enforce budgets: soft warnings, hard daily/session caps, and a runaway-loop velocity guard.
- Correlate spend with git history (cost per commit / per diff).
- Surface all of this in a terminal and a local web console.

### Non-functional
- **Latency**: negligible relative to the upstream call it wraps. The proxy adds one in-process hop; the dominant cost is the provider round-trip (hundreds of ms to tens of seconds). Sub-millisecond bookkeeping is a non-goal dressed up as a requirement — see §5.
- **Privacy**: no prompt text, source code, or credentials ever leave the device. Provider API keys pass through to the provider untouched and are never stored.
- **Footprint**: a single command to run. No build step, no native modules, no external services.
- **Reliability**: a failure in tracking must never break a developer's session. Tracking degrades to transparent passthrough.

### Constraints
- One developer, zero-dollar infra budget, must run today on Windows/macOS/Linux.
- Prefer the standard library over dependencies.

---

## 2. High-level design

```
                 LOCAL DEVELOPER MACHINE
 ┌───────────────────────────────────────────────────────────┐
 │  IDE / Agent CLI  (Claude Code, Cursor, OpenAI SDK, aider) │
 │        │  ANTHROPIC_BASE_URL / OPENAI_BASE_URL → :8090     │
 │        ▼                                                   │
 │  ┌──────────────────── AegisFlow daemon ────────────────┐ │
 │  │                                                       │ │
 │  │  Proxy core (src/proxy/server.ts)                     │ │
 │  │   • detect provider   • budget pre-flight             │ │
 │  │   • forward upstream  • tee SSE → usage accumulator   │ │
 │  │   • inject cost headers                               │ │
 │  │        │                    │                         │ │
 │  │        │ usage              │ rate lookup             │ │
 │  │        ▼                    ▼                         │ │
 │  │  Cost engine        Pricing table (pricing/models.json)│ │
 │  │  (src/cost)                                           │ │
 │  │        │                                              │ │
 │  │        ▼                                              │ │
 │  │  Store (node:sqlite)  ◀── Budget guard (src/budget)   │ │
 │  │  (src/store/db.ts)    ◀── Git correlation (src/git)   │ │
 │  │        ▲                                              │ │
 │  │        │ read-only                                    │ │
 │  │  Dashboard server (src/dashboard) ── serves UI + API  │ │
 │  └───────────────────────────────────────────────────────┘ │
 │        │  upstream HTTPS (unchanged, keys pass through)   │ │
 └────────┼──────────────────────────────────────────────────┘
          ▼
   api.anthropic.com / api.openai.com
```

The whole daemon is one Node process. The proxy (`:8090`) and the dashboard (`:8091`) share a single `Store` instance — the proxy writes, the dashboard reads.

### Component responsibilities

| Component | File | Responsibility |
|---|---|---|
| Proxy core | `src/proxy/server.ts` | HTTP server, provider detection, forwarding, streaming tee, header injection, passthrough fallback |
| Usage parser | `src/proxy/usage.ts` | Normalize Anthropic/OpenAI usage; accumulate usage from SSE |
| Cost engine | `src/cost/pricing.ts` | Resolve model rate, compute USD from normalized usage |
| Store | `src/store/db.ts` | SQLite schema + queries (requests, sessions, commits, attribution) |
| Budget guard | `src/budget/guard.ts` | Evaluate caps and runaway velocity, return allow/warn/block |
| Alerts | `src/alerts/detect.ts` | Detect governance conditions (budget, spike, runaway, throttling, value crater, est. pricing); pure detector + store-backed wrapper |
| Export | `src/export/csv.ts` | Serialize the request ledger to CSV (RFC-4180 quoting) / JSON for BI; CLI `export` + dashboard `/api/export.csv` |
| Git correlation | `src/git/correlate.ts` | Read commits via `git`, attribute spend in the window before each |
| Quality / Yield | `src/git/quality.ts` | Survival lens: code survival (blame at HEAD), revert detection, AI Yield, churn |
| Realization | `src/value/realization.ts` | Assembles each commit's gate funnel; Realization Rate, Realized Value, acceptance |
| Gate ladder | `src/value/gates.ts` | The eight gates + pass/fail/unknown funnel scoring |
| Proposals | `src/value/proposals.ts` | Extract proposed edits from responses; edit-distance acceptance |
| Lift baseline | `src/value/liftBaseline.ts` | Resolve manual-minutes-per-task-type: cited/refreshable population prior + personal pre-tracking git history, combined by continuous-data empirical-Bayes shrinkage |
| Receipts | `src/value/receipt.ts` | ed25519-signed, verifiable Value Receipts |
| System scan | `src/scan/scan.ts`, `src/scan/knownApps.ts` | Proactive, read-only discovery: the 3 importable tools, repos under a root, and a wider best-effort inventory of other AI coding tools detected (never a claim of import capability) |
| Config | `src/config.ts` | Load/save `~/.aegisflow/config.json`, resolve paths |
| Dashboard | `src/dashboard/` | Read-only JSON API + single-page console |
| CLI | `src/cli.ts` | `start`, `today/week/month`, `realize`, `report`, `receipt`, `yield`, `budget`, `audit`, … |

---

## 3. Data flow — one request

```
IDE/Agent          Proxy              Store           Upstream
   │  POST /v1/messages  │                │               │
   │────────────────────▶│                │               │
   │                     │ budget.evaluate()              │
   │                     │───────────────▶│ (read today/session/window spend)
   │                     │◀───────────────│               │
   │           block? → 429 + provider-shaped error, log at $0
   │                     │                │               │
   │                     │  forward (Accept-Encoding: identity)
   │                     │───────────────────────────────▶│
   │                     │◀── SSE chunks / JSON ──────────│
   │◀── stream tee ──────│  (push each chunk to usage accumulator)
   │                     │                │               │
   │                     │ computeCost(usage)             │
   │                     │ insertRequest()│               │
   │                     │───────────────▶│               │
   │  (non-stream: X-Aegis-Cost-USD header on the response)
```

**Streaming nuance.** Response headers flush before the body, so for streaming responses the final cost can't be a header. We send remaining-budget headers up front and record the final cost server-side (visible in the dashboard and `X-Aegis-Cost-USD` for non-streaming). This is an honest consequence of HTTP, not a limitation we hide.

**OpenAI usage capture.** OpenAI only emits a usage chunk on a stream when `stream_options.include_usage` is set. The proxy injects that flag into outbound OpenAI requests so usage is always captured. Anthropic always reports usage in `message_start` + `message_delta`.

---

## 4. Data model

SQLite, seven tables (`src/store/db.ts`). Timestamps stored as both ISO string and epoch-ms; range/window queries use epoch-ms to avoid timezone ambiguity.

- **requests** — one row per intercepted call: provider, model, project, `user` (developer/team, from `X-Aegis-User`), session, the four token dimensions, `cost_usd`, `estimated`, `streamed`, `status_code`, `duration_ms`. The `user` column is added by an idempotent migration (`ALTER TABLE`) for DBs created before it existed.
- **sessions** — interaction windows keyed by `X-Aegis-Session-Id`.
- **git_commits** — commits discovered during `audit`.
- **commit_attribution** — spend attributed to each commit's preceding window.
- **proposals** — proposed edits captured in the proxy path (the Accepted-gate signal): provider, model, project, and the proposed files/lines as JSON.
- **gate_signals** — ingested outcome verdicts (`tested`/`merged`/`shipped`/`incident`) from `aegisflow report`, optionally linked to a commit hash.
- **receipts** — emitted Value Receipts, one per certified unit.

The schema diverges from the source research in three deliberate ways, all in `docs/RESEARCH-REVIEW.md`: cache-write/cache-read columns added (they drive real cost), the fictional `reasoning_tokens` *multiplier* removed (reasoning tokens are billed as output), and the `efficiency_metrics` table (TER/AES) deferred rather than shipped.

---

## 5. Key decisions & trade-offs

### D1 — Reverse proxy (base-URL override), not MITM
The research describes a "transparent MITM proxy" with a root CA *and* base-URL override. These are different products. We chose base-URL override.

- **Why**: The target tools already support `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`. A root CA that decrypts all TLS is a security-team non-starter, gets flagged by endpoint protection, and is precisely the "surveillance" posture the product disavows.
- **Trade-off**: We only see traffic the developer explicitly routes to us. A tool that hardcodes its endpoint is invisible until configured. Accepted — opt-in is the honest default. A MITM "advanced mode" could be added later, clearly flagged.

### D2 — TypeScript on Node 24, not Rust
- **Why**: The proxy's overhead is irrelevant next to the provider round-trip. Node 24 runs TypeScript directly (type-stripping) and ships SQLite built-in, giving the same "single zero-config artifact" story Rust was invoked for — runnable today, matching the rest of the stack, zero native compilation.
- **Trade-off**: A hot loop processing tens of thousands of req/s would favor Rust/Go. That is not this workload (one developer's agents). If AegisFlow ever became a shared team gateway, the core would be a rewrite candidate. The cost model and schema are language-independent, so that port is bounded.

### D3 — Real cost model, not the research's formula
Cost = `input·R_in + output·R_out + cacheWrite·R_cw + cacheRead·R_cr`. The research's separate "reasoning multiplier" models a price that neither provider charges. Verified against live pricing; Anthropic values are authoritative, OpenAI values flagged community-maintained in the table.

### D4 — Budget enforcement is cumulative + velocity, not per-request prediction
You can't know a request's cost before it runs (output is unknown). So the guard blocks on *already-crossed* daily/session caps and on spend velocity inside a sliding window (the runaway-loop signature). This is what's actually enforceable, framed honestly.

### D5 — The Realization Standard: production measured as verified outcome, with the dollar as one lens
The product's positive thesis is a real *unit of account* for AI-assisted work — defined in full in **[THE-STANDARD.md](THE-STANDARD.md)**. It supersedes two earlier attempts that were both rebuilt, not shipped: the research's subjective "AI Efficiency Score", and our own first pass (**AI Yield = surviving lines ÷ cost**, which was lines-of-code with a price tag — it rewards verbosity, ignores correctness, and stapled two existing tools together).

The Standard instead scores each commit through a **funnel of eight objective gates** (`src/value/`): Proposed → Accepted → Committed → Tested → Merged → Shipped → Survived → Clean. Three headline numbers fall out:

- **Realization Rate** — production, *dollar-free*: share of matured units that reached verified durable value. Money is **not** the measure of production; it is a separate lens.
- **Realized Value Rate** — the money lens: share of *spend* that reached realized (the AI P&L), plus a waste-by-stage breakdown of where un-realized spend died.
- **First-Pass Acceptance** — the signal only an in-path proxy can produce: edit-distance between the AI's *proposed* diff (parsed from the response body, `src/value/proposals.ts`) and what was actually committed. Measures the human-AI collaboration loop directly, in-session.

Design properties that make it a standard rather than a dashboard:
- **`unknown` is first-class, never `fail`** (`src/value/gates.ts`). A gate you haven't wired stays `unknown` and the report shows instrumentation coverage. The model spans the whole lifecycle; the engine fills in what it observes; gaps are explicit and pluggable via `aegisflow report` (ingests test/merge/ship/incident signals into `gate_signals`).
- **Maturity holds the line on honesty**: Survived and Clean are `unknown` until the window elapses, so no unit is called realized prematurely.
- **Value Receipts** (`src/value/receipt.ts`): each unit emits an ed25519-signed, canonical record of cost → gate verdicts → outcome. Verification separates two guarantees: **integrity** (body unaltered, signature valid, claimed keyId honestly fingerprints the embedded key) always holds from the receipt alone; **authenticity** (signed by the expected party) requires an out-of-band trust anchor — the verifier pins the publisher's keyId (`receipt --verify <file> --key-id <id>`, publish yours with `receipt --pubkey`). Without a pin, a self-consistent forgery would read as intact, so the CLI flags unpinned checks explicitly. This is what turns a private number into a portable, auditable unit of account.
- **Honest scope**: proposal capture covers **both streaming (SSE tool-call reassembly, `src/proxy/stream-proposals.ts`) and non-streaming** responses through identical extraction; Tested/Merged/Shipped depend on ingested signals; Survived/Clean are "to date". None of these are faked — unobserved gates read `unknown`. (Full reasoning in RESEARCH-REVIEW §3.)

### D6 — Fail open
DB write failure, parse failure, or any internal error falls through to passthrough. A budget *block* is the only thing that intentionally stops a request. Tracking is never load-bearing for the developer's work.

---

## 6. Scale & reliability

This is single-user, single-process, local. "Scale" means a busy developer's agents, not a fleet.

- **Throughput**: bounded by upstream latency; concurrency is Node's event loop. SQLite writes are tiny and happen after the response is sent to the client.
- **Storage growth**: `prune` removes rows past `retentionDays` and `VACUUM`s. A heavy multi-agent month is megabytes, not gigabytes.
- **Failure modes**: corrupt config → defaults; DB locked/unwritable → passthrough; upstream error → forwarded verbatim to the client.
- **Observability**: the daemon prints a per-request line; the dashboard polls every 4s; `today --json` is scriptable.

---

## 7. What I'd revisit as it grows

Five items that used to live here are done and moved to the README's Status
section: native provider pricing beyond the OpenAI wire format (Gemini is now a
first-class, verified rate-card entry), auto-updating pricing (`pricing --refresh` /
`--auto` against a community feed), passive log import (`aegisflow import` —
Claude Code, opencode, Codex CLI — which grew into `scan`/`discover`, the zero-wiring
onboarding path), a machine-wide tool inventory scan (`scan` now also surfaces a
read-only, best-effort inventory of other AI coding tools it recognizes but doesn't
import from yet — config-dir/PATH-binary checks only, see `src/scan/knownApps.ts` —
holding the same consent/framing bar as the rest of `scan`: read-only, discloses
exactly what it found, never reads as system surveillance), and a cited,
personally-calibrated Lift baseline (the manual-minutes-per-task-type input is now a
METR-anchored population prior blended with the user's own pre-tracking git history
via empirical-Bayes shrinkage, replacing the old flat unsourced table — see
`docs/RETURN-ON-INTELLIGENCE.md` §7.1). What's still genuinely open:

1. **A hosted, cross-machine team tier** — the optional, metadata-only sync to a shared
   dashboard; SSO; support/SLA. Numeric-only, opt-in, signed if built. This is real
   future value, but it requires an operator: ongoing hosting, and a support
   commitment that sits outside this release's local-only, zero-maintenance,
   donationware shape. Not scoped for this release. Revisit only if real usage and
   requests justify taking on that operational commitment — the local store and
   schema are designed so it *could* be added later without touching the hot path,
   but "could" isn't "should" until there's a real signal to build it for.
2. **Native non-OpenAI-wire-format APIs** — Bedrock, Vertex, and OpenAI's `/responses`
   shape. Everything reachable over an OpenAI-compatible wire format is already
   covered; these three have genuinely different request/response envelopes.
3. **A true transcript-judge or controlled A/B time study** for Lift — a different,
   larger thing than the baseline-sourcing upgrade above. That upgrade made the
   manual-*comparator* honest (cited + personally calibrated instead of a flat
   guess); it did not change how the AI-assisted side is measured. This item would
   judge the actual AI-assisted session directly (an LLM reading transcripts, or a
   real controlled A/B), which could tighten the TSF interval further. Deliberately
   not default-on even if built: a transcript-judge approach means sending session
   content to an LLM API, which is a real, loud opt-in decision against the "nothing
   leaves your machine" promise — not just an API-cost question. See the README's
   Lift section and `docs/RETURN-ON-INTELLIGENCE.md` §7/§7.1 for what's already
   measured without it.
4. **Rust core** — only if AegisFlow becomes a shared gateway under real concurrency.
   Until then it's premature.

---

## 8. Honest scope boundaries

- Sees only traffic routed through it (D1).
- Cost accuracy depends on the pricing table; unknown models are flagged `estimated` and use a conservative fallback rather than failing.
- Budget blocking is pre-flight on cumulative state; a single in-flight request can still complete above a cap (you can't un-send a request mid-stream).
- "Cost reduction %" is a function of baseline waste, not a guarantee the tool makes. AegisFlow provides visibility and controls; the savings are the user's to realize.
