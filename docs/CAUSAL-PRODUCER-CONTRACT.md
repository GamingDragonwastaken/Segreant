# Causal producer contract

This document defines the local producer boundary for the request-to-study-unit
identity step. It is intentionally narrower than a causal result. The pure
producer and its Store-owned adapter can derive an auditable identity join key
from retained scalar evidence; neither can turn that join key into a causal
effect, provider invoice truth, or realized-value claim.

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

## Store-owned integration

The independent path is now wired behind the Store boundary in
`src/store/causalProducer.ts` and re-exported as two internal `Store` methods:

- `prepareIndependentCausalLineageBindingV2(input)` is read-only and returns a
  `ready` or `blocked` assessment;
- `appendIndependentCausalLineageBindingV2(input)` repeats the same checks and
  appends the scalar-only binding atomically with the realization identity
  update.

The adapter reads and authenticates one exact protocol, assignment decision,
execution, matured terminal outcome, named request set, declared route scope,
realization row, and retained Git row. It independently derives
`independentCausalUnitIdDigestV2` from the retained commit/project/time/size/
subject-digest scalars rather than accepting the realization `unit_json` or a
caller-supplied unit identity. It then runs the ordinary-ledger verifier over
the exact request rows: IDs must be unique and ordered, requests must be
successful non-estimated proxy observations, cost must conserve in fixed-point
microdollars, pricing lineage must agree, and the declared scope must be
present. A `ready` assessment is therefore reproducible local scalar evidence,
not a provider-account or invoice verification.

The append uses the existing append-only lineage helper inside one
`BEGIN IMMEDIATE` transaction. A second identical append is idempotent; a
conflicting binding, tampered Git scalar, malformed row, missing scope, or
failed ledger check rolls back without writing a partial identity. The adapter
does not expose a public CLI/API/dashboard projection and does not change
routing, budgets, or qualification claims.

## Receipt and replay

An eligible assessment returns one immutable local
`fiscus.causal-producer-receipt` envelope. The envelope contains scalar IDs,
digests, request count, exact request cost in microdollars, scope identity,
realization and outcome evidence digests, sequence, and a previous-receipt
hash. The receipt hash is a domain-separated SHA-256 over every other field.
Sequence one must have a null predecessor; later sequences must carry a
namespaced SHA-256 predecessor. `verifyCausalProducerReceiptV1(...)` validates
the exact shape and receipt hash without echoing arbitrary input errors.

The pure V1 receipt always carries `claimStatus: "not_established"` and records
that its ordinary-ledger verifier is unresolved by design. It remains suitable
as a narrow producer artifact, not as a public causal result. The Store-owned
V2 adapter has a separate verified ordinary-ledger result, but that result is
still only local scalar eligibility and does not establish provider billing
finality or a causal customer claim.

## Explicit exclusions

The module rejects unexpected raw-content fields, including prompt, source,
output, credential, API-key, token, and realization-JSON names. It does not
perform network calls, read files, open a database, invoke a model, or mutate
the Store. Its caller must provide snapshots obtained from a Store reader that
has already authenticated retained physical rows and assignment manifests.

The operator-declared scope is a provenance condition, not provider-account
verification. The pure V1 receipt does not establish billing completeness. The
Store-owned V2 ledger verifier is stricter about the retained local request
rows, but it still cannot see off-path provider usage, invoice adjustments,
account ownership, billing lag, or provider finality. Neither producer
independently proves that a real-world operator followed the randomized
assignment; retained execution adherence and assignment artifacts must
continue through the existing qualification gate.

## Remaining qualification work

The Store wiring closes the local identity-and-ledger substrate, but it does
not close the causal task. Before any causal financial language could be
released, a governed prospective study still has to be registered and run,
follow-up and data-lock rules must be satisfied, the outcome must be
independently retained, and every qualification gate must pass. Public v2
registration, lifecycle ownership, export, and projection remain deliberately
deferred. A provider-authoritative account mapping and invoice-compatible
source is also a separate gate; the local ordinary-ledger verifier cannot
substitute for it.
