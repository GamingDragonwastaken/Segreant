# economics — exact Money and immutable economic events

## Consumes

- canonical exact `Money`/`Rate` values from `money.ts` and `rate.ts`;
- canonical UTC event and recording times;
- source-event links for corrections, credits, allocations and reversals.

## Guarantees

- event amounts retain currency and economic basis; unlike bases are never
  silently summed;
- economic events are canonical JSON plus a SHA-256 digest in an append-only
  SQLite ledger;
- credits/reversals are additive signed events, not destructive updates;
- projections are deterministic and can be replayed at a recorded-time boundary.

## Invariants

- balances are projections, never mutable history;
- monetary event kinds require an exact `Money` amount;
- `allocation_reversed` names the event it reverses and lists it as a source;
- source-event IDs must already exist before a new event is appended;
- no floating-point value is introduced by serialization, replay or projection.

## Verify

```bash
node --test --experimental-strip-types test/economic-events.test.ts
```
