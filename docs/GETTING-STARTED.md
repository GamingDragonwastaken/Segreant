# Getting started with Segreant

Segreant is a **local-first** proxy that meters what your AI tools spend and
measures what that spend actually returns. It needs
**Node 24+** and has **zero runtime dependencies**.

Before routing real work, read **[DATA-BOUNDARIES.md](DATA-BOUNDARIES.md)**:
Segreant has no hosted collection or telemetry by default, but proxy traffic still
goes to the AI provider you configure, and proposal capture is a local storage
choice.

> **Release status:** Segreant is not published to npm yet, so `npx segreant`
> will not work. From a clone, run `npm install` and then `npm link` once; that
> puts this checkout's `segreant` command on your `PATH`, and every command
> below works as written. Without linking, run the same commands as
> `npm run segreant -- <verb>`.

---

## 1. See it work in 60 seconds (no setup, no keys)

```bash
segreant demo          # seed a realistic synthetic dataset (isolated demo.db)
segreant demo --serve  # ...and open the dashboard on http://localhost:8091
```

Everything you see is priced by the real cost engine on synthetic traffic — your
real metering is never touched. When you're done: `segreant demo --clear`.

Try these against the demo to feel the product:

```bash
segreant roi --demo       # the Return-on-Intelligence scorecard
segreant sources --demo   # spend by connected tool, at honest depth
segreant budget --recommend --demo   # a cap that fits + the shadow price
```

For a local recovery checkpoint, create a verified snapshot and restore only
into a new path:

```bash
segreant backup --out ./backups/segreant.sqlite --json
segreant restore --from ./backups/segreant.sqlite --out ./recovered/segreant.sqlite --json
segreant restore --from ./backups/segreant.sqlite --out ./recovered/segreant.sqlite --apply --json
```

Restore never overwrites the active ledger. The SQLite file and its manifest are
sensitive local artifacts (they can include retained proposals or causal
assignment material) and are not encrypted by Segreant.

If you need to hand a local run to another engineer, export a redacted bundle:

```bash
segreant diagnostics --json --out ./support/segreant-diagnostics.json
```

It contains runtime, schema, egress, pricing, and resource observations with
correlation IDs and durations, but no prompts, source, credentials, raw ledger
rows, or absolute user paths. The command is read-only and refuses to overwrite
an existing export.

## 2. Meter your own AI usage

### The easiest path: zero wiring, if you already use a supported tool

If you already run **Claude Code, opencode, or Codex CLI**, you don't need to
configure anything — those tools already log their own usage locally, and Segreant
can just read it:

```bash
segreant scan            # finds the tools + git repos on this machine (read-only)
segreant scan --setup    # imports everything it found + correlates per-project RoI
```

That's it — no base URL, no proxy, no key to point anywhere. Re-run `scan` any time;
it tells you what's new since last time. This is genuinely the fastest way to see
real numbers, and it's why it's what `segreant guide` leads with on a fresh install.

`scan` also mentions other AI coding tools it sees on your machine (Cursor,
Windsurf, Aider, Continue, Zed) even though it can't import from them yet — an
honest inventory, not a claim of coverage.

### The proxy path: connect, don't intercept

For anything else — or if you want Segreant to actively **cap** spend in real time,
not just read logs after the fact — point a tool at the local proxy; it meters the
request and forwards it to the real provider **with your own key**. There is no root
certificate and no traffic interception — your key never touches anyone else, and
anything you don't route simply isn't metered (honest by design).

```bash
segreant start     # proxy on :8090, dashboard on :8091
```

**A — a coding agent that already has providers (e.g. opencode):** wrap a provider
you already use. This is the most native proxy path — your existing key, all its
traffic:

```bash
segreant connect opencode                       # see your providers + advice
segreant connect opencode --wrap <provider> --write
```

**B — any OpenAI-compatible SDK / script / curl:** point its base URL at the proxy
and tag the source:

```bash
segreant connect api my-app     # prints the exact base URL + header to set
```

**C — environment variables (Claude Code, aider, etc.):**

```bash
# PowerShell
$env:ANTHROPIC_BASE_URL="http://localhost:8090"
$env:OPENAI_BASE_URL="http://localhost:8090/v1"
```

**Grant the provider route.** Segreant starts in **local-locked** mode and forwards
nothing to a cloud provider until you allow that exact route. For OpenAI:

```bash
segreant egress apply --apply --mode controlled_cloud \
  --id openai-inference --purpose provider_inference \
  --data-class provider_request --method POST \
  --origin https://api.openai.com --path-prefix /v1/
```

For Anthropic, add a second rule (the OpenAI rule is kept):

```bash
segreant egress apply --apply --mode controlled_cloud \
  --id anthropic-inference --purpose provider_inference \
  --data-class provider_request --method POST \
  --origin https://api.anthropic.com --path-prefix /v1/
```

`segreant egress status` shows the active mode and rules. The full behaviour,
including receipt-chain recovery, is in [GUIDE.md](GUIDE.md#egress-control).

See [INTEGRATIONS.md](INTEGRATIONS.md) for per-tool recipes and the one common gotcha
(don't add `/v1` when a client already appends the request path).

### Already imported or proxied spend from multiple projects?

```bash
segreant discover   # correlate what's already in the ledger into per-project RoI
```

`scan --setup` already does this as its last step; run `discover` on its own after a
fresh `import` if you skipped `scan`.

### Check it's flowing

```bash
segreant doctor    # config, DB, proxy reachability, pricing freshness, alerts
segreant today     # today's spend, by model / user / source
segreant sources   # which tools you've connected and at what depth
```

## 3. Turn on the value measurement (optional but it's the point)

Spend metering works immediately. To measure *return*, give Segreant a git repo to
read outcomes from, and (optionally) a labor rate so it can price the dollar return:

```bash
segreant config              # see all settings + where they live
# set lift.laborRatePerHour to price your supervision time into the honest cost
segreant realize --repo .    # the Realization funnel over recent commits
segreant roi --repo . --labor-rate 120
```

Outcomes the proxy can't see (tests, ships) are best captured **ambiently** — wrap
the command once and every run reports itself, no human in the loop:

```bash
segreant exec -- npm test                        # exit 0 → tested=pass, else fail
segreant exec --kind shipped -- npm run deploy   # deploys report themselves too
```

Put it in a package.json script (`"test": "segreant exec -- vitest"`) and the
funnel feeds itself from then on. The wrapper is transparent: same output, same
exit code, so pipelines and CI steps behave identically. Manual reporting stays
available as the fallback:

```bash
segreant report --commit <hash> --kind tested
segreant report --session <id> --kind resolved   # usage without code signals
```

## 4. Govern the spend

```bash
segreant budget --daily 25 --soft 18   # hard + soft caps
segreant budget --recommend            # a cap that fits usage + the shadow price
segreant alerts                         # budget/spike/throttle/value alerts
segreant export --csv --days 30         # get the numbers out
```

## 5. Per-user value (opt-in, privacy-first)

How much of each person's AI spend reaches a real outcome — as a *distribution*,
never a leaderboard. It's **off by default**; enable it deliberately (it's the
surveillance-prone axis), and even then it's withheld below a k-anonymity floor.

```bash
# enable in config: perUser.enabled = true  (see: segreant config)
segreant team              # team distribution + coaching headroom (no names)
segreant team --me you@co  # your OWN extraction vs. the team median
```

The org view shows the median, the spread, and *coaching headroom* — the latent
value if below-median extractors were supported up to the median. It's a case for
enablement, not a ranking. See [FAQ.md](FAQ.md) → "Do you rank developers?".

## Where things live

- **Config + database:** `~/.segreant/` (Windows: `%USERPROFILE%\.segreant`).
- **Somewhere else instead:** set `SEGREANT_HOME` to any directory and every
  command — including `start` and `demo` — reads and writes there. Useful for
  keeping a trial completely separate from a real ledger. `SEGREANT_DB` overrides
  just the database file. These are the only overrides Segreant reads.
- **Nothing else.** No cloud account, no telemetry.

## Next

- [METHODOLOGY.md](METHODOLOGY.md) — how the RoI number works, in plain language.
- [FAQ.md](FAQ.md) — privacy, coverage, and the honest limits.
- [RETURN-ON-INTELLIGENCE.md](RETURN-ON-INTELLIGENCE.md) — the full derivation.
