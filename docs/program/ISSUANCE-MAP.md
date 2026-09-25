# Claim-Issuance Map

Every boundary at which this repository creates or strengthens a claim, and the
class of authority it holds. WP-B01, against AII-036.

This document is not the map. `src/epistemic/issuance-map.ts` is the map, and
`test/issuance-map.test.ts` checks it against the source tree; this page is the
readable projection of it, and the test fails if the two disagree — a boundary
missing here, a row here for a boundary the code no longer declares, or a row
whose Class or Reach cell does not say what the code says.

That last check is newer than the others and it was added because it was needed
(D-188). For a while the test compared the SET OF IDS only, so the columns could
drift without anything noticing, and they did: `alloc.exactRun` was corrected to
`imported_uninvoked` in the code and left reading `product` here, which is the
very field that correction existed to stop overstating. **A projection test that
checks membership certifies the document's existence, not its content.**

## Why a map and not a review

The kernel primitives are sound under their tested contracts. Evidence, Claim,
Derivation, Witness, the DAG and persistence layer enforce the authority they
declare. AII-036 is closed at the current reconciliation head because the map has
no `unmigrated_authority` row; the continuing risk is regression.

The risk is that a future product path mints a stronger semantics *beside* the kernel.
That does not arrive as a bad Claim — a bad Claim gets refused. It arrives as
one new file that is entirely correct in itself, computes something a consumer
reasonably reads as established, and is on no list of things that are allowed to
do that. Nothing in a tree of two hundred files says which paths hold authority,
so nothing notices.

So the map is executable. A `canonical` boundary that stops calling the kernel
fails a test. A boundary declared `display_only` that starts issuing fails. A
file anywhere in `src/` that calls `claim({...})` without appearing here fails.

## Two axes, not one

Authority class says what a boundary does when it runs. It says nothing about
whether anything runs it, and the difference decides which defect to fix first.

`reach` is the second axis, and it has THREE states rather than two.

`product` means the module is in the transitive import closure of `src/cli.ts`
— the entry `bin/segreant.mjs` runs through `dist/cli.js` — or of the team-server
entry, which imports root source directly, AND something in that closure names
the entry point the boundary declares. `imported_uninvoked` means the first half
holds and the second does not: the module ships, and no product path calls into
it. `unreached` means neither.

The middle state exists because the two halves were once one field. Import
reachability was measured and invocation was claimed, and `alloc.exactRun` sat
on the authoritative money path declared live in the product while the only
mentions of `Store.saveExactAllocationRun` anywhere were its own definition and
one forwarder (D-184). **`reach` decides queue position, so a field that
overstates what its check establishes misdirects exactly the work this map
exists to direct.**

So every boundary now declares the symbol a product path would have to call to
reach it, and the test looks for that symbol in the closure outside the files
that define or forward it. The check is deliberately one-directional: a mention
is not a call, so it can prove that NOTHING invokes a boundary and never that
something does. That asymmetry is the right way round for a gate — it fails only
when nothing in the product so much as names the entry point, which cannot be a
false alarm. All seventeen were traced by hand at D-188; the other sixteen held.

The test also walks the import graph and compares it against the declaration, so
a boundary that gains or loses a consumer fails until the map is corrected: the
moment to reconsider its queue position, rather than a field to update quietly.

Of the seventeen boundaries, sixteen are `product`, one is
`imported_uninvoked`, and none is `unreached`. The two decision boundaries
were the unreached pair until D-220: `src/budget/capDecision.ts` now calls
`certifyDecision` and `minimaxRegret` for the budget-cap decision that
`segreant budget --recommend` renders, and routes a certified cap through
`issueDecisionToKernel` on `--apply`. `alloc.exactRun` is the
middle case: `src/store/db.ts` imports it, and no product path calls the store
method that would run it. None of this is dead code to delete on sight. The imported-but-uninvoked exact
allocation boundary is a deliberate capability that is not currently an
operator-facing authority. Its reach classification remains explicit so a future
consumer cannot silently change its risk class.

This paragraph had gone stale twice before D-188 — once when the second decision
boundary was added and again when `alloc.exactRun` was reclassified — because
nothing checked a count stated in prose. The per-row cells are now checked; a
prose count still is not, which is why this one is written to be re-derivable
from the table directly below it.

## Classes

| Class | Meaning |
|---|---|
| `canonical` | Issues Evidence/Claim through the kernel. Legality and non-escalation are enforced there. |
| `kernel_primitive` | Reasons in kernel types and four-valued state but issues nothing. It supplies what a canonical boundary needs in order to be legal. |
| `integrity_only` | Proves who produced a record and that it was not altered. Establishes nothing about whether the record is true (AII-020). |
| `display_only` | Projects or formats something established elsewhere. Must not be the first place a stronger claim appears. |
| `unmigrated_authority` | Produces a stronger claim outside the kernel today. A defect with a name and a queue position, not an accepted design. |

## The map

| Boundary | Module | Class | Reach | What a consumer could read out of it |
|---|---|---|---|---|
| `billing.reconciliation` | `src/billing/epistemic.ts` | canonical | product | Provider-billed cost for a period, and its reconciliation against metered usage |
| `economics.periodClose` | `src/economics/epistemic.ts` | canonical | product | An economic period is closed, with a basis-separated snapshot and projection digest |
| `alloc.exactRun` | `src/alloc/epistemic.ts` | canonical | **imported_uninvoked** | An exact allocation run produced this distribution from these source events |
| `value.codingRealization` | `src/value/epistemic.ts` | canonical | product | A unit of coding work reached a terminal lifecycle state under the declared gate ladder |
| `measurement.completeness` | `src/measurement/completeness.ts` | kernel_primitive | product | A source completely covers a scope and interval, so absence within it is informative |
| `git.revertCompleteness` | `src/git/completeness.ts` | kernel_primitive | product | This git history was completely read for revert evidence over this project and period |
| `outcomes.contract` | `src/outcomes/contract.ts` | kernel_primitive | product | A domain-neutral outcome contract is confirmed, unresolved, or conflicted |
| `value.receipt` | `src/value/receipt.ts` | integrity_only | product | This exact record was produced by the holder of this key and has not been altered |
| `team.rollup` | `src/team/rollup.ts` | integrity_only | product | A project-level aggregate of locally computed values, signed for transport |
| `dashboard.claimSupport` | `src/dashboard/claim-support.ts` | display_only | product | What each of the four product claims’ evidence reaches, on named axes, as sent to any consumer of `/api/*` |
| `judge.session` | `src/judge/orchestrate.ts` | display_only | product | A model-graded quality judgment for a session |
| `causal.qualification` | `src/causal/qualification.ts` | kernel_primitive | product | A local randomized study qualifies as causal evidence |
| `causal.estimate` | `src/causal/estimate.ts` | kernel_primitive | product | An assigned-arm difference with a finite-range interval |
| `causal.issuance` | `src/causal/epistemic.ts` | canonical | product | A randomized study supports a causal effect, bound by derivation to the randomization |
| `billing.countermodels` | `src/billing/countermodels.ts` | kernel_primitive | product | What the reconciliation residual degrades to if one of its stated conditions is false, and whether anything Segreant has could tell |
| `decision.certificate` | `src/decision/engine.ts` | **kernel_primitive** | product | Pure interval-dominance primitive; product presentation/action routes through the canonical adapter before strengthening |
| `decision.certificate.issuance` | `src/decision/epistemic.ts` | **canonical** | product | One action robustly dominates the alternatives under the declared utility intervals, bound to interval Evidence and a decision-fitness Derivation |

Each module states its own class in its own docblock, so a reader opening the
file learns what authority it holds without having to find this page first.

## Closure state

`UNMIGRATED_BOUNDARIES` is empty at the final reconciliation boundary, and the
executable map tests keep the source declaration, readable projection, authority
class and reach classification aligned.

The causal estimators remain `kernel_primitive`: they decide whether a supported
effect exists but issue nothing. `causal.issuance` performs the canonical
Evidence/Claim/Witness/Derivation binding, so source revocation reaches downstream
causal Claims.

`decision.certificate` likewise remains pure decision mathematics. Product
budget presentation constructs the canonical decision preview before showing a
certificate, and the online controller requires the adapter-produced decision
Claim plus its independent assurance/control-policy gates before any mutation.

`billing.countermodels` remains a kernel primitive because its positive broken-
condition state is arithmetic on the reconciliation run itself; if that state
ever acquires an independent source of judgment, it must be migrated into a
canonical issuance boundary rather than silently gaining authority.

The one `imported_uninvoked` boundary, `alloc.exactRun`, is not an AII-036 bypass:
it is already canonical when invoked. Its classification records product reach,
not epistemic legality.

## What this map does not establish

It does not establish that the canonical boundaries are correct — only that they
route through the kernel, where correctness is enforced by other tests. It does
not establish that the `display_only` and `integrity_only` classifications are
the right *design*, only that those files hold the authority they say they hold.
AII-036's issuance-frontier condition is closed: every mapped strengthening boundary now routes through the kernel contract. This map still does not prove the mathematical or evidential correctness of those boundaries; their domain tests and ledger legality checks carry that burden.

Nor does closing the causal pair make any causal estimate more true. Issuance
adds revocability and an auditable binding; the interval, the joint decision rule
and the qualification gates are unchanged and remain the only things deciding
whether an effect is supported. A study that earned no claim language before
earns none now — it issues its observed difference and no causal claim at all.

Reach is a claim about the import graph and nothing more. That a boundary is
`unreached` does not mean it is harmless, and that one is `product` does not
mean it is wrong — only that if it were wrong, someone would see it.
