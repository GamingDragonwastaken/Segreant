<div align="center">

<img src="web/assets/seal-256.png" alt="The Segreant Minted Seal — a heraldic griffin engraved on a gold coin" width="112" />

# Segreant

**Govern the spend. Not the developer.**

The financial control layer for AI coding agents, running on your own machine.
Every dollar your agents spend is metered, capped, checked against the
provider's bill, assigned to the budget it belongs to, and traced to the work
it produced. And every number tells you exactly how much it can be trusted.

`local-first` · `zero runtime dependencies` · `2,300+ tests` · `Node 24+` · `free for personal use`

[![CI](https://github.com/GamingDragonwastaken/Fiscus/actions/workflows/ci.yml/badge.svg)](https://github.com/GamingDragonwastaken/Fiscus/actions/workflows/ci.yml)

</div>

---

## The problem

Coding agents bill by the token, and they fail expensively. An agent stuck in a
loop overnight doesn't raise an error; it sends an invoice. Your monitoring
can't see it, because a `$0.002` request and a `$0.40` retry loop look
identical when all you measure is latency and errors.

Then finance asks a simple question, *"what is AI costing us, and is it worth
it?"*, and every tool answers with one confident number. That number is
usually an estimate dressed as a bill, or a bill with no owner, or a value
figure nobody can defend.

## Four numbers, never one

Segreant is built on a single refusal: **it will not collapse four different
questions into one number.**

| | The question | Where the answer comes from |
|---|---|---|
| **Metered usage** | What did the traffic use, at list price? | Segreant's proxy or your tools' own logs, priced from a versioned local rate card |
| **Provider-billed cost** | What did the provider actually charge? | The provider's cost export or Costs API (OpenAI today), imported and kept separate |
| **Allocated cost** | Whose budget does it belong to? | Allocation rules you write, reported together with what they left unallocated |
| **Value** | Did the spend become shipped, kept work? | Outcome evidence from git, tests and your reports |

Every figure on every screen says which of the four it is. When the evidence
for a number is missing, Segreant shows **unknown**. It never fills in a guess.

## What makes it different

Most cost tools are dashboards. Segreant is an accounting system with an
evidence model underneath, and it behaves like one.

- **Every row carries its provenance.** Each priced request records the exact
  rate-card SHA-256 and whether the price was an exact, family or fallback
  match. Repricing appends a before/after event; nothing is silently
  overwritten.
- **Budgets fail closed.** If the budget config is malformed or the ledger
  can't be read, Segreant stops forwarding. A broken meter never becomes an
  unlimited one.
- **Reconciliation shows its residual.** When metered spend and the
  provider's bill disagree, the gap is reported with the conditions that
  explain it and what it can and cannot bound. It is never forced to zero.
- **Allocation conserves money.** Allocated plus unallocated equals the ledger
  total to the microdollar, checked on every run. A run that doesn't balance
  is refused.
- **Model comparisons know when they're confounded.** Cheaper-model trials use
  anytime-valid intervals, correct for multiple comparisons, and flag
  themselves when the work sizes differ, the sample spans a price change, or
  the commits came from too few sessions.
- **Evidence you can hand to someone else.** Realized work produces
  ed25519-signed value receipts. The whole evidence ledger exports as a
  `.segreantpack` that a standalone verifier checks offline, without trusting
  Segreant.
- **A kernel that can't be talked into certainty.** Claims live in a small
  trusted core that tracks four evidence states: unknown, supported, refuted
  and conflicted. It refuses derivations that would strengthen a claim beyond
  its evidence, and revoking a source revokes everything built on it.
- **Zero runtime dependencies.** Node's built-in SQLite and nothing else. CI
  proves it with a CycloneDX SBOM on every build.

## See it in 30 seconds

No API key, no account, no setup. Clone the repo, then:

```bash
npm install     # builds the local CLI; the only packages installed are dev tooling
npm run demo    # seeds labelled synthetic data and opens the dashboard
```

Open **http://localhost:8091**. You'll see spend by project and model, budget
controls and governance alerts, the Return on Intelligence view, and a
review-only cheaper-model trial. It all runs on an isolated `demo.db` and is
labelled as synthetic. Clear it with `segreant demo --clear`.

## Use it on your real work

Put the `segreant` command on your `PATH` from the clone (Segreant is not on npm
yet):

```bash
npm link
```

**Option A: no wiring at all.** If you use Claude Code, Codex or opencode,
Segreant reads the usage those tools already log on your machine, including
subscription usage a proxy never sees:

```bash
segreant scan            # finds your AI tools and git repos; changes nothing
segreant scan --setup    # imports that usage and groups it by project
segreant today           # what today cost, by model, project and tool
```

**Option B: route traffic through Segreant** to meter it live and enforce budgets:

```bash
npm run start          # proxy on :8090, dashboard on :8091
```

```bash
export ANTHROPIC_BASE_URL="http://localhost:8090"
export OPENAI_BASE_URL="http://localhost:8090/v1"
```

Segreant starts **locked**: it forwards nothing to a cloud provider until you
grant that exact route with `segreant egress apply`; the two commands for OpenAI
and Anthropic are in [GETTING-STARTED.md](docs/GETTING-STARTED.md). Then set a
cap:

```bash
segreant budget --daily 25 --soft 18 --runaway 2   # hard cap, warning, loop guard
```

Caps are opt-in. A fresh install meters but never blocks. Unset the two
variables and Segreant is out of the path.

Per-tool recipes (Cursor, aider, opencode, Antigravity, your own SDK scripts):
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## What you can do with it

- **See the spend.** By day, project, model, tool and developer, in the
  terminal (`segreant today`, `week`, `month`) or the dashboard. Export CSV for
  your own BI.
- **Stop runaway agents.** Daily, per-session and velocity caps on proxied
  traffic.
- **Check against the real bill.** Import an OpenAI cost export, or pull
  OpenAI's Costs API read-only, and reconcile it against what Segreant metered
  at project-day level. See [PROVIDER-RECONCILIATION.md](docs/PROVIDER-RECONCILIATION.md).
- **Allocate to cost centres.** Versioned, effective-dated rules, reported as
  showback. See [ALLOCATION.md](docs/ALLOCATION.md).
- **Measure what the spend produced.** Return on Intelligence follows each
  commit through tested, merged, shipped and survived. See
  [RETURN-ON-INTELLIGENCE.md](docs/RETURN-ON-INTELLIGENCE.md).
- **Try a cheaper model, carefully.** `segreant frontier` compares models on the
  same kind of task. It never changes your routing for you.
- **Keep your data yours.** SQLite on your disk, verified backup and restore,
  and evidence packs you can sign and verify.

Every command, flag and design detail is in the **[Segreant guide](docs/GUIDE.md)**.

## For teams and enterprises

The same local tool scales up without sending prompts or code anywhere:

- **Team rollups.** Each machine signs and pushes per-project value and spend
  summaries to a team server *you* run. Per-developer views are opt-in,
  distribution-only and k-anonymous.
- **Finance-ready output.** Cost-centre allocation with conservation checks,
  provider-billed evidence with digests and coverage declarations, and a
  [FOCUS](docs/FOCUS-COMPATIBILITY.md)-compatible billing export.
- **Identity and storage.** The team server supports OIDC sign-in and
  PostgreSQL.

The team server is implemented and tested, but it has not yet been validated in
a production deployment; see [team-server/README.md](team-server/README.md)
before exposing it to a network.

## What Segreant will not claim

Built to be believed, so it is strict about what it says.

- **A local estimate is not a bill.** Metered amounts are list-price estimates.
  Provider figures are imported separately, and reconciled cost never feeds
  budgets or recommendations.
- **Value is not causation.** The dollar figure in the value view is an
  **Observed value scenario**: manual-equivalent value under assumptions you
  set. It is not a causal return. A causal net benefit result is separate and
  requires a registered randomized study (see
  [CAUSAL-EVIDENCE-PROTOCOL.md](docs/CAUSAL-EVIDENCE-PROTOCOL.md)).
- **Attribution labels are declarations, not verified identity.** Each label
  records how it was obtained, and a missing one stays missing.
- **Not surveillance.** Personal views are for self-improvement. Team views
  are opt-in and aggregate-only.

The complete, test-enforced list of what is supported, intended and not
offered is [CAPABILITY-EVIDENCE-CONTRACT.md](docs/CAPABILITY-EVIDENCE-CONTRACT.md).

## Privacy

Segreant has no hosted service and sends no telemetry by default. The ledger
lives under `~/.segreant`, and the dashboard loads nothing from third parties:
no CDNs, fonts or analytics. Requests you route through the proxy still go to
the AI provider you configured, and your API keys pass through without being
stored. Every other outbound path (price-card refresh, alert webhooks, team
rollups) is opt-in and listed in [DATA-BOUNDARIES.md](docs/DATA-BOUNDARIES.md).

## Status

Segreant is **pre-release (0.1.0)** and not on npm yet; run it from a clone as
shown above. CI covers Linux, macOS and Windows, including a packaged-install
smoke test, a browser accessibility pass and supply-chain checks.
Reconciliation and outcome measurement are implemented and tested but have not
yet been validated against real provider accounts or with outside users. That
is what the first users will prove.

If you try it, what confused you or what broke is the most useful thing you
can send: [open an issue](https://github.com/GamingDragonwastaken/Fiscus/issues)
or [start a discussion](https://github.com/GamingDragonwastaken/Fiscus/discussions).

## Documentation

| Start here | Go deeper | Trust and boundaries |
|---|---|---|
| [Getting started](docs/GETTING-STARTED.md) | [Segreant guide](docs/GUIDE.md) | [Data boundaries](docs/DATA-BOUNDARIES.md) |
| [Integrations](docs/INTEGRATIONS.md) | [Architecture](docs/ARCHITECTURE.md) | [Capability contract](docs/CAPABILITY-EVIDENCE-CONTRACT.md) |
| [FAQ](docs/FAQ.md) | [Methodology (plain language)](docs/METHODOLOGY.md) | [Threat model](docs/THREAT-MODEL.md) |

The full index is in [docs/README.md](docs/README.md).

## By the numbers

| | |
|---|---|
| Product code | ~88,000 lines of strict TypeScript |
| Tests | ~70,000 lines, 2,300+ test cases across the CLI, dashboard and team server |
| Runtime dependencies | 0 |
| CI | 11 jobs on every pull request: three operating systems, the team server against real PostgreSQL, a packaged install, supply chain, accessibility, and exact-head verification |

## Development

```bash
npm install          # dev-only: typescript + @types/node
npm run build        # compile to dist/
npm test             # the full suite
npm run typecheck    # strict TypeScript
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are verified,
[GOVERNANCE.md](GOVERNANCE.md) for who decides what, [SECURITY.md](SECURITY.md)
for reporting a vulnerability, [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)
for what stays stable, and [docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md)
for how a release is gated.

## Supporting Segreant

Segreant is built independently and is free for personal and noncommercial use.
Companies pay for a cheap commercial license
([COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)), and that is what funds the
work. Paying never unlocks features
([docs/NEUTRALITY.md](docs/NEUTRALITY.md) makes that a checkable commitment).

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free for personal use, research,
education and nonprofits. Using Segreant in a business needs a commercial
license, which is cheap and quick to get; see
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
