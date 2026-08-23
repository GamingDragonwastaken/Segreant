# Fiscus FAQ

## Privacy & security

**Does my code or prompts ever leave my machine?**
Fiscus does not send your prompts or code to a Fiscus-operated telemetry service
by default. Metering, storage, and RoI calculations run locally, but a request
you deliberately route through the proxy is forwarded to the AI provider you
configure and can include its prompt, source snippets, tool payloads, and
provider credential. Other explicit paths include pricing/baseline refresh,
alert webhooks, a configured hosted judge, an OpenAI Costs pull, and an opt-in
team rollup. [DATA-BOUNDARIES.md](DATA-BOUNDARIES.md) is the complete,
current outbound and retention contract.

**Can I make Fiscus itself refuse all cloud traffic?**
Yes. New configuration begins in `local_locked` mode, where Fiscus refuses
non-loopback HTTP(S) targets before DNS. A local model at `localhost` or
`127.0.0.1` remains available. To permit a cloud route, use `fiscus egress
plan` to inspect one exact rule and `fiscus egress apply --apply` to persist it;
`fiscus egress verify` validates the redacted local receipt chain. This is a
Fiscus-process boundary, not a claim about other applications, direct clients,
the operating system, or provider retention.

**Is my proposed code stored anywhere, even locally?**
Yes, temporarily. To measure whether an AI's proposed edit was actually
accepted (the "First-Pass Acceptance" signal), Fiscus stores the proposed
code text in your local database for up to 30 days by default
(`proposalRetentionDays` in config) — long enough to match it against a
later git commit. Proposal rows remain local to the Fiscus store unless an
operator explicitly exports or forwards the surrounding data. Set
`metadataOnly: true`
to turn this off entirely (you lose Acceptance tracking, keep everything
else), or run `fiscus prune` / use the dashboard Settings page to purge it
early. Provider requests and other declared egress paths follow
[DATA-BOUNDARIES.md](DATA-BOUNDARIES.md).

**Do you see my API keys?**
No. Keys stay in your environment / your tool's config. The proxy forwards the auth
header upstream unchanged and never stores it. Fiscus's author never sees it.

**Do you rank or score individual developers?**
No — and the code refuses to. Per-user *value* (how much of someone's AI spend
reaches a real outcome) is **off by default**; spend-by-user is cost governance and
stays available, but attributing value to named people is opt-in. Even switched on,
the org view is a **distribution only** (median, spread, a coaching-headroom number)
— never a ranked list — and it is **withheld entirely** below a k-anonymity floor
(default 5 people), so a small team can't use it to single anyone out. Names appear
only in a person's own view of themselves (`fiscus team --me <you>`). Thin samples
are shrunk toward the team mean, so nobody is judged on two noisy sessions. The
headline number is *coaching headroom* — the latent value if below-median extractors
were supported up to the median — an argument for enablement, not for blame.

**Is there a root certificate or traffic interception?**
No. Fiscus is a base-URL reverse proxy — you explicitly point tools at it. That's
a deliberate choice: enterprise security teams (rightly) ban dev-machine root CAs, so
"connect, don't intercept" is the only enterprise-viable model.

## Coverage

**What can it meter?**
Anything you can point at a base URL: opencode, aider, Cursor, Cline, Continue, Zed,
Claude Code, any OpenAI- or Anthropic-compatible SDK, scripts, and curl. For opencode
it can natively wrap a provider you already use.

**What can't it meter, and why?**
Closed/hosted endpoints that route to their own servers — e.g. **opencode Zen**, or
consumer apps like ChatGPT/Claude desktop with no base-URL override. A cooperative
proxy fundamentally can't see traffic that doesn't pass through it, and we won't
install a root CA to force it. Those are honestly labeled as unmeterable here.

**Do I have to change a base URL to meter my coding tool?**
No — that's what **importers** are for. Subscription-mode tools (Claude Code on
Pro/Max, Codex, opencode) talk straight to vendor servers and never touch a
proxy, but they each write their exact usage to local disk. `fiscus import
claude-code | opencode | codex | all` reads that native record — no base URL, no
key, no config. It's idempotent (safe to re-run or cron), and `--watch` keeps it
live, polling read-only so the tool keeps writing uninterrupted. In the dashboard,
the **Import local usage** panel does the same with one click and an "auto every
30s" toggle — no terminal needed. Imported usage flows into every surface
(`today`, `sources`, `roi`, the dashboard) exactly like proxied traffic. On a flat
subscription the dollar figure is *consumption valued at list rates* — what the
traffic would bill via API, not your invoice — and it's labeled as such. Don't
both proxy AND import the same tool for the same period, or it double-counts.

**So which path do I use?**
Two, by tool type. **Proxy** (base URL + your key) meters *and enforces* caps —
best for API-key tools, scripts, and enterprises with gateways. **Import** meters
natively with zero wiring — best for subscription tools a proxy can't see. Most
people import their editor and, if they also run raw API scripts, proxy those.

**What does `fiscus scan` mean when it lists a tool as "detected" but not imported?**
Scan also runs a wider, read-only inventory pass — checking for config directories
or PATH binaries of AI coding tools beyond the three native importers (today:
Cursor, Windsurf, Aider, Continue, Zed). Seeing one listed is honestly just an
existence check — `~/.cursor` exists, or `aider` is on PATH — never a promise that
its usage is being read. Spend from a detected-but-not-imported tool isn't counted
anywhere until you wire it via the proxy path (if it supports a base URL) or a
native importer ships for it.

**Does the proxy slow my requests down?**
Negligibly. The proxy overhead is microseconds against a provider round-trip of
hundreds of milliseconds to seconds. If Fiscus is off, traffic you pointed at it
simply fails over/through — tracking never breaks your session.

## The measurement

**Why don't you count lines of code or tokens?**
Because both reward volume, and AI inflates volume for free. More lines/tokens is not
more value — better code is often shorter. We score only observable *outcomes*
(kept, shipped, survived, mattered), never size.

**Why don't you trust "developers feel faster"?**
A controlled study found experienced developers were 19% *slower* with AI while
believing they were 24% faster. Self-report is off by ~40 points, so we use behavior,
never surveys.

**Why does my RoI Index show missing coverage and a range?**
Because some of the four value lenses may not be wired yet. The observed-only
geometric mean is an observational score, not a universal ceiling: measuring a
missing lens can raise or lower it. Fiscus therefore keeps that observed score
separate from the full-instrumentation sensitivity range obtained by evaluating
unknown necessary lenses at their admissible endpoints. Add evidence to reduce
what must be assumed and inspect the disclosed direction/size of the change; the
calculation does not promise a monotone movement.

**Why did a small experiment's great score get "pulled down"?**
Reliability shrinkage. Two-of-two successes isn't the same evidence as 140-of-200, so
thin results are shrunk toward the population average until there's enough data. It
stops the tool from chasing luck.

**How do you value AI use without code signals (chat, research, drafting)?**
The same funnel, with the outcome reported instead of read from git. But it's
*graded*, not pass/fail: an answer you merely *used* counts less than one you
*resolved* a ticket with, which counts less than something you *published* —
mapped onto the same reach ladder the code Impact lens uses. The grade is only ever
what you reported (`fiscus report --session <id> --kind used|resolved|published`),
never inferred from the content of your prompts. Acceptance and survival-over-time
don't apply to a one-shot answer, so they stay honestly n/a rather than faked.

**What's the "shadow price of intelligence"?**
The name for a research scenario: a hypothetical power-law response curve can
produce a marginal-value number, μ. Fiscus does not currently present it as a
forecast, a general allocation recommendation, a routing instruction, or an
automatic budget action. A decision-grade version requires a controlled,
within-task allocation design and independent validation.

**Can I trust the interval while watching it live?**
Yes — and that's rarer than it sounds. A classical interval is only valid if you
look once, at a pre-planned sample size; watched continuously (the way every
dashboard is actually used), its real error rate explodes — in simulation, a 90%
classical interval goes wrong at some point in ~64% of runs. Fiscus's
realization rate carries an **anytime-valid** interval (a confidence sequence)
instead: the guarantee holds simultaneously at every glance, so you may peek
whenever and act whenever. The honest price is a slightly wider interval — shown,
not hidden.

**What do I have to configure for the dollar return to appear?**
A labor rate (`lift.laborRatePerHour`) — for code, that's it. Per-task minutes
(`lift.baselineMinutes`) now resolve automatically: a cited population prior (METR's
published human-timed task scale) blended with your own pre-tracking git history via
empirical-Bayes shrinkage, falling back to the population prior alone when you don't
have enough history yet. Set `lift.baselineMinutes` yourself and your value always
wins — auto-resolution only fills in what you haven't set. Non-coding outcomes
(resolved tickets, published drafts) still need `lift.outcomeBaselineMinutes` set
explicitly — there's no git-history signal for those. Until a labor rate is set you
still get the full 0–100 RoI Index and spend metering; the *dollar* ratio stays
honestly un-priced rather than invented.

**How would I know if the metric itself is being gamed?**
The Stability line. An anytime-valid drift alarm watches the realization stream
for the signature of a bent metric — a rate that moves while a constant-rate story
fails — without reading any content. It fires on real regime changes too (a new
model, a new workflow), and says so: its job is to force the question *"did the
work change, or did the measuring get bent?"* — which no other dashboard even asks.
False alarms are capped at 5% over all of time, and that cap is verified by
simulation in the test suite.

**What should I measure next?**
Ask the tool: the "Instrument next" line names the unmeasured lens whose
measurement would move your Index most at a disclosed midpoint (a sensitivity
calculation, not a prediction). It names the cheapest place to reduce an
unmeasured assumption; the measured value may move the Index up or down.

## Cost & licensing

**What does Fiscus cost?**
The local tool is free. It uses only free tiers and Node built-ins; there's no
account and no telemetry.

**Is my data mine?**
Entirely. It's a local file (`~/.fiscus/`). Export anytime with
`fiscus export --csv`. Delete anytime by removing the directory.

## Troubleshooting

**A tool returns 404 through the proxy.**
Usually the `/v1` double-version gotcha: if your client already appends
`/chat/completions`, point it at `http://localhost:8090` **without** `/v1`. See
[INTEGRATIONS.md](INTEGRATIONS.md).

**`doctor` says the rate card is stale.**
`fiscus pricing --refresh` pulls current rates from the community price feed
(LiteLLM's model-price file — machine-readable, updated by hundreds of
contributors within days of every model release; the GET sends nothing about
you). It needs a reviewed `pricing_refresh` egress rule in controlled-cloud
mode. For self-maintenance, `fiscus pricing --auto` refreshes on start
whenever the table goes stale. A malformed or shrunken feed is refused and the
current table kept — a bad refresh can never corrupt your pricing.

Pricing updates accept only HTTPS sources without embedded credentials, refuse
redirects and oversized responses, and archive every accepted normalized card
under a SHA-256 identity before activating it. `fiscus pricing --json` shows the
redacted source identity, accepted-cache time, declared source date (when
provided), and integrity state. A successful 304 response means the source
revalidated the same local card; it is not presented as a newly published price.
Every Fiscus rate remains a local list-price estimate, not a provider invoice,
contractual discount, credit, tax, or reconciliation result.

**How does pricing stay correct as new models launch?**
Three layers, in order: the refreshed community feed above (170+ models across
Anthropic, OpenAI, Google); substring family-matching when an exact name is
missing (a new `-preview` variant prices as its family); and a conservative
flat fallback that marks every such request `~est` — surfaced in `doctor` as
"% of spend on estimated rates", so pricing drift is measured, never silent.

**Nothing shows under value / RoI.**
Attach a git repo (`--repo .`) and let the maturity window elapse, or report outcomes
with `fiscus report`. Value stays honestly dark until there's something real to
show.
