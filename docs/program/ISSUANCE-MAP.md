# Claim-Issuance Map

Every boundary at which this repository creates or strengthens a claim, and the
class of authority it holds. WP-B01, against AII-036.

This document is not the map. `src/epistemic/issuance-map.ts` is the map, and
`test/issuance-map.test.ts` checks it against the source tree; this page is the
readable projection of it, and the test fails if the two disagree in either
direction — a boundary missing here, or a row here for a boundary the code no
longer declares.

## Why a map and not a review

The kernel primitives are sound. Evidence, Claim, Derivation, Witness, the DAG
and the persistence layer all enforce what they promise. The finding that stays
`PARTIAL` is not about them.

The risk is that a product path mints a stronger semantics *beside* the kernel.
That does not arrive as a bad Claim — a bad Claim gets refused. It arrives as
one new file that is entirely correct in itself, computes something a consumer
reasonably reads as established, and is on no list of things that are allowed to
do that. Nothing in a tree of two hundred files says which paths hold authority,
so nothing notices.

So the map is executable. A `canonical` boundary that stops calling the kernel
fails a test. A boundary declared `display_only` that starts issuing fails. A
file anywhere in `src/` that calls `claim({...})` without appearing here fails.

## Classes

| Class | Meaning |
|---|---|
| `canonical` | Issues Evidence/Claim through the kernel. Legality and non-escalation are enforced there. |
| `kernel_primitive` | Reasons in kernel types and four-valued state but issues nothing. It supplies what a canonical boundary needs in order to be legal. |
| `integrity_only` | Proves who produced a record and that it was not altered. Establishes nothing about whether the record is true (AII-020). |
| `display_only` | Projects or formats something established elsewhere. Must not be the first place a stronger claim appears. |
| `unmigrated_authority` | Produces a stronger claim outside the kernel today. A defect with a name and a queue position, not an accepted design. |

## The map

| Boundary | Module | Class | What a consumer could read out of it |
|---|---|---|---|
| `billing.reconciliation` | `src/billing/epistemic.ts` | canonical | Provider-billed cost for a period, and its reconciliation against metered usage |
| `economics.periodClose` | `src/economics/epistemic.ts` | canonical | An economic period is closed, with a basis-separated snapshot and projection digest |
| `alloc.exactRun` | `src/alloc/epistemic.ts` | canonical | An exact allocation run produced this distribution from these source events |
| `value.codingRealization` | `src/value/epistemic.ts` | canonical | A unit of coding work reached a terminal lifecycle state under the declared gate ladder |
| `measurement.completeness` | `src/measurement/completeness.ts` | kernel_primitive | A source completely covers a scope and interval, so absence within it is informative |
| `git.revertCompleteness` | `src/git/completeness.ts` | kernel_primitive | This git history was completely read for revert evidence over this project and period |
| `outcomes.contract` | `src/outcomes/contract.ts` | kernel_primitive | A domain-neutral outcome contract is confirmed, unresolved, or conflicted |
| `value.receipt` | `src/value/receipt.ts` | integrity_only | This exact record was produced by the holder of this key and has not been altered |
| `team.rollup` | `src/team/rollup.ts` | integrity_only | A project-level aggregate of locally computed values, signed for transport |
| `judge.session` | `src/judge/orchestrate.ts` | display_only | A model-graded quality judgment for a session |
| `causal.qualification` | `src/causal/qualification.ts` | **unmigrated_authority** | A local randomized study qualifies as causal evidence |
| `causal.estimate` | `src/causal/estimate.ts` | **unmigrated_authority** | An assigned-arm difference with a finite-range interval |
| `decision.certificate` | `src/decision/engine.ts` | **unmigrated_authority** | One action robustly dominates the alternatives under the declared utility intervals |

Each module states its own class in its own docblock, so a reader opening the
file learns what authority it holds without having to find this page first.

## The three that are open, and what closing each requires

None of the three is currently producing a false result. Each is conservative in
isolation. What they lack is that their conclusions are not bound by a
Derivation to the evidence underneath them — so **revoking a source cannot
invalidate anything downstream of them**, which is the property the kernel
exists to provide and the reason "unchecked" is not the same as "fine".

**`causal.qualification`** is the observational-to-causal boundary: the single
largest claim strengthening in the product. The gates refuse to derive causality
from Lift, from a baseline, or from a historic model comparison, and prefer
`collecting` / `inconclusive` / `invalid` to a flattering conclusion. Closing it
requires qualification to issue a canonical Claim whose Derivation legality
refuses causal strengthening without a committed protocol and an assignment
witness. Then revoking the assignment evidence invalidates the result, which
today it cannot.

**`causal.estimate`** depends on the above and inherits its position. Its
interval bounds are declared before outcome collection and it does not adapt.
What is missing is that the interval is not carried as kernel uncertainty on an
issued Claim.

**`decision.certificate`** produces a dominance certificate, which is a
decision-fitness claim. `src/epistemic/derivation.ts` already refuses
unsupported decision-fitness strengthening — but only for claims routed through
it. Closing this requires issuance at the point the certificate is produced.

## What this map does not establish

It does not establish that the canonical boundaries are correct — only that they
route through the kernel, where correctness is enforced by other tests. It does
not establish that the `display_only` and `integrity_only` classifications are
the right *design*, only that those files hold the authority they say they hold.
And it does not close AII-036: three boundaries are openly outside the kernel,
and the test asserts that the unmigrated list is non-empty, so that emptying it
requires closing the finding rather than editing a list.
