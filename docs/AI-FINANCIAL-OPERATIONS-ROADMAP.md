# Fiscus AI Financial Operations Roadmap

**Status:** Product-direction decision and staged build plan, 2026-08-11. It describes an intended expansion; it is not a claim that the capabilities below are shipped or that Fiscus is a financial system of record today.

## 1. The product Fiscus should become

Fiscus should become a **provenance-aware AI Financial Operations Control Plane**:

> A system that helps an organization observe, reconcile, allocate, govern, and evaluate AI spend - beginning with coding agents - while showing exactly what each financial or outcome claim is based on.

This is not personal finance, investment advice, accounting software, payment processing, or a generic compliance/GRC product. It is the financial-operations layer for organizational AI usage.

The existing local-first tool remains the right first wedge:

> **Fiscus for Coding-Agent Financial Truth:** what intentionally captured agents cost, which team or project owns that cost, what provider evidence confirms it, what controls applied, and what delivery evidence exists about the work.

The eventual platform is broader than a local proxy, but it must grow from the real strength already present: granular coding-agent metering tied to explicit evidence of software outcomes. It must not pretend that a price-table estimate is an invoice, or that a passed test proves business value.

## 2. The fundamental truth model

Fiscus must preserve four distinct layers. They may be related, but they must never be silently collapsed into a single `AI cost` or `ROI` number.

```text
metered usage != provider-billed cost != allocated cost != realized business value
```

| Layer | What it can prove | What it cannot prove |
| --- | --- | --- |
| **Metered usage** | What Fiscus observed through an explicitly routed proxy or supported local tool log. | All organizational usage, provider invoice totals, contractual discounts, or business value. |
| **Provider cost** | What a provider API, cloud billing export, or bill reports for a defined account and period. | Per-prompt causality unless the provider supplies a compatible request-level source. |
| **Allocated cost** | How an organization chose to assign source cost under a versioned allocation policy. | That the allocation was provider-native or objectively inevitable. |
| **Outcome evidence** | What a configured source asserted or attested about one bounded unit of work. | Causality, customer benefit, revenue, universal quality, or productivity. |

Every finance-facing number must expose: source class, provider/account scope, time period, currency, freshness, coverage, transformations, and any allocation/reconciliation policy used to produce it.

### Cost-basis labels

Use these stable labels throughout the database, API, dashboard, export, and receipts:

- `metered_estimate` - calculated from captured usage and a rate-card version.
- `tool_log_estimate` - inferred from a supported tool's local activity, not subscription billing.
- `provider_reported` - reported by a provider usage/cost API or cloud export.
- `invoice_reconciled` - reconciled against an authoritative billing period with variance explained.
- `derived_allocation` - assigned by an explicit organizational rule.
- `adjustment` - a documented correction, credit, tax, discount, or true-up.
- `unknown` - no adequate source exists; never silently substitute zero.

Outcome evidence needs its own independent labels: `user_asserted`, `local_command`, `git_observed`, `signed_ci`, `deployment_attested`, and `unknown`.

## 3. What exists today, and what is missing

Fiscus is already a credible **local AI spend-control and outcome-evidence product**. It has a local proxy and supported native imports, a SQLite request ledger, pricing freshness/estimated-cost handling, live local caps, alerts, exports, coding-work realization signals, signed CI `tested` evidence, and an early optional aggregate team-service experiment.

That is not yet an AI Financial Operations platform. The gaps below are the minimum work required before making that claim.

| Capability | Current Fiscus position | Minimum missing capability | Priority |
| --- | --- | --- | --- |
| Financial source of truth | Local price-table metering and tool-log estimates. | Authoritative provider/billing ingestion, period close, source identity, currency, credits, discounts, adjustments, and retained source lineage. | P0 |
| Reconciliation | Repricing can improve an estimate; there is no bill-to-ledger comparison. | A per-provider-account, per-period reconciliation record with coverage, variance, and reason codes. | P0 |
| Organization and identity | Local labels; optional team service has only early aggregate access. | Single-organization model, roles, OIDC group-to-role mapping, account/project/cost-center ownership, and trustworthy ingestion identity. | P0 |
| Allocation and showback | Project/user labels and value-aware budget recommendations. | Versioned direct/shared allocation rules, unallocated cost, effective dates, approval, reversal, and period showback exports. | P0 |
| Central controls | Local proxy caps protect only routed traffic. | Policy objects with scope, owner, version, exception, simulation, decision log, and an honest observed-only state for off-path usage. | P0 |
| Integration plane | Local importers, proxy, CSV/JSON, webhook, team rollups, and offline CI artifact import. | Versioned connector contract, authenticated read API, idempotent ingestion, connector health/freshness/coverage, and data-warehouse exports. | P1 |
| Forecast and planning | Historical p90/headroom and a value-aware allocation recommendation. | Forecast horizon, prediction intervals, scenario assumptions, backtesting, actual-vs-forecast history, and budget/forecast/final variance. | P1 |
| Outcome evidence breadth | Strong coding-agent foundation; signed CI v1 is intentionally `tested` only. | Protected merge, deployment, rollback/incident, and other source-specific evidence adapters, each bound to immutable work. | P1 |
| Enterprise deployment | Optional BYO Postgres/OIDC service is an unverified experiment. | Tenant boundary, authorization, real database/OIDC/TLS/recovery proof, audit retention, secret handling, and an actual team UI. | P1 |
| Procurement and commitments | No contract, PO, committed-spend, entitlement, or discount data model. | Read-only contract/rate/commitment inputs and explicit coverage of their effect on costs. | P2 |

The first platform milestone is therefore not more model routing, charts, or a generic trust center. It is a **financial-truth ledger**.

## 4. The minimum viable platform

To be an integral component of an AI financial-operations ecosystem, Fiscus minimally needs six connected capabilities:

1. **Capture:** collect near-real-time, agent-level usage and maintain its local-first edge collector.
2. **Reconcile:** ingest an authoritative provider source and retain the difference between observed usage and reported/billed cost.
3. **Attribute:** map cost to organization, provider account, product, environment, project, team, cost center, agent, workflow, and - where appropriate - customer/tenant.
4. **Govern:** record budget and routing policy decisions, including what was actually enforceable and what was merely observed.
5. **Allocate:** create transparent showback/chargeback-ready outputs through approved, versioned allocation rules.
6. **Evidence:** connect cost to delivery evidence and disclose its source strength without claiming causal business return.

Fiscus already has meaningful parts of Capture, local Govern, and Evidence. The decisive platform gaps are Reconcile, organization-grade Attribute, and financial Allocation.

### Canonical record model

Build a provider-neutral `FinancialUsageRecord` around FOCUS-compatible concepts where possible. Do not claim FOCUS conformance until actual exported datasets are mapped and validated.

```text
record_id
source_system + immutable_source_id + source_kind
observed_at + charge_period_start + charge_period_end + collected_at
provider + billing_account + project/workspace + service + SKU + model + region
usage dimensions (input/output/cache/reasoning tokens, requests, capacity units)
currency + amount + cost_basis + pricing_reference + pricing_version
credits + discounts + taxes + adjustments + commitment context
allocation dimensions (product, environment, cost center, team, agent, workflow, tenant)
allocation_rule_id + allocation_method + allocation_ratio + effective period
reconciliation_status + reconciliation_delta + variance_reason
outcome_evidence_refs + evidence_provenance
freshness + completeness + raw_evidence_digest + connector_policy_digest
```

Original provider records are immutable. Reconciliation, allocation, and correction create linked, versioned derived records; they never overwrite the original charge.

### Reference architecture

```text
AI tools / coding agents ----> local Fiscus collector and proxy ----> provider
                                   |\
                                   | \---- metered-usage evidence (fast, local)
                                   |
Provider cost APIs / exports --> read-only customer-run connectors
                                   |
                                   +---- provider billing evidence (authoritative, lagged)

Git / CI / deployment sources --> bounded outcome-evidence adapters
                                   |
                                   v
                  provenance-preserving financial evidence ledger
                                   |
                  reconciliation + allocation + policy decision engine
                                   |
             local dashboard / central API / warehouse or ERP-ready export
```

The local collector retains detailed code-agent context. A central deployment should receive only the customer-approved financial rollups, source lineage, and outcome metadata needed for its scope. Raw prompts, source code, provider credentials, and full provider responses are not platform defaults.

## 5. Build sequence

### Stage 0 - Harden the truthful coding-agent wedge

**Result:** Fiscus can be safely described as a local-first evidence-led accounting layer for AI coding-agent consumption.

- Finish local release truth: package, browser, provider-metric, and documentation validation.
- Keep every current number labelled as metered estimate, tool-log estimate, or source-specific evidence.
- Enforce immutable commit binding for strict lifecycle gates; retain manual/local results as visible but weaker evidence.
- Publish a provider/feature capability matrix that distinguishes proxy enforcement, imported observation, and unobserved usage.

**Exit evidence:** controlled provider runs reconcile request counts/tokens to the documented provider surface at the supported grain; unobserved and unknown-pricing cases are visible; no marketing copy calls local metering invoice-accurate.

### Stage 1 - Financial-truth foundation (first platform build)

**Result:** one organization can compare Fiscus observations with one authoritative provider cost source.

**Current increment (local v1):** Fiscus has a strict operator-supplied OpenAI
billing-evidence import with immutable normalized provider-declared charge
records, source-file digest, account reference, period, coverage declaration,
and separate CSV/JSON export. It is intentionally `not_reconciled`: no verified
provider-account mapping exists on request rows yet, and no provider credential,
raw-provider parser, or claimed variance has been introduced. See
[BILLING-EVIDENCE-IMPORT.md](BILLING-EVIDENCE-IMPORT.md).

**Current authenticated observation increment (local v1):** Fiscus also has a
fixture-verified, explicitly invoked read-only OpenAI Organization Costs
collector. It accepts only an active local declaration for exactly
`https://api.openai.com` with a `proj_...` project reference; a preview never
reads credentials or contacts a network, while `pull --apply` permits only the
fixed Costs `GET`. It records immutable success/failure runs and normalized
daily project/line-item/currency observations with page digest chains, never an
Admin key or raw response. This proves neither provider account ownership nor
reconciliation, provider finality, invoice close, request-level cost, variance,
allocation, or a budget/recommendation action. A later changed provider day is
a new snapshot, not a silent overwrite or additive total.

1. Introduce the cost-source taxonomy and immutable financial ledger entities.
2. Ship one read-only authoritative connector first. Start with OpenAI organization cost/usage, or a customer-owned cloud billing export selected with a design partner; do not build five shallow connectors at once.
3. Store account/project scope, source cursor or export ID, collection time, source update time, raw-evidence digest, pagination state, and connector version.
4. Add a reconciliation run per provider account and billing period:

   ```text
   provider-reported or invoiced total
   - Fiscus metered total for the same defined scope
   - documented adjustments
   = visible unexplained variance
   ```

5. Add coverage reporting: observed, unobserved, late, estimated, reconciled, duplicate, and unresolved records.

**Exit evidence:** a controlled account validates streaming, cache/reasoning tokens, retries/errors, model aliases, billing lag, and duplicate import. The product shows a variance with a reason rather than force-fitting numbers to agree.

### Stage 2 - Organization, allocation, and policy

**Result:** finance, engineering, and platform owners can use the same cost record without treating client labels as accounting truth.

- Start with **one organization per deployment**, not multi-tenant SaaS.
- Model organization, member, team, project, provider account, cost center, environment, owner, and policy scope.
- Connect OIDC identity and group membership to at least `admin`, `finance_budget_owner`, `developer`, and `auditor` roles.
- Register collectors/connectors to a verified service or developer identity. Client-supplied headers remain useful metadata, but are not trusted alone for chargeback.
- Build direct allocation, fixed split, proportional split, shared-cost pool, and unallocated fallback policies. Each needs owner, effective date, version, approval, source coverage, and reversal history.
- Produce closed-period showback reports by cost center/project/team/provider/model. A proposed budget reallocation stays separate from accounting allocation.
- Add policy objects for scoped thresholds, allowed providers/models, per-session limits, exceptions, simulation, approvals, rollback, and decision/audit events.

**Exit evidence:** allocation ratios validate to 100%; the original charge remains recoverable; an unauthorized user cannot see or change another scope; and off-path/imported spend is labelled observed-only rather than centrally enforced.

### Stage 3 - Operational platform and ecosystem interface

**Result:** Fiscus becomes a dependable source for an existing FinOps, data, or finance stack.

- Publish a versioned ingestion contract and a stable financial export schema.
- Add authenticated, read-only API endpoints plus warehouse/BI exports. ERP posting is an export/integration concern, not an accounting-system replacement.
- Track connector health: scope, permissions, last successful sync, source freshness, partial pages, error state, coverage gaps, and idempotency behavior.
- Add provider connectors one at a time using an explicit capability matrix: granularity, expected lag, cost basis, dimensions, enforcement possibility, and known blind spots.
- Add source-specific outcome adapters: protected merge, deployment, rollback/incident, and selected product metrics only where their attribution contract is clear.

**Exit evidence:** data can be replayed from retained source references/digests, exported without losing provenance, and consumed by an external BI/FinOps workflow without changing its cost basis.

### Stage 4 - Forecast, commitments, and approval-gated actions

**Result:** Fiscus can support planning decisions without automating financial decisions.

- Forecast daily/weekly/monthly spend by provider account, project, and model; include cold-start status, prediction interval, model/version, assumptions, and out-of-sample error.
- Compare budget, forecast, run rate, provider-reported cost, and finalized/reconciled cost.
- Add contract, rate-card, commitment, credit, and discount metadata only as permissioned read-only inputs with clear coverage rules.
- Introduce write adapters only after the read plane is proven. Every action requires distinct write credentials, a human approval, target/version preconditions, dry-run, idempotency, provider readback, audit trail, expiry, and rollback.

**Exit evidence:** forecasts are backtested; a finance user can see why a variance occurred; and a tested write action remains a proposed/approved operational action, never an autonomous financial decision.

## 6. Connector and trust design rules

### Read-only by default

Provider billing credentials can expose organization structure, usage, and other sensitive data. The first connector pattern is:

```text
customer provider or cloud account
  -> customer-run least-privilege reader/export
  -> normalized Cost Evidence Record
  -> Fiscus evidence ledger (local or customer-hosted)
```

Do not make a personal laptop the default destination for organization-admin billing keys. Prefer a customer-run connector or a dedicated read-only service environment, with raw evidence held in the customer's chosen store unless explicit retention is approved.

Each connector must be read-only and log its scope, capability set, source query/export period, cursor, result count, raw-evidence digest, connector/policy version, operator identity, freshness, and partial/failure state. It must never log credentials, prompt content, source code, or raw provider responses by default.

### Provider-specific reality matters

- Provider billing sources can be daily or lagged, while a proxy is near-real-time.
- Provider bills may include token categories, service tiers, regional routing, commitments, credits, taxes, discounts, and line items that a local request record cannot see.
- Billing exports often aggregate at a grain different from per-request telemetry. Reconciliation must join only at a compatible grain and state residual variance.
- Tags and labels are allocation metadata, not confidential data or verified identity. The platform should enforce metadata taxonomy in the collector/gateway where a provider cannot require it.

### Financial controls are not claims of universal enforcement

Fiscus should show whether a policy is:

- `enforced_in_path` - actively applied to traffic routed through Fiscus;
- `provider_native` - enforced by a configured provider/platform control;
- `observed_only` - detected after the fact through logs/imports/exports;
- `proposed` - recommendation awaiting human approval;
- `unknown` - enforcement cannot be established.

## 7. Explicit non-goals

The following are deliberately out of scope, including for later platform stages:

- Personal finance, tax, lending, investment, insurance, payroll, accounting advice, payments, custody, or credit decisions.
- An autonomous AI CFO that moves money, reallocates budgets, changes cloud accounts, blocks teams, or chooses vendors from inferred ROI.
- A generic compliance/GRC clone, a certification claim, or an audit-readiness promise without a separately validated program.
- Hidden traffic interception, TLS MITM, unconsented prompt collection, or a Fiscus-operated warehouse of customer code/prompts.
- Employee surveillance, rankings, compensation decisions, or performance management based on AI use/value metrics.
- A universal productivity or business-value number. Outcome evidence is decision support with explicit uncertainty, not causal proof.

## 8. Product positioning and success criteria

### Recommended position now

**Fiscus for Coding-Agent Financial Truth**

> The local-first AI FinOps ledger for coding agents: what they cost, which evidence exists that the work survived, and what to fund next.

This preserves the strongest current product truth while the platform builds the financial source-of-record capabilities needed for a wider enterprise claim.

### Position once Stages 1 and 2 are proven

**Fiscus AI Financial Operations Control Plane**

> Reconcile, allocate, govern, and evaluate AI spend across providers and workloads, with every claim tied to its cost basis and evidence source.

Do not use that broader position before actual provider reconciliation, allocation coverage, policy auditability, and organizational authorization have passed their gates.

### Platform-release gates

1. **Source truth:** every amount identifies source, scope, period, currency, freshness, coverage, and transformation lineage.
2. **Connector safety:** first provider connector is least-privilege/read-only, idempotent, and tested for stale/partial/wrong-scope data without leaking credentials.
3. **Reconciliation:** provider snapshots and local metering can be compared reproducibly; unexplainable variance stays visible.
4. **Allocation:** all derived allocations point to immutable source charges; policies are versioned, effective-dated, reversible, and preserve unallocated cost.
5. **Governance:** authorization, policy simulation, audit events, exception handling, and enforceability status are tested.
6. **Evidence:** outcome signals stay bounded to their source and immutable unit; `unknown` remains unknown.
7. **Enterprise delivery:** production team deployment is blocked until database, identity, authorization, TLS, backup/restore, retention, and isolation are verified on real infrastructure.
8. **Customer evidence:** no claim of market fit, billing accuracy, savings, or ROI until it is validated in permissioned design-partner use with documented coverage and error rates.

## 9. Standards and provider sources

This roadmap uses the following sources as architecture constraints, not as borrowed marketing claims:

- [FinOps Foundation: FinOps for AI](https://www.finops.org/framework/technology-categories/ai/) - AI spend needs more granular allocation, shorter forecast cycles, governance, and value alignment.
- [FinOps Foundation: Allocation](https://www.finops.org/framework/capabilities/allocation/) - allocation, shared-cost strategy, and allocation-compliance are central to accountability and showback/chargeback.
- [FinOps Foundation: Invoicing and Chargeback](https://www.finops.org/framework/capabilities/invoicing-chargeback/) - financial operations require reconciliation and close-oriented capability, not only estimates.
- [FOCUS Specification v1.3](https://focus.finops.org/focus-specification/v1-3/) - the directional open cost/usage model for interoperable financial data.
- [AWS Bedrock CUR data](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-understanding-cur-data.html) and [cost-attribution FAQ](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-faq.html) - billing aggregates, request-level logs, token types, and their different reconciliation grains.
- [Microsoft Foundry cost management](https://learn.microsoft.com/en-us/azure/foundry/concepts/manage-costs) - estimates, Cost Management, tag limitations, and provider-native budget behavior are distinct.
- [Google Cloud Billing export](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup) - detailed usage, price, commitment, and FOCUS-oriented export are provider-owned financial sources.
- [OpenAI project management and budgets](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform) - project-level access, usage, and budget behavior are separate provider controls.

## 10. The decision

The autonomous product decision is to **keep the current coding-agent FinOps and evidence core, then build financial truth before breadth**.

Fiscus should not chase a vague AI-finance platform or imitate Vanta. It should become the system that can answer, with evidence and caveats: *what did this AI work cost, which financial source supports that amount, who owns it, which policy applied, what remains unallocated or unreconciled, and what outcome evidence exists?*
