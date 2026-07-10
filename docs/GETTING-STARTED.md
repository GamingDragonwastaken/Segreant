# Getting started with AegisFlow

AegisFlow is a **local-first** proxy that meters what your AI tools spend and
measures what that spend actually returns. Nothing leaves your machine. It needs
**Node 24+** and has **zero runtime dependencies**.

---

## 1. See it work in 60 seconds (no setup, no keys)

```bash
npx aegisflow demo          # seed a realistic synthetic dataset (isolated demo.db)
npx aegisflow demo --serve  # ...and open the dashboard on http://localhost:8091
```

Everything you see is priced by the real cost engine on synthetic traffic — your
real metering is never touched. When you're done: `npx aegisflow demo --clear`.

Try these against the demo to feel the product:

```bash
npx aegisflow roi --demo       # the Return-on-Intelligence scorecard
npx aegisflow sources --demo   # spend by connected tool, at honest depth
npx aegisflow budget --recommend --demo   # a cap that fits + the shadow price
```

## 2. Meter your own AI usage

### The easiest path: zero wiring, if you already use a supported tool

If you already run **Claude Code, opencode, or Codex CLI**, you don't need to
configure anything — those tools already log their own usage locally, and AegisFlow
can just read it:

```bash
npx aegisflow scan            # finds the tools + git repos on this machine (read-only)
npx aegisflow scan --setup    # imports everything it found + correlates per-project RoI
```

That's it — no base URL, no proxy, no key to point anywhere. Re-run `scan` any time;
it tells you what's new since last time. This is genuinely the fastest way to see
real numbers, and it's why it's what `aegisflow guide` leads with on a fresh install.

`scan` also mentions other AI coding tools it sees on your machine (Cursor,
Windsurf, Aider, Continue, Zed) even though it can't import from them yet — an
honest inventory, not a claim of coverage.

### The proxy path: connect, don't intercept

For anything else — or if you want AegisFlow to actively **cap** spend in real time,
not just read logs after the fact — point a tool at the local proxy; it meters the
request and forwards it to the real provider **with your own key**. There is no root
certificate and no traffic interception — your key never touches anyone else, and
anything you don't route simply isn't metered (honest by design).

```bash
npx aegisflow start     # proxy on :8090, dashboard on :8091
```

**A — a coding agent that already has providers (e.g. opencode):** wrap a provider
you already use. This is the most native proxy path — your existing key, all its
traffic:

```bash
npx aegisflow connect opencode                       # see your providers + advice
npx aegisflow connect opencode --wrap <provider> --write
```

**B — any OpenAI-compatible SDK / script / curl:** point its base URL at the proxy
and tag the source:

```bash
npx aegisflow connect api my-app     # prints the exact base URL + header to set
```

**C — environment variables (Claude Code, aider, etc.):**

```bash
# PowerShell
$env:ANTHROPIC_BASE_URL="http://localhost:8090"
$env:OPENAI_BASE_URL="http://localhost:8090/v1"
```

See [INTEGRATIONS.md](INTEGRATIONS.md) for per-tool recipes and the one common gotcha
(don't add `/v1` when a client already appends the request path).

### Already imported or proxied spend from multiple projects?

```bash
npx aegisflow discover   # correlate what's already in the ledger into per-project RoI
```

`scan --setup` already does this as its last step; run `discover` on its own after a
fresh `import` if you skipped `scan`.

### Check it's flowing

```bash
npx aegisflow doctor    # config, DB, proxy reachability, pricing freshness, alerts
npx aegisflow today     # today's spend, by model / user / source
npx aegisflow sources   # which tools you've connected and at what depth
```

## 3. Turn on the value measurement (optional but it's the point)

Spend metering works immediately. To measure *return*, give AegisFlow a git repo to
read outcomes from, and (optionally) a labor rate so it can price the dollar return:

```bash
npx aegisflow config              # see all settings + where they live
# set lift.laborRatePerHour to price your supervision time into the honest cost
npx aegisflow realize --repo .    # the Realization funnel over recent commits
npx aegisflow roi --repo . --labor-rate 120
```

Outcomes the proxy can't see (tests, ships) are best captured **ambiently** — wrap
the command once and every run reports itself, no human in the loop:

```bash
npx aegisflow exec -- npm test                        # exit 0 → tested=pass, else fail
npx aegisflow exec --kind shipped -- npm run deploy   # deploys report themselves too
```

Put it in a package.json script (`"test": "aegisflow exec -- vitest"`) and the
funnel feeds itself from then on. The wrapper is transparent: same output, same
exit code, so pipelines and CI steps behave identically. Manual reporting stays
available as the fallback:

```bash
npx aegisflow report --commit <hash> --kind tested
npx aegisflow report --session <id> --kind resolved   # non-coding usage
```

## 4. Govern the spend

```bash
npx aegisflow budget --daily 25 --soft 18   # hard + soft caps
npx aegisflow budget --recommend            # a cap that fits usage + the shadow price
npx aegisflow alerts                         # budget/spike/throttle/value alerts
npx aegisflow export --csv --days 30         # get the numbers out
```

## 5. Per-user value (opt-in, privacy-first)

How much of each person's AI spend reaches a real outcome — as a *distribution*,
never a leaderboard. It's **off by default**; enable it deliberately (it's the
surveillance-prone axis), and even then it's withheld below a k-anonymity floor.

```bash
# enable in config: perUser.enabled = true  (see: aegisflow config)
npx aegisflow team              # team distribution + coaching headroom (no names)
npx aegisflow team --me you@co  # your OWN extraction vs. the team median
```

The org view shows the median, the spread, and *coaching headroom* — the latent
value if below-median extractors were supported up to the median. It's a case for
enablement, not a ranking. See [FAQ.md](FAQ.md) → "Do you rank developers?".

## Where things live

- **Config + database:** `~/.aegisflow/` (Windows: `%USERPROFILE%\.aegisflow`).
- **Nothing else.** No cloud account, no telemetry.

## Next

- [METHODOLOGY.md](METHODOLOGY.md) — how the RoI number works, in plain language.
- [FAQ.md](FAQ.md) — privacy, coverage, and the honest limits.
- [RETURN-ON-INTELLIGENCE.md](RETURN-ON-INTELLIGENCE.md) — the full derivation.
