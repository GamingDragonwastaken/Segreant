import { minimalHittingSets } from './dag.ts';

/**
 * Countermodels and assumption fragility (WP-B04).
 *
 * NOT A MAPPED BOUNDARY. This sits inside the kernel beside `claim.ts` and
 * issues nothing; the map covers the boundaries that reason ABOUT claims from
 * outside it. `billing.countermodels` is the mapped application of this file,
 * and it is mapped because its output reaches an operator.
 *
 * THE GAP THIS CLOSES. A `Claim` carries `assumptions` as an array of prose,
 * and the reconciliation run carries five `conditions` in the same shape. Both
 * are honest and both are inert: nothing can say what happens if one of them is
 * FALSE, so a reader is told the conclusion rests on a condition and left to
 * work out for themselves what the world looks like if it does not hold, and
 * whether anything they have could tell them.
 *
 * A countermodel is that world, written down. Concretely: a state of affairs
 * consistent with every observation the claim was built from, in which the claim
 * does not hold. Four fields, and each exists because leaving it out is a
 * specific way of being useless:
 *
 *   `violates`     which assumption. A countermodel not tied to a stated
 *                  assumption is free-floating doubt, and doubt that attaches to
 *                  nothing cannot be discharged by anything.
 *   `world`        what is true instead, concretely enough to be checked. "The
 *                  data might be wrong" is not a countermodel.
 *   `claimBecomes` what the claim degrades TO. Never "false": a bound that stops
 *                  bounding is a different failure from a figure that is off by
 *                  a known sign, and an operator's next move differs.
 *   `excludedBy`   THE OBSERVATION THAT WOULD RULE IT OUT, or `null` when
 *                  nothing available can. The null case is the most valuable
 *                  answer here and the one a fragility summary must not round
 *                  away: it says the claim is permanently conditional, not
 *                  merely unverified today.
 *
 * ABSENCE OF A COUNTERMODEL IS NOT ROBUSTNESS. This is the whole reason
 * `assessAssumptionFragility` reports `uncoveredAssumptions` and refuses to set
 * `robustnessAssessed` while any remain. An assessment that returned "no live
 * countermodels" for a claim nobody had written countermodels for would be the
 * completeness failure this repository keeps finding in other clothes — reading
 * "we did not look" as "there is nothing there". It is the same rule as
 * `src/measurement/completeness.ts` applies to absence inference, one level up:
 * a negative result is only informative over the ground actually covered.
 *
 * WHAT A LIVE COUNTERMODEL DOES NOT MEAN. Not that the claim is wrong, and not
 * that it is unlikely. There is deliberately no probability here — attaching one
 * would replace a structural statement with a number nobody can source, which is
 * the collapse `src/epistemic/profile.ts` opens by refusing. A live countermodel
 * means exactly this: the evidence at hand does not distinguish the claim's
 * world from that one.
 */

/**
 * What the evidence at hand says about this world.
 *
 * Four values, and the fourth is the one that makes this more than a doubt
 * register:
 *
 *   `live`      the evidence does not distinguish the claim's world from this
 *               one. Not "unlikely" — there is deliberately no probability
 *               anywhere in this module.
 *   `realized`  the evidence positively ESTABLISHES this world. The claim does
 *               not hold as stated, and saying only that a countermodel is
 *               unexcluded would understate what is known.
 *   `excluded`  ruled out, and it must name what ruled it out.
 *   `unknown`   a discriminating observation exists and has not been made.
 *               Genuinely different from `live`, where it was made and came back
 *               unhelpful, and from a `null` `excludedBy`, where no such
 *               observation is available at all.
 */
export const COUNTERMODEL_STATUSES = ['live', 'realized', 'excluded', 'unknown'] as const;
export type CountermodelStatus = (typeof COUNTERMODEL_STATUSES)[number];

export interface CountermodelInput {
  readonly id: string;
  /** The assumption this world violates, verbatim as the claim states it. */
  readonly violates: string;
  /** The alternative state of affairs, concretely enough to be checked. */
  readonly world: string;
  /** What the claim degrades to in that world. */
  readonly claimBecomes: string;
  /**
   * The observation that would rule this world out, or `null` when nothing
   * available can. `null` is a claim about the evidence available here, not
   * about the world.
   */
  readonly excludedBy: string | null;
  readonly status: CountermodelStatus;
}

export type Countermodel = Readonly<CountermodelInput>;

export interface FragilityAssessment {
  /** Every assumption considered, in the order the claim states them. */
  readonly assumptions: readonly string[];
  /** Assumptions with at least one `live` or `realized` countermodel. */
  readonly fragileAssumptions: readonly string[];
  /**
   * Assumptions the evidence has positively broken. The claim does not hold as
   * stated for these, which is a stronger and more urgent statement than
   * fragility.
   */
  readonly violatedAssumptions: readonly string[];
  /**
   * Assumptions for which no countermodel was recorded at all. NOT the same as
   * an assumption whose countermodels are all excluded: nobody looked.
   */
  readonly uncoveredAssumptions: readonly string[];
  /**
   * Unexcluded countermodels that nothing available CAN exclude. These make the
   * claim permanently conditional rather than pending a check an operator could
   * go and do, and they are the ones that belong beside the figure. The
   * complement — an unexcluded countermodel WITH a named discriminator — is
   * actionable, and separating the two is most of this assessment's value.
   */
  readonly unexcludable: readonly Countermodel[];
  readonly live: readonly Countermodel[];
  readonly realized: readonly Countermodel[];
  readonly excluded: readonly Countermodel[];
  readonly pending: readonly Countermodel[];
  /**
   * False when any countermodel is `realized`. A caller that prints the claim
   * without reading this is printing a figure its own evidence contradicts.
   */
  readonly claimHoldsAsStated: boolean;
  /**
   * True only when every stated assumption has at least one countermodel. When
   * false, `fragileAssumptions` being empty means nothing at all.
   */
  readonly robustnessAssessed: boolean;
  /**
   * True only when the assessment covered at least one stated assumption and
   * every recorded countermodel was excluded. Pending, live, realized and
   * unexcludable worlds all withhold certification. This is deliberately
   * separate from `claimHoldsAsStated`: an unknown world does not refute a
   * claim, but it cannot certify one either.
   */
  readonly certified: boolean;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

const COUNTERMODEL_KEYS = new Set(['id', 'violates', 'world', 'claimBecomes', 'excludedBy', 'status']);

/**
 * Validate and freeze one countermodel.
 *
 * The one structural rule worth stating out loud: **`excluded` requires an
 * `excludedBy`.** A world cannot be ruled out by nothing. Without that rule the
 * cheapest way to make a claim look robust is to mark every countermodel
 * excluded and record no reason, which is precisely the move this whole module
 * exists to make impossible.
 */
export function countermodel(input: CountermodelInput): Countermodel {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('countermodel must be an object');
  for (const key of Object.keys(input)) {
    if (!COUNTERMODEL_KEYS.has(key)) throw new Error(`countermodel contains unknown field: ${key}`);
  }
  const id = nonEmpty(input.id, 'countermodel id');
  const violates = nonEmpty(input.violates, `countermodel ${id} violates`);
  const world = nonEmpty(input.world, `countermodel ${id} world`);
  const claimBecomes = nonEmpty(input.claimBecomes, `countermodel ${id} claimBecomes`);
  if (!COUNTERMODEL_STATUSES.includes(input.status)) {
    throw new Error(`countermodel ${id} has an invalid status: ${String(input.status)}`);
  }
  if (input.excludedBy !== null && typeof input.excludedBy !== 'string') {
    throw new Error(`countermodel ${id} excludedBy must be a string or null`);
  }
  const excludedBy = input.excludedBy === null ? null : nonEmpty(input.excludedBy, `countermodel ${id} excludedBy`);
  if (input.status === 'excluded' && excludedBy === null) {
    throw new Error(`countermodel ${id} is marked excluded but names nothing that excluded it`);
  }
  if (input.status === 'unknown' && excludedBy === null) {
    // `unknown` means "the discriminating observation exists and has not been
    // made". With no such observation there is nothing to wait for, and the
    // honest status is `live`.
    throw new Error(`countermodel ${id} is pending an observation it does not name; with no discriminator it is live`);
  }
  return Object.freeze({ id, violates, world, claimBecomes, excludedBy, status: input.status });
}

/**
 * Assess how much of a claim's conditionality has actually been examined.
 *
 * `assumptions` is the claim's own list, verbatim, and every countermodel must
 * violate one of them. A countermodel naming an assumption the claim does not
 * state is rejected rather than ignored: it is either about a different claim or
 * about an assumption the claim has failed to declare, and both are defects that
 * should stop the caller rather than quietly shrink the assessment.
 */
export function assessAssumptionFragility(
  assumptions: readonly string[],
  countermodels: readonly Countermodel[],
): FragilityAssessment {
  if (!Array.isArray(assumptions)) throw new Error('assumptions must be an array');
  const stated = assumptions.map((value, index) => nonEmpty(value, `assumption ${index}`));
  const known = new Set(stated);
  if (known.size !== stated.length) throw new Error('assumptions must be distinct');

  const seen = new Set<string>();
  const validated = countermodels.map((item) => {
    const value = countermodel(item);
    if (seen.has(value.id)) throw new Error(`duplicate countermodel id: ${value.id}`);
    seen.add(value.id);
    if (!known.has(value.violates)) {
      throw new Error(`countermodel ${value.id} violates an assumption this claim does not state: ${value.violates}`);
    }
    return value;
  });

  const live = validated.filter((item) => item.status === 'live');
  const realized = validated.filter((item) => item.status === 'realized');
  const excluded = validated.filter((item) => item.status === 'excluded');
  const pending = validated.filter((item) => item.status === 'unknown');
  const covered = new Set(validated.map((item) => item.violates));
  const breaking = new Set([...live, ...realized].map((item) => item.violates));

  const robustnessAssessed = stated.every((value) => covered.has(value));
  const certified = stated.length > 0
    && validated.length > 0
    && robustnessAssessed
    && validated.every((item) => item.status === 'excluded');

  return Object.freeze({
    assumptions: Object.freeze([...stated]),
    fragileAssumptions: Object.freeze(stated.filter((value) => breaking.has(value))),
    violatedAssumptions: Object.freeze(stated.filter((value) => realized.some((item) => item.violates === value))),
    uncoveredAssumptions: Object.freeze(stated.filter((value) => !covered.has(value))),
    // Realized worlds count here too: one the evidence has established is by
    // definition one nothing excluded.
    unexcludable: Object.freeze([...live, ...realized].filter((item) => item.excludedBy === null)),
    live: Object.freeze(live),
    realized: Object.freeze(realized),
    excluded: Object.freeze(excluded),
    pending: Object.freeze(pending),
    claimHoldsAsStated: realized.length === 0,
    robustnessAssessed,
    certified,
  });
}

/**
 * Alternative supports for a certification, and the assumptions each rests on.
 *
 * A support is a set of assumptions that carries the certification ON ITS OWN
 * when every member of it holds. Certification therefore survives exactly while
 * one support survives intact, and it is removed only when every support has at
 * least one failed member. That is the same edge reading `dag.ts` settled at
 * D-098 — within a support the members are jointly necessary prerequisites,
 * across supports they are alternatives — so the two modules cannot drift into
 * describing one relation two ways.
 *
 * `assumptions` is the certificate's own list, verbatim and complete. A support
 * naming an assumption the certificate does not state is rejected rather than
 * ignored, for the same reason `assessAssumptionFragility` rejects a
 * countermodel that violates an unstated assumption: it is either about a
 * different certificate or about an assumption the certificate failed to
 * declare, and both should stop the caller.
 */
export interface CertificationStructure {
  readonly assumptions: readonly string[];
  /** False when the certificate never certified anything to begin with. */
  readonly certified: boolean;
  readonly supports: readonly (readonly string[])[];
}

/**
 * Why a result carries no invalidating sets. Never `null` alongside an empty
 * `sets`, because "there was no certification" and "nobody declared what
 * carries it" are different statements, and collapsing either into a bare empty
 * array is how a caller comes to read absence as strength.
 */
export type InvalidationEmptiness =
  | 'certification_not_in_force'
  | 'no_supports_declared';

export interface MinimalInvalidatingSets {
  /** The certificate's assumptions, in the order it states them. */
  readonly assumptions: readonly string[];
  /**
   * Inclusion-minimal sets of assumptions whose JOINT failure removes the
   * certification, smallest first then lexicographic. A singleton means that
   * assumption alone is load-bearing; a pair means neither member alone is.
   */
  readonly sets: readonly (readonly string[])[];
  /**
   * Assumptions appearing in no minimal set: their failure alone changes
   * nothing about this certification.
   *
   * `null` means NOT DETERMINED, and the other fields say why — either
   * `truncated` is true, or `emptyBecause` is set. A capped enumeration cannot
   * tell "in no minimal set" from "in a set the search never reached", and an
   * uncertified or unexamined structure has no certification for an assumption
   * to be inert with respect to. Returning `[]` in either case would report a
   * question nobody answered as an answer of "none".
   */
  readonly inertAssumptions: readonly string[] | null;
  /** True when `limit` stopped the search; `sets` is then a prefix. */
  readonly truncated: boolean;
  /** The bound actually applied, whether or not it was reached. */
  readonly limit: number;
  readonly emptyBecause: InvalidationEmptiness | null;
}

/**
 * The default enumeration bound.
 *
 * There is no principled maximum here, only an admission: the number of minimal
 * invalidating sets is exponential in the number of alternative supports, so a
 * function promising to enumerate them all is promising something it cannot cost
 * in advance. 256 is large enough that no structure this codebase produces today
 * comes near it — the decision certificate yields two sets — and small enough
 * that a pathological structure stops rather than runs.
 */
export const DEFAULT_INVALIDATING_SET_LIMIT = 256;

export interface InvalidatingSetOptions {
  /** Maximum sets carried and returned. Positive integer. */
  readonly limit?: number;
}

/** NUL, which no validated assumption string can contain. */
const SUPPORT_KEY_SEPARATOR = String.fromCharCode(0);

/**
 * Minimal sets of named assumptions whose joint failure removes a certification.
 *
 * WHAT THIS IS AND IS NOT. It is a bounded search over an EXPLICITLY DECLARED
 * support structure, computed by the one hitting-set fold in `dag.ts`. It is not
 * a theorem prover and claims no completeness over anything but the supports it
 * was handed: an assumption the structure failed to declare as load-bearing
 * comes back inert, which is a statement about the declaration and not about the
 * world. `CertificationStructure` is where a domain records that judgement, in
 * one place, where it can be read and disputed.
 *
 * WHY THE ANSWER IS SETS OF NAMES AND NOT A SCORE. A ranked fragility number
 * would be unsourceable in exactly the way `src/epistemic/profile.ts` refuses,
 * and it would not tell an operator what to go and check. A named set does:
 * every member is an assumption the certificate itself states, so "this
 * certification falls if these two both fail" is a checkable proposition rather
 * than a mood.
 *
 * THE BOUND IS PART OF THE ANSWER. `truncated` says the enumeration stopped
 * early, and `inertAssumptions` goes `null` when it did, because a prefix that
 * still reported which assumptions matter to nothing would be a capped answer
 * wearing a complete one's clothes.
 */
export function minimalInvalidatingAssumptionSets(
  structure: CertificationStructure,
  options: InvalidatingSetOptions = {},
): MinimalInvalidatingSets {
  if (structure === null || typeof structure !== 'object' || Array.isArray(structure)) {
    throw new Error('certification structure must be an object');
  }
  if (!Array.isArray(structure.assumptions)) throw new Error('assumptions must be an array');
  if (typeof structure.certified !== 'boolean') {
    throw new Error('certification structure must state whether it is certified');
  }
  if (!Array.isArray(structure.supports)) throw new Error('supports must be an array');

  const stated = structure.assumptions.map((value, index) => nonEmpty(value, `assumption ${index}`));
  const known = new Set(stated);
  if (known.size !== stated.length) throw new Error('assumptions must be distinct');

  const limit = options.limit === undefined ? DEFAULT_INVALIDATING_SET_LIMIT : options.limit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('invalidating set limit must be a positive integer');
  }

  const seenSupports = new Set<string>();
  const family: string[][] = [];
  structure.supports.forEach((support, index) => {
    if (!Array.isArray(support)) throw new Error(`support ${index} must be an array`);
    const members = support.map((value, position) => nonEmpty(value, `support ${index}[${position}]`));
    if (members.length === 0) {
      // A support carried by nothing cannot be hit, so it would make the
      // certification unfalsifiable by assumption failure. That is a claim
      // nobody gets to make by leaving an array empty.
      throw new Error(`support ${index} must name at least one assumption`);
    }
    const distinct = [...new Set(members)].sort((a, b) => a.localeCompare(b));
    if (distinct.length !== members.length) throw new Error(`support ${index} repeats an assumption`);
    for (const member of distinct) {
      if (!known.has(member)) {
        throw new Error(`support ${index} names an assumption this certificate does not state: ${member}`);
      }
    }
    const key = distinct.join(SUPPORT_KEY_SEPARATOR);
    if (seenSupports.has(key)) return;
    seenSupports.add(key);
    family.push(distinct);
  });

  const empty = (emptyBecause: InvalidationEmptiness): MinimalInvalidatingSets => Object.freeze({
    assumptions: Object.freeze([...stated]),
    sets: Object.freeze([]),
    inertAssumptions: null,
    truncated: false,
    limit,
    emptyBecause,
  });

  if (!structure.certified) return empty('certification_not_in_force');
  if (family.length === 0) return empty('no_supports_declared');

  const enumeration = minimalHittingSets(family, limit);
  const covered = new Set(enumeration.sets.flatMap((set) => [...set]));

  return Object.freeze({
    assumptions: Object.freeze([...stated]),
    sets: enumeration.sets,
    inertAssumptions: enumeration.truncated
      ? null
      : Object.freeze(stated.filter((value) => !covered.has(value))),
    truncated: enumeration.truncated,
    limit,
    emptyBecause: null,
  });
}
