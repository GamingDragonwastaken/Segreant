# Vision Audit

**Date:** 2026-08-17. **Audited tree:** `main`, working tree clean at the time
of writing.

This document applies the product's own rule to the product's own plans: an
important claim should be inspectable through evidence. `PRODUCT_BRIEF.md` and
[AI-FINANCIAL-OPERATIONS-ROADMAP.md](AI-FINANCIAL-OPERATIONS-ROADMAP.md) say
what Fiscus is meant to be. This says what it currently **is**, clause by
clause, with a file to check for each answer, and where each missing piece
belongs if it gets built.

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
- **`PRODUCT_BRIEF.md`:** the four questions Fiscus answers (what did it cost,
  can it be stopped, did the work become durable software, and what is too
  weakly instrumented to support a decision).
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
| **Provider-billed cost** | **Partially built, and correctly refusing to overstate itself.** Operator-supplied billing evidence import produces immutable provider-declared charge records with currency, charge period, charge type, and a source digest. A read-only OpenAI Costs collector records immutable daily observations. Both are hard-labelled `not_reconciled`. | `src/billing/importer.ts`, `src/billing/openaiCosts.ts`, `billing_evidence_records` in `src/store/db.ts` |
| **Allocated cost** | **Absent as a layer.** This is the largest structural gap in the product. See §3. | — |
| **Realized business value** | **Built, and by volume the most developed subsystem in the repository.** The eight-gate ladder, funnel scoring, four value lenses, anytime-valid confidence sequences, bounded lift with METR discounting, value-of-information ranking, signed receipts. | `src/value/` (20 modules, ~4,760 lines) |

**The join between layers 1 and 2 exists and is deliberately blocked, not
missing.** `src/billing/openaiCostsCoverage.ts` partitions every local ledger
row in a provider snapshot period into the declared route and four disjoint
exclusion buckets, then returns `comparisonStatus: 'blocked_not_reconciled'`
and `varianceStatus: 'not_calculated'` with three named blockers. That is the
right behaviour: the mapping is operator-declared, off-path usage is not
observable, and provider finality is undocumented. Nothing here should be
"fixed" by calculating a number.

**The join between layers 3 and 4 does not exist, because layer 3 does not.**
Value is currently attributed to the same label the *request* carried, which
means Fiscus can say what a project's AI work cost and whether it survived, but
not what an organization decided that cost belongs to.

---

## 3. The missing layer: allocation

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

**Do not build this yet without deciding §6 first.** Allocation without a
reconciled source allocates an estimate, which is a more expensive way to be
wrong.

---

## 4. The six capabilities

| Capability | State | Where the remainder belongs |
| --- | --- | --- |
| **Capture** | Complete for the stated wedge. Proxy metering, three importers, repo-resolved attribution, path-prefix declaration for header-less clients. | — |
| **Reconcile** | Structurally ready, blocked on owner authorization (T-015), not on code. | Nothing to build. An authorized export or least-privilege credential is an owner action. |
| **Attribute** | Complete at *project* grain, absent at *organization* grain. Five attribution bases with recorded provenance; no cost centre, team, environment, or tenant. | Organization grain belongs in `team-server/`, behind the T-006 infrastructure gate. Project grain is done. |
| **Govern** | Half-built, and the half that is missing is a **name**, not a mechanism. Caps are enforced for proxy traffic and cannot be enforced for imported traffic; `viaClause` in `src/store/db.ts` already makes exactly that distinction. But the roadmap's enforceability vocabulary (`enforced_in_path`, `provider_native`, `observed_only`, `proposed`, `unknown`) appears nowhere in the source. | The status belongs on the budget result in `src/budget/guard.ts`, with the vocabulary in `src/value/characterization.ts`. This is a small, high-value change: the distinction is already *made*, it simply cannot be *shown*. |
| **Allocate** | Absent. See §3. | `src/alloc/` (new) + `src/store/db.ts`. |
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
