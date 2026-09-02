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

## Two axes, not one

Authority class says what a boundary does when it runs. It says nothing about
whether anything runs it, and the difference decides which defect to fix first.

`reach` is the second axis. `product` means the module is in the transitive
import closure of `src/cli.ts` — the entry `bin/fiscus.mjs` runs through
`dist/cli.js` — or of the team-server entry, which imports root source directly.
`unreached` means the module compiles, is tested, and nothing ships it. The test
walks the import graph and compares it against the declaration, so a boundary
that gains or loses a consumer fails until the map is corrected: the moment to
reconsider its queue position, rather than a field to update quietly.

Fourteen of the fifteen boundaries are `product`. `decision.certificate` is not
— nothing imports `src/decision/engine.ts`, and the two modules that name it
(`src/budget/recommend.ts`, `src/value/instrumentationSensitivity.ts`) do so in
comments describing where it is intended to go. That is not dead code to delete
on sight; it is a deliberate primitive without a consumer yet. But it changes
the reading of the three open boundaries below, and it changes their order.

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
| `alloc.exactRun` | `src/alloc/epistemic.ts` | canonical | product | An exact allocation run produced this distribution from these source events |
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
| `decision.certificate` | `src/decision/engine.ts` | **unmigrated_authority** | unreached | One action robustly dominates the alternatives under the declared utility intervals |

Each module states its own class in its own docblock, so a reader opening the
file learns what authority it holds without having to find this page first.

## The three that are open, and what closing each requires

None of the three is currently producing a false result. Each is conservative in
isolation. What they lack is that their conclusions are not bound by a
Derivation to the evidence underneath them — so **revoking a source cannot
invalidate anything downstream of them**, which is the property the kernel
exists to provide and the reason "unchecked" is not the same as "fine".

Two of the three have been closed. `causal.qualification` and `causal.estimate`
were the `product`-reaching pair — the paths on which an unbacked strengthening
could reach an operator today — and `causal.issuance` now carries their output
into the kernel. `decision.certificate` remains, and it cannot reach anyone
because nothing imports it, which lowers its urgency without lowering its
priority: an unwired boundary is precisely the one that gets wired by someone who
never read this page.

**`causal.qualification` and `causal.estimate` — CLOSED by `causal.issuance`.**
The gates were never wrong; they refuse to derive causality from Lift, from a
baseline, or from a historic model comparison, and prefer `collecting` /
`inconclusive` / `invalid` to a flattering conclusion. What was missing was the
binding. The adapter issues the observed arm difference as an OBSERVATIONAL
claim and the effect as a RANDOMIZED one, with a Derivation between them, so
`assessDerivationLegality` demands a `causal_identification` witness and
`appendDerivation` refuses without it. The witness is grounded in the assignment
Evidence alone, which is what puts the effect claim in that evidence's revocation
closure — the property that did not exist before and is what "unchecked is not
the same as fine" was pointing at. Both modules are now `kernel_primitive`: they
decide whether an effect is supported, and issue nothing. See D-081.

**`decision.certificate`** produces a dominance certificate, which is a
decision-fitness claim. It is also `unreached`: nothing in the product imports
`src/decision/engine.ts`, so today it decides nothing for anyone. `src/epistemic/derivation.ts` already refuses
unsupported decision-fitness strengthening — but only for claims routed through
it. Closing this requires issuance at the point the certificate is produced.

## What this map does not establish

It does not establish that the canonical boundaries are correct — only that they
route through the kernel, where correctness is enforced by other tests. It does
not establish that the `display_only` and `integrity_only` classifications are
the right *design*, only that those files hold the authority they say they hold.
And it does not close AII-036: one boundary — `decision.certificate` — is still
openly outside the kernel, and the test asserts that the unmigrated list is
non-empty, so that emptying it requires closing the finding rather than editing
a list.

Nor does closing the causal pair make any causal estimate more true. Issuance
adds revocability and an auditable binding; the interval, the joint decision rule
and the qualification gates are unchanged and remain the only things deciding
whether an effect is supported. A study that earned no claim language before
earns none now — it issues its observed difference and no causal claim at all.

Reach is a claim about the import graph and nothing more. That a boundary is
`unreached` does not mean it is harmless, and that one is `product` does not
mean it is wrong — only that if it were wrong, someone would see it.
