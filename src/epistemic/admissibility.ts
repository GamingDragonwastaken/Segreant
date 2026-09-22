/**
 * Claim-relative admissibility and ordering (WP-B05).
 *
 * NOT A MAPPED BOUNDARY. This sits inside the kernel beside `profile.ts` and
 * issues nothing; it decides whether a profile already established elsewhere
 * clears a stated bar.
 *
 * THE THING THIS REFUSES TO BE. A single number, or a single ladder, saying how
 * strong a claim is. `mergeClaimProfiles` already refuses to rank monetary
 * bases, for the reason that decides this whole module: `billed` and
 * `allocated` are not two rungs of one quantity, they are different economic
 * semantics, and any ordering over them is invented rather than observed. A
 * trust score would bury that refusal under a decimal point.
 *
 * So strength here is always RELATIVE TO A USE. "Is this claim strong enough?"
 * has no answer. "Is this claim strong enough to gate traffic?" has one, and it
 * is a different answer from "strong enough to put in a finance report" — with
 * neither claim being the stronger of the two. That is a partial order, and the
 * value of a partial order is precisely the pairs it declines to order.
 *
 * TWO KINDS OF REQUIREMENT, AND THE DIFFERENCE IS LOAD-BEARING.
 *
 *   `atLeast`  on an axis whose declared constant IS an ordering — `INTEGRITY`,
 *              `COVERAGE`, `SCOPE_STATUS` and the rest run weakest-first, so a
 *              minimum is meaningful.
 *   `oneOf`    on an axis that is a set of alternatives rather than a ladder.
 *              `MONETARY_BASIS` is the one that matters: `atLeast` on it is
 *              rejected at construction, because accepting it would smuggle in
 *              exactly the ranking `mergeClaimProfiles` refuses.
 *
 * A REQUIREMENT NOBODY STATED ADMITS NOTHING. `UseRequirement.requires` may be
 * empty, and an empty requirement does not mean "everything qualifies" — it
 * means nobody has said what qualifying would be. `admits` reports that as
 * `stated: false` and refuses to return `admitted: true`, for the same reason
 * `assessAssumptionFragility` refuses to call an unexamined claim robust: an
 * unasked question is not a passed test.
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
} from './profile.ts';

/**
 * Axes whose declared constant is an ordering, so a minimum is meaningful.
 *
 * Not a judgement made here: this is exactly the set `mergeClaimProfiles`
 * applies `weaker()` to, which is that function stating which constants it
 * treats as weakest-first. The two axes it handles differently are the two
 * below.
 */
export const ORDERED_AXES = [
  'integrity', 'authenticity', 'scope', 'coverage', 'measurement', 'causality', 'finality', 'decisionFitness',
] as const;
export type OrderedAxis = (typeof ORDERED_AXES)[number];

/**
 * Each ordered axis with the constant that orders it. The `Record` is exhaustive
 * by type, so an axis added above without an order fails to compile — and the
 * test asserts the other direction, that these eight plus the two unordered ones
 * are exactly the profile's ten. Neither list is allowed to drift alone.
 */
const ORDERS: Readonly<Record<OrderedAxis, readonly string[]>> = Object.freeze({
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
 * Axes that are a set of alternatives rather than a ladder.
 *
 * `monetaryBasis` is here for the reason `mergeClaimProfiles` gives: the values
 * name different economic semantics, not degrees of one. `epistemic` is here
 * because Belnap's four values are a lattice — `conflicted` is not "more" than
 * `supported`, it is a different thing to know.
 */
export const UNORDERED_AXES = ['monetaryBasis', 'epistemic'] as const;
export type UnorderedAxis = (typeof UNORDERED_AXES)[number];

export interface OrderedRequirement {
  readonly axis: OrderedAxis;
  readonly atLeast: string;
}

export interface MembershipRequirement {
  readonly axis: UnorderedAxis;
  readonly oneOf: readonly string[];
}

export type AxisRequirement = OrderedRequirement | MembershipRequirement;

export interface UseRequirement {
  readonly id: string;
  /**
   * What a profile must reach. EMPTY IS A REAL STATE and does not mean
   * "anything qualifies" — see the module docblock.
   */
  readonly requires: readonly AxisRequirement[];
  /** Why, in the terms of the evidence. Displayed, so it is written for a reader. */
  readonly because: string;
}

export interface UnmetRequirement {
  readonly axis: string;
  /** What the requirement asked for, rendered for display. */
  readonly needed: string;
  /** What the profile actually carries on that axis. */
  readonly actual: string;
}

export interface Admissibility {
  readonly use: string;
  /** True only when a requirement was stated AND every part of it is met. */
  readonly admitted: boolean;
  /**
   * Whether anyone has said what qualifying for this use would be. When false,
   * `admitted` is false and `unmet` is empty, and those two together mean
   * "unexamined" rather than "failed" — a distinction a caller must not flatten.
   */
  readonly stated: boolean;
  readonly unmet: readonly UnmetRequirement[];
  readonly because: string;
}

function rank(axis: OrderedAxis, value: string): number {
  const index = ORDERS[axis].indexOf(value);
  if (index < 0) throw new Error(`${axis} carries a value outside its declared order: ${value}`);
  return index;
}

function isOrdered(requirement: AxisRequirement): requirement is OrderedRequirement {
  return 'atLeast' in requirement;
}

/**
 * Validate and freeze one use requirement.
 *
 * The rule worth stating out loud: **`atLeast` is rejected on an unordered
 * axis.** `MONETARY_BASIS` has nine members and no ordering — `mergeClaimProfiles`
 * says so by turning disagreement into `mixed` rather than picking a winner —
 * so `{ axis: 'monetaryBasis', atLeast: 'billed' }` would be asserting an order
 * that does not exist, in the one place nobody would look for it.
 */
export function useRequirement(input: UseRequirement): UseRequirement {
  const id = typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : null;
  if (id === null) throw new Error('use requirement id must be a non-empty string');
  if (typeof input.because !== 'string' || input.because.trim().length === 0) {
    throw new Error(`use requirement ${id} must say why`);
  }
  if (!Array.isArray(input.requires)) throw new Error(`use requirement ${id} requires must be an array`);

  const seen = new Set<string>();
  const requires = input.requires.map((requirement) => {
    const axis = String((requirement as { axis: unknown }).axis);
    if (seen.has(axis)) throw new Error(`use requirement ${id} states ${axis} twice`);
    seen.add(axis);

    if (isOrdered(requirement)) {
      if (!(ORDERED_AXES as readonly string[]).includes(axis)) {
        throw new Error(
          `use requirement ${id} uses atLeast on ${axis}, which has no declared ordering; `
          + 'state the acceptable values with oneOf instead',
        );
      }
      rank(requirement.axis, requirement.atLeast);
      return Object.freeze({ axis: requirement.axis, atLeast: requirement.atLeast });
    }

    if (!(UNORDERED_AXES as readonly string[]).includes(axis)) {
      throw new Error(`use requirement ${id} uses oneOf on ${axis}, which is ordered; state a minimum with atLeast`);
    }
    if (!Array.isArray(requirement.oneOf) || requirement.oneOf.length === 0) {
      throw new Error(`use requirement ${id} states an empty oneOf for ${axis}, which nothing can satisfy`);
    }
    if (axis === 'monetaryBasis') {
      for (const value of requirement.oneOf) {
        if (!(MONETARY_BASIS as readonly string[]).includes(value)) {
          throw new Error(`use requirement ${id} names a monetary basis that does not exist: ${value}`);
        }
      }
    }
    return Object.freeze({ axis: requirement.axis, oneOf: Object.freeze([...requirement.oneOf]) });
  });

  return Object.freeze({ id, requires: Object.freeze(requires), because: input.because.trim() });
}

/** Does this profile clear the bar this use states? */
export function admits(profile: ClaimProfile, requirement: UseRequirement): Admissibility {
  const unmet: UnmetRequirement[] = [];
  for (const part of requirement.requires) {
    const actual = String((profile as unknown as Record<string, unknown>)[part.axis]);
    if (isOrdered(part)) {
      if (rank(part.axis, actual) < rank(part.axis, part.atLeast)) {
        unmet.push({ axis: part.axis, needed: `at least ${part.atLeast}`, actual });
      }
    } else if (!part.oneOf.includes(actual)) {
      unmet.push({ axis: part.axis, needed: `one of ${part.oneOf.join(', ')}`, actual });
    }
  }

  const stated = requirement.requires.length > 0;
  return Object.freeze({
    use: requirement.id,
    // An unstated requirement is not a passed one. `stated` carries that, and
    // `admitted` must not launder it into a yes.
    admitted: stated && unmet.length === 0,
    stated,
    unmet: Object.freeze(unmet),
    because: requirement.because,
  });
}

export type UseComparison = 'better' | 'worse' | 'equivalent' | 'incomparable';

/**
 * Order two profiles FOR ONE USE, and decline to order them when they do not.
 *
 * `incomparable` is the return value this function exists for. Two claims can
 * each satisfy something the other does not — a provider-billed total has an
 * integrity a metered estimate lacks, and a metered estimate attaches to
 * individual requests as a billed total does not — and no amount of arithmetic
 * turns that into a rank. Anything that returned `better` there would be
 * inventing the ladder this module was written to avoid.
 *
 * Comparison is over the requirement's OWN axes only. Axes the use does not ask
 * about are irrelevant to it by construction, and letting them break a tie would
 * make the answer depend on facts the use has said it does not care about.
 */
export function compareForUse(a: ClaimProfile, b: ClaimProfile, requirement: UseRequirement): UseComparison {
  if (requirement.requires.length === 0) return 'incomparable';

  let aAhead = false;
  let bAhead = false;
  for (const part of requirement.requires) {
    const left = String((a as unknown as Record<string, unknown>)[part.axis]);
    const right = String((b as unknown as Record<string, unknown>)[part.axis]);
    if (left === right) continue;

    if (isOrdered(part)) {
      if (rank(part.axis, left) > rank(part.axis, right)) aAhead = true;
      else bAhead = true;
      continue;
    }
    // An unordered axis cannot say which is ahead — only whether each is in the
    // admissible set. Differing membership is a genuine two-way difference.
    const leftIn = part.oneOf.includes(left);
    const rightIn = part.oneOf.includes(right);
    if (leftIn === rightIn) {
      // Both in, or both out, but not the same value: on an unordered axis that
      // is a difference with no direction, which is what makes it incomparable
      // rather than equivalent.
      if (leftIn) return 'incomparable';
      return 'incomparable';
    }
    if (leftIn) aAhead = true;
    else bAhead = true;
  }

  if (aAhead && bAhead) return 'incomparable';
  if (aAhead) return 'better';
  if (bAhead) return 'worse';
  return 'equivalent';
}
