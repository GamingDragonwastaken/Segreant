# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase. Strict TypeScript on Node 24, **zero runtime dependencies** —
`typescript` and `@types/node` are the only entries in `devDependencies`. Build
is `tsc` into `dist/` plus a copy of the web assets (`scripts/build.mjs`). SQLite
via `node:sqlite`; tests via `node:test`.

**Web GUI build decision (2026-08-18):** the GUI is authored in TypeScript and
compiled by the *same* `tsc` invocation that already builds the server, emitting
plain unminified ES modules served as many small files. No bundler, no
framework, no minification, no new dependency, and no external network request
from the page. This is the "zero-build, many files, but with a build step"
combination: it buys shared types between server and browser, real module
boundaries, and typed complex UI (filterable tables, multi-step forms) while
keeping the shipped page readable by a human and the runtime dependency count at
zero. Interactive primitives are hand-written in-repo rather than imported.

## Users

Two audiences on the same surfaces, confirmed by the owner 2026-08-18:

- **A developer or technical operator** who could use the CLI but should not
  have to memorize forty verbs to see the whole product.
- **A finance, ops, or business owner who will never open a terminal.** The web
  GUI must be sufficient on its own for this person — the terminal is not an
  acceptable escape hatch for them.

Both use the same screens. The first run asks which one you are, and the GUI
adapts from that answer. The CLI does not need to adapt.

## Product Purpose

Fiscus is a local-first financial control, cost-accounting, and evidence-of-value
layer for AI usage — an **AI Financial Operations** layer. It meters configured
proxy traffic and selected local tool logs, applies local budget controls,
allocates cost to cost centres, reconciles against provider billing where the
evidence allows, and presents Return on Intelligence as an explicitly
evidence-limited measurement.

Success is that an operator can answer "what did AI cost, who should carry it,
and what did we get for it" and can **inspect the basis of every one of those
answers** rather than trusting a number.

It is currently strongest around AI coding agents, but the intended scope is
**all AI spend, not only developer or API spend.** Surfaces must not be designed
in a way that hard-codes the coding-agent case as the only one.

## Positioning

The central accounting distinction, which competitors collapse and Fiscus keeps
separate at every layer:

> `metered usage != provider-billed cost != allocated cost != realized business value`

Each of those is a different truth with a different evidence standard, and
Fiscus refuses to present one as another. Anything derived carries the basis it
was derived from. Where evidence does not support a claim, the product withholds
the claim and says why — including when that makes it look weaker.

What it is **not**: not AI financial advice, not software for performing
financial services using AI, not a "Vanta for finance" clone, not primarily an
AI governance/GRC product. The only borrowed idea is: make important claims
inspectable through evidence.

## Operating Context

The ledger, proxy, GUI, and API run on the operator's machine by default. A
local proxy (`:8090`) meters traffic; a SQLite ledger stores it; and the GUI/API
serve on `:8091`. Provider forwarding and other outbound paths remain explicit
Fiscus-process egress decisions under `docs/DATA-BOUNDARIES.md`; direct clients,
other processes, operating-system policy, and provider retention are outside
that boundary. An optional team server exists and is separately gated — it is
**not** approved for internet-facing deployment.

Data arrives by three routes, and the route determines what may be claimed:
proxy traffic (can carry a declared project label), native tool-log import
(records model and cost but nothing that ties it to a declared provider project),
and operator-supplied provider exports. Reconciliation counts only proxy traffic
carrying the declared scope — a real ledger on the owner's machine holds $832 of
imported OpenAI spend that therefore cannot reconcile, and the product says so
before the operator goes and mints a credential.

Fiscus itself has no hosted telemetry by default. Proxy requests still travel to
whichever AI provider the operator configured when that provider route is
enabled, and the declared egress mode/rule records the Fiscus-process decision.

## Capabilities and Constraints

- Roughly forty CLI verbs today: metering, budgets and alerts, project
  attribution, imports, provider billing evidence and reconciliation, cost-centre
  allocation, pricing and repricing, value/RoI measurement, judging, evidence
  records, export, team rollups, doctor/audit/guide.
- **The GUI is to reach full parity with the CLI** (owner decision, 2026-08-18).
  Consequential operations are not withheld from the GUI; they are gated with
  explicit warnings and confirmation. Genuinely consequential ones, which must
  never fire without deliberate confirmation: anything that reads a provider
  credential, anything that sends data off the machine (`team push`), anything
  that rewrites recorded money (`reprice`), and anything that deletes
  (`prune`, clearing proposals).
- Read-only-by-default idiom throughout: compute and preview by default,
  `--apply` to persist. The GUI must preserve preview-then-commit as a visible
  step, not collapse it.
- Provenance-label idiom: unknown provenance stays unknown (`legacy_unknown`) and
  is never backfilled from context.
- Exact integer microdollar arithmetic; largest-remainder distribution so
  allocation conserves to the microdollar.
- Local-first and least-privilege: prefer read-only provider access, never expose
  or forward credentials unnecessarily, no hidden telemetry or unexpected egress.
- The GUI must make **zero external network requests** — no CDN, no web fonts, no
  analytics. This is a checkable trust property, not a preference.

## Brand Commitments

Name: **Fiscus**. Voice is precise, plain, and unhedged; it states limits in the
same breath as results. It never inflates a claim the evidence does not carry,
and it does not apologize for withholding one. Existing brand assets ("Minted
Seal" set) are in the repository.

## Evidence on Hand

- A real local ledger: 18,422 requests / $1,574.42, of which $832.33 across
  9,499 requests is OpenAI arriving by native import.
- A labelled demo seed (`fiscus demo`) depicting five acquisition routes, which
  self-identifies as demo in every payload.
- `docs/RELEASE-GATE.md` — commit-bound gate records with real artifact digests
  and observed CI runs.
- `docs/VISION-AUDIT.md` — clause-by-clause audit of source against stated vision.
- **Absent, and never to be fabricated:** no completed reconciliation against a
  real provider bill; no npm publication; no production team deployment; no
  customers, testimonials, benchmarks, or pricing.

## Product Principles

1. **Never present one truth layer as another.** Metered, billed, allocated, and
   realized are four different claims with four different evidence standards.
2. **Every figure carries its basis.** If a number cannot state where it came
   from, it does not ship.
3. **Withhold rather than inflate.** Say what is missing, in the same place the
   result appears — before the user spends effort or permission on it.
4. **The Fiscus process has a declared egress boundary.** Local-first storage
   and UI are the default; provider forwarding and other outbound paths require
   an explicit configured route and remain distinct from machine-wide firewall,
   direct-client, and provider-retention guarantees.
5. **Parity with responsibility.** Anything the CLI can do, the GUI can do — and
   anything consequential announces its consequence before it happens.

## Accessibility & Inclusion

The non-technical audience is a stated requirement, not an aspiration: concepts
must be explained where they are used, not in a manual. Target WCAG 2.2 AA —
keyboard operable throughout, visible focus, sufficient contrast in both themes,
and no meaning carried by color alone (financial state especially).
