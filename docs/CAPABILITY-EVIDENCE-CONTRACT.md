# Capability and evidence contract

**Candidate-source review:** 2026-08-27, source revisions `0fc647c` (Store-owned
independent causal producer), `5eafa2e` (billing mapping coverage dashboard),
`c31e1ea`/`25cb707`/`556b5d0` (mapping and identity regressions), `e3cef41`
(asserted T-069 identity boundary), `aa24764` (recursive-trigger append-only
hardening), `3516e5a` (source-generation/publication gate), and `4e8d387`
(release-reader boundary). This document describes the locally implemented
product and the evidence available at that candidate. It is not a statement
that a hosted service, customer deployment, or provider invoice validation
exists. Any later candidate must re-review this contract against its exact
source revision; this marker is not inherited by a newer branch tip.

Fiscus is a local-first AI Financial Operations tool. Its present evidence and
implementation are strongest for AI coding-agent work. Its broader direction is
AI financial operations across AI usage, but direction is not a present-support
claim.

## Authority order

1. Runtime behaviour, source, tests, and a release gate bound to the exact
   revision decide what has shipped.
2. PRODUCT.md defines intended users, purpose, constraints, and requirements.
3. This document defines permitted current capability and evidence claims.
4. AI-FINANCIAL-OPERATIONS-ROADMAP.md defines intended direction and staged work,
   not delivery.
5. VISION-AUDIT.md and dated release-gate rows are historical evidence only for
   their named revision.

## Financial truth chain

Fiscus keeps four different claims separate:

    metered usage != provider-billed cost != allocated cost != realized business value

| Layer | Supported now | Evidence tier | Never infer |
| --- | --- | --- | --- |
| Metered usage | Explicitly routed proxy traffic and selected local tool imports; local list-price calculation with retained rate-card basis. | source-tested, fixture-tested, labelled demo, and a real local ledger | Provider billing, completeness, or verified account identity from an imported/logged row. |
| Provider-billed cost | Immutable operator-supplied OpenAI billing evidence; a narrowly scoped read-only OpenAI Costs collection path; compatible OpenAI project-day reconciliation mechanics. | source-tested and fixture-tested; no completed real-bill reconciliation is held here | Invoice finality, request/model-level matching, or a variance without route/account scope. |
| Allocated cost | Local showback through versioned, effective-dated, reversible cost-centre rules and an explicit unallocated position. | source-tested and fixture-tested | Chargeback, a provider invoice allocation, or causal reallocation advice. |
| Realized business value | Evidence-limited realization and return measurement for instrumented coding workflows. | source-tested, fixture-tested, labelled demo, and local evidence only | Universal productivity, causal proof, financial advice, or automatic spend action. |

## Supported now

- A local OpenAI- and Anthropic-compatible proxy meters intentionally routed
  traffic, applies local soft/hard/velocity controls, and serves a local CLI and
  dashboard.
- A Fiscus-process egress boundary starts in `local_locked` mode: it permits
  literal loopback HTTP(S) targets only and refuses non-loopback targets before
  DNS. `controlled_cloud` mode permits a cloud request only when an enabled,
  exact rule matches its purpose, data class, method, HTTPS origin, and leading
  path; it pins the selected public IP for the dial, follows no redirect, and,
  after policy evaluation, writes a redacted hash-chained `preflight_allowed`
  receipt before DNS resolution and a `dial_started` receipt before the socket.
  Only a
  genuinely absent receipt history may establish genesis; any present history
  that is empty, malformed, truncated, hash-invalid, unreadable, or not safely
  lockable refuses before DNS/socket creation and is never silently reset.
  The loader also fails closed on an unknown egress mode, a non-array rule set,
  or a non-boolean `enabled` value; controlled-cloud DNS accepts only numeric
  global-unicast destinations, and the selected address is pinned into the
  request. Loaded rules are held to the same exact semantic contract as CLI
  rules: canonical HTTPS origin, non-empty safe path prefix, valid identifier,
  and no unexpected fields. The encoded IANA boundary allows only the listed
  globally-reachable IPv6 exceptions under the otherwise non-global 2001::/23
  parent and the explicit globally-reachable IPv4 exceptions in 192.0.0.0/24.
- A local versioned rate card supplies a local list-price estimate. Rows retain
  pricing match and lineage; a list-price estimate is not a provider bill.
- The ledger preserves the distinction between proxy usage, imported usage,
  operator-supplied billing evidence, direct provider observations, and
  synthetic demo data.
- OpenAI project-day reconciliation is deliberately narrow, immutable, and
  residual-bearing. It withholds a result when the required route/account scope
  is absent.
- Imported provider lines can be assigned to an exact local project and
  accounting account through append-only operator mapping versions. Coverage,
  mapped dollars, residual dollars, stale/ambiguous mappings, target summaries,
  and the exclusions are visible in the CLI/API/dashboard. This is an
  accounting-preparation aid: the declaration is not provider identity, and
  mapped imports remain excluded from budget enforcement, RoI, and model advice
  until an authoritative provider scope is established.
- Cost-centre allocation is local showback with exact microdollar conservation.
- Return on Intelligence has coverage labels, assumptions, uncertainty, and
  review-only within-task model trials. The product includes a local,
  append-only randomized-study protocol/assignment/analysis lane with
  Store-internal execution, terminal-outcome, follow-up-policy, clock-authority,
  qualification, and T-069 scalar lineage-validation substrate. T-069 now
  persists a scalar-only request-to-realization sidecar behind an exact,
  append-only schema; its reload path authenticates the canonical envelope and
  duplicated identity columns. The Store-owned producer adapter independently
  derives the unit identity from retained Git scalar metadata and verifies the
  exact request ledger before it can append that identity. The normal
  realization pipeline does not invoke this adapter automatically, and an
  asserted or matching scalar is not by itself audited causal proof. Retained
  execution and outcome JSON must be canonical round-trips, and realization
  timestamps must follow execution completion. These later records are not
  public CLI/API/dashboard evidence. Cost-bearing V2 qualification remains
  fail-closed unless the sidecar is present and valid, ordinary ledger evidence
  passes, provider/account scope is independently addressed where required,
  and every other causal gate passes. Until a real protocol is registered,
  executed, and qualified, the product has no causal result to present.
  Neither path routes providers or changes budgets automatically.
- The browser dashboard has no third-party assets or analytics and is intended
  to expose a preview before consequential local changes. The CLI remains the
  reference surface while GUI parity is completed.

## Intended direction

- Broader AI Financial Operations across AI modalities and acquisition routes.
- More provider evidence sources, regional/currency semantics, and
  organization-level governance where independently validated.
- Better evidence-constrained economic decisions only after comparable,
  permissioned outcome evidence exists.

## Not established or not offered

- Universal AI-spend coverage, provider invoice truth, currency conversion, or
  chargeback.
- Production-hosted team service, organization authorization, or public
  deployment validation.
- Causal RoI, a general Shadow Price forecast, automatic routing/reallocation,
  or financial advice.
- Customer proof, testimonials, provider invoice evidence, or npm publication.

## Egress and retention matrix

The detailed source of truth is DATA-BOUNDARIES.md. These summaries prevent
local-first from being read as offline.

| Path | Operator control | Recipient | Data category | Non-claim |
| --- | --- | --- | --- | --- |
| Normal proxy route | Exact `provider_inference` controlled-cloud rule, then tool base URL and configured upstream | Configured AI provider | Provider request, which can contain prompts, source snippets, tool payloads, and provider credential | Fiscus does not make provider retention/privacy promises. |
| OpenAI Costs pull | Explicit applied command, declared scope, environment-only key, and exact `provider_cost_observation` rule | Fixed OpenAI Costs endpoint | Narrow read-only provider cost request; normalized observations retained locally | Not a provider-account verification or a request-level reconciliation. |
| Pricing/baseline refresh | Explicit command or configured refresh plus an exact rule | Operator-selected HTTPS manifest | Public manifest request; accepted normalized result/provenance stored locally | Not usage telemetry or provider invoice evidence. |
| Alert webhook | Explicit webhook configuration plus an exact rule | Operator-selected webhook | Configured alert summary | Not prompt, source, or credential transfer. |
| Hosted judge | Explicit judge choice plus an exact rule | Configured judge provider | Bounded session excerpt for the selected tier | Not local-only evaluation. |
| Team rollup | Explicit team push plus an exact rule | Operator-run team endpoint | Signed numeric aggregate | Not default telemetry or approved internet deployment. |

Fiscus has no Fiscus-hosted product telemetry by default. That does not change
the provider or optional egress paths above.

### High-assurance egress modes

- **Local locked** is the default and is enforceable for Fiscus's own HTTP(S)
  transport: no non-loopback target is resolved or dialled. It permits a local
  inference service at a literal loopback address such as `127.0.0.1` or
  `localhost`.
- **Controlled cloud** is opt-in and rule-scoped. A rule does not authorize a
  hostname pattern, arbitrary query/redirect target, plaintext remote HTTP, or
  another purpose/data class. The process receipt records a redacted target
  fingerprint, rule identifier, event, timestamp, byte count, response status,
  and hash-chain link; it never records a query, request body, API key, header,
  raw origin, or response body.
- Both modes are **process-scoped**. They do not control a direct client that
  bypasses Fiscus, another application, OS resolver/VPN/firewall policy, a
  machine administrator, or the provider after a deliberately permitted cloud
  request arrives. A cryptographically independent, machine-wide assurance
  needs separately deployed identity, firewall, and retention controls.

## Approved wording

- Say local list-price estimate, not provider-billed cost, unless a recorded
  provider source and its reconciliation conditions support the narrower claim.
- Say local showback allocation, not chargeback.
- Say observed/manual-equivalent value scenario under recorded assumptions, not
  that AI definitively paid for itself. A causal net-benefit claim is allowed
  only from a qualified causal-study result with its protocol identifier and
  lower-bound evidence.
- Say no Fiscus-hosted telemetry by default; do not generalize that default into
  an egress guarantee or claim that proxy traffic remains on the device.
- Say `local_locked Fiscus-process transport refused non-loopback HTTP(S)
  egress` only when that mode is active and receipts verify; say
  `controlled_cloud rule and receipt` for a permitted cloud request. Do not
  generalize either to the operating system, other applications, direct
  clients, or provider retention.
- Say a present receipt-history integrity or persistence failure blocks before
  dial and needs operator repair/restore; do not describe it as transparent
  passthrough or as a fresh genesis.
- Say a bounded stale-lock refusal requires confirming that no Fiscus writer is
  active before removing only that lock; do not claim Fiscus auto-cleans locks.
- Say review-only model trial, not forecast, recommendation, routing decision,
  or automatic action.
- State current coding-agent strength separately from the broader AI Financial
  Operations direction.

## Change rule

Any capability, egress path, pricing/recommendation rule, public claim, or
release candidate must update the affected row in this contract and its
verification test. If the source, evidence tier, scope, uncertainty, and
revocation condition cannot be named, the claim must be withheld.
