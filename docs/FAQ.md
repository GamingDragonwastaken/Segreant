# AegisFlow FAQ

## Privacy & security

**Does my code or prompts ever leave my machine?**
No. Metering, storage, and all RoI math run locally in a file-based database. The
only outbound traffic is (1) forwarding your AI requests to the provider you already
use — with your own key, exactly as your tool would have — and (2) two *optional,
off-by-default* things: a public pricing-table refresh (a plain GET, sends nothing
about you) and alert webhooks you configure (which carry alert titles/severity only,
never content).

**Do you see my API keys?**
No. Keys stay in your environment / your tool's config. The proxy forwards the auth
header upstream unchanged and never stores it. AegisFlow's author never sees it.

**Is there a root certificate or traffic interception?**
No. AegisFlow is a base-URL reverse proxy — you explicitly point tools at it. That's
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
install a root CA to force it. Those are honestly labeled as unmeterable here; the
roadmap covers them later via **billing/usage import** (spend-only), not interception.

**Does the proxy slow my requests down?**
Negligibly. The proxy overhead is microseconds against a provider round-trip of
hundreds of milliseconds to seconds. If AegisFlow is off, traffic you pointed at it
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

**Why is my RoI Index sometimes labeled an "upper bound"?**
Because some of the four value lenses aren't wired yet. Every unmeasured necessary
condition can only *lower* the true value, so a partly-measured score is an honest
ceiling. Wire more (report tests/ships, attach a repo) and it moves toward the truth —
usually down. That's the point: more measurement, more honest, never inflated.

**Why did a small experiment's great score get "pulled down"?**
Reliability shrinkage. Two-of-two successes isn't the same evidence as 140-of-200, so
thin results are shrunk toward the population average until there's enough data. It
stops the tool from chasing luck.

**What's the "shadow price of intelligence"?**
The value of one more AI dollar, spent optimally, right now (μ). μ ≥ $1 means invest
more; μ < $1 means the next dollar returns less than it costs — cut before you grow.

**What do I have to configure for the dollar return to appear?**
A labor rate (`lift.laborRatePerHour`) and, ideally, per-task manual-time baselines.
Until then you still get the full 0–100 RoI Index and spend metering; the *dollar*
ratio stays honestly un-priced rather than invented.

## Cost & licensing

**What does AegisFlow cost?**
The local tool is free. It uses only free tiers and Node built-ins; there's no
account and no telemetry.

**Is my data mine?**
Entirely. It's a local file (`~/.aegisflow/`). Export anytime with
`aegisflow export --csv`. Delete anytime by removing the directory.

## Troubleshooting

**A tool returns 404 through the proxy.**
Usually the `/v1` double-version gotcha: if your client already appends
`/chat/completions`, point it at `http://localhost:8090` **without** `/v1`. See
[INTEGRATIONS.md](INTEGRATIONS.md).

**`doctor` says the rate card is stale.**
`aegisflow pricing --refresh` (or set `pricing.autoRefresh: true` to refresh stale
pricing when the proxy starts).

**Nothing shows under value / RoI.**
Attach a git repo (`--repo .`) and let the maturity window elapse, or report outcomes
with `aegisflow report`. Value stays honestly dark until there's something real to
show.
