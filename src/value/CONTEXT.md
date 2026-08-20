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

## Verify

```bash
npm test -- --test-name-pattern="value|trial|frontier|realization|lift"
```
