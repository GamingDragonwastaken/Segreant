# Utility context

## Consumes

- Fiscus-owned response objects whose numeric monetary properties use the
  `*Usd` suffix.

## Guarantees

- `stringifyJson` rounds only safe, finite `*Usd` numbers to six decimal places
  at serialization time.
- Non-money numbers, object shapes, internal calculations, hashes, and canonical
  protocol/signature serialization are not changed.
- Externally influenced proxy/dashboard capture paths use the shared resource
  policy in `resource-limits.ts` rather than scattered buffer constants.
- A capture that hits a policy bound is rejected or explicitly marked
  `truncated`; it is never silently promoted to complete evidence.
- Native Claude Code, Codex and opencode imports enumerate incrementally and
  disclose skipped oversized lines, rows, or source files through their
  `ImportSummary` coverage fields.
- Canonical receipt and kernel serialization rejects hostile cycles, depth,
  node counts and oversized strings/outputs before signing or verification.

## Invariants

- A rounded value must correspond to an integer number of microdollars.
- A value whose rounded microdollars exceed JavaScript's safe integer range is
  left unchanged rather than given invented precision.

## Verify

- `test/json-money.test.ts`
