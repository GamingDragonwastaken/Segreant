# epistemic — evidence state and dependency legality

## Consumes

- typed evidence/claim/decision node identities;
- directed prerequisite-to-dependent edges;
- revocation events supplied by an append-only store or protocol layer.

## Guarantees

- revocation closure includes every transitive dependent and the original revoked node;
- independent sibling branches remain valid unless they depend on a revoked node;
- duplicate revocations are idempotent and cycles are traversed safely;
- malformed and duplicate dependency edges fail closed;
- closure computation never deletes or mutates historical nodes.

## Invariants

- an edge `from -> to` means `to` depends on `from`;
- revocation is a projected validity result, not destructive deletion;
- conflict and unknown evidence states remain distinct in the wider kernel.

## Verify

```bash
node --test --experimental-strip-types test/revocation-closure.test.ts test/epistemic-state.test.ts
```
