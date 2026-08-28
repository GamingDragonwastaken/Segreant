# Utility context

## Consumes

- Fiscus-owned response objects whose numeric monetary properties use the
  `*Usd` suffix.

## Guarantees

- `stringifyJson` rounds only safe, finite `*Usd` numbers to six decimal places
  at serialization time.
- Non-money numbers, object shapes, internal calculations, hashes, and canonical
  protocol/signature serialization are not changed.

## Invariants

- A rounded value must correspond to an integer number of microdollars.
- A value whose rounded microdollars exceed JavaScript's safe integer range is
  left unchanged rather than given invented precision.

## Verify

- `test/json-money.test.ts`
