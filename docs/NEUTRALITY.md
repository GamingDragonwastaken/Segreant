# Neutrality

Fiscus's core product runs with no hosted service, no account, and no
donation mechanism. This states what that means concretely and which paths
are opt-in add-ons rather than requirements.

## The core requires nothing hosted

`npm install && npm run demo` or `npm run start` runs entirely against a local
SQLite ledger and a local proxy/dashboard — no signup, no license key, no
Fiscus-operated account, no telemetry by default
(`docs/DATA-BOUNDARIES.md`). There is no donation link, sponsorship prompt, or
paid tier gating any function described in `PRODUCT.md`. This document exists
so that claim stays checkable rather than aspirational: every egress path
listed below is the complete set (`docs/DATA-BOUNDARIES.md`'s declared-egress
table is enforced by a test that pins it against the code in both
directions), so a hosted requirement could not be added without appearing
there.

## Every non-local path is opt-in, named, and scoped

Each of these requires an explicit operator action or configuration; none
runs by default:

| Path | Requires |
| --- | --- |
| Proxy traffic to an AI provider | Pointing a tool at the Fiscus proxy — this is the product's function, not a Fiscus-operated service |
| Pricing manifest refresh | `fiscus pricing --refresh` or `pricing.autoRefresh` |
| Baseline manifest refresh | `fiscus baseline --refresh --url ...`, operator-supplied URL |
| Alert webhook delivery | `fiscus alerts --set-webhook ...` |
| Provider cost observation | `fiscus billing openai-costs pull ... --apply`, one fixed OpenAI endpoint |
| Team rollup | `fiscus team push --url ...`, to an operator-run team server |
| Hosted judge | An explicitly configured hosted judge provider |

None of these is a Fiscus-operated account, subscription, or telemetry
collector — they are, respectively, a public manifest fetch, an
operator-configured webhook, a provider's own billing endpoint, and an
operator-run server. Fiscus has no billing relationship with any user and
collects nothing centrally.

## Product and project neutrality

- The LICENSE is MIT, copyright "Fiscus contributors" — no individual name
  attached to ownership of the license grant.
- `docs/RELEASE-GATE.md`'s "Product claims allowed at this stage" section
  fixes the precise language this project may use about itself and forbids
  overclaiming (not "AI financial advice," not "zero egress," not a verified
  production deployment) — the same discipline applied to marketing claims
  that `CLAUDE.md` applies to accounting claims.
- There is no sponsor, no paid placement, and no vendor whose product is
  favored in comparison surfaces (`docs/RETURN-ON-INTELLIGENCE.md`'s model
  trials are explicitly review-only and do not automatically reallocate
  budget or rank providers as causal evidence).

## Public-interest governance note

Because there is one maintainer today (`GOVERNANCE.md`), "neutral" here means
"no hosted lock-in and no financial relationship gating functionality," not
"governed by a foundation or multiple independent maintainers." If that
changes, it will be recorded as a decision-log entry, not a quiet edit to this
page.

## What this document does not promise

It does not control what a configured AI provider does with data it receives,
and it is not a guarantee that a future version will keep every path above
free — a change to that would need to survive the review this page exists to
invite, and would be recorded here and in `docs/program/DECISION-LOG.md` when
it happens.
