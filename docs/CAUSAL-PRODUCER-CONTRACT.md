# Causal producer contract

This document defines the local producer boundary for the missing request-to-
study-unit identity step. It is intentionally narrower than a causal result.
The producer can derive an auditable identity join key from retained scalar
evidence; it cannot turn that join key into a causal effect, provider invoice
truth, or realized-value claim.

## What the producer does

`src/causal/producer.ts` exposes
`produceCausalUnitReceiptV1(...)`. The function is synchronous, deterministic,
local, and side-effect free. It accepts:

- a committed V2 protocol and one retained V2 assignment decision;
- one authenticated V2 execution and one authenticated matured terminal
  outcome;
- a scalar projection of every retained request referenced by the execution;
- an operator-declared scope snapshot; and
- a scalar realization snapshot without the realization `unit_json` field.

Before producing a receipt, the boundary checks protocol, decision, execution,
outcome, request IDs, arm/provider/model identity, execution timestamps,
request timestamps, non-estimated proxy cost, pricing-lineage digests, exact
microdollar cost conservation, scope coherence, realization maturity, and the
outcome's event-chain link. Any missing or contradictory evidence returns an
`inconclusive` or `invalid` assessment with no usable derived digest.

The request-to-unit digest is calculated over this domain-separated material:

```text
fiscus.causal.producer-unit
1
canonical({
  type, version, studyId, protocolHash,
  operator-declared scope identity,
  ordered request id/timestamp/provider/model/project identity scalars
})
```

The identity material intentionally excludes request cost, outcome values,
outcome evidence, realization values, prompts, source text, model output,
credentials, token contents, and realization `unit_json`. Cost and outcome are
still mandatory eligibility checks; they are not allowed to redefine the unit
after exposure. A changed request set therefore produces a different identity,
while a changed post-treatment outcome does not.

The derived digest is compared with the retained assignment decision's digest.
Only an exact match can produce a receipt. A mismatch is returned as an
`invalid` assessment with both digests exposed as non-secret conflict evidence;
it is never silently rewritten or promoted.

## Receipt and replay

An eligible assessment returns one immutable local
`fiscus.causal-producer-receipt` envelope. The envelope contains scalar IDs,
digests, request count, exact request cost in microdollars, scope identity,
realization and outcome evidence digests, sequence, and a previous-receipt
hash. The receipt hash is a domain-separated SHA-256 over every other field.
Sequence one must have a null predecessor; later sequences must carry a
namespaced SHA-256 predecessor. `verifyCausalProducerReceiptV1(...)` validates
the exact shape and receipt hash without echoing arbitrary input errors.

The receipt always carries `claimStatus: "not_established"` and records that
the ordinary-ledger verifier is unresolved. It is therefore suitable as an
input to a later Store append-only sidecar integration, not as a public causal
result.

## Explicit exclusions

The module rejects unexpected raw-content fields, including prompt, source,
output, credential, API-key, token, and realization-JSON names. It does not
perform network calls, read files, open a database, invoke a model, or mutate
the Store. Its caller must provide snapshots obtained from a Store reader that
has already authenticated retained physical rows and assignment manifests.

The operator-declared scope is a provenance condition, not provider-account
verification. The current execution record's ordinary-ledger verifier remains
unresolved, so the producer does not establish billing completeness. The
receipt also does not independently prove that a real-world operator followed
the randomized assignment; the retained execution adherence and assignment
artifacts must continue through the existing qualification gate.

## Integration hook

The next Store-owned slice should expose a read-only, authenticated snapshot
adapter and call the producer after execution, outcome, request, and
realization rows are all available:

1. Read and authenticate the committed protocol, assignment decision,
   execution, terminal outcome, request scalar rows, scope declaration, and
   realization scalar row.
2. Call `produceCausalUnitReceiptV1` with a sequence and predecessor from a
   producer-receipt table or equivalent append-only event stream.
3. Refuse the sidecar append unless the assessment is `produced` and the
   receipt verifies locally.
4. Persist the derived digest as the producer's identity evidence outside
   `unit_json`; keep the existing qualification result inconclusive while the
   ordinary-ledger and independent outcome gates remain open.
5. Re-authenticate the receipt and its physical identity columns on every
   reload, and treat a missing, conflicting, or corrupt receipt as a failed
   lineage condition rather than as absence.

This contract deliberately leaves that persistence and Store wiring as a
separate change so the pure producer can be reviewed and tested independently
of the existing causal tables.
