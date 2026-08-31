# value — Return on Intelligence, measured with stated limits

<!-- Layer 2 contract. 20 modules, ~4,800 lines: the largest and most claim-sensitive area. -->

## Consumes

- `src/store/db.ts` for work units, realization snapshots, and proposals.
- `src/git/` for commit attribution and changed-line volume.
- Recorded pricing basis and rate-card lineage — a comparison across mixed bases
  is capped, not computed anyway.

## Guarantees

- Confidence is a label with a precondition, not a vibe: `trial` is the ceiling
  unless the anytime-valid separation survives one flipped outcome on each side.
- Named `confounders` (unit-size gap, non-overlapping periods, session
  clustering, mixed pricing bases, spanned card revision) **cap** the result
  regardless of the statistics, and are surfaced in the CLI and the GUI.
- Multiple comparisons are Bonferroni-split across eligible model **pairs**, with
  the applied level and count on the payload.
- Snapshots predating a pricing basis keep their amounts, are marked stale, and
  are reported as excluded rather than silently repriced.
- Every surface that reports value composes it through `report.ts`
  (`valueSpine` / `usageValue` / `budgetAdvice` / `valueReport`). The primitives
  are shared; so is the SEQUENCE that assembles them, so the CLI and
  `/api/value` cannot drift apart by hand-editing one of them.
- Coding attribution now carries an additive exact seam: each WorkUnit can
  retain JSON-safe effective Money/source-event coverage from the Store read
  model, and mature rollups disclose `exact`, `partial`, or `legacy_unknown`
  coverage separately from the legacy numeric compatibility fields. A price
  correction updates this lineage transactionally; it never changes funnel
  outcomes. Usage, cohort and budget advice now consume the same grouped exact
  read model, and frontier/time-reclaimed projections plus the modern Value view
  carry its coverage disclosures. Signed receipts and team rollups remain
  explicit follow-on migrations until their public compatibility boundaries are
  versioned.

- Complete exact-covered WorkUnits can emit signed receipt v2 bodies carrying
  canonical effective Money/source/correction lineage; incomplete or oversized
  numeric projections stay on receipt v1. A valid signature proves integrity of
  the signed bytes, not provider authority, causal truth, or completeness beyond
  the v2 semantic checks.

- Exact-covered project values can travel through signed team-rollup v2 bodies
  carrying the same canonical effective/source lineage. The team server keeps
  v1 numeric columns for compatibility, stores the signed body and an additive
  `economic_json` project read model, and validates v2 semantics before insert.
  This is a transport/read-model migration, not provider attestation or causal
  proof; live Postgres execution and trust-anchor governance remain external.

- The classic Value renderer now carries the same exact/partial/legacy coverage
  disclosure as the modern view for mature, usage, budget, project and team
  sections. Missing or malformed economic objects render as `legacy_unknown`;
  the browser contract types project lineage explicitly. This closes only the
  bounded Value parity gap, not the universal generated dashboard/schema drift.

- Pricing-card lineage is now preserved separately from the mutable active-cache
  pointer: each newly accepted card has a hash-addressed immutable sidecar with
  source/acceptance metadata, and historical cohorts expose it only when the
  card and sidecar validate together. Pre-sidecar or tampered history remains
  unavailable; a local rate card is never provider-billed evidence.

- The canonical realization persistence path automatically crosses the Trusted
  Epistemic Kernel. It preflights and atomically persists one idempotent
  `value.realization_recorded` Evidence/Claim per mature, current, fully realized
  unit with complete exact effective request coverage, re-derived from the Store
  ledger on the same project/window basis. Partial, maturing, stale,
  synthetic-demo and legacy snapshots remain outside the kernel. The claim is a
  provisional local lifecycle/showback statement, never causal effect, business
  value, provider billing or settlement; window-scoped spend is explicitly
  project-blind.

- The coding `clean` gate is open-world: a mature unit with no observed revert or
  incident is still `unknown` unless supported `CompletenessWitness` records cover
  both `commit_reverted` and `linked_incident` for the commit scope and the full
  observation interval. Direct revert/incident evidence remains `fail` regardless
  of witness coverage. The completeness metadata travels with the WorkUnit and is
  revalidated before a kernel Evidence/Claim is issued; an asserted `qualified`
  flag or witness identity cannot substitute for the canonical coverage check.

- Proposal extraction is intrinsically bounded: tool arguments, fenced-code
  text, file count, line count, fragment count and aggregate retained bytes use
  the shared resource policy. A `truncated` extraction returns no files and
  cannot feed the acceptance gate; storage preserves the coverage state.

## Invariants

- **`realizedValueUsd` is two different claims and they never merge.**
  `realization.matured.realizedValueUsd` is attributed SPEND on units that
  realized (a cost); `roi.returnRatio.realizedValueUsd` is manual-equivalent
  VALUE produced. Different evidence, different question — never renamed into
  each other, never derived from each other.
- **A gate on the label is not a fix to the estimator.** Never correct for
  clustering inside the interval math and then claim the guarantee still holds.
- **Withhold or disclose; never strengthen.** If evidence does not carry the
  claim, the claim does not ship.
- A price change moves money, never an outcome. Repricing re-attributes cost
  inside one transaction and leaves gates, maturity, survival, acceptance, and
  the realized flag untouched — pinned by a diff-the-whole-funnel test.
- List price is not billed cost. Any comparison priced from a rate card says so.
- A realized coding unit is not realized economic value. The kernel bridge carries
  lifecycle gate evidence and exact request-lineage spend only; it never upgrades
  either into causal or business-value truth.

## Verify

```bash
npm test -- --test-name-pattern="value|trial|frontier|realization|lift"
```
