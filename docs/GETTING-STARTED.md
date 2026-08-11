# Getting started with Fiscus

Fiscus is a **local-first** proxy that meters what your AI tools spend and
measures what that spend actually returns. It needs
**Node 24+** and has **zero runtime dependencies**.

Before routing real work, read **[DATA-BOUNDARIES.md](DATA-BOUNDARIES.md)**:
Fiscus has no hosted collection or telemetry by default, but proxy traffic still
goes to the AI provider you configure, and proposal capture is a local storage
choice.

> **Release status:** this checkout is not yet published to npm. Run commands
> from a clone with `node bin/fiscus.mjs ...`. The `npx fiscus ...` examples below
> describe the intended post-publication command and must not be treated as an
> available package until the registry release is verified.

---

## 1. See it work in 60 seconds (no setup, no keys)

```bash
npx fiscus demo          # seed a realistic synthetic dataset (isolated demo.db)
npx fiscus demo --serve  # ...and open the dashboard on http://localhost:8091
```

Everything you see is priced by the real cost engine on synthetic traffic — your
real metering is never touched. When you're done: `npx fiscus demo --clear`.

Try these against the demo to feel the product:

```bash
npx fiscus roi --demo       # the Return-on-Intelligence scorecard
npx fiscus sources --demo   # spend by connected tool, at honest depth
npx fiscus budget --recommend --demo   # a cap that fits + the shadow price
```

## 2. Meter your own AI usage

### The easiest path: zero wiring, if you already use a supported tool

If you already run **Claude Code, opencode, or Codex CLI**, you don't need to
configure anything — those tools already log their own usage locally, and Fiscus
can just read it:

```bash
npx fiscus scan            # finds the tools + git repos on this machine (read-only)
npx fiscus scan --setup    # imports everything it found + correlates per-project RoI
```

That's it — no base URL, no proxy, no key to point anywhere. Re-run `scan` any time;
it tells you what's new since last time. This is genuinely the fastest way to see
real numbers, and it's why it's what `fiscus guide` leads with on a fresh install.

`scan` also mentions other AI coding tools it sees on your machine (Cursor,
Windsurf, Aider, Continue, Zed) even though it can't import from them yet — an
honest inventory, not a claim of coverage.

### The proxy path: connect, don't intercept

For anything else — or if you want Fiscus to actively **cap** spend in real time,
not just read logs after the fact — point a tool at the local proxy; it meters the
request and forwards it to the real provider **with your own key**. There is no root
certificate and no traffic interception — your key never touches anyone else, and
anything you don't route simply isn't metered (honest by design).

```bash
npx fiscus start     # proxy on :8090, dashboard on :8091
```

**A — a coding agent that already has providers (e.g. opencode):** wrap a provider
you already use. This is the most native proxy path — your existing key, all its
traffic:

```bash
npx fiscus connect opencode                       # see your providers + advice
npx fiscus connect opencode --wrap <provider> --write
```

**B — any OpenAI-compatible SDK / script / curl:** point its base URL at the proxy
and tag the source:

```bash
npx fiscus connect api my-app     # prints the exact base URL + header to set
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
npx fiscus discover   # correlate what's already in the ledger into per-project RoI
```

`scan --setup` already does this as its last step; run `discover` on its own after a
fresh `import` if you skipped `scan`.

### Check it's flowing

```bash
npx fiscus doctor    # config, DB, proxy reachability, pricing freshness, alerts
npx fiscus today     # today's spend, by model / user / source
npx fiscus sources   # which tools you've connected and at what depth
```

## 3. Turn on the value measurement (optional but it's the point)

Spend metering works immediately. To measure *return*, give Fiscus a git repo to
read outcomes from, and (optionally) a labor rate so it can price the dollar return:

```bash
npx fiscus config              # see all settings + where they live
# set lift.laborRatePerHour to price your supervision time into the honest cost
npx fiscus realize --repo .    # the Realization funnel over recent commits
npx fiscus roi --repo . --labor-rate 120
```

Outcomes the proxy can't see (tests, ships) are best captured **ambiently** — wrap
the command once and every run reports itself, no human in the loop:

```bash
npx fiscus exec -- npm test                        # exit 0 → tested=pass, else fail
npx fiscus exec --kind shipped -- npm run deploy   # deploys report themselves too
```

Put it in a package.json script (`"test": "fiscus exec -- vitest"`) and the
funnel feeds itself from then on. The wrapper is transparent: same output, same
exit code, so pipelines and CI steps behave identically. Manual reporting stays
available as the fallback:

```bash
npx fiscus report --commit <hash> --kind tested
npx fiscus report --session <id> --kind resolved   # usage without code signals
```

## 4. Govern the spend

```bash
npx fiscus budget --daily 25 --soft 18   # hard + soft caps
npx fiscus budget --recommend            # a cap that fits usage + the shadow price
npx fiscus alerts                         # budget/spike/throttle/value alerts
npx fiscus export --csv --days 30         # get the numbers out
```

## 5. Per-user value (opt-in, privacy-first)

How much of each person's AI spend reaches a real outcome — as a *distribution*,
never a leaderboard. It's **off by default**; enable it deliberately (it's the
surveillance-prone axis), and even then it's withheld below a k-anonymity floor.

```bash
# enable in config: perUser.enabled = true  (see: fiscus config)
npx fiscus team              # team distribution + coaching headroom (no names)
npx fiscus team --me you@co  # your OWN extraction vs. the team median
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
