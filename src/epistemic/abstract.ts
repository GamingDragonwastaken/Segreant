/**
 * Abstract interpretation over the claim lattice (WP-R01).
 *
 * WHAT THIS ADDS THAT THE KERNEL DID NOT HAVE. `assessDerivationLegality`
 * checks ONE step against ONE input claim. `assessPreservation` checks ONE
 * claim against its cited evidence. Neither of them, and nothing else in
 * `src/`, bounds what a whole DERIVATION CHAIN can establish. A conclusion four
 * merges downstream of its leaves was compared with its immediate predecessors
 * and with nothing else.
 *
 * THE DOMAIN IS THE AXIS LATTICE, THE TRANSFER FUNCTION IS THE DERIVATION RULE,
 * AND SOUNDNESS IS "THE CONCRETE RESULT IS BELOW THE ABSTRACT BOUND". A
 * `ClaimBound` is what a set of inputs LICENSES on each axis, not what some
 * claim happens to carry. `derivedBound` pushes bounds across one derivation;
 * `analyzeDerivationChain` folds it over a DAG and checks every conclusion.
 *
 * TWO KINDS OF AXIS, AND THE SPLIT IS NOT THIS MODULE'S INVENTION.
 * `admissibility.ts` already declares it: `ORDERED_AXES` are ladders where a
 * minimum is meaningful, and `UNORDERED_AXES` — `monetaryBasis` and
 * `epistemic` — are sets of alternatives where any ranking would be invented.
 * So an ordered axis is bounded by a CEILING and an unordered axis by an
 * ADMISSIBLE SET. `monetaryBasis` never acquires an ordering here, and the one
 * thing this module refuses to do is give it one.
 *
 * WHICH DIRECTION THIS ERRS IN, AND WHY THAT IS THE SAFE ONE. Every choice
 * below narrows the bound rather than widening it. An unresolved input claim
 * yields BOTTOM, not "ignore it". Disagreeing monetary bases yield `mixed`, not
 * the stronger of the two. A conflicted epistemic join admits only `conflicted`,
 * not a collapse to `supported`. The failure this module exists to prevent is a
 * bound that says a chain CAN establish something it cannot; a bound that is
 * too tight produces a false refusal, which costs a caller an explicit witness
 * and costs the reader nothing. Withhold rather than inflate.
 *
 * THIS IS AN ADDITIONAL GATE, NOT A REPLACEMENT. It does not weaken, reorder,
 * or bypass any existing check, and the ledger's per-step refusals stand
 * unchanged. Where this module refuses something the ledger allows — the
 * monetary basis case below — the ledger is the one that is short.
 *
 * WHAT IT DOES NOT DO: it never says a proposition is TRUE. A bound is about
 * what the evidence structure licenses, in the same sense as
 * `PreservationAssessment.isProofOfTruth: false`.
 */

import {
  AUTHENTICITY,
  CAUSALITY,
  COVERAGE,
  DECISION_FITNESS,
  FINALITY,
  INTEGRITY,
  MEASUREMENT,
  MONETARY_BASIS,
  SCOPE_STATUS,
  type ClaimProfile,
  type MonetaryBasisStatus,
} from './profile.ts';
import { EPISTEMIC_STATES, informationJoin, informationLeq, type EpistemicState } from './state.ts';
import { PROFILE_STRENGTH_AXES, type Derivation, type DerivationWitnessKind } from './derivation.ts';
import type { Claim } from './claim.ts';

/** The eight ladder axes, in the order `admissibility.ts` declares them. */
export const BOUNDED_ORDERED_AXES = [
  'integrity', 'authenticity', 'scope', 'coverage', 'measurement', 'causality', 'finality', 'decisionFitness',
] as const;
export type BoundedOrderedAxis = (typeof BOUNDED_ORDERED_AXES)[number];

const AXIS_ORDERS: Readonly<Record<BoundedOrderedAxis, readonly string[]>> = Object.freeze({
  integrity: INTEGRITY,
  authenticity: AUTHENTICITY,
  scope: SCOPE_STATUS,
  coverage: COVERAGE,
  measurement: MEASUREMENT,
  causality: CAUSALITY,
  finality: FINALITY,
  decisionFitness: DECISION_FITNESS,
});

/**
 * Axis -> witness kind, read from `derivation.ts` rather than restated.
 *
 * A missing entry would silently mean "this axis can never be lifted", so the
 * mapping is built once and every ordered axis must appear in it.
 */
const AXIS_WITNESS: Readonly<Record<BoundedOrderedAxis, DerivationWitnessKind>> = Object.freeze(
  (() => {
    const mapping: Partial<Record<BoundedOrderedAxis, DerivationWitnessKind>> = {};
    for (const axis of PROFILE_STRENGTH_AXES) {
      if ((BOUNDED_ORDERED_AXES as readonly string[]).includes(axis.source)) {
        mapping[axis.source as BoundedOrderedAxis] = axis.key;
      }
    }
    for (const axis of BOUNDED_ORDERED_AXES) {
      if (mapping[axis] === undefined) {
        throw new Error(`ordered axis ${axis} has no declared witness kind in PROFILE_STRENGTH_AXES`);
      }
    }
    return mapping as Record<BoundedOrderedAxis, DerivationWitnessKind>;
  })(),
);

/**
 * THE AXIS `assessDerivationLegality` PLACES NO CONSTRAINT ON.
 *
 * `PROFILE_STRENGTH_AXES` covers the eight ladders and `epistemic` is handled
 * beside it, which leaves `monetaryBasis` — the axis carrying the distinction
 * the whole product is built on — checked by nothing on the derivation path.
 * Measured, not argued: a chain whose leaves are `list` and `estimated` derives
 * a `billed` conclusion with `allowed: true` and `requiredWitnesses: []`, and
 * the ledger stores it.
 *
 * `metered usage != provider-billed cost` is exactly what that collapses.
 */
export const MONETARY_BASIS_IS_UNGUARDED_HERE = 'monetaryBasis' as const;

/** A basis that asserts no economic quantity at all — always a legal weakening. */
const NO_BASIS: MonetaryBasisStatus = 'none';
/** The label `mergeClaimProfiles` produces for disagreement. Never a strengthening. */
const MIXED_BASIS: MonetaryBasisStatus = 'mixed';

/**
 * What a set of inputs licenses, per axis.
 *
 * An ordered axis carries a CEILING: every value at or below it is admissible.
 * `null` is BOTTOM for that axis — nothing is admissible, which is what an
 * unresolved input produces. The two unordered axes carry an admissible SET,
 * canonically ordered by their declared constant, and an empty set is BOTTOM.
 */
export interface ClaimBound {
  readonly integrity: string | null;
  readonly authenticity: string | null;
  readonly scope: string | null;
  readonly coverage: string | null;
  readonly measurement: string | null;
  readonly causality: string | null;
  readonly finality: string | null;
  readonly decisionFitness: string | null;
  readonly epistemic: readonly EpistemicState[];
  readonly monetaryBasis: readonly MonetaryBasisStatus[];
}

export interface AxisViolation {
  readonly axis: BoundedOrderedAxis | 'epistemic' | 'monetaryBasis';
  /** What the conclusion carries. */
  readonly actual: string;
  /** What the chain licenses, rendered for a reader. */
  readonly licensed: string;
  readonly message: string;
}

function canonical<T extends string>(values: Iterable<T>, order: readonly string[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
}

function rank(axis: BoundedOrderedAxis, value: string): number {
  const index = AXIS_ORDERS[axis].indexOf(value);
  if (index < 0) throw new Error(`${axis} carries a value outside its declared order: ${value}`);
  return index;
}

/** Nothing is admissible on any axis. An unresolved input abstracts to this. */
export const BOTTOM_BOUND: ClaimBound = Object.freeze({
  integrity: null,
  authenticity: null,
  scope: null,
  coverage: null,
  measurement: null,
  causality: null,
  finality: null,
  decisionFitness: null,
  epistemic: Object.freeze([]),
  monetaryBasis: Object.freeze([]),
});

/** Everything is admissible. Only a caller declaring an unconstrained root uses this. */
export const TOP_BOUND: ClaimBound = Object.freeze({
  integrity: INTEGRITY[INTEGRITY.length - 1]!,
  authenticity: AUTHENTICITY[AUTHENTICITY.length - 1]!,
  scope: SCOPE_STATUS[SCOPE_STATUS.length - 1]!,
  coverage: COVERAGE[COVERAGE.length - 1]!,
  measurement: MEASUREMENT[MEASUREMENT.length - 1]!,
  causality: CAUSALITY[CAUSALITY.length - 1]!,
  finality: FINALITY[FINALITY.length - 1]!,
  decisionFitness: DECISION_FITNESS[DECISION_FITNESS.length - 1]!,
  epistemic: canonical(EPISTEMIC_STATES, EPISTEMIC_STATES),
  monetaryBasis: canonical(MONETARY_BASIS, MONETARY_BASIS),
});

/**
 * Abstraction (alpha) of one concrete profile.
 *
 * A claim is its own strongest bound: it licenses exactly what it carries, and
 * on the unordered axes exactly that value plus the weakening below.
 *   - `epistemic`: everything the information order puts at or below it, since
 *     discarding a polarity withholds and adding one inflates.
 *   - `monetaryBasis`: the basis itself, plus `none`. Dropping the economic
 *     quantity is always available; acquiring one is not.
 */
export function claimBound(profile: ClaimProfile): ClaimBound {
  return Object.freeze({
    integrity: profile.integrity,
    authenticity: profile.authenticity,
    scope: profile.scope,
    coverage: profile.coverage,
    measurement: profile.measurement,
    causality: profile.causality,
    finality: profile.finality,
    decisionFitness: profile.decisionFitness,
    epistemic: downwardClosure(profile.epistemic),
    monetaryBasis: canonical(
      profile.monetaryBasis === NO_BASIS ? [NO_BASIS] : [profile.monetaryBasis, NO_BASIS],
      MONETARY_BASIS,
    ),
  });
}

/** Every state whose polarities are contained in `ceiling`, conflict retained. */
function downwardClosure(ceiling: EpistemicState): readonly EpistemicState[] {
  const below = EPISTEMIC_STATES.filter((state) => informationLeq(state, ceiling));
  // A conflicted ceiling means two sources disagree. Reporting either side alone
  // would present a disagreement as settled, so only `conflicted` stays.
  return canonical(ceiling === 'conflicted' ? ['conflicted'] : below, EPISTEMIC_STATES);
}

/** The information-order top of an admissible set; null when the set is BOTTOM. */
function epistemicCeiling(states: readonly EpistemicState[]): EpistemicState | null {
  if (states.length === 0) return null;
  return states.reduce((left, right) => informationJoin(left, right));
}

/** Everything the set positively asserts — `none` is the withholding option, not an assertion. */
function assertedBases(bases: readonly MonetaryBasisStatus[]): readonly MonetaryBasisStatus[] {
  return bases.filter((basis) => basis !== NO_BASIS);
}

/**
 * Meet of two bounds: what BOTH inputs license.
 *
 * Weakness propagates. This is the same quantifier `assertClaimWithinItsEvidence`
 * settled on for cited evidence and for the same reason — every input is a
 * prerequisite, so withdrawing one withdraws the conclusion, and a maximum would
 * let one strong input launder the others.
 */
export function meetClaimBounds(a: ClaimBound, b: ClaimBound): ClaimBound {
  const merged: Record<string, unknown> = {};
  for (const axis of BOUNDED_ORDERED_AXES) {
    const left = a[axis];
    const right = b[axis];
    merged[axis] = left === null || right === null
      ? null
      : AXIS_ORDERS[axis][Math.min(rank(axis, left), rank(axis, right))]!;
  }

  const leftCeiling = epistemicCeiling(a.epistemic);
  const rightCeiling = epistemicCeiling(b.epistemic);
  // A merge SEES both inputs' polarities, so the combined ceiling is their
  // join — and a join that lands on `conflicted` admits only `conflicted`.
  merged['epistemic'] = leftCeiling === null || rightCeiling === null
    ? Object.freeze([])
    : downwardClosure(informationJoin(leftCeiling, rightCeiling));

  merged['monetaryBasis'] = meetBases(a.monetaryBasis, b.monetaryBasis);
  return Object.freeze(merged as unknown as ClaimBound);
}

/**
 * THE RULE THAT WAS MISSING, AND IT IS NOT A LADDER.
 *
 * `mergeClaimProfiles` already answers this for profiles: identical bases pass
 * through, differing bases become `mixed`. That is not an ordering and this is
 * not one either — `mixed` is the honest label for disagreement, not a rung
 * above `billed`. Applied to bounds:
 *
 *   - both sides BOTTOM, or either side BOTTOM  -> BOTTOM.
 *   - one side asserts nothing (`none` only)    -> the other side, unchanged.
 *     A claim with no economic quantity has nothing to disagree with.
 *   - both assert the same set                  -> that set.
 *   - otherwise                                 -> `mixed` alone.
 *
 * `none` is then always re-added, because dropping the economic quantity is a
 * weakening and weakenings are always available.
 */
function meetBases(
  a: readonly MonetaryBasisStatus[],
  b: readonly MonetaryBasisStatus[],
): readonly MonetaryBasisStatus[] {
  if (a.length === 0 || b.length === 0) return Object.freeze([]);
  const left = assertedBases(a);
  const right = assertedBases(b);
  if (left.length === 0) return canonical([...b, NO_BASIS], MONETARY_BASIS);
  if (right.length === 0) return canonical([...a, NO_BASIS], MONETARY_BASIS);
  const same = left.length === right.length && left.every((basis) => right.includes(basis));
  if (same) return canonical([...left, NO_BASIS], MONETARY_BASIS);
  return canonical([MIXED_BASIS, NO_BASIS], MONETARY_BASIS);
}

/**
 * A declared re-basing: `from` may legitimately be derived into `to`.
 *
 * DELIBERATELY EMPTY, IN THE STYLE OF `DIMENSION_ROLLUPS`. Allocation is the
 * obvious candidate — `ledger.ts` says so in as many words, that "a claim whose
 * basis differs from its evidence is often a legitimate derivation — allocation
 * is exactly that" — but which bases allocate into which is a statement about
 * this product's economics, and inventing one here to make a bound look useful
 * would be the exact inflation this module exists to refuse.
 *
 * AN EMPTY REGISTER MEANS "NOBODY HAS DECLARED ONE", NOT "NONE EXIST", the same
 * distinction `admits` carries as `stated: false`. Callers that know their own
 * re-basings declare them per analysis via `licensedBasisTransitions`, where the
 * declaration is visible at the call site instead of buried in a default.
 *
 * ADDING AN ENTRY IS A DECISION. It asserts that a figure on `to` can be
 * computed from a figure on `from` without new evidence. The reverse direction
 * is never implied, and `billed` is reachable from nothing: a provider-billed
 * amount is a fact about a provider statement, not a transformation of an
 * estimate.
 */
export const BASIS_DERIVATIONS: ReadonlyArray<readonly [from: MonetaryBasisStatus, to: MonetaryBasisStatus]> =
  Object.freeze([]);

export interface DerivedBoundOptions {
  /**
   * Re-basings this caller declares, beyond `BASIS_DERIVATIONS`. Each entry
   * widens the monetary bound and is the caller's assertion, recorded in the
   * analysis it produced.
   */
  readonly licensedBasisTransitions?: ReadonlyArray<readonly [MonetaryBasisStatus, MonetaryBasisStatus]>;
}

/**
 * THE TRANSFER FUNCTION. Bound the strongest conclusion these inputs support.
 *
 * Call it BEFORE running a derivation to know what the result may say, and
 * compare a conclusion against it afterwards with `boundViolations`.
 *
 * A witness lifts its axis to the top of that axis. That is exactly what
 * `assessDerivationLegality` does with the same witness kind, and the looseness
 * is inherited rather than introduced: this abstraction is only as tight as the
 * kernel's witness discipline, and a witness that overstates its own reach
 * overstates this bound too.
 *
 * NO INPUTS IS BOTTOM, NOT TOP. A derivation with nothing to rest on licenses
 * nothing; the alternative reading — "unconstrained" — is how an empty
 * requirement becomes a passed one.
 */
export function derivedBound(
  inputs: readonly ClaimBound[],
  witnessKinds: readonly DerivationWitnessKind[],
  options: DerivedBoundOptions = {},
): ClaimBound {
  if (inputs.length === 0) return BOTTOM_BOUND;
  const met = inputs.reduce((left, right) => meetClaimBounds(left, right));

  const lifted: Record<string, unknown> = {};
  for (const axis of BOUNDED_ORDERED_AXES) {
    lifted[axis] = witnessKinds.includes(AXIS_WITNESS[axis])
      ? AXIS_ORDERS[axis][AXIS_ORDERS[axis].length - 1]!
      : met[axis];
  }
  lifted['epistemic'] = witnessKinds.includes('epistemic_resolution')
    ? canonical(EPISTEMIC_STATES, EPISTEMIC_STATES)
    : met.epistemic;

  const transitions = [...BASIS_DERIVATIONS, ...(options.licensedBasisTransitions ?? [])];
  const reachable = new Set<MonetaryBasisStatus>(met.monetaryBasis);
  if (met.monetaryBasis.length > 0) {
    for (const basis of assertedBases(met.monetaryBasis)) {
      for (const [from, to] of transitions) if (from === basis) reachable.add(to);
    }
    reachable.add(NO_BASIS);
  }
  lifted['monetaryBasis'] = canonical(reachable, MONETARY_BASIS);

  return Object.freeze(lifted as unknown as ClaimBound);
}

/** Is this concrete profile below the abstract bound? Empty means yes. */
export function boundViolations(profile: ClaimProfile, bound: ClaimBound): readonly AxisViolation[] {
  const violations: AxisViolation[] = [];
  for (const axis of BOUNDED_ORDERED_AXES) {
    const ceiling = bound[axis];
    const actual = profile[axis];
    if (ceiling === null) {
      violations.push({
        axis,
        actual,
        licensed: 'nothing',
        message: `${axis} ${actual} is above a bound that licenses nothing on this axis`,
      });
      continue;
    }
    if (rank(axis, actual) > rank(axis, ceiling)) {
      violations.push({
        axis,
        actual,
        licensed: `at most ${ceiling}`,
        message: `${axis} ${actual} exceeds the ${ceiling} its chain supports`,
      });
    }
  }

  if (!bound.epistemic.includes(profile.epistemic)) {
    violations.push({
      axis: 'epistemic',
      actual: profile.epistemic,
      licensed: bound.epistemic.length === 0 ? 'nothing' : `one of ${bound.epistemic.join(', ')}`,
      message: `epistemic state ${profile.epistemic} is not supported by its chain`,
    });
  }
  if (!bound.monetaryBasis.includes(profile.monetaryBasis)) {
    violations.push({
      axis: 'monetaryBasis',
      actual: profile.monetaryBasis,
      licensed: bound.monetaryBasis.length === 0 ? 'nothing' : `one of ${bound.monetaryBasis.join(', ')}`,
      message: `monetary basis ${profile.monetaryBasis} is not supported by its chain, which supports `
        + `${bound.monetaryBasis.length === 0 ? 'nothing' : bound.monetaryBasis.join(', ')}`,
    });
  }
  return Object.freeze(violations);
}

export interface ChainInput {
  readonly claims: readonly Claim[];
  readonly derivations: readonly Derivation[];
  readonly licensedBasisTransitions?: ReadonlyArray<readonly [MonetaryBasisStatus, MonetaryBasisStatus]>;
}

export interface ChainViolation {
  readonly claimId: string;
  readonly derivationId: string;
  readonly violations: readonly AxisViolation[];
}

export interface ChainAnalysis {
  /** Bound computed for every claim in the chain, by id. */
  readonly bounds: ReadonlyMap<string, ClaimBound>;
  /** Claims whose profile is not below their bound. */
  readonly violations: readonly ChainViolation[];
  /** True only when every conclusion is below its bound. */
  readonly withinBound: boolean;
  /** Claims taken as roots because no supplied derivation produces them. */
  readonly leaves: readonly string[];
  /**
   * Derivation input claim ids the caller did not supply. Their conclusions are
   * bounded at BOTTOM and therefore always violate: an absent input is unknown,
   * and unknown stays unknown rather than being read as unconstrained.
   */
  readonly unresolvedInputs: readonly string[];
  /** This is never a proof that any proposition is true. */
  readonly isProofOfTruth: false;
}

/**
 * Fold the transfer function over a derivation DAG and check every conclusion.
 *
 * Leaves — claims no supplied derivation produces — are abstracted from their
 * own profile. That is the deliberate edge of this analysis: it bounds what a
 * CHAIN adds, and takes each root at face value. What a root may say about its
 * cited evidence is `assertClaimWithinItsEvidence` and `assessPreservation`,
 * which this does not repeat and does not replace.
 *
 * A claim produced by more than one supplied derivation takes the MEET of the
 * bounds they give it — two routes to one conclusion is two prerequisites, not
 * a choice of the more convenient one.
 */
export function analyzeDerivationChain(input: ChainInput): ChainAnalysis {
  const claims = new Map<string, Claim>();
  for (const item of input.claims) {
    if (claims.has(item.id)) throw new Error(`duplicate claim in chain: ${item.id}`);
    claims.set(item.id, item);
  }

  const producers = new Map<string, Derivation[]>();
  for (const step of input.derivations) {
    if (!claims.has(step.outputClaimId)) {
      throw new Error(`derivation ${step.id} produces ${step.outputClaimId}, which is not in the chain`);
    }
    const existing = producers.get(step.outputClaimId);
    if (existing === undefined) producers.set(step.outputClaimId, [step]);
    else existing.push(step);
  }

  const unresolved = new Set<string>();
  for (const step of input.derivations) {
    for (const id of step.inputClaimIds) if (!claims.has(id)) unresolved.add(id);
  }

  const bounds = new Map<string, ClaimBound>();
  const violations: ChainViolation[] = [];
  const options: DerivedBoundOptions = { licensedBasisTransitions: input.licensedBasisTransitions };
  const resolving = new Set<string>();

  const boundOf = (claimId: string): ClaimBound => {
    const cached = bounds.get(claimId);
    if (cached !== undefined) return cached;
    const item = claims.get(claimId);
    if (item === undefined) return BOTTOM_BOUND;
    if (resolving.has(claimId)) throw new Error(`derivation chain is cyclic at ${claimId}`);
    resolving.add(claimId);

    const steps = producers.get(claimId);
    let result: ClaimBound;
    if (steps === undefined || steps.length === 0) {
      result = claimBound(item.profile);
    } else {
      const perStep = steps.map((step) => {
        const inputBounds = step.inputClaimIds.map((id) => boundOf(id));
        return derivedBound(inputBounds, step.witnesses.map((w) => w.kind), options);
      });
      result = perStep.reduce((left, right) => meetClaimBounds(left, right));
      for (let index = 0; index < steps.length; index += 1) {
        const found = boundViolations(item.profile, perStep[index]!);
        if (found.length > 0) {
          violations.push(Object.freeze({
            claimId,
            derivationId: steps[index]!.id,
            violations: found,
          }));
        }
      }
    }
    resolving.delete(claimId);
    bounds.set(claimId, result);
    return result;
  };

  for (const item of input.claims) boundOf(item.id);

  const leaves = input.claims
    .filter((item) => (producers.get(item.id)?.length ?? 0) === 0)
    .map((item) => item.id);

  return Object.freeze({
    bounds,
    violations: Object.freeze(violations),
    withinBound: violations.length === 0,
    leaves: Object.freeze(leaves),
    unresolvedInputs: Object.freeze([...unresolved].sort()),
    isProofOfTruth: false,
  });
}
