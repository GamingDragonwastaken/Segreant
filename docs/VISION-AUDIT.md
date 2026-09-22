# Vision Audit

**Date:** 2026-08-17. **Audited tree:** `main`, working tree clean at the time
of writing.

> **Update, 2026-08-18 — §6 was acted on, and §3 has since been built.**
> The owner chose to unblock the provider lane rather than re-rank the roadmap.
> Reconciliation landed at project-day grain
> ([PROVIDER-RECONCILIATION.md](PROVIDER-RECONCILIATION.md)), and cost-centre
> allocation landed after it ([ALLOCATION.md](ALLOCATION.md)) — on the owner's
> direction, ahead of the sequencing this audit recommended. See §3 for what that
> changed and what it did not. Sections 2, 4 and 6 are annotated; the rest stands
> as written.

This document applies the product's own rule to the product's own plans: an
important claim should be inspectable through evidence. PRODUCT.md and
[AI-FINANCIAL-OPERATIONS-ROADMAP.md](AI-FINANCIAL-OPERATIONS-ROADMAP.md) say
what Fiscus is meant to be. This historical audit says what it was at the
audited revision, clause by clause, with a file to check for each answer and
where each missing piece belonged. For the live capability/evidence contract,
use [CAPABILITY-EVIDENCE-CONTRACT.md](CAPABILITY-EVIDENCE-CONTRACT.md).

It is an audit, not a plan. It does not schedule anything, and it does not
authorize anything — several gaps below are blocked on an owner decision rather
than on engineering, and are marked that way.

---

## 1. The vision being audited against

Four sources describe it, and they agree:

- **The owner's standing brief:** a local-first financial control,
  cost-accounting, evidence-of-value, and eventually broader *AI Financial
  Operations* layer for AI usage, currently strongest around AI coding agents.
  Explicitly **not** AI financial advice, not software for performing financial
  services with AI, not a Vanta clone, not a governance/GRC product. The Vanta
  lesson is only *make important claims inspectable through evidence*.
- **[PRODUCT.md](../PRODUCT.md):** the four questions Fiscus answers (what did
  it cost, can it be stopped, did the work become durable software, and what is
  too weakly instrumented to support a decision).
- **[AI-FINANCIAL-OPERATIONS-ROADMAP.md](AI-FINANCIAL-OPERATIONS-ROADMAP.md):**
  the six-capability platform (Capture, Reconcile, Attribute, Govern, Allocate,
  Evidence) and the staged build order.
- **[THE-STANDARD.md](THE-STANDARD.md):** the Realization Standard, the unit of
  account for AI-assisted work.

The load-bearing sentence, from which everything else follows:

```text
metered usage != provider-billed cost != allocated cost != realized business value
```

The rest of this audit is organized around it, because the four layers are the
only claim in the vision that the code either honours or does not.

---

## 2. The truth chain, layer by layer

| Layer | State | Evidence |
| --- | --- | --- |
| **Metered usage** | **Built, and the strongest part of the product.** Exact per-request capture through the proxy, read-only import for subscription tools, full pricing lineage per row (card SHA-256, source kind, match kind, matched provider/model), and a reprice audit trail that never rewrites history. | `src/proxy/server.ts`, `src/connect/*.ts`, `src/cost/pricing.ts`, `requests` + `request_price_events` in `src/store/db.ts` |
| **Provider-billed cost** | **Partially built, and correctly refusing to overstate itself.** Operator-supplied billing evidence import produces immutable provider-declared charge records with currency, charge period, charge type, and a source digest. A read-only OpenAI Costs collector records immutable daily observations, and (since 2026-08-18) a reconciliation run compares one against the local ledger at project-day grain. The operator-supplied import path is still hard-labelled `not_reconciled`; the connector path is `reconciled_with_residual`. | `src/billing/importer.ts`, `src/billing/openaiCosts.ts`, `src/billing/reconcile.ts`, `billing_evidence_records` in `src/store/db.ts` |
| **Allocated cost** | **Built 2026-08-18.** Versioned, effective-dated, reversible rules over cost centres; three methods; unallocated as a first-class position; conservation enforced to the microdollar; every line carrying the cost basis it allocated. Showback only. | `src/alloc/rules.ts`, `src/alloc/apply.ts`, `cost_centres` + `allocation_rules` + `allocation_runs` in `src/store/db.ts` |
| **Realized business value** | **Built, and by volume the most developed subsystem in the repository.** The eight-gate ladder, funnel scoring, four value lenses, anytime-valid confidence sequences, bounded lift with METR discounting, value-of-information ranking, signed receipts. | `src/value/` (20 modules, ~4,760 lines) |

**The join between layers 1 and 2 now exists** (`src/billing/reconcile.ts`, added
2026-08-18). The original audit found it deliberately blocked, with five named
blockers on `openaiCostsCoverage.ts`. Three of those turned out to be blockers to
a *per-request* reconciliation rather than to reconciliation as such: line items
never join to models, local amounts are rate-card estimates (which is the
*subject* of the comparison), and single-snapshot finality is unknowable — all
three are answered by comparing project-day totals and recording whether
independent snapshots agree. Two survive as permanent conditions on every result,
carried on the record rather than resolved. The coverage surface remains as it
was; it answers a different question and is still correct to refuse.

**The join between layers 3 and 4 still does not exist**, and that is now a
deliberate position rather than an absence. Value is measured against the project
label a request carried; allocation assigns cost to a cost centre. Joining them
would produce RoI *per cost centre*, which sounds useful and is the exact shape
of the generic RoI-driven reallocation this product already refused once, on the
grounds that unlike work is not comparable. Nothing should join these two until
there is a reason better than that they are adjacent.

---

## 3. Allocation — was the missing layer, built 2026-08-18

> **Built on the owner's direction, ahead of the sequencing recommended below.**
> The section is left standing rather than rewritten, because the gate it argued
> for is the honest record of what was and was not known when the layer shipped.
> What was built, and what the gate became, is at the end of this section.


The vision names allocation as P0 in five separate places — the truth chain, the
capability table, the six-capability minimum, Stage 2, and platform-release gate
4. In the code there is no allocation record, no cost centre, no owner, no rule
version, no effective date, no reversal, and no unallocated bucket in the
accounting sense.

What exists and is easy to mistake for it:

- `src/budget/allocate.ts` is a **research helper**, self-labelled
  `exploratory_raw`, deliberately withheld from every product surface. It is a
  methodology artifact, not an allocation engine, and the decision to keep it
  off the product surface was correct.
- `project_aliases` merges fragmented labels at query time. That is label
  hygiene, not allocation — it cannot express "40% of this shared cost belongs
  to the platform cost centre".
- The `default` bucket holds spend that declared no project. That is
  *unattributed*, which is an instrumentation gap. *Unallocated* is an
  accounting position. They are different things and the product currently has
  only the first.

**Where it should live.** A new `src/alloc/` module plus a `cost_allocations`
table in `src/store/db.ts`, written as derived, versioned, reversible records
that reference immutable `requests` rows and never overwrite them. The store
already has this exact idiom twice — `request_price_events` for repricing and
`realization_units.cost_scope` for re-attribution — so allocation should be
built as a third instance of a pattern the codebase already knows, not as a new
one. The vocabulary (`allocation_method`, `allocation_ratio`, effective period)
belongs in `src/value/characterization.ts`, which is already the single home for
axis vocabulary and exists precisely to stop a definition drifting across four
call sites.

**The gate this section argued for.** Allocation without a reconciled source
allocates an estimate, which is a more expensive way to be wrong: allocating
across a variance nobody has yet seen spreads an unexamined error over a cost
centre and gives it a decimal point.

### What shipped, and what the gate became

The layer was built before that gate was met — no reconciliation has yet run
against real provider data. The concern was addressed **structurally instead of
by sequencing**, which is a weaker guarantee and worth naming as such:

- **The basis travels with the money.** Every allocation line carries the
  `cost_basis` of the rows beneath it, the run reports its distinct bases, and
  the whole result self-labels `derived_allocation_of_local_estimates`. A
  showback figure therefore cannot forget what it is made of, and the CLI says
  outright that none of these is a provider-reported or reconciled amount.
- **Unallocated is a first-class output** with a reason and its largest project
  labels, so the coverage gap is visible rather than swept into a fallback.
- **Conservation is enforced, not asserted** — `allocated + unallocated ==
  ledger total` to the microdollar, checked on every run, and the store refuses
  to record a run where it is false.
- **Allocation is excluded from budgets, RoI, and recommendations**, so an
  estimate allocated today cannot quietly become a control tomorrow.

**What this does not fix:** the residual is still unexamined. If the provider
reports materially more than Fiscus metered for a period, every cost centre's
figure for that period is understated by an unknown share, and nothing in the
allocation layer can detect that. The basis label tells a reader the number is an
estimate; it does not tell them how wrong it is. **Reconcile before charging
anyone against these figures** — that instruction is now in the CLI output, the
README, and `ALLOCATION.md`, which is the best a structural fix can do.

The audit's placement advice held: `src/alloc/` as a third instance of the
store's derived-record idiom, with the run refusing rather than rounding. One
deviation — the vocabulary stayed in `src/alloc/rules.ts` rather than moving to
`characterization.ts`, because allocation vocabulary is not a spend *axis*: it
describes a policy over axes, and merging the two would have made
`characterization.ts` mean two things.

---

## 4. The six capabilities

| Capability | State | Where the remainder belongs |
| --- | --- | --- |
| **Capture** | Complete for the stated wedge. Proxy metering, three importers, repo-resolved attribution, path-prefix declaration for header-less clients. | — |
| **Reconcile** | **Built** as of 2026-08-18, at project-day grain, `reconciled_with_residual`. Running one still needs a credential the owner supplies. | Nothing further to build for v1. Discharging `local_route_scope_is_not_provider_verified` would need the proxy's key identity bound to the project through the Admin API — a broader credential scope, and a deliberate non-decision. |
| **Attribute** | Complete at *project* grain, absent at *organization* grain. Five attribution bases with recorded provenance; no cost centre, team, environment, or tenant. | Organization grain belongs in `team-server/`, behind the T-006 infrastructure gate. Project grain is done. |
| **Govern** | Half-built, and the half that is missing is a **name**, not a mechanism. Caps are enforced for proxy traffic and cannot be enforced for imported traffic; `viaClause` in `src/store/db.ts` already makes exactly that distinction. But the roadmap's enforceability vocabulary (`enforced_in_path`, `provider_native`, `observed_only`, `proposed`, `unknown`) appears nowhere in the source. | The status belongs on the budget result in `src/budget/guard.ts`, with the vocabulary in `src/value/characterization.ts`. This is a small, high-value change: the distinction is already *made*, it simply cannot be *shown*. |
| **Allocate** | **Built 2026-08-18** — showback only, on local estimates, with the basis attached. See §3. | Approval workflow, closed-period locking, and a dashboard surface are deliberately deferred; see ALLOCATION.md §7. |
| **Evidence** | The strongest capability, and ahead of the roadmap's description of it. | Breadth gaps below. |

---

## 5. Vocabulary drift between the roadmap and the code

Three vocabularies were specified in the roadmap and then implemented
differently, or not at all. Each is a small fix, and each is the kind of drift
that quietly turns a document into fiction.

**Cost basis.** The roadmap (§2) names `metered_estimate`, `tool_log_estimate`,
`provider_reported`, `invoice_reconciled`, `derived_allocation`, `adjustment`,
`unknown`. The shipped union in `src/cost/pricing.ts` is `local_list_price`,
`fallback_estimate`, `tool_reported_unverified`, `synthetic_demo`, `unpriced`,
`legacy_unknown` — with `provider_reported` living separately on billing records.
The code's labels are the more precise of the two (they distinguish an exact
list-price match from a family fallback, and a tool's own number from a
calculated one), and they are in migrated databases. **Fix the roadmap, not the
code**, and state the mapping. The doc is free to change; the column is not.

**Evidence source.** The roadmap names six labels; `GateSignalRow.evidenceSource`
in `src/store/db.ts` has three (`manual`, `local-command`, `signed-ci`).
`deployment_attested` is genuinely unbuilt. `git_observed` is the interesting
one: git *is* observed — `committed`, `survived`, and `clean` are derived from it,
and `GATE_META` in `src/value/gates.ts` already records `source: 'git'` per gate
— but no git-derived signal row is ever written, so per-signal provenance cannot
distinguish a git observation from an operator's assertion. **Where:** the union
in `src/store/db.ts` and a writer in `src/git/correlate.ts`.

**Enforceability status.** Specified in roadmap §6, implemented nowhere. See
§4, Govern.

---

## 6. The finding that matters most

Weigh the engineering by volume: `src/value/` is 20 modules and ~4,760 lines;
`src/billing/` is 5 modules and ~940; `src/budget/` is 3 and ~460. The roadmap
ranks financial truth, reconciliation, organization identity, allocation, and
central controls as **P0**, and outcome-evidence breadth as **P1**. The built
product is the inverse of its own stated priority order.

This is not carelessness, and the audit should say why: **the P0 work is
externally blocked and the P1 work is not.** Reconciliation has been blocked
since T-015 on an authorized provider export or a least-privilege credential —
an owner action. Organization identity is blocked on real Postgres, OIDC, and
TLS (T-006). Faced with two blocked P0 lanes, the work went where evidence
could still be produced, which is the correct instinct.

But it has now run for long enough that it is a de facto strategy. The honest
options are two, and it is an owner decision which:

1. **Unblock the P0 lane.** Provide a read-only provider credential or an
   exported billing period, and reconciliation becomes buildable. Everything in
   §3 unblocks behind it.
2. **Re-rank the roadmap to match reality** — declare the Realization Standard
   the product, and financial-operations breadth a later expansion rather than
   the next stage.

What should *not* happen is the third thing, which is drifting further while the
roadmap continues to assert an order the work is not following. That would make
the roadmap exactly the kind of uninspectable claim the product exists to
oppose.

### Resolved, 2026-08-18: option 1

The owner chose to unblock the lane. `src/billing/` is now 6 modules and ~1,285
lines, and the reconciliation itself is built and tested — including against the
case where no credential exists, which is most of them.

Worth recording precisely, because the audit was partly wrong about the shape of
the blocker: **most of what looked like an authorization problem was a grain
problem.** Three of the five recorded blockers dissolved once the comparison was
made at project-day totals instead of per-request, and none of those three needed
a credential. What genuinely requires an owner is *running* a reconciliation — a
provider snapshot needs a least-privilege Admin key — not *building* one. The
engine, its refusals, and its conditions were all buildable and testable without
one, and now are.

The lesson generalizes: "blocked on the owner" deserves the same scrutiny as any
other claim in this repository. Part of it was true and part of it was an
untested assumption that had been carried forward for several sessions.

---

## 7. Where the vision is already met, and should stop being treated as pending

Recorded so that finished work stops appearing in gap lists:

- **Stage 0 of the roadmap is complete.** Package, browser, provider-metric and
  documentation validation all have commit-bound records in
  [RELEASE-GATE.md](RELEASE-GATE.md); every number is labelled with its basis;
  strict lifecycle gates are commit-bound; the capability matrix distinguishes
  proxy enforcement from imported observation.
- **"Unknown stays unknown"** is honoured throughout, and is enforced rather
  than intended: `Verdict` has a first-class `unknown`, no provenance column is
  ever backfilled, and `legacy_unknown` rows are never guessed at.
- **The privacy and local-first constraints hold.** The dashboard is loopback-
  bound with a Host allowlist against DNS rebinding (`src/dashboard/server.ts`),
  price refresh is off by default, no credential is logged, and the Costs
  connector reads no credential and touches no network during a preview.
- **Individual-level value is opt-in with a k-anonymity floor**
  (`src/value/cohort.ts`), which discharges the "no developer ranking product"
  non-goal in code rather than in prose.

---

## 8. Smaller gaps, with their homes

| Gap | Where | Note |
| --- | --- | --- |
| Currency is single-valued end to end | `requests.cost_usd` and the billing record type in `src/store/db.ts` | Two different single-valuings: the metered ledger bakes USD into the *column name*, while the billing evidence schema has a real `currency TEXT` column whose TypeScript type is pinned to the `'USD'` literal. The rate card asserts `"currency": "USD"` and nothing checks it against either. Fine today; a silent mislabel the first time a non-USD source appears |
| Forecast has no prediction interval, no backtest, no actual-vs-forecast history | `src/budget/recommend.ts` | The p90/headroom basis is already computed there; this is an addition, not a rewrite |
| Signed CI evidence is `tested`-only by explicit refusal | `src/githubActionsEvidence.ts` (kind union), `src/value/gates.ts` | Merge, deployment, and rollback adapters are named P1 in the roadmap |
| No versioned connector contract or authenticated read API | `src/connect/connectors.ts`, `src/dashboard/server.ts` | Stage 3; premature while there is one deployment and no external consumer |
| Demo does not exercise billing or reconciliation | `src/demo/seed.ts` | **Deliberate, and should stay that way.** The demo depicts routes it could genuinely have taken; fabricating provider billing evidence is the one demo lie that would matter |

---

## 9. What this audit did not check

- **Calibration.** Whether the RoI Index, the lift bounds, or the realization
  rate correspond to anything real is unvalidated and requires design-partner
  data. Nothing here tests it.
- **The team server.** Audited only as "exists, typechecks, 55/55 tests,
  unverified against real infrastructure". Its authorization model was not
  reviewed line by line.
- **The judge subsystem** (`src/judge/`), which spends API tokens and was not
  exercised.
- **Market demand.** Out of scope for a source audit, and still a hypothesis.
