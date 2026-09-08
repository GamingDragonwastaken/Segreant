# epistemic — evidence state and dependency legality

## Consumes

- typed evidence/claim/decision node identities;
- canonical immutable Evidence envelopes with explicit source, coordinate, trust, completeness and retention metadata;
- canonical immutable Claim envelopes with typed propositions, profile aliases, uncertainty and derivation dependencies;
- first-class immutable Assumption envelopes with scope/time, epistemic state and evidence dependencies;
- canonical immutable, evidence-grounded Witness envelopes for derivation proof obligations;
- canonical immutable Derivation records with explicit transformations, coordinate changes and witness identities;
- immutable Evidence/Claim dependency DAG snapshots with as-of views, assumption/measurement queries, conflict paths, supersession links and revocation projections;
- SQLite-backed append-only kernel ledger with canonical JSON/digest revalidation, atomic dependency writes and revocation-event replay;
- a combined `replayAsOf` projection that applies node availability and event-recording boundaries in one immutable result;
- canonical JSON serialization/digest envelopes for Evidence, Claim, Assumption and Derivation records;
- directed prerequisite-to-dependent edges;
- revocation events supplied by an append-only store or protocol layer;
- a declared map of every repository boundary that creates or strengthens a claim, with the class of authority each holds (`issuance-map.ts`).
- whole derivation CHAINS, as a set of claims plus the derivations between them, for abstract interpretation over the axis lattice (`abstract.ts`).

## Does not establish

`abstract.ts` never says a proposition is TRUE, in the same sense as
`PreservationAssessment.isProofOfTruth: false`; a bound is about what the
evidence structure licenses.

It also does not close the hole it was built to cover. `assessDerivationLegality`
iterates `PROFILE_STRENGTH_AXES`, which cannot include `monetaryBasis` because
that axis has no ladder — measured, a derivation whose input carries
`monetaryBasis: 'estimated'` and whose output carries `'billed'` is
`allowed: true` with ZERO required witnesses, and the ledger stores it, because
the ledger checks every input claim against a rule that never looks at the money
axis. `abstract.ts` refuses that re-basing, and **nothing calls `abstract.ts`**:
no ledger path, no product path. `BASIS_DERIVATIONS` is deliberately empty, which
means "nobody has declared a legitimate re-basing", not "none exist" — allocation
is the obvious candidate and inventing it here to make a bound look useful would
be the inflation the module refuses.

The analysis takes each leaf at face value: it bounds what a CHAIN adds, and what
a root may say about its own cited evidence is `assertClaimWithinItsEvidence` and
`assessPreservation`, which it neither repeats nor replaces. A witness lifts its
axis to that axis's top, exactly as the kernel's own rule does, so the
abstraction is only as tight as the witness discipline it inherits: a witness
that overstates its reach overstates this bound too.

## Guarantees

- revocation closure includes every transitive dependent and the original revoked node;
- independent sibling branches remain valid unless they depend on a revoked node;
- duplicate revocations are idempotent and cycles are traversed safely;
- malformed and duplicate dependency edges fail closed;
- closure computation never deletes or mutates historical nodes.
- An Evidence/Claim `revocation` envelope's `eventId` and the `epistemic_revocations` table (`appendRevocation`'s own PRIMARY KEY namespace) are checked against each other in both directions: `appendRevocation` refuses an `eventId` a different node's envelope already claims, and appending an Evidence/Claim refuses a `revocation.eventId` the table already records against a different target. Neither direction requires the other side to exist first — only a target MISMATCH when the id is on record on either side is refused.
- `RevocationProjection` carries an effective-time dimension: `revokedIds`/`trace` cover only revocations already in effect as of the caller's reference instant (the `asOf` boundary, or the real current instant for a live read), and `pendingIds` covers ones known but not yet effective — an envelope's `effectiveAt`, distinct from its node's availability. A table-recorded event has no separate effective time and is always immediately effective.
- Evidence payloads are cloned/frozen and may be replaced by a hash/reference when raw content should not be retained.
- Claims retain evidence IDs and derivation identity; a profile mismatch or absent evidence dependency fails closed.
- A claim's `measurementModelRef`, when it names one, must be a reference at least one cited Evidence declares. `claim()` requires a reference to be WRITTEN once `profile.measurement` rises above `proxy_unvalidated`; the append boundary requires it to be one some record of the measurement made, so a measurement citation cannot appear at the claim layer out of nothing. This is a containment check and not a fourth ceiling: a model reference is an identity, not a rung, so no ordering is invented and the deliberate refusal to rank `monetaryBasis` is untouched. It does NOT establish that the reference resolves to a registered model — the evidence can name nothing just as the claim could.
- Witnesses are first-class persisted nodes; every witness used by a stored derivation must match the registered kind, coordinates, detail and evidence IDs.
- Derivation legality refuses unsupported strengthening of coordinates, epistemic state, coverage, measurement, causality, monetary finality, trust or decision fitness.
- Every product path that issues a kernel Claim is declared in `issuance-map.ts`, and a path that issues without appearing there fails a test rather than becoming a second authority.
- `abstract.ts` bounds what a whole chain licenses, which no per-step check does: `assessDerivationLegality` compares one step against one input claim and `assessPreservation` compares one claim against its cited evidence, so a conclusion several merges downstream of its leaves was compared with its neighbours and nothing else.
- The abstract domain reuses the split `admissibility.ts` already declares: ordered axes are bounded by a CEILING, and the two unordered axes — `monetaryBasis` and `epistemic` — by an ADMISSIBLE SET. `monetaryBasis` acquires no ordering here, and refusing to give it one is the point.
- `PROFILE_STRENGTH_AXES` is exported from `derivation.ts` and read rather than restated, so the per-step rule and its abstraction cannot drift apart.
- Every choice in the abstraction NARROWS rather than widens: an unresolved input is BOTTOM and not "ignore it"; no inputs at all is BOTTOM and not "unconstrained"; disagreeing monetary bases become `mixed` rather than the stronger of the two; a conflicted epistemic join admits only `conflicted`. A bound that is too tight costs a caller an explicit witness; a bound that is too loose says a chain can establish something it cannot.

## Invariants

- an edge `from -> to` means `to` depends on `from`;
- revocation is a projected validity result, not destructive deletion;
- conflict and unknown evidence states remain distinct in the wider kernel.
- integrity, authenticity, completeness and truth are independent axes; no universal `trusted` boolean is emitted.
- claim-level causal, monetary and finality aliases are copied from the profile and cannot diverge.
- Coordinate witness kinds must match exact source/target coordinates; non-coordinate witnesses cannot smuggle coordinate changes.
- Dependency edges are prerequisite-to-dependent and acyclic; supersession is lifecycle metadata, not a revocation dependency.
- As-of views never expose nodes unavailable at the requested boundary; revocation returns traceable projections and never deletes history.
- Revocation of witness evidence transitively reaches the witness and every claim whose derivation cites it.
- Repeated as-of replay is deterministic across handles; later nodes and later-recorded revocations cannot appear in earlier projections.
- Persistent inserts are exact-replay idempotent but divergent same-ID payloads and `INSERT OR REPLACE` attempts fail closed through database triggers.
- Serialized records sort object keys, preserve array order, reject cycles/unsupported values, and verify both digest and canonical bytes before rehydration.
- Claims may carry first-class `assumptionIds`; the Store links them as `assumes` edges so assumption revocation reaches dependent claims without treating display text as a trust source.
- The issuance map's `unmigrated_authority` list is non-empty by construction while AII-036 is `PARTIAL`: emptying it requires closing the finding, not editing the list. Three boundaries — causal qualification, causal estimation and decision certificates — strengthen claims outside the kernel today, which means revoking their sources cannot invalidate what depends on them.

## Verify

```bash
node --test --experimental-strip-types test/revocation-closure.test.ts test/epistemic-state.test.ts
node --test --experimental-strip-types test/epistemic-evidence.test.ts
node --test --experimental-strip-types test/epistemic-claim.test.ts
node --test --experimental-strip-types test/epistemic-derivation-object.test.ts test/epistemic-derivation.test.ts
node --test --experimental-strip-types test/epistemic-dag.test.ts
node --test --experimental-strip-types test/epistemic-ledger.test.ts
node --test --experimental-strip-types test/epistemic-assumption.test.ts
node --test --experimental-strip-types test/epistemic-witness.test.ts
node --test --experimental-strip-types test/epistemic-replay-conformance.test.ts
node --test --experimental-strip-types test/epistemic-serialization.test.ts
node --test --experimental-strip-types test/issuance-map.test.ts
node --test --experimental-strip-types test/epistemic-trust-non-escalation.test.ts
node --test --experimental-strip-types test/epistemic-revocation-envelope.test.ts test/epistemic-revocation-event-linkage.test.ts test/epistemic-revocation-pending.test.ts
```
