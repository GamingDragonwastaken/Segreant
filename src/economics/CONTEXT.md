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
- projections are deterministic and can be replayed at a recorded-time boundary;
- accounting-facing request charges can be issued as one exact Money event on the
  same Store transaction as the compatibility request row.

## Invariants

- balances are projections, never mutable history;
- monetary event kinds require an exact `Money` amount;
- `allocation_reversed` names the event it reverses and lists it as a source;
- charge, provider-observation, bill, and allocation event kinds require their
  compatible economic basis;
- allocation reversals must target a compatible, non-negative allocation and
  cannot exceed it;
- source-event IDs must already exist before a new event is appended;
- no floating-point value is introduced by serialization, replay or projection;
- exact request issuance accepts only USD Money and maps list/estimated,
  provider-observed, and billed bases to explicit event kinds;
- legacy numeric request rows are not backfilled into exact Money without evidence.

## Verify

```bash
node --test --experimental-strip-types test/economic-events.test.ts
```
