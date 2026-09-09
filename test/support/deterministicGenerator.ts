/**
 * Deterministic, dependency-free generation for law-level economic tests.
 *
 * ZERO RUNTIME DEPENDENCIES IS A HARD RULE OF THIS REPOSITORY, so there is no
 * `fast-check` here and there is not going to be one. What a property-testing
 * library actually supplies is two things: a reproducible stream of
 * pseudo-random choices, and a way to shrink a failing case. This file supplies
 * the first exactly and the second narrowly, which is what the laws in
 * `economic-money-laws.test.ts` and `economic-conservation-laws.test.ts` need.
 *
 * `Math.random()` IS BANNED HERE ON PURPOSE. A law that fails once and never
 * reproduces is worse than no law at all: it teaches whoever sees it to ignore
 * the next failure. Every generator takes an explicit seed, every failure
 * message prints that seed together with the case index, and re-running the file
 * replays the identical sequence of cases.
 *
 * THE ALIGNMENT BUDGET IS PART OF THE CONTRACT. `addMoney` aligns two scales by
 * multiplying the smaller-scaled coefficient by a power of ten, and `normalize`
 * then refuses a coefficient wider than `MAX_MONEY_COEFFICIENT_DIGITS`. So the
 * amounts a law over sums may draw are bounded: whole digits and scale are
 * capped so that summing a handful of generated values can never reach the
 * ceiling. That ceiling is real and is asserted directly, as a boundary, in
 * `economic-money-laws.test.ts` — it is not swept under a generator.
 */

import { MAX_MONEY_COEFFICIENT_DIGITS, MAX_MONEY_SCALE } from '../../src/economics/money.ts';

/** Widest whole part a generated amount may carry. */
export const GENERATED_MAX_WHOLE_DIGITS = 1_200;

/** Widest fractional part a generated amount may carry: the module's own ceiling. */
export const GENERATED_MAX_SCALE = MAX_MONEY_SCALE;

/** How many generated amounts a single law may sum while staying inside the coefficient ceiling. */
export const GENERATED_SUM_ARITY = 8;

// A generated value aligned to the widest generated scale occupies at most
// GENERATED_MAX_WHOLE_DIGITS + GENERATED_MAX_SCALE digits; summing
// GENERATED_SUM_ARITY of them adds at most one more. If this stops holding, the
// generators would be producing cases whose failures are about the ceiling
// rather than about the law under test.
if (GENERATED_MAX_WHOLE_DIGITS + GENERATED_MAX_SCALE + GENERATED_SUM_ARITY >= MAX_MONEY_COEFFICIENT_DIGITS) {
  throw new Error('generated money bounds exceed the alignment budget for the coefficient ceiling');
}

export interface DeterministicRandom {
  /** The seed this stream was constructed from, for reproducing a failure. */
  readonly seed: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  below(maxExclusive: number): number;
  /** Uniform integer in [min, maxInclusive]. */
  between(min: number, maxInclusive: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(values: readonly T[]): T;
  /** True with probability numerator/denominator. */
  chance(numerator: number, denominator: number): boolean;
  /** A Fisher-Yates shuffle that does not mutate its argument. */
  shuffled<T>(values: readonly T[]): T[];
}

/**
 * mulberry32. Thirty-two bits of state and one multiply-xorshift round: uniform
 * enough to generate test inputs, and — the property that actually matters here
 * — identical on every platform and every run for a given seed.
 */
export function deterministicRandom(seed: number): DeterministicRandom {
  if (!Number.isSafeInteger(seed)) throw new Error('deterministic seed must be a safe integer');
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const below = (maxExclusive: number): number => {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error('bound must be a positive safe integer');
    return Math.floor(next() * maxExclusive) % maxExclusive;
  };
  return Object.freeze({
    seed,
    next,
    below,
    between: (min: number, maxInclusive: number): number => {
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(maxInclusive) || maxInclusive < min) {
        throw new Error('range must be a non-empty safe-integer interval');
      }
      return min + below(maxInclusive - min + 1);
    },
    pick: <T>(values: readonly T[]): T => {
      if (values.length === 0) throw new Error('cannot pick from an empty array');
      return values[below(values.length)] as T;
    },
    chance: (numerator: number, denominator: number): boolean => below(denominator) < numerator,
    shuffled: <T>(values: readonly T[]): T[] => {
      const result = [...values];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const swap = below(index + 1);
        const held = result[index] as T;
        result[index] = result[swap] as T;
        result[swap] = held;
      }
      return result;
    },
  });
}

/** A stable, printable seed derived from a law's name, so each law replays independently. */
export function seedFor(baseSeed: number, label: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash ^ (baseSeed >>> 0)) >>> 0;
}

/**
 * The shape families a generated amount is drawn from. Named rather than
 * anonymous so a failure report can say WHICH corner of the input space the
 * counterexample came from, before it is shrunk to something unrecognisable.
 */
export const AMOUNT_FAMILIES = [
  'zero',
  'currency_two_places',
  'sub_cent',
  'integral',
  'high_precision',
  'wide_whole',
  'mixed',
] as const;
export type AmountFamily = (typeof AMOUNT_FAMILIES)[number];

function digitRun(rng: DeterministicRandom, count: number, allowLeadingZero: boolean): string {
  if (count <= 0) return '';
  let out = allowLeadingZero ? String(rng.below(10)) : String(rng.between(1, 9));
  for (let index = 1; index < count; index += 1) out += String(rng.below(10));
  return out;
}

function compose(rng: DeterministicRandom, wholeDigits: number, scale: number): string {
  const whole = wholeDigits <= 0 ? '0' : digitRun(rng, wholeDigits, false);
  const fraction = digitRun(rng, scale, true);
  const magnitude = scale === 0 ? whole : `${whole}.${fraction}`;
  return rng.chance(1, 2) ? `-${magnitude}` : magnitude;
}

/** A plain decimal string inside the alignment budget, drawn from one named family. */
export function generateAmountText(rng: DeterministicRandom, family?: AmountFamily): string {
  const chosen = family ?? rng.pick(AMOUNT_FAMILIES);
  switch (chosen) {
    case 'zero':
      // '-0' and '0.000' are legal inputs that must normalize to the same zero,
      // which is exactly the case a hand-written example forgets to include.
      return rng.pick(['0', '-0', '0.0', '0.000000', '-0.00']);
    case 'currency_two_places':
      return compose(rng, rng.between(1, 6), 2);
    case 'sub_cent':
      return compose(rng, rng.between(0, 2), rng.between(3, 12));
    case 'integral':
      return compose(rng, rng.between(1, 18), 0);
    case 'high_precision':
      return compose(rng, rng.between(0, 3), rng.between(GENERATED_MAX_SCALE - 40, GENERATED_MAX_SCALE));
    case 'wide_whole':
      return compose(rng, rng.between(GENERATED_MAX_WHOLE_DIGITS - 40, GENERATED_MAX_WHOLE_DIGITS), rng.between(0, 6));
    case 'mixed':
    default:
      return compose(rng, rng.between(0, 40), rng.between(0, 40));
  }
}

/** A non-negative plain decimal string with a bounded scale, for ledger scenarios. */
export function generateNonNegativeAmountText(rng: DeterministicRandom, maxScale = 6): string {
  const scale = rng.between(0, maxScale);
  const whole = rng.chance(1, 6) ? '0' : digitRun(rng, rng.between(1, 5), false);
  if (scale === 0) return whole;
  return `${whole}.${digitRun(rng, scale, true)}`;
}

const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Candidate simplifications of one decimal string. */
function simplerForms(text: string): readonly string[] {
  const forms = new Set<string>();
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const sign = negative ? '-' : '';
  forms.add('0');
  forms.add(`${sign}1`);
  if (negative) forms.add(unsigned);
  if (fraction.length > 0) {
    forms.add(`${sign}${whole}`);
    forms.add(`${sign}${whole}.${fraction.slice(0, Math.max(1, fraction.length >> 1))}`);
    forms.add(`${sign}${whole}.${fraction.slice(0, 1)}`);
  }
  if (whole.length > 1) {
    const half = whole.slice(0, Math.max(1, whole.length >> 1));
    forms.add(fraction.length > 0 ? `${sign}${half}.${fraction}` : `${sign}${half}`);
    forms.add(fraction.length > 0 ? `${sign}${whole.slice(0, 1)}.${fraction}` : `${sign}${whole.slice(0, 1)}`);
  }
  forms.delete(text);
  return [...forms].filter((form) => PLAIN_DECIMAL.test(form));
}

/**
 * Greedily shrink a failing tuple of decimal strings while the failure survives.
 *
 * This runs ONLY after a law has already failed. A raw counterexample from the
 * `wide_whole` family is 1200 digits long and tells the reader nothing; the
 * minimized one usually fits on a line and names the actual mechanism. It is
 * deliberately monotone — a candidate is kept only if `fails` still holds — so
 * it can never turn a real failure into a passing report.
 */
export function shrinkAmounts(
  operands: readonly string[],
  fails: (candidate: readonly string[]) => boolean,
): readonly string[] {
  if (!fails(operands)) return operands;
  let best = [...operands];
  let improving = true;
  let guard = 0;
  while (improving && guard < 200) {
    improving = false;
    guard += 1;
    for (let index = 0; index < best.length; index += 1) {
      for (const candidate of simplerForms(best[index] as string)) {
        const attempt = [...best];
        attempt[index] = candidate;
        if (fails(attempt)) {
          best = attempt;
          improving = true;
          break;
        }
      }
    }
  }
  return best;
}
