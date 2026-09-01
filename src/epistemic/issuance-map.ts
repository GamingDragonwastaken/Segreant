/**
 * The repository-wide claim-issuance map (AII-036, WP-B01).
 *
 * The kernel primitives are sound. The remaining risk is not that a Claim is
 * built wrongly — it is that a product path mints a stronger semantics beside
 * the kernel and nobody notices, because nothing in the tree says which paths
 * are allowed to do that. This file is that statement, in a form a test can
 * check.
 *
 * Every boundary at which this repository creates or strengthens a claim is
 * listed here with the class of authority it holds:
 *
 *   canonical             issues Evidence/Claim through the kernel; legality
 *                         and non-escalation are enforced there.
 *   kernel_primitive      reasons in kernel types and four-valued state but
 *                         issues nothing. It supplies what a canonical
 *                         boundary needs in order to be legal.
 *   integrity_only        proves who produced a record and that it was not
 *                         altered. It establishes nothing about whether the
 *                         record is TRUE (AII-020).
 *   display_only          projects or formats something already established
 *                         elsewhere. It must not be the first place a stronger
 *                         claim appears.
 *   unmigrated_authority  produces a stronger claim outside the kernel today.
 *                         This is a defect with a name and a queue position,
 *                         not an accepted design.
 *
 * The map is not documentation about the code; `test/issuance-map.test.ts`
 * reads it and the source together. A `canonical` boundary that stops calling
 * the kernel fails. A non-canonical boundary that starts calling it fails. A
 * file that calls `claim()` without appearing here fails — which is the case
 * this exists for, since that is exactly how an alternate authority arrives:
 * one new file, correct in itself, on no map.
 */

/** What kind of authority a boundary holds over the claims it emits. */
export type IssuanceClass =
  | 'canonical'
  | 'kernel_primitive'
  | 'integrity_only'
  | 'display_only'
  | 'unmigrated_authority';

export interface IssuanceBoundary {
  /** Stable identifier, used by the program records and the test failure text. */
  readonly id: string;
  /** Repository-relative module that owns the boundary. */
  readonly module: string;
  /** What a consumer could read out of this boundary's output. */
  readonly asserts: string;
  readonly issuanceClass: IssuanceClass;
  /**
   * For `canonical`: what the kernel legality buys here. For everything else:
   * why this is not an escalation, or — for `unmigrated_authority` — exactly
   * what is wrong and what closing it requires.
   */
  readonly note: string;
}

export const ISSUANCE_MAP: readonly IssuanceBoundary[] = Object.freeze([
  {
    id: 'billing.reconciliation',
    module: 'src/billing/epistemic.ts',
    asserts: 'Provider-billed cost for a period, and its reconciliation against metered usage.',
    issuanceClass: 'canonical',
    note: 'Provider and local Evidence are separate sources; a mixed-basis reconciliation Claim carries both and never collapses them into one settled figure.',
  },
  {
    id: 'economics.periodClose',
    module: 'src/economics/epistemic.ts',
    asserts: 'An economic period is closed, with a basis-separated event snapshot and projection digest.',
    issuanceClass: 'canonical',
    note: 'Issuance is idempotent per finalized period and carries source-event IDs, so a reopened or forged close cannot re-issue.',
  },
  {
    id: 'alloc.exactRun',
    module: 'src/alloc/epistemic.ts',
    asserts: 'An exact allocation run produced this distribution from these source events.',
    issuanceClass: 'canonical',
    note: 'Run identity is digest-derived, so the Claim cannot outlive a change to the result it describes.',
  },
  {
    id: 'value.codingRealization',
    module: 'src/value/epistemic.ts',
    asserts: 'A unit of coding work reached a terminal lifecycle state under the declared gate ladder.',
    issuanceClass: 'canonical',
    note: 'Lifecycle realization only. The retained amount is attributed SPEND, not realized value, and the negative `clean` predicate requires supported completeness witnesses on both event channels.',
  },
  {
    id: 'measurement.completeness',
    module: 'src/measurement/completeness.ts',
    asserts: 'A source completely covers a scope and interval, so absence within it is informative.',
    issuanceClass: 'kernel_primitive',
    note: 'Produces the witness that lets a canonical boundary support a negative claim, and is the reason absence is never silently read as a negative. It issues nothing itself, so it cannot be the place a stronger claim first appears.',
  },
  {
    id: 'git.revertCompleteness',
    module: 'src/git/completeness.ts',
    asserts: 'This git history was completely read for revert evidence over this project and period.',
    issuanceClass: 'kernel_primitive',
    note: 'The first completeness witness the product emits from real evidence. It witnesses coverage, never the absence of a revert: a revert is necessarily newer than what it reverts, so a scan that reached a commit has seen every revert of it. Covers `commit_reverted` only, so the coding `clean` gate still cannot pass on git evidence alone.',
  },
  {
    id: 'outcomes.contract',
    module: 'src/outcomes/contract.ts',
    asserts: 'A domain-neutral outcome contract is confirmed, unresolved, or conflicted.',
    issuanceClass: 'kernel_primitive',
    note: 'Conjunctive over required predicates in four-valued state. An unknown required fact stays unresolved and contradiction stays conflicted, so confirmation cannot be reached by omission. It evaluates a contract; issuing the result is the caller’s boundary.',
  },
  {
    id: 'value.receipt',
    module: 'src/value/receipt.ts',
    asserts: 'This exact record was produced by the holder of this key and has not been altered since.',
    issuanceClass: 'integrity_only',
    note: 'A signature is not a truth claim (AII-020). It authenticates the emitter and fixes the bytes; whether the gate verdicts inside are correct rests entirely on the boundary that produced them. Semantic validation of exact coverage is separate from, and does not inherit strength from, the signature.',
  },
  {
    id: 'team.rollup',
    module: 'src/team/rollup.ts',
    asserts: 'A project-level aggregate of locally computed values, signed for transport.',
    issuanceClass: 'integrity_only',
    note: 'The transport authenticates the sender; it adds nothing to the strength of the values carried. An aggregate of compatibility-basis rows stays compatibility-basis after signing.',
  },
  {
    id: 'dashboard.claimSupport',
    module: 'src/dashboard/claim-support.ts',
    asserts: 'What each of the four product claims\u2019 evidence reaches, on named axes, as sent to any consumer of /api/*.',
    issuanceClass: 'display_only',
    note: 'It states what the payload-building code already knows and issues nothing. It is on this map because it is the first place a consumer meets a claim\u2019s strength as a value rather than as prose \u2014 which is exactly the position from which a stronger semantics gets minted beside the kernel without anyone noticing. Where it cannot tell, it must say unknown.',
  },
  {
    id: 'judge.session',
    module: 'src/judge/orchestrate.ts',
    asserts: 'A model-graded quality judgment for a session.',
    issuanceClass: 'display_only',
    note: 'A judge verdict is one model’s opinion, obtained under a declared trust tier, and a swallowed failure returns a visibly neutral result. It is never converted into a supported quality Claim, and no canonical boundary consumes it.',
  },
  {
    id: 'causal.qualification',
    module: 'src/causal/qualification.ts',
    asserts: 'A local randomized study qualifies as causal evidence, or is collecting, inconclusive, or invalid.',
    issuanceClass: 'unmigrated_authority',
    note: 'This is the observational-to-causal boundary — the single largest strengthening in the product — and it decides outside the kernel. The module is conservative and refuses to derive causality from Lift, a baseline or a model comparison, so it is not currently WRONG; it is unchecked. Closing it requires the qualification to issue a canonical Claim whose Derivation legality refuses causal strengthening without a committed protocol and assignment witness, so that revoking the assignment evidence invalidates the downstream result. Tracked under AII-036 and AII-021.',
  },
  {
    id: 'causal.estimate',
    module: 'src/causal/estimate.ts',
    asserts: 'An assigned-arm difference with a finite-range interval, for a qualified study.',
    issuanceClass: 'unmigrated_authority',
    note: 'Depends on `causal.qualification` and inherits its position. The estimator itself is deliberately unadaptive and pre-declares its bounds; what is missing is that the interval is not carried as kernel uncertainty on an issued Claim, so nothing downstream can be invalidated when the study it rests on is revoked.',
  },
  {
    id: 'decision.certificate',
    module: 'src/decision/engine.ts',
    asserts: 'One action robustly dominates the alternatives under the declared utility intervals, or the comparison is undetermined.',
    issuanceClass: 'unmigrated_authority',
    note: 'A dominance certificate is a decision-fitness claim, and `src/epistemic/derivation.ts` already refuses unsupported decision-fitness strengthening — but only for claims that go through it, and this one does not. The engine is honest in isolation (`undetermined` is a real outcome and a rule-selected action is labelled as such); the gap is that no Derivation binds the certificate to the evidence its intervals came from. Closing it requires issuance at the point the certificate is produced.',
  },
]);

/** Boundaries that mint kernel Evidence/Claim records. */
export const CANONICAL_BOUNDARIES: readonly IssuanceBoundary[] = Object.freeze(
  ISSUANCE_MAP.filter((boundary) => boundary.issuanceClass === 'canonical'),
);

/**
 * Boundaries that strengthen a claim outside the kernel today. Non-empty by
 * design: an empty list would mean AII-036 is closed, and it is not.
 */
export const UNMIGRATED_BOUNDARIES: readonly IssuanceBoundary[] = Object.freeze(
  ISSUANCE_MAP.filter((boundary) => boundary.issuanceClass === 'unmigrated_authority'),
);
