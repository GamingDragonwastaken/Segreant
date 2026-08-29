# epistemic — evidence state and dependency legality

## Consumes

- typed evidence/claim/decision node identities;
- canonical immutable Evidence envelopes with explicit source, coordinate, trust, completeness and retention metadata;
- canonical immutable Claim envelopes with typed propositions, profile aliases, uncertainty and derivation dependencies;
- first-class immutable Assumption envelopes with scope/time, epistemic state and evidence dependencies;
- canonical immutable Derivation records with explicit transformations, coordinate changes and witness identities;
- immutable Evidence/Claim dependency DAG snapshots with as-of views, assumption/measurement queries, conflict paths, supersession links and revocation projections;
- SQLite-backed append-only kernel ledger with canonical JSON/digest revalidation, atomic dependency writes and revocation-event replay;
- canonical JSON serialization/digest envelopes for Evidence, Claim, Assumption and Derivation records;
- directed prerequisite-to-dependent edges;
- revocation events supplied by an append-only store or protocol layer.

## Guarantees

- revocation closure includes every transitive dependent and the original revoked node;
- independent sibling branches remain valid unless they depend on a revoked node;
- duplicate revocations are idempotent and cycles are traversed safely;
- malformed and duplicate dependency edges fail closed;
- closure computation never deletes or mutates historical nodes.
- Evidence payloads are cloned/frozen and may be replaced by a hash/reference when raw content should not be retained.
- Claims retain evidence IDs and derivation identity; a profile mismatch or absent evidence dependency fails closed.
- Derivation legality refuses unsupported strengthening of coordinates, epistemic state, coverage, measurement, causality, monetary finality, trust or decision fitness.

## Invariants

- an edge `from -> to` means `to` depends on `from`;
- revocation is a projected validity result, not destructive deletion;
- conflict and unknown evidence states remain distinct in the wider kernel.
- integrity, authenticity, completeness and truth are independent axes; no universal `trusted` boolean is emitted.
- claim-level causal, monetary and finality aliases are copied from the profile and cannot diverge.
- Coordinate witness kinds must match exact source/target coordinates; non-coordinate witnesses cannot smuggle coordinate changes.
- Dependency edges are prerequisite-to-dependent and acyclic; supersession is lifecycle metadata, not a revocation dependency.
- As-of views never expose nodes unavailable at the requested boundary; revocation returns traceable projections and never deletes history.
- Persistent inserts are exact-replay idempotent but divergent same-ID payloads and `INSERT OR REPLACE` attempts fail closed through database triggers.
- Serialized records sort object keys, preserve array order, reject cycles/unsupported values, and verify both digest and canonical bytes before rehydration.
- Claims may carry first-class `assumptionIds`; the Store links them as `assumes` edges so assumption revocation reaches dependent claims without treating display text as a trust source.

## Verify

```bash
node --test --experimental-strip-types test/revocation-closure.test.ts test/epistemic-state.test.ts
node --test --experimental-strip-types test/epistemic-evidence.test.ts
node --test --experimental-strip-types test/epistemic-claim.test.ts
node --test --experimental-strip-types test/epistemic-derivation-object.test.ts test/epistemic-derivation.test.ts
node --test --experimental-strip-types test/epistemic-dag.test.ts
node --test --experimental-strip-types test/epistemic-ledger.test.ts
node --test --experimental-strip-types test/epistemic-assumption.test.ts
node --test --experimental-strip-types test/epistemic-serialization.test.ts
```
