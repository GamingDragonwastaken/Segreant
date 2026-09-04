# economics — exact Money and immutable economic events

## Consumes

- canonical exact `Money`/`Rate` values from `money.ts` and `rate.ts`;
- canonical UTC event and recording times;
- source-event links for corrections, credits, allocations and reversals.

## Guarantees

- event amounts retain currency and economic basis; unlike bases are never
  silently summed;
- event kinds are assigned explicit projection roles (`usage`, `charge`,
  `price`, `adjustment`, `translation`, `allocation`, `control`) so unlike
  economic flows are not collapsed into one balance;
- economic events are canonical JSON plus a SHA-256 digest in an append-only
  SQLite ledger, with normalized immutable source-link rows backed by foreign
  keys;
- credits/reversals are additive signed events, not destructive updates;
- local repricing is an additive, typed `price_corrected` event that retains
  the previous and replacement amounts, targets an estimated/list-price charge
  or prior typed correction, and cannot be recorded before that source;
- historical FX is an additive `fx_translated` derivative with one monetary
  source, an exact rational rate, optional canonical validity interval,
  explicit rate provenance/effective time, source-to-target convention and an
  explicit no-rounding policy;
- projections are deterministic and can be replayed at a recorded-time boundary;
- accounting-facing request charges can be issued as one exact Money event on the
  same Store transaction as the compatibility request row;
- exact request budget projections can apply a validated local price correction
  through an explicit `effective` basis; the immutable source and correction
  event IDs remain inspectable while the legacy request row stays a compatibility
  projection;
- a period can be finalized as an immutable, half-open snapshot whose digest
  binds every in-period event known at the recording boundary, its exact
  basis-separated balances, and its source-event set; status is replayable at
  an `asOf` recording boundary;
- reopening is an additive control event with an explicit reason. It preserves
  the prior close and permits late evidence only after the lifecycle records
  that reopening; a competing close is surfaced as `conflicted`, never chosen
  silently.
- the supported Store/CLI finalization path can issue a kernel Evidence/Claim
  pair with the exact close digest, source-event set, and basis-separated
  balances; the claim stays provisional and self-authenticated because a local
  close does not prove provider billing completeness or settlement finality;

## Invariants

- balances are projections, never mutable history;
- monetary event kinds require an exact `Money` amount;
- `allocation_reversed` names the event it reverses and lists it as a source;
- `price_corrected` names exactly one `charge_estimated` or prior
  `price_corrected` source, carries typed `reprice` metadata, uses the source
  currency/basis, and each predecessor has at most one direct correction
  successor;
- charge, provider-observation, bill, and allocation event kinds require their
  compatible economic basis;
- every dependent event is recorded no earlier than each source it references;
- provider-observed and billed corrections use their own provider/billing
  adjustment semantics; they cannot be relabelled as local repricing;
- `fx_translated` must reproduce its target exactly from the retained source,
  rate and basis; any retained rate validity interval is canonical and
  preserved through serialization/replay; non-terminating conversions are
  refused until a quantization policy is explicitly specified;
- allocation reversals must target a compatible, non-negative allocation and
  cannot exceed it;
- source-event IDs must already exist before a new event is appended;
- no floating-point value is introduced by serialization, replay or projection;
- exact request issuance accepts only USD Money and maps list/estimated,
  provider-observed, and billed bases to explicit event kinds;
- legacy numeric request rows are not backfilled into exact Money without evidence;
- when an exact request already exists, a numeric-only reprice is refused rather
  than allowing the compatibility row and economic history to diverge;
- close controls have no monetary amount, occur exactly at the exclusive period
  end, and are recorded no earlier than that end;
- a finalization's source IDs are sorted, unique and exactly equal to every
  non-control event in the period visible at its recording boundary; its
  event count, digest and basis-separated balances are recomputed on replay;
- an in-period event cannot be appended while its period is `finalized` or
  `conflicted`; reopening is explicit and does not delete or rewrite history;
- a malformed, duplicate-transition or competing close never degrades to
  `open` or selects a winner: the status is `conflicted` and downstream
  finalization is refused;

## Verify

```bash
node --test --experimental-strip-types test/economic-events.test.ts test/economic-close.test.ts
```
