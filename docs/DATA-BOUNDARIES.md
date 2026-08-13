# Fiscus data boundaries

Fiscus is a local-first AI coding-agent FinOps and evidence-of-value tool. It is
not a hosted telemetry product. By default it does not send product analytics,
the local ledger, prompts, source code, or stored proposals to Fiscus or any
Fiscus-operated service.

Local-first does not mean that an AI provider request is made offline. This page
states exactly what crosses the machine boundary, when it happens, and what the
operator controls.

## Normal proxy traffic

When a tool is pointed at the Fiscus proxy, Fiscus forwards that tool's request
to the one upstream configured in `upstreams.anthropic` or `upstreams.openai`.
That request can contain prompts, source snippets, tool payloads, and the
provider credential exactly as required by the provider API. Fiscus does not
store credentials and does not forward them to any Fiscus service.

The proxy deliberately ignores `x-aegis-openai-base`, including in old configs.
A request-controlled destination would otherwise be able to receive a caller's
provider credential. To use a different provider, change the trusted configured
upstream or run a separate Fiscus process with its own configuration.

## What Fiscus stores locally

The local SQLite ledger records metering and outcome information: timestamps,
provider/model labels, token counts, calculated cost, project/session labels,
and configured outcome signals. For every newly local-priced row it also keeps
the SHA-256 of the local rate card, card source kind, and whether the model
matched exactly, by family, or by fallback. An explicit `fiscus reprice --apply`
adds an append-only before/after event; it does not silently reinterpret an old
amount. Tool-reported amounts, zero-cost audit events, synthetic demo data, and
pre-lineage historical rows are separately labelled. These are local pricing
evidence labels, not provider invoice, discount, credit, tax, or reconciliation
data. The ledger does not intentionally store provider API keys.

When an operator explicitly runs `fiscus billing import --file ... --apply`,
Fiscus also stores an immutable, provider-declared billing-evidence ledger. V1
accepts only a strict local OpenAI evidence JSON contract. It retains the file
basename, SHA-256 digest, size, import/source-period metadata, non-secret local
billing-account reference, coverage declaration, and allowlisted normalized
charge fields. It does **not** retain the raw file by default and does not read
provider credentials, browser sessions, or billing pages. These records remain
separate from proxy/local-tool requests: they do not affect caps, RoI, request
estimates, or `today` totals, and their status is `not_reconciled`. See
[BILLING-EVIDENCE-IMPORT.md](BILLING-EVIDENCE-IMPORT.md) for the exact local
schema and retention implications.

`fiscus billing scope set ... --apply` separately records only an operator's
non-secret local statement that future OpenAI-proxy traffic is routed to the
exact configured endpoint for a named account/project reference. Fiscus stores
the sanitized endpoint display and fingerprint, never an endpoint credential,
provider session, or API key. The status is always
`operator_declared_unverified`; it is not provider-account verification,
reconciliation, or an instruction to change routing.

With the default `metadataOnly: false`, Fiscus may also retain parsed proposed
code lines locally to measure whether an AI proposal later appeared in a Git
commit. This is a local-only convenience signal, not a claim that source never
touches the disk. Set `metadataOnly: true` to disable proposal capture and
First-Pass Acceptance measurement.

Proposal rows are pruned when `fiscus start` begins if they exceed
`proposalRetentionDays` (30 days by default). They can be deleted immediately
with the Settings action or `fiscus prune`. If Fiscus is not running, no
background process is active to delete data; run one of those controls when an
immediate deletion deadline matters.

## Optional outbound paths

These paths are off unless an operator deliberately invokes or configures them:

- `fiscus pricing --refresh`, or `pricing.autoRefresh` with a configured manifest,
  downloads a public pricing manifest from the selected HTTPS URL. The request is
  a plain GET with no usage, prompt, or customer data; the accepted normalized
  card and redacted source provenance remain local under the Fiscus home.
- `fiscus baseline --refresh --url ...` downloads a baseline manifest from the
  URL supplied by the operator.
- `fiscus alerts --set-webhook ...` sends configured alert summaries to the
  operator's webhook. It is not for prompts, source, or credentials.
- A hosted judge is an explicit configuration choice. It can send the bounded
  session excerpt described by the selected judge tier to that configured judge
  provider. The local judge tier remains on-device.
- `fiscus team push --url ...` sends a signed, numeric rollup to an operator-run
  team server. It is opt-in and separate from the local product.

The signed GitHub Actions outcome importer is offline: it reads an artifact from
disk, verifies it against a locally pinned public key and explicit policy flags,
then retains the verified envelope in the local ledger. It does not call GitHub.

## What this page does not promise

Fiscus cannot change an upstream provider's retention, training, privacy, or
security terms. Review the provider and any optional endpoint you choose before
routing sensitive material. Fiscus's privacy promise is about its own local
operation and the explicit controls above, not a guarantee about every service
you configure around it.
