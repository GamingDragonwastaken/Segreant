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

The proxy deliberately ignores `x-fiscus-openai-base`, including in old configs.
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

When an operator runs `fiscus billing openai-costs pull ... --apply`, Fiscus
may make exactly one additional outbound type: a read-only `GET` to the fixed
OpenAI Organization Costs endpoint at `https://api.openai.com/v1/organization/costs`.
The command first requires a local scope for exactly that endpoint plus a
`proj_...` project reference, and requires a UTC day range of no more than 180
days. Preview and a pull without `--apply` do not read a credential or contact
OpenAI. On an applied pull only, `OPENAI_ADMIN_API_KEY` is read from the current
process environment; it is never persisted, printed, included in an error, or
sent to any destination other than the fixed OpenAI request. Fiscus retains only
allowlisted normalized daily observations plus a digest chain/run status; it
does not retain raw response bodies. Direct provider observations are a separate
unreconciled collection, not request spend, and do not affect caps, RoI, or
recommendations. Failed/partial pulls retain failure metadata with no usable
provider observations.

All Fiscus-process HTTP(S) transport is now governed by the egress boundary.
The default `egress.mode: "local_locked"` permits literal loopback targets only
and refuses non-loopback targets before DNS. A cloud operation needs
`controlled_cloud` mode plus one enabled exact rule for its purpose, data class,
method, HTTPS origin, and leading path. Before an allowed request is dialled,
Fiscus persists redacted local receipts for policy preflight and dial start; it
adds a response or failure receipt afterwards. The receipt chain contains
hashes, rule identifiers, event metadata, byte counts, and status only—not
request bodies, query strings, API keys, headers, raw origins, or response
bodies. A missing receipt file is the only genesis case. If the path is present
but empty, malformed, truncated, hash-invalid, unreadable, or cannot be safely
locked/extended, Fiscus refuses before DNS/socket creation; it never treats that
state as a fresh chain. `fiscus egress status` and `fiscus egress verify` expose
the configured scope, exact failure reason, and local chain health so the
operator can repair or restore the retained history before retrying. A bounded
stale-lock refusal requires confirming that no Fiscus writer is active before
the operator removes only that lock; abandoned locks are never auto-deleted.
Receipt writes are synchronous, but Fiscus does not claim `fsync` or power-loss
durability for this local ledger.

The append path keeps a redacted, hash-checked checkpoint in
`egress-receipts.checkpoint.json` containing only the last verified file
identity, count, and chain hash. It is an optimization, not a second source of
truth: a missing/invalid checkpoint or changed receipt identity triggers a
complete JSONL validation, and `fiscus egress verify` always scans the complete
history. Checkpoint persistence failure fails closed. Status-only egress
callers cancel the returned response body so repeated health, webhook, and team
operations do not retain unused response streams.

When the proxy receives an upstream redirect, it preserves the status/body for
diagnosis but strips `Location` before returning the response. A downstream
client therefore cannot silently follow a provider redirect to a destination
outside the configured Fiscus-process egress policy.

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
  card and redacted source provenance remain local under the Fiscus home. It
  additionally needs an exact `pricing_refresh` egress rule in controlled-cloud
  mode.
- `fiscus baseline --refresh --url ...` downloads a baseline manifest from the
  URL supplied by the operator and needs an exact `baseline_refresh` rule.
- `fiscus alerts --set-webhook ...` sends configured alert summaries to the
  operator's webhook. It is not for prompts, source, or credentials, and needs
  an exact `alert_delivery` rule.
- A hosted judge is an explicit configuration choice. It can send the bounded
  session excerpt described by the selected judge tier to that configured judge
  provider and needs an exact `hosted_judge` rule. The local judge tier remains
  on-device through a literal loopback target.
- `fiscus team push --url ...` sends a signed, numeric rollup to an operator-run
  team server. It is opt-in and separate from the local product. It needs an
  exact `team_rollup` rule for a cloud endpoint; literal loopback development
  targets are permitted without a cloud rule. Fiscus refuses a non-loopback
  `http://` endpoint for this command; use HTTPS in deployment, or
  `http://localhost`, `http://127.0.0.1`, or `http://[::1]` only for local
  development.

The signed GitHub Actions outcome importer is offline: it reads an artifact from
disk, verifies it against a locally pinned public key and explicit policy flags,
then retains the verified envelope in the local ledger. It does not call GitHub.

## What this page does not promise

Fiscus cannot change an upstream provider's retention, training, privacy, or
security terms. Review the provider and any optional endpoint you choose before
routing sensitive material. Fiscus's privacy promise is about its own local
operation and the explicit controls above, not a guarantee about every service
you configure around it.

The egress boundary is also not a machine-wide firewall: it cannot stop a
client from bypassing Fiscus, another process, the operating-system resolver,
VPN/firewall policy, a machine administrator, or a provider after Fiscus has
deliberately forwarded a permitted request. Those guarantees need independently
managed operating-system, network, identity, and provider controls.
