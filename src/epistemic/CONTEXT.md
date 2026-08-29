# epistemic — evidence state and dependency legality

## Consumes

- typed evidence/claim/decision node identities;
- canonical immutable Evidence envelopes with explicit source, coordinate, trust, completeness and retention metadata;
- directed prerequisite-to-dependent edges;
- revocation events supplied by an append-only store or protocol layer.

## Guarantees

- revocation closure includes every transitive dependent and the original revoked node;
- independent sibling branches remain valid unless they depend on a revoked node;
- duplicate revocations are idempotent and cycles are traversed safely;
- malformed and duplicate dependency edges fail closed;
- closure computation never deletes or mutates historical nodes.
- Evidence payloads are cloned/frozen and may be replaced by a hash/reference when raw content should not be retained.

## Invariants

- an edge `from -> to` means `to` depends on `from`;
- revocation is a projected validity result, not destructive deletion;
- conflict and unknown evidence states remain distinct in the wider kernel.
- integrity, authenticity, completeness and truth are independent axes; no universal `trusted` boolean is emitted.

## Verify

```bash
node --test --experimental-strip-types test/revocation-closure.test.ts test/epistemic-state.test.ts
node --test --experimental-strip-types test/epistemic-evidence.test.ts
```
