# market — public quality per dollar

## Consumes

The dated bundled `market/snapshot.json`; per-source refresh files under
`<SEGREANT_HOME>/market/` written by `refresh.ts`; `config.features`; and,
only when the operator passes `--repo`, their own realized value per model
from `src/value/frontier.ts`.

## Guarantees

- Three claims stay separate: a public benchmark result, a public list price,
  and the operator's realized value. Personal value is a nullable field beside
  public rows and never enters a public figure or frontier.
- Only the Aider board, which publishes each run's dollar cost, gets a
  per-dollar figure (cost per solved task). Arena ratings are not a ratio
  scale: no per-dollar quotient, and a model is dominated only when a model
  priced no higher has a whole rating interval above its own.
- Missing is never zero: an unpublished run cost, an unpriced model, or a
  missing source is `null` or a `missing`/`disabled` status, with no frontier
  position.
- Every board carries its source, licence, link, fetch time, and newest result
  date; a normalized price join names the price-list entry it used.
- A switched-off market or source reports `disabled` and computes nothing.
- The consensus score (`consensus.ts`) is a reliability-weighted item-response
  fit over chance-corrected scores, never a raw mean across scales. A model
  needs two benchmarks; its range is leave-one-benchmark-out. Weights come
  only from the published rubric (`RELIABILITY`), mirrored in
  `docs/MARKET-SOURCES.md`. Stored fits are reused only when their key (method
  version and exact input hashes) matches; bump `CONSENSUS_VERSION` when the
  method changes.

## Invariants

Refreshes go only through `egressFetch` under `market_refresh` /
`market_manifest`, to fixed URLs, with bounded bodies and atomic per-source
writes; a failure leaves the previous copy. The three arena boards share one
grant (`market-arena`) because identical rules would be ambiguous. Reading the
market never opens a socket or the ledger (except `--repo`, read-only).

## Verify

`node --test --experimental-strip-types test/features-market.test.ts`; the full
suite and both TypeScript passes before integration. Rebuild the bundle with
`scripts/build-market-snapshot.mjs` from a real refresh, never by hand.
