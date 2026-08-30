# Fiscus — Architecture

This document records what Fiscus is, how it's built, and — just as important — what it deliberately is **not**. It reflects the system as actually implemented, not an aspirational spec.

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
- **Privacy**: Fiscus is local-first for its ledger and UI, stores no provider API keys, and has no Fiscus-hosted
  telemetry by default. A request intentionally routed through the proxy is
  forwarded to the configured provider, which may receive prompt text, source
  snippets, tool payloads, and the provider credential it requires.
- **Footprint**: a single local command to run after the distributable is built.
  The runtime uses Node's bundled SQLite and has no native module or external
  database service dependency. Provider forwarding and optional refresh,
  webhook, judge, cost-observation, and team paths use the declared Fiscus-process
  egress boundary; they are not hidden services.
- **Reliability**: ordinary metering/DB failures degrade to transparent
  passthrough, but the declared egress policy and pre-dial receipt-integrity
  gate are intentionally load-bearing. A present receipt history that cannot be
  validated or extended refuses the outbound request before DNS/socket creation.

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
 │  ┌──────────────────── Fiscus daemon ────────────────┐ │
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

The whole daemon is one Node process. The proxy (`:8090`) and the dashboard (`:8091`) share a single `Store` instance — the proxy writes, the dashboard mostly reads. `fiscus start` creates both and shuts both down together, so the GUI's lifetime is the CLI's; there is no separate service to supervise.

"Mostly reads" is deliberate wording. The dashboard began read-only and is not any more: the GUI reaches parity with the CLI on a small, explicit set of writes, each behind a preview and a same-origin header guard (§2.1).

### 2.1 The web GUI

The GUI is a browser application, not a page the server prints. It exists because
a product whose whole argument is that a figure must carry its basis cannot ship
a surface where the basis is a tooltip.

**Build.** Two `tsc` passes, no bundler, no runtime dependency:
`tsconfig.build.json` emits the Node runtime, and
`src/dashboard/web/app/tsconfig.json` emits the browser app against DOM libs with
no Node types. `rewriteRelativeImportExtensions` turns `.ts` specifiers into
browser-valid `.js`, so the source imports what it means and the browser resolves
what ships. The output is plain unminified ES modules served as static files.
`erasableSyntaxOnly` forbids constructor parameter properties — type syntax may
never emit code.

**Structure.** `web/app/core/` holds the primitives (a hand-written
`signal`/`effect`/`computed` reactive core, an `h()`/`render()` DOM builder, the
API client, the capability registry); `web/app/components/` holds the spine and
the action drawer; `web/app/views/` holds one module per route.

**The spine is the layout, not a header.** Four bands — metered, billed,
allocated, realized — separated by the product's own `≠`, each established or not
on its OWN evidence, each also being the navigation. An unestablished band reads
*not established*, never zero: a zero is a measurement and an absence is not.

**Two entry points.** `/` serves the GUI; `/classic` serves the earlier
single-page console. They link to each other in both directions, pinned by a test
— serving `/classic` without a way back made it a one-way door.

**Security properties**, all enforced by tests rather than convention:

- No HTML-parsing sink anywhere in the app (`innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write` are all absent). Ledger data is
  operator-supplied — project names from folder names, model ids from provider
  responses — so it must never be able to become markup.
- Zero external requests. No CDN, no fonts, no analytics. Pinned for both entry
  points.
- Mutating routes require `x-fiscus-local: 1`, a header a cross-origin page cannot
  set without a preflight this server never answers.
- CSP served with the HTML.

**The GUI/server payload contract.** The browser app declares its own view of
every payload, and the browser tsconfig cannot see the Node source — so the two
declarations are structurally unrelated to the typechecker. A field name invented
in the GUI is not a compile error, and reading an absent field yields `undefined`,
which renders as whatever a screen shows for "absent": usually a legitimate,
honest-looking state. That failure mode shipped three times (a breakdown table of
em-dashes; "no cap set" on a machine with a $30 cap enforcing; a silently
discarded settings patch). The no-node route/envelope descriptor in
`src/dashboard/contracts.ts` is copied byte-for-byte into the browser build
under the publication lock; the server route table and modern client consume its
paths/methods/guards, and its top-level payload contracts fail closed at runtime.
`test/dashboard-contract.test.ts` derives endpoint→interface pairings from the
canonical descriptor, fetches every JSON read envelope against a real server,
and asserts every required field and primitive/container kind actually arrives.
Nested browser-interface metadata is generated with an exact `api.ts` source
hash, while the hand-written declarations and classic inline HTML remain
explicit follow-on migration surfaces. The GUI parity registry additionally
exposes immutable `CapabilitySpec` metadata for consequence, authority,
egress, credentials, reversibility, assurance, and surface bindings.

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
| Realization | `src/value/realization.ts`, `src/value/epistemic.ts` | Assembles each commit's gate funnel; Realization Rate, Realized Value, acceptance; automatically issues exact mature lifecycle Evidence/Claims on persistence |
| Gate ladder | `src/value/gates.ts` | The eight gates + pass/fail/unknown funnel scoring |
| Proposals | `src/value/proposals.ts` | Extract proposed edits from responses; edit-distance acceptance |
| Lift baseline | `src/value/liftBaseline.ts` | Resolve manual-minutes-per-task-type: cited/refreshable population prior + personal pre-tracking git history, combined by continuous-data empirical-Bayes shrinkage |
| Receipts | `src/value/receipt.ts` | ed25519-signed, verifiable Value Receipts |
| System scan | `src/scan/scan.ts`, `src/scan/knownApps.ts` | Proactive, read-only discovery: the 3 importable tools, repos under a root, and a wider best-effort inventory of other AI coding tools detected (never a claim of import capability) |
| Config | `src/config.ts` | Load/save `~/.fiscus/config.json`, resolve paths |
| Dashboard API | `src/dashboard/server.ts` | JSON API over the store, plus six CSRF-guarded mutating routes (`/api/import`, `/api/discover`, `POST /api/scan`, `/api/judge`, `/api/settings/update`, `/api/settings/clear-proposals`) |
| Dashboard contracts/types | `src/dashboard/contracts.ts`, `src/dashboard/shared-types.ts`, `scripts/generate-dashboard-payload-contract.mjs` | One no-runtime source for named payload interfaces plus route/method/envelope metadata; locked generation emits the browser copy and nested runtime contract hash |
| Web GUI | `src/dashboard/web/` | The browser application: four-claim spine, seven routes, preview-then-commit drawer. Built, not inlined — see §2.1 |
| CLI | `src/cli.ts` + `src/cli/` | Thin dispatcher (`src/cli.ts`: help, version, main) over per-command modules — `showCmd`, `valueCmd`, `teamCmd`, `importCmd`, `connectCmd`, `opsCmd`, `runCmd`, with shared `ui`/`flags` helpers |

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
   │  (non-stream: X-Fiscus-Cost-USD header on the response)
```

**Streaming nuance.** Response headers flush before the body, so for streaming responses the final cost can't be a header. We send remaining-budget headers up front and record the final cost server-side (visible in the dashboard and `X-Fiscus-Cost-USD` for non-streaming). This is an honest consequence of HTTP, not a limitation we hide.

**OpenAI usage capture.** OpenAI only emits a usage chunk on a stream when `stream_options.include_usage` is set. The proxy injects that flag into outbound OpenAI requests so usage is always captured. Anthropic always reports usage in `message_start` + `message_delta`.

---

## 4. Data model

SQLite, seven tables (`src/store/db.ts`). Timestamps stored as both ISO string and epoch-ms; range/window queries use epoch-ms to avoid timezone ambiguity.

- **requests** — one row per intercepted call: provider, model, project, `user` (developer/team, from `X-Fiscus-User`), session, the four token dimensions, `cost_usd`, `estimated`, `streamed`, `status_code`, `duration_ms`. The `user` column is added by an idempotent migration (`ALTER TABLE`) for DBs created before it existed.
- **sessions** — interaction windows keyed by `X-Fiscus-Session-Id`.
- **git_commits** — commits discovered during `audit`.
- **commit_attribution** — spend attributed to each commit's preceding window.
- **proposals** — proposed edits captured in the proxy path (the Accepted-gate signal): provider, model, project, and the proposed files/lines as JSON.
- **gate_signals** — ingested outcome verdicts (`tested`/`merged`/`shipped`/`incident`) from `fiscus report`, optionally linked to a commit hash.
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
- **Trade-off**: A hot loop processing tens of thousands of req/s would favor Rust/Go. That is not this workload (one developer's agents). If Fiscus ever became a shared team gateway, the core would be a rewrite candidate. The cost model and schema are language-independent, so that port is bounded.

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
- **`unknown` is first-class, never `fail`** (`src/value/gates.ts`). A gate you haven't wired stays `unknown` and the report shows instrumentation coverage. The model spans the whole lifecycle; the engine fills in what it observes; gaps are explicit and pluggable via `fiscus report` (ingests test/merge/ship/incident signals into `gate_signals`).
- **Maturity holds the line on honesty**: Survived and Clean are `unknown` until the window elapses, so no unit is called realized prematurely.
- **Value Receipts** (`src/value/receipt.ts`): each unit emits an ed25519-signed, canonical record of cost → gate verdicts → outcome. Verification separates two guarantees: **integrity** (body unaltered, signature valid, claimed keyId honestly fingerprints the embedded key) always holds from the receipt alone; **authenticity** (signed by the expected party) requires an out-of-band trust anchor — the verifier pins the publisher's keyId (`receipt --verify <file> --key-id <id>`, publish yours with `receipt --pubkey`). Without a pin, a self-consistent forgery would read as intact, so the CLI flags unpinned checks explicitly. This is what turns a private number into a portable, auditable unit of account.
- **Realization kernel bridge** (`src/value/epistemic.ts`): the canonical persisted realization path automatically and atomically issues one idempotent `value.realization_recorded` Evidence/Claim per mature unit whose eight declared gates are all observed `pass` and whose effective request-lineage attribution is complete and re-derived from the Store ledger. The payload retains commit/window/gate/economic provenance and a digest-bound identity. Its profile is provisional, self-authenticated and non-causal; it does not assert business value, provider billing, settlement or project-specific cost when the source scope is the project-blind window basis. Partial, maturing, stale, synthetic-demo and legacy snapshots remain outside this bridge.
- **Honest scope**: proposal capture covers **both streaming (SSE tool-call reassembly, `src/proxy/stream-proposals.ts`) and non-streaming** responses through identical extraction; Tested/Merged/Shipped depend on ingested signals; Survived/Clean are "to date". None of these are faked — unobserved gates read `unknown`. (Full reasoning in RESEARCH-REVIEW §3.)

### D6 — Fail open for measurement, fail closed for declared egress integrity
DB write failure, parse failure, or another ordinary measurement error falls
through to passthrough. The egress boundary is different: a policy denial,
present-invalid receipt history, unreadable history, or lock/persistence failure
intentionally stops the outbound request before DNS resolution. When an allowed
target is resolved, a DNS denial is raised after that resolution attempt and
before socket creation; no DNS-denied target is dialled.
For controlled-cloud DNS results, IPv4 and IPv6 validation use numeric,
registry-shaped globally-reachable boundaries and fail closed on multicast,
unspecified, loopback, private, link-local, documentation, benchmark, and
reserved ranges. The IPv6 snapshot retains the IANA 2001::/23 parent denial
while allowing only its encoded globally-reachable exceptions:
2001:1::1/128, ::2/128, ::3/128, 2001:3::/32, 2001:4:112::/48,
2001:20::/28, and 2001:30::/28. Teredo, 2001:2::/48, unallocated
remainder, documentation, 2002::/16, and 3fff::/20 remain denied. The IPv4
snapshot denies documentation 198.51.100.0/24 and 203.0.113.0/24,
192.88.99.0/24, and 192.0.0.0/24 except globally-reachable 192.0.0.9/.10;
ordinary 192.0.1.0/24 and IANA-globally-reachable AS112/AMT ranges
192.31.196.0/24, 192.52.193.0/24, and 192.175.48.0/24 remain eligible. The
selected eligible address is pinned into the one socket request; the OS resolver
is not asked to choose a different address afterward.
Only a genuinely absent receipt path may establish a genesis predecessor, and a
present invalid path is never silently reset. Loaded JSON egress configuration
also accepts only the two declared modes and exact rule field types; ambiguous
mode/enabled values return to local-locked behavior rather than authorizing a
cloud rule. Loaded rules use the same exact semantic validator as CLI-authored
rules: canonical HTTPS origin, non-empty safe path prefix, valid identifiers,
and no unexpected fields. A bounded stale-lock refusal is
operator-repairable only after confirming no Fiscus writer is active; the lock
is never auto-deleted. A budget *block* is another
intentional request stop. Receipt persistence is synchronous, but it is not an
`fsync` or power-loss durability guarantee; the boundary is process-scoped and
does not defeat a machine administrator who can replace local files.

---

## 6. Scale & reliability

This is single-user, single-process, local. "Scale" means a busy developer's agents, not a fleet.

- **Throughput**: bounded by upstream latency; concurrency is Node's event loop. SQLite writes are tiny and happen after the response is sent to the client.
- **Storage growth**: `prune` removes rows past `retentionDays` and `VACUUM`s. A heavy multi-agent month is megabytes, not gigabytes.
- **Failure modes**: corrupt/invalid config → startup refusal; a budget read or
  request-record failure → provider forwarding refusal until repair/restart;
  invalid/unreadable/unlockable egress receipt history → refusal; publication
  lock or child-runtime failures → nonzero launcher failure, never a silent
  success or lock bypass
  before dial with an actionable local error; upstream error → forwarded
  verbatim to the client.
- **Observability**: the daemon prints a per-request line; the dashboard polls every 4s; `today --json` is scriptable.

---

## 7. What I'd revisit as it grows

Six items that used to live here are done and moved to the README's Status
section: native provider pricing beyond the OpenAI wire format (Gemini is now a
first-class, verified rate-card entry), auto-updating pricing (`pricing --refresh` /
`--auto` against a community feed), passive log import (`fiscus import` —
Claude Code, opencode, Codex CLI — which grew into `scan`/`discover`, the zero-wiring
onboarding path), a machine-wide tool inventory scan (`scan` now also surfaces a
read-only, best-effort inventory of other AI coding tools it recognizes but doesn't
import from yet — config-dir/PATH-binary checks only, see `src/scan/knownApps.ts` —
holding the same consent/framing bar as the rest of `scan`: read-only, discloses
exactly what it found, never reads as system surveillance), a cited,
personally-calibrated Lift baseline (the manual-minutes-per-task-type input is now a
METR-anchored population prior blended with the user's own pre-tracking git history
via empirical-Bayes shrinkage, replacing the old flat unsourced table — see
`docs/RETURN-ON-INTELLIGENCE.md` §7.1), and correct native `/responses` metering (the
OpenAI-compatible route already forwarded `/responses` traffic, but two latent bugs
meant it was mismetered at best: the proxy force-injected a Chat-Completions-only
`stream_options` param that the Responses API rejects outright, 400ing every
*streaming* `/responses` request, and the usage parser only understood the
`prompt_tokens` shape, not `/responses`' `input_tokens` shape, on the requests that
did succeed — see `src/proxy/usage.ts` and `src/proxy/server.ts`). What's still
genuinely open:

1. **A hosted, cross-machine team tier** — the optional, metadata-only sync to a shared
   dashboard; SSO; support/SLA. Numeric-only, opt-in, signed. Scoped in
   [docs/TEAM-TIER-DESIGN.md](TEAM-TIER-DESIGN.md) as a bring-your-own
   server/hosting/SSO deployment model, keeping Fiscus as software an operator
   deploys rather than a service we run — that framing hasn't changed. **The
   client half is now built:** `src/team/rollup.ts` (`buildRollupBody`/
   `signRollup`/`verifyRollup`, reusing `value/receipt.ts`'s `canonical`/
   `keyIdForPem` directly — canonicalization must be byte-identical between
   signer and verifier, so that's a correctness requirement, not just reuse for
   its own sake) and the `fiscus team push` CLI command (`--url`, `--dry-run`,
   `--pubkey`, `--window`, `--project`) — 5 adversarial tests in
   `test/team-rollup.test.ts` (tamper detection, key-pinning against a
   self-consistent forgery, a forged keyId claim, a garbled public key). A
   developer can sign and push a numeric-only per-project rollup today. **The
   server scaffold is now built too:** `team-server/` — a genuinely separate
   npm package (its own `package.json`, `pg` as its sole dependency, never
   pulled into the main CLI's install), a Postgres schema
   (`team-server/schema.sql`: `developers`, `rollups`, `rollup_projects`,
   applied idempotently on boot), and an HTTP server (`team-server/src/
   server.ts`) exposing `POST /developers` (admin-bearer-token-gated
   registration — fails closed without a token configured, not open) and
   `POST /rollups` (verifies the pushed rollup's signature pinned to the
   *registered* key, never the key embedded in the payload, before storing —
   the concrete defense against a self-consistent forgery from an unregistered
   key). **Honestly unverified:** the real SQL (`team-server/src/store.ts`'s
   `PgRollupStore`, `schema.sql`) was code-reviewed but not run against a live
   Postgres this session (Docker wasn't running locally when this was built) —
   see `team-server/README.md` for how to verify it. Compensating evidence: a
   genuine end-to-end run of the real `fiscus team push` CLI against the
   real `team-server` HTTP layer (fake store in place of Postgres) proved the
   client↔server wire format matches, for both the accept and the
   unregistered-key-reject paths.
   **OIDC/JWT verification is now built too:** `team-server/src/oidc.ts`'s
   `verifyIdToken`, `node:crypto` only (no `jsonwebtoken`/`jose` dependency),
   gating a real route (`GET /me`) rather than left untested in isolation.
   Algorithm whitelisted to RS256/ES256 — rejects `alg: "none"` (a real
   historical JWT vulnerability) and HS256 (would allow an algorithm-confusion
   attack using the issuer's own public RSA key as a forged HMAC secret); ES256
   verified with `dsaEncoding: 'ieee-p1363'` since JWT's raw-`r‖s` ECDSA
   encoding differs from `node:crypto`'s DER default. Proven against **genuine**
   RS256/ES256 signatures via an in-process fake IdP that signs real tokens
   with real keypairs (`team-server/test/fakeIdp.ts`) — 12 tests in `oidc.test.ts`
   plus 3 HTTP-level tests for `/me`.
   **The aggregate dashboard API is now built too:** `GET /dashboard/projects`
   (team-wide totals per project) and `GET /dashboard/developers` (an opt-in,
   k-anonymized per-developer distribution), both OIDC-gated. The interesting
   part wasn't the SQL, it was getting two things right that a naive
   implementation would get wrong: (1) `ProjectValue.realizationRate` is a
   *unit-count* ratio, not a dollar ratio — the aggregate query weights it as
   `SUM(realizationRate_i × units_i) / SUM(units_i)`, algebraically exact
   because `realizationRate_i × units_i = realizedUnits_i` by definition, so
   the team view means the same thing the single-machine dashboard already
   means by "realization rate," not a silently different number under the
   same name; and (2) a project with too few contributing developers is
   suppressed row-by-row (`TEAM_SERVER_MIN_COHORT`, default 5) — otherwise a
   lone contributor's project total just *is* their personal total under
   another name, re-deriving the same re-identification risk the existing
   single-machine `src/value/cohort.ts` feature already guards against, one
   level down. `GET /dashboard/developers` gets `cohort.ts`'s full two-factor
   treatment (opt-in *and* k-anonymized, distribution only, never a named
   list) via `team-server/src/aggregate.ts` — kept as pure, HTTP/DB-free
   functions so the privacy logic is unit-testable on its own (9 tests) apart
   from the HTTP-level tests that push hand-computed rollups through the real
   server and assert exact numbers chosen so a naive unweighted average would
   visibly disagree. Total `team-server/` suite: 46 tests. **Still not
   built:** a rendered dashboard UI that calls these APIs, and any link
   between an OIDC identity and a specific developer's `keyId` (so there is
   still no "these are MY numbers" self-view — only the team-wide aggregate
   and the anonymized distribution). Still true that nothing in
   `src/team/rollup.ts`, the CLI command, or `team-server/` touches
   `src/proxy/server.ts` or any per-request path.
2. **Native Bedrock and Vertex wire formats** — the two remaining non-OpenAI-compatible
   envelopes. Unlike `/responses` above (same OpenAI base URL, bearer-key auth, JSON
   over HTTPS — only the JSON shape and streaming event semantics differed), Bedrock
   puts the model id in the URL path rather than the body and Vertex rejects static
   API keys outright (OAuth2 access token required) — both verified against AWS's
   and Google's own references, not assumed. Both remain reverse-proxy-compatible in
   principle (Bedrock via its newer bearer-token "API key" mode, not classic SigV4
   signing which a transparent proxy can't support; Vertex via a client-supplied
   OAuth2 access token, still a forwardable bearer token even though it isn't a
   static key) — so this doesn't require Fiscus to hold real cloud credentials.
   Not yet scoped as a build: Bedrock's cache-token inclusive/exclusive usage
   semantics specifically still need the same independent cross-check the
   `/responses` fix used before any cost math on them would be trustworthy.
3. **A true transcript-judge or controlled A/B time study** for Lift — narrower now
   than it used to be. The AI-assisted side of the TSF ratio used to be pure
   wall-clock duration, unable to tell a focused three-turn session from a
   forty-turn one that flailed to the same result. The content-free half of that
   gap is now closed: `src/value/liftEfficiency.ts` pools each covered work unit's
   Acceptance rate (already computed for the Acceptance lens, edit-distance,
   never content) and shrinks it toward the ledger's own first-pass rate via the
   same empirical-Bayes machinery as §8, feeding a small, bounded discount into
   `boundedLift` alongside selection/substitution/concurrency — see
   `docs/RETURN-ON-INTELLIGENCE.md` §7.2. The LLM-judge ladder above it is now
   mostly built too: `src/judge/tier.ts` (`resolveJudgeTier`, the trust-ladder
   gate), `src/judge/payload.ts` (a content-free structural summary — turn
   counts, timing gaps, request-size trend, the exact signals the algorithmic
   piece didn't wire in), and `src/judge/call.ts` +
   `src/judge/orchestrate.ts`'s `judgeSession` (the actual OpenAI-compatible
   call, strictly parsed, gated first, gracefully degraded on any failure) —
   61 tests across seven files (incl. the `fiscus judge` CLI wiring and the
   transcript reader), none of them mocked-away: real local HTTP
   servers stand in for the judge endpoint the same way `test/proxy.test.ts`
   already stands in for upstream providers. The full-content tiers are real
   too — resolved WITHOUT a transcript-capture feature: `src/judge/transcript.ts`
   reads each tool's own on-disk session log ephemerally at judge time
   (Claude Code's `<sessionId>.jsonl`, opencode's session database, Codex's
   rollout JSONL — bounded excerpt, clipping disclosed, nothing persisted;
   the store still never stores prompt/response text), and `fiscus judge`
   judges real sessions looked up from the store (`--session <id>` to pick).
   See [docs/LIFT-AI-SIDE-JUDGE-DESIGN.md](LIFT-AI-SIDE-JUDGE-DESIGN.md) §2's
   boxed note. Genuinely still open: a real controlled A/B and automatic
   invocation from `fiscus lift`.
4. **Rust core** — only if Fiscus becomes a shared gateway under real concurrency.
   Until then it's premature.

---

## 8. Honest scope boundaries

- Sees only traffic routed through it (D1).
- Cost accuracy depends on the pricing table; unknown models are flagged `estimated` and use a conservative fallback rather than failing.
- Budget blocking is pre-flight on cumulative state; a single in-flight request can still complete above a cap (you can't un-send a request mid-stream).
- "Cost reduction %" is a function of baseline waste, not a guarantee the tool makes. Fiscus provides visibility and controls; the savings are the user's to realize.
