<div align="center">

<img src="web/assets/seal-256.png" alt="The Fiscus Minted Seal — a heraldic griffin engraved on a gold coin" width="112" />

# Fiscus

**Govern the spend. Not the developer.**

A local ledger and spend guard for AI coding agents. See what every project,
model and tool costs, stop a runaway agent before it runs up a bill, and check
your numbers against the provider's own bill, without ever passing an estimate
off as an invoice.

`local-first` · `zero runtime dependencies` · `Node 24+` · `MIT`

[![CI](https://github.com/GamingDragonwastaken/Fiscus/actions/workflows/ci.yml/badge.svg)](https://github.com/GamingDragonwastaken/Fiscus/actions/workflows/ci.yml)

</div>

---

## Why this exists

Coding agents bill by the token, and they fail expensively. An agent stuck in a
loop overnight does not raise an error; it sends an invoice. Latency and error
monitoring cannot see this: a `$0.002` request and a `$0.40` retry loop look the
same.

"What is AI costing us?" sounds like one number. It is four different
questions, and Fiscus keeps them as four different numbers:

| | Question | Where it comes from |
|---|---|---|
| **Metered usage** | What did the traffic use, at list price? | Fiscus's proxy or your tools' local logs, priced from a versioned local rate card |
| **Provider-billed cost** | What did the provider actually charge? | The provider's cost export or Costs API (OpenAI today), imported and kept separate |
| **Allocated cost** | Whose budget does it belong to? | Allocation rules you write, reported with their unallocated remainder |
| **Value** | Did the spend turn into kept, shipped work? | Outcome evidence from git, tests and your reports |

Every figure Fiscus shows says which of these it is. When the evidence for a
number is missing, Fiscus shows it as unknown instead of filling it in.

## See it in 30 seconds

No API key, no account, no setup. Clone the repo, then:

```bash
npm install     # builds the local CLI; the only packages installed are dev tooling
npm run demo    # seeds labelled synthetic data and opens the dashboard
```

Open **http://localhost:8091**. You will see spend by project and model,
budget controls and governance alerts, the Return on Intelligence view, and a
review-only cheaper-model trial. All of it runs on an isolated `demo.db` and is
labelled as synthetic. Clear it with `fiscus demo --clear`.

## Use it on your real work

Put the `fiscus` command on your `PATH` from the clone (Fiscus is not on npm
yet):

```bash
npm link
```

**Option A: no wiring at all.** If you use Claude Code, Codex or opencode,
Fiscus can read the usage those tools already log on your machine, including
subscription usage a proxy never sees:

```bash
fiscus scan            # finds your AI tools and git repos; changes nothing
fiscus scan --setup    # imports that usage and groups it by project
fiscus today           # what today cost, by model, project and tool
```

**Option B: route traffic through Fiscus** to meter it live and enforce budgets:

```bash
npm run start          # proxy on :8090, dashboard on :8091
```

```bash
export ANTHROPIC_BASE_URL="http://localhost:8090"
export OPENAI_BASE_URL="http://localhost:8090/v1"
```

Fiscus starts **locked**: it forwards nothing to a cloud provider until you
grant that exact route with `fiscus egress apply`; the two commands for OpenAI
and Anthropic are in [GETTING-STARTED.md](docs/GETTING-STARTED.md). Then set a
cap:

```bash
fiscus budget --daily 25 --soft 18 --runaway 2   # hard cap, warning, loop guard
```

Caps are opt-in. A fresh install meters but never blocks. Unset the two
variables and Fiscus is out of the path.

Per-tool recipes (Cursor, aider, opencode, Antigravity, your own SDK scripts):
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## What you can do with it

- **See the spend.** By day, project, model, tool and developer, in the
  terminal (`fiscus today`, `week`, `month`) or the dashboard. Export to CSV
  for your own BI.
- **Stop runaway agents.** Daily, per-session and velocity caps on proxied
  traffic. If the budget configuration or the ledger can't be read, Fiscus
  stops forwarding rather than letting spend through unmetered.
- **Check against the real bill.** Import an OpenAI cost export, or pull
  OpenAI's Costs API read-only, and compare it with what Fiscus metered at project-day
  level. What doesn't match is reported as a residual and explained, never
  forced to zero. See [PROVIDER-RECONCILIATION.md](docs/PROVIDER-RECONCILIATION.md).
- **Allocate to cost centres.** Versioned, effective-dated rules. The allocated
  and unallocated amounts always add up to the ledger total, to the microdollar.
  See [ALLOCATION.md](docs/ALLOCATION.md).
- **Measure what the spend produced.** Return on Intelligence follows commits
  through tested, merged, shipped and survived, and emits signed value
  receipts. See [RETURN-ON-INTELLIGENCE.md](docs/RETURN-ON-INTELLIGENCE.md).
- **Try a cheaper model, carefully.** `fiscus frontier` compares models on the
  same kind of task. It says when a comparison is confounded, and it never
  changes your routing for you.
- **Keep your data yours.** SQLite on your disk, verified backup and restore,
  and portable evidence packs you can sign and verify.

Every command, flag and design detail is in the **[Fiscus guide](docs/GUIDE.md)**.

## What Fiscus will not claim

- **A local estimate is not a bill.** Metered amounts are list-price estimates
  from a local rate card. Provider figures are imported separately, and
  reconciled cost never feeds budgets or recommendations.
- **Value is not causation.** The dollar figure in the value view is an
  **Observed value scenario**: manual-equivalent value under assumptions you set
  (baseline, labour rate). It is not a causal return. A causal net benefit
  result is separate and requires a registered randomized study (see
  [CAUSAL-EVIDENCE-PROTOCOL.md](docs/CAUSAL-EVIDENCE-PROTOCOL.md)).
- **Attribution labels are declarations, not verified identity.** Each label
  records how it was obtained, and a missing one stays missing.
- **Not surveillance.** Personal views are for self-improvement. Team views are
  opt-in, aggregate-only and k-anonymous.

The complete, test-enforced list of what is supported, intended and not offered
is [CAPABILITY-EVIDENCE-CONTRACT.md](docs/CAPABILITY-EVIDENCE-CONTRACT.md).

## Privacy

Fiscus has no hosted service and sends no telemetry by default. The ledger
lives under `~/.fiscus`, and the dashboard loads nothing from third parties: no
CDNs, fonts or analytics. Requests you route through the proxy still go to the
AI provider you configured, and your API keys pass through without being
stored. Every other outbound path (price-card refresh, alert webhooks, team
rollups) is opt-in and listed in [DATA-BOUNDARIES.md](docs/DATA-BOUNDARIES.md).

## Status

Fiscus is **pre-release (0.1.0)**. It is not published to npm yet; run it from
a clone as shown above. CI covers Linux, macOS and Windows, including a packaged
install smoke test, a browser accessibility pass, and supply-chain checks.
Provider-billed reconciliation and outcome measurement are implemented and
tested, but have not yet been validated against real provider accounts or with
outside users; that field evidence is what comes next. The optional
[team server](team-server/README.md) is not approved for internet-facing
deployment.

If you try it, what confused you or broke is the most useful thing you can send:
[open an issue](https://github.com/GamingDragonwastaken/Fiscus/issues).

## Documentation

| Start here | Go deeper | Trust and boundaries |
|---|---|---|
| [Getting started](docs/GETTING-STARTED.md) | [Fiscus guide](docs/GUIDE.md) | [Data boundaries](docs/DATA-BOUNDARIES.md) |
| [Integrations](docs/INTEGRATIONS.md) | [Architecture](docs/ARCHITECTURE.md) | [Capability contract](docs/CAPABILITY-EVIDENCE-CONTRACT.md) |
| [FAQ](docs/FAQ.md) | [Methodology (plain language)](docs/METHODOLOGY.md) | [Threat model](docs/THREAT-MODEL.md) |

The full index is in [docs/README.md](docs/README.md).

## Development

```bash
npm install          # dev-only: typescript + @types/node
npm run build        # compile to dist/
npm test             # the full suite
npm run typecheck    # strict TypeScript
```

Runtime dependencies: **none**, and CI checks that with a CycloneDX SBOM
(`npm run verify:sbom`). See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes
are verified, [GOVERNANCE.md](GOVERNANCE.md) for who decides what,
[SECURITY.md](SECURITY.md) for reporting a vulnerability,
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for what stays stable, and
[docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md) for how a release is gated.

## Supporting Fiscus

Fiscus is free, and everything it does works without an account, a
subscription or a donation. [docs/NEUTRALITY.md](docs/NEUTRALITY.md) makes that
a checkable commitment. If it saves you money and you want to help it keep
going, the **Sponsor** button at the top of this repository goes to GitHub
Sponsors.

## License

[MIT](LICENSE).
