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
 * A SECOND AXIS: WHETHER THE PRODUCT ACTUALLY REACHES IT. Authority class says
 * what a boundary does when it runs. It says nothing about whether anything
 * runs it, and the difference decides which defect to fix first. An
 * `unmigrated_authority` on a path the CLI reaches can put an unbacked
 * conclusion in front of an operator today; one nothing imports cannot, however
 * wrong it would be if wired. Both belong on the map — a latent boundary is the
 * one most likely to be wired by someone who never read this file — but calling
 * them the same risk misdirects the work.
 *
 * `reach` is DECLARED here and CHECKED by the test, which walks the import
 * graph from the CLI entry point rather than trusting the field. A boundary
 * that gains or loses a consumer therefore fails until the declaration is
 * corrected, which is the moment to reconsider its queue position.
 *
 * IMPORTED AND INVOKED ARE DIFFERENT FACTS, AND THIS FILE USED TO CONFLATE
 * THEM (D-184). The paragraph above says authority class "says nothing about
 * whether anything RUNS it" and hands that question to `reach` -- but the check
 * walks IMPORTS, and a module can sit in the closure while no product path ever
 * calls into it. `alloc.exactRun` was exactly that: declared `product` because
 * `src/store/db.ts` imports it, while the only mentions of the forwarder
 * `Store.saveExactAllocationRun` anywhere in `src/` are its own definition and
 * that forwarder. No CLI command and no route calls it. Since `reach` decides
 * queue position, an overstated one misdirects the work this map exists to
 * direct. There are now three values, and `invocation` below is how the third
 * is checked -- for the boundaries that declare it, which is not yet all of
 * them, and the test states that count out loud rather than implying it.
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

/**
 * Whether any product path reaches this boundary, on the two axes that differ.
 *
 * `unreached` — the module is not in the transitive import closure of
 * `src/cli.ts` (the entry `bin/fiscus.mjs` runs through `dist/cli.js`) or of the
 * team-server entry, which imports root source directly. It compiles, it is
 * tested, and nothing ships it.
 *
 * `imported_uninvoked` — the module IS in that closure and no product file
 * outside its own definition names the entry point that would run it. It ships,
 * and an operator still cannot meet it. This is the state `alloc.exactRun` was
 * in while declared `product` (D-184).
 *
 * `product` — imported AND named by a product file outside its own module.
 * A mention is not a call, so this is the weaker half of the pair on purpose:
 * the check can prove that nothing invokes a boundary, never that something
 * does.
 */
export type IssuanceReach = 'product' | 'imported_uninvoked' | 'unreached';

export interface IssuanceBoundary {
  /** Stable identifier, used by the program records and the test failure text. */
  readonly id: string;
  /** Repository-relative module that owns the boundary. */
  readonly module: string;
  /** What a consumer could read out of this boundary's output. */
  readonly asserts: string;
  readonly issuanceClass: IssuanceClass;
  /** Declared here, checked against the import graph by the test. */
  readonly reach: IssuanceReach;
  /**
   * The entry point a PRODUCT file must name for this boundary to actually run
   * (D-184). Optional only because tracing seventeen call chains is work that
   * has been done for four of them so far; the test asserts that count out
   * loud, so the gap stays visible instead of reading as coverage.
   *
   * `definedIn` lists the modules that define or merely FORWARD the symbol. A
   * mention there proves nothing — `Store.saveExactAllocationRun` forwards to
   * the allocation issuance and is itself called by no product path, which is
   * the whole case this field exists to catch.
   */
  readonly invocation: {
    readonly symbol: string;
    readonly definedIn: readonly string[];
  };
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
    reach: 'product',
    invocation: { symbol: 'issueOpenAiReconciliationToKernel', definedIn: ['src/store/db.ts'] },
    note: 'Provider and local Evidence are separate sources; a mixed-basis reconciliation Claim carries both and never collapses them into one settled figure.',
  },
  {
    id: 'economics.periodClose',
    module: 'src/economics/epistemic.ts',
    asserts: 'An economic period is closed, with a basis-separated event snapshot and projection digest.',
    issuanceClass: 'canonical',
    reach: 'product',
    invocation: { symbol: 'issueEconomicPeriodCloseToKernel', definedIn: ['src/store/db.ts'] },
    note: 'Issuance is idempotent per finalized period and carries source-event IDs, so a reopened or forged close cannot re-issue.',
  },
  {
    id: 'alloc.exactRun',
    module: 'src/alloc/epistemic.ts',
    asserts: 'An exact allocation run produced this distribution from these source events.',
    issuanceClass: 'canonical',
    // Imported by `src/store/db.ts` and invoked by nothing (D-184). The exact
    // allocation path is the one AII-017/AII-018 are migrating everything
    // toward, so this is a boundary on the authoritative money path that no
    // operator can currently reach -- which lowers its urgency and raises the
    // odds that it is wired one day by someone who never opened this file.
    reach: 'imported_uninvoked',
    invocation: { symbol: 'saveExactAllocationRun', definedIn: ['src/store/db.ts', 'src/store/allocation.ts'] },
    note: 'Run identity is digest-derived, so the Claim cannot outlive a change to the result it describes. Nothing in the product calls `Store.saveExactAllocationRun`, so the run this describes is never produced outside tests.',
  },
  {
    id: 'value.codingRealization',
    module: 'src/value/epistemic.ts',
    asserts: 'A unit of coding work reached a terminal lifecycle state under the declared gate ladder.',
    issuanceClass: 'canonical',
    reach: 'product',
    invocation: { symbol: 'saveRealizationUnits', definedIn: ['src/store/db.ts', 'src/store/realization.ts'] },
    note: 'Lifecycle realization only. The retained amount is attributed SPEND, not realized value, and the negative `clean` predicate requires supported completeness witnesses on both event channels.',
  },
  {
    id: 'measurement.completeness',
    module: 'src/measurement/completeness.ts',
    asserts: 'A source completely covers a scope and interval, so absence within it is informative.',
    issuanceClass: 'kernel_primitive',
    reach: 'product',
    invocation: { symbol: 'assessCompleteness', definedIn: ['src/measurement/completeness.ts'] },
    note: 'Produces the witness that lets a canonical boundary support a negative claim, and is the reason absence is never silently read as a negative. It issues nothing itself, so it cannot be the place a stronger claim first appears.',
  },
  {
    id: 'git.revertCompleteness',
    module: 'src/git/completeness.ts',
    asserts: 'This git history was completely read for revert evidence over this project and period.',
    issuanceClass: 'kernel_primitive',
    reach: 'product',
    invocation: { symbol: 'revertCompletenessWitness', definedIn: ['src/git/completeness.ts'] },
    note: 'The first completeness witness the product emits from real evidence. It witnesses coverage, never the absence of a revert: a revert is necessarily newer than what it reverts, so a scan that reached a commit has seen every revert of it. Covers `commit_reverted` only, so the coding `clean` gate still cannot pass on git evidence alone.',
  },
  {
    id: 'outcomes.contract',
    module: 'src/outcomes/contract.ts',
    asserts: 'A domain-neutral outcome contract is confirmed, unresolved, or conflicted.',
    issuanceClass: 'kernel_primitive',
    reach: 'product',
    invocation: { symbol: 'evaluateOutcomeContract', definedIn: ['src/outcomes/contract.ts'] },
    note: 'Conjunctive over required predicates in four-valued state. An unknown required fact stays unresolved and contradiction stays conflicted, so confirmation cannot be reached by omission. It evaluates a contract; issuing the result is the caller’s boundary.',
  },
  {
    id: 'value.receipt',
    module: 'src/value/receipt.ts',
    asserts: 'This exact record was produced by the holder of this key and has not been altered since.',
    issuanceClass: 'integrity_only',
    reach: 'product',
    invocation: { symbol: 'signReceipt', definedIn: ['src/value/receipt.ts'] },
    note: 'A signature is not a truth claim (AII-020). It authenticates the emitter and fixes the bytes; whether the gate verdicts inside are correct rests entirely on the boundary that produced them. Semantic validation of exact coverage is separate from, and does not inherit strength from, the signature.',
  },
  {
    id: 'team.rollup',
    module: 'src/team/rollup.ts',
    asserts: 'A project-level aggregate of locally computed values, signed for transport.',
    issuanceClass: 'integrity_only',
    reach: 'product',
    invocation: { symbol: 'signRollup', definedIn: ['src/team/rollup.ts'] },
    note: 'The transport authenticates the sender; it adds nothing to the strength of the values carried. An aggregate of compatibility-basis rows stays compatibility-basis after signing.',
  },
  {
    id: 'dashboard.claimSupport',
    module: 'src/dashboard/claim-support.ts',
    asserts: 'What each of the four product claims\u2019 evidence reaches, on named axes, as sent to any consumer of /api/*.',
    issuanceClass: 'display_only',
    reach: 'product',
    invocation: { symbol: 'meteredClaimSupport', definedIn: ['src/dashboard/claim-support.ts'] },
    note: 'It states what the payload-building code already knows and issues nothing. It is on this map because it is the first place a consumer meets a claim\u2019s strength as a value rather than as prose \u2014 which is exactly the position from which a stronger semantics gets minted beside the kernel without anyone noticing. Where it cannot tell, it must say unknown.',
  },
  {
    id: 'judge.session',
    module: 'src/judge/orchestrate.ts',
    asserts: 'A model-graded quality judgment for a session.',
    issuanceClass: 'display_only',
    reach: 'product',
    invocation: { symbol: 'judgeSessionFromStore', definedIn: ['src/judge/orchestrate.ts'] },
    note: 'A judge verdict is one model’s opinion, obtained under a declared trust tier, and a swallowed failure returns a visibly neutral result. It is never converted into a supported quality Claim, and no canonical boundary consumes it.',
  },
  {
    id: 'causal.qualification',
    module: 'src/causal/qualification.ts',
    asserts: 'A local randomized study qualifies as causal evidence, or is collecting, inconclusive, or invalid.',
    issuanceClass: 'kernel_primitive',
    reach: 'product',
    invocation: { symbol: 'qualifyCausalStudy', definedIn: ['src/causal/qualification.ts'] },
    note: 'Decides whether a local randomized study is structurally sound, and issues nothing. `causal.issuance` is the boundary that converts a qualified study into kernel records, and it mints the `causal_identification` witness ONLY from a qualification this module returned as `qualified` — so an unsound study cannot produce a legal derivation. It was `unmigrated_authority` until that adapter existed (AII-036, AII-021): the gates were conservative and correct, and the conclusion was bound to nothing.',
  },
  {
    id: 'causal.estimate',
    module: 'src/causal/estimate.ts',
    asserts: 'An assigned-arm difference with a finite-range interval, for a qualified study.',
    issuanceClass: 'kernel_primitive',
    reach: 'product',
    invocation: { symbol: 'estimateCausalStudy', definedIn: ['src/causal/estimate.ts'] },
    note: 'Depends on `causal.qualification` and inherits its position. The estimator is deliberately unadaptive and pre-declares its bounds; `causal.issuance` now carries the interval and the joint decision rule onto an issued Claim, so revoking the study evidence invalidates what was derived from it. The estimator still decides whether an effect is supported — issuance refuses to mint a causal claim it did not already authorise, and adds revocability rather than strength.',
  },
  {
    id: 'causal.issuance',
    module: 'src/causal/epistemic.ts',
    asserts: 'A randomized local study supports a causal effect, bound by a Derivation to the randomization that identifies it.',
    issuanceClass: 'canonical',
    reach: 'product',
    invocation: { symbol: 'issueCausalStudyToKernel', definedIn: ['src/store/db.ts'] },
    note: 'Issues the observed arm difference as an OBSERVATIONAL claim and the effect as a RANDOMIZED one, with a Derivation between them. The kernel only checks strengthening, so a single claim asserting `randomized` would have been legal and would have rebuilt the defect in kernel types; the axis gap is what forces a `causal_identification` witness to exist and `appendDerivation` to refuse without it. The witness is grounded in the assignment Evidence alone, which is what puts the effect claim in that evidence’s revocation closure.',
  },
  {
    id: 'billing.countermodels',
    module: 'src/billing/countermodels.ts',
    asserts: 'What the reconciliation residual degrades to if one of its stated conditions is false, and whether anything Fiscus has could tell.',
    issuanceClass: 'kernel_primitive',
    reach: 'product',
    invocation: { symbol: 'reconciliationCountermodels', definedIn: ['src/billing/countermodels.ts'] },
    note: 'It weakens rather than strengthens, which is why it is not canonical, but it belongs on this map for the opposite reason to most entries: the `realized` status is a positive assertion about the world — a negative residual establishes that the rate card over-prices on-path traffic — and it reaches an operator through `fiscus billing reconcile` without a kernel record behind it. That is tolerable only because it is derived from arithmetic on the run itself rather than from judgement, and it is the thing to migrate first if these worlds ever acquire a source other than the run.',
  },
  {
    id: 'decision.certificate',
    module: 'src/decision/engine.ts',
    asserts: 'One action robustly dominates the alternatives under the declared utility intervals, or the comparison is undetermined.',
    issuanceClass: 'unmigrated_authority',
    reach: 'unreached',
    invocation: { symbol: 'certifyDecision', definedIn: ['src/decision/engine.ts'] },
    note: 'The pure engine computes a plain certificate but issues no kernel record. Closing it requires every consequential certificate path to use the canonical adapter when a decision certificate becomes a durable claim.',
  },
  {
    id: 'decision.certificate.issuance',
    module: 'src/decision/epistemic.ts',
    asserts: 'One action robustly dominates the alternatives under the declared utility intervals, or the comparison is undetermined.',
    issuanceClass: 'canonical',
    reach: 'unreached',
    invocation: { symbol: 'issueDecisionToKernel', definedIn: ['src/decision/epistemic.ts'] },
    note: 'The engine remains a pure decision primitive. This adapter binds a recomputed proven certificate to an observational interval Claim, a decision_fitness Witness, and a Derivation; undetermined certificates issue only the observation. The adapter is currently tested but unreached, so the next product step is a reviewed consumer that persists it before action.',
  },
]);

/** Boundaries that mint kernel Evidence/Claim records. */
export const CANONICAL_BOUNDARIES: readonly IssuanceBoundary[] = Object.freeze(
  ISSUANCE_MAP.filter((boundary) => boundary.issuanceClass === 'canonical'),
);

/** Boundaries some product path actually reaches. */
export const LIVE_BOUNDARIES: readonly IssuanceBoundary[] = Object.freeze(
  ISSUANCE_MAP.filter((boundary) => boundary.reach === 'product'),
);

/**
 * Boundaries nothing imports.
 *
 * Not dead code to delete on sight — `src/decision/engine.ts` is a deliberate
 * primitive whose intended consumers are named in `src/budget/recommend.ts` and
 * `src/value/instrumentationSensitivity.ts` — but a latent boundary and a
 * shipping one are different risks, and the migration queue should say which it
 * is looking at.
 */
export const UNREACHED_BOUNDARIES: readonly IssuanceBoundary[] = Object.freeze(
  ISSUANCE_MAP.filter((boundary) => boundary.reach === 'unreached'),
);

/**
 * Boundaries the product SHIPS and never calls (D-184).
 *
 * Between the two lists above, and the reason there are three: a module in the
 * import closure that no product path invokes is shipped and unreachable at
 * once. It cannot put a wrong conclusion in front of an operator today, so it
 * is not `product`; it is not latent in the way an unimported module is either,
 * because it is already inside everything that ships and one call site away
 * from running. Reading it as `product` overstates the urgency; reading it as
 * `unreached` understates the exposure.
 *
 * Only boundaries that DECLARE an `invocation` entry point can land here, so
 * this list is a lower bound on the real one and the test says how many have
 * been traced at all.
 */
export const IMPORTED_UNINVOKED_BOUNDARIES: readonly IssuanceBoundary[] = Object.freeze(
  ISSUANCE_MAP.filter((boundary) => boundary.reach === 'imported_uninvoked'),
);

/**
 * Boundaries that strengthen a claim outside the kernel today. Non-empty by
 * design: an empty list would mean AII-036 is closed, and it is not.
 */
export const UNMIGRATED_BOUNDARIES: readonly IssuanceBoundary[] = Object.freeze(
  ISSUANCE_MAP.filter((boundary) => boundary.issuanceClass === 'unmigrated_authority'),
);
