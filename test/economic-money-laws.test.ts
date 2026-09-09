/**
 * The money algebra as LAWS, over generated inputs rather than chosen ones.
 *
 * WHAT THIS ADDS THAT `exact-money.test.ts` DOES NOT. That file is example-based
 * and good: it pins 0.1 + 0.2, the beyond-safe-integer case, the currency and
 * basis refusals, the hostile-size refusals. What an example cannot do is say
 * that `addMoney` is *associative*, or that `compareMoney` is a *total order* —
 * those are statements about every input, and a statement about every input is
 * only tested by generating inputs the author did not choose.
 *
 * EXACTNESS MEANS STRING EQUALITY OF THE NORMAL FORM. Not `assert.ok(Math.abs(a
 * - b) < eps)`, not float tolerance anywhere, at all, ever. Every comparison
 * below goes through `canonical()`, which renders coefficient, scale, currency
 * and basis, so a law that passes has compared the whole identity of the value
 * and not merely its printed magnitude.
 *
 * DETERMINISM. The seed is a constant; each law derives its own stream from it
 * by name so adding a law does not renumber the cases of the others. Every
 * failure prints the base seed, the derived seed, the case index, the generated
 * operands verbatim and a shrunk counterexample. Re-running this file replays
 * exactly the same cases: there is no `Math.random()` in this suite.
 *
 * WHERE THE ALGEBRA STOPS BEING TOTAL. `addMoney` aligns scales by multiplying
 * a coefficient by a power of ten, and `normalize` refuses a coefficient wider
 * than `MAX_MONEY_COEFFICIENT_DIGITS`. So addition is a PARTIAL operation near
 * the ceiling, and associativity is not a theorem there: an intermediate sum can
 * exceed the limit while a differently-associated one does not. That is a real
 * property of a resource-limited exact type, not a defect, and it is stated
 * directly as a boundary test at the end of this file rather than hidden by
 * generating only small values. The generators stay inside the budget on
 * purpose, and `deterministicGenerator.ts` fails loudly if that stops holding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMoney,
  compareMoney,
  ECONOMIC_BASES,
  formatMoneyAmount,
  MAX_MONEY_COEFFICIENT_DIGITS,
  money,
  moneyFromJson,
  moneyToJson,
  negateMoney,
  subtractMoney,
  type EconomicBasis,
  type Money,
} from '../src/economics/money.ts';
import {
  deterministicRandom,
  generateAmountText,
  seedFor,
  shrinkAmounts,
  type DeterministicRandom,
} from './support/deterministicGenerator.ts';

/** One constant, printed on every failure. Change it only to widen a sweep deliberately. */
const BASE_SEED = 0x0f1c_5c02;

/** Currencies are opaque three-letter codes to this module; XTS is the ISO test code. */
const CURRENCIES = ['USD', 'EUR', 'JPY', 'XTS'] as const;

/**
 * The whole identity of a value, not its printed magnitude. Two Money values
 * that format identically but differ in scale, currency or basis are DIFFERENT
 * values, and a law that compared only `formatMoneyAmount` would not notice.
 */
function canonical(value: Money): string {
  return `${formatMoneyAmount(value)} ${value.currency} ${value.basis} [coefficient=${value.coefficient} scale=${value.scale}]`;
}

interface FailureInput {
  readonly law: string;
  readonly seed: number;
  readonly index: number;
  readonly operands: readonly string[];
  readonly detail: string;
  /** Re-runs the law on a candidate tuple; true means the failure survives. */
  readonly stillFails?: (candidate: readonly string[]) => boolean;
}

/** Build the failure report. Only ever called on the failing path, so shrinking is free. */
function report(input: FailureInput): string {
  const minimized = input.stillFails === undefined ? input.operands : shrinkAmounts(input.operands, input.stillFails);
  return [
    '',
    `LAW FAILED: ${input.law}`,
    `reproduce with base seed ${BASE_SEED}, law seed ${input.seed}, case index ${input.index}`,
    `generated operands: ${input.operands.map((value) => JSON.stringify(value)).join(', ')}`,
    `minimized operands: ${minimized.map((value) => JSON.stringify(value)).join(', ')}`,
    input.detail,
  ].join('\n');
}

function context(law: string): { seed: number; rng: DeterministicRandom } {
  const seed = seedFor(BASE_SEED, law);
  return { seed, rng: deterministicRandom(seed) };
}

/** How many generated cases each law sweeps. Reported, because a sweep is worth its enumeration. */
export const MONEY_LAW_CASES = 500;

// ---------------------------------------------------------------------------
// Additive structure
// ---------------------------------------------------------------------------

test('LAW addMoney is commutative over generated amounts', () => {
  const { seed, rng } = context('addMoney/commutative');
  for (let index = 0; index < MONEY_LAW_CASES; index += 1) {
    const currency = rng.pick(CURRENCIES);
    const basis = rng.pick(ECONOMIC_BASES);
    const operands = [generateAmountText(rng), generateAmountText(rng)];
    const evaluate = (values: readonly string[]): [string, string] => {
      const a = money(values[0] as string, currency, basis);
      const b = money(values[1] as string, currency, basis);
      return [canonical(addMoney(a, b)), canonical(addMoney(b, a))];
    };
    const [left, right] = evaluate(operands);
    if (left !== right) {
      assert.fail(report({
        law: 'addMoney(a, b) === addMoney(b, a)',
        seed,
        index,
        operands,
        detail: `a + b = ${left}\nb + a = ${right}\ncurrency=${currency} basis=${basis}`,
        stillFails: (candidate) => {
          const [x, y] = evaluate(candidate);
          return x !== y;
        },
      }));
    }
  }
});

test('LAW addMoney is associative over generated amounts inside the coefficient budget', () => {
  const { seed, rng } = context('addMoney/associative');
  for (let index = 0; index < MONEY_LAW_CASES; index += 1) {
    const currency = rng.pick(CURRENCIES);
    const basis = rng.pick(ECONOMIC_BASES);
    const operands = [generateAmountText(rng), generateAmountText(rng), generateAmountText(rng)];
    const evaluate = (values: readonly string[]): [string, string] => {
      const a = money(values[0] as string, currency, basis);
      const b = money(values[1] as string, currency, basis);
      const c = money(values[2] as string, currency, basis);
      return [canonical(addMoney(addMoney(a, b), c)), canonical(addMoney(a, addMoney(b, c)))];
    };
    const [left, right] = evaluate(operands);
    if (left !== right) {
      assert.fail(report({
        law: 'addMoney(addMoney(a, b), c) === addMoney(a, addMoney(b, c))',
        seed,
        index,
        operands,
        detail: `(a + b) + c = ${left}\na + (b + c) = ${right}\ncurrency=${currency} basis=${basis}`,
        stillFails: (candidate) => {
          const [x, y] = evaluate(candidate);
          return x !== y;
        },
      }));
    }
  }
});

test('LAW zero is the two-sided additive identity for every basis', () => {
  const { seed, rng } = context('addMoney/identity');
  for (let index = 0; index < MONEY_LAW_CASES; index += 1) {
    const currency = rng.pick(CURRENCIES);
    const basis = rng.pick(ECONOMIC_BASES);
    const operands = [generateAmountText(rng)];
    const evaluate = (values: readonly string[]): [string, string, string] => {
      const a = money(values[0] as string, currency, basis);
      // A zero written with a scale, so the identity is tested against a value
      // that had to normalize rather than one that was already canonical.
      const zero = money('0.000', currency, basis);
      return [canonical(a), canonical(addMoney(a, zero)), canonical(addMoney(zero, a))];
    };
    const [self, right, left] = evaluate(operands);
    if (self !== right || self !== left) {
      assert.fail(report({
        law: 'addMoney(a, 0) === a === addMoney(0, a)',
        seed,
        index,
        operands,
        detail: `a = ${self}\na + 0 = ${right}\n0 + a = ${left}\ncurrency=${currency} basis=${basis}`,
        stillFails: (candidate) => {
          const [s, r, l] = evaluate(candidate);
          return s !== r || s !== l;
        },
      }));
    }
  }
});

test('LAW subtractMoney(a, a) and addMoney(a, negateMoney(a)) are exactly zero', () => {
  const { seed, rng } = context('addMoney/inverse');
  // Exactly zero means the canonical zero: coefficient 0n AND scale 0. A result
  // that formatted as "0.00" would be a different value carrying a scale it has
  // no basis for, and every downstream digest would see it.
  const expectedZero = (currency: string, basis: EconomicBasis): string => canonical(money('0', currency, basis));
  for (let index = 0; index < MONEY_LAW_CASES; index += 1) {
    const currency = rng.pick(CURRENCIES);
    const basis = rng.pick(ECONOMIC_BASES);
    const operands = [generateAmountText(rng)];
    const evaluate = (values: readonly string[]): [string, string, string] => {
      const a = money(values[0] as string, currency, basis);
      return [
        canonical(subtractMoney(a, a)),
        canonical(addMoney(a, negateMoney(a))),
        canonical(negateMoney(negateMoney(a))) === canonical(a) ? 'involution-holds' : 'involution-broken',
      ];
    };
    const [difference, sum, involution] = evaluate(operands);
    const zero = expectedZero(currency, basis);
    if (difference !== zero || sum !== zero || involution !== 'involution-holds') {
      assert.fail(report({
        law: 'subtractMoney(a, a) === 0, addMoney(a, negateMoney(a)) === 0, negateMoney is an involution',
        seed,
        index,
        operands,
        detail: `expected zero = ${zero}\na - a = ${difference}\na + (-a) = ${sum}\nnegate: ${involution}\ncurrency=${currency} basis=${basis}`,
        stillFails: (candidate) => {
          const [d, s, i] = evaluate(candidate);
          return d !== zero || s !== zero || i !== 'involution-holds';
        },
      }));
    }
  }
});

// ---------------------------------------------------------------------------
// Order structure
// ---------------------------------------------------------------------------

test('LAW compareMoney is a total order consistent with the arithmetic', () => {
  const { seed, rng } = context('compareMoney/total-order');
  for (let index = 0; index < MONEY_LAW_CASES; index += 1) {
    const currency = rng.pick(CURRENCIES);
    const basis = rng.pick(ECONOMIC_BASES);
    const operands = [generateAmountText(rng), generateAmountText(rng), generateAmountText(rng)];
    const evaluate = (values: readonly string[]): readonly string[] => {
      const [a, b, c] = values.map((value) => money(value as string, currency, basis)) as [Money, Money, Money];
      const zero = money('0', currency, basis);
      const problems: string[] = [];
      // Reflexive.
      if (compareMoney(a, a) !== 0) problems.push(`compare(a, a) = ${compareMoney(a, a)}, expected 0`);
      // Antisymmetric.
      if (compareMoney(a, b) !== -compareMoney(b, a)) {
        problems.push(`compare(a, b) = ${compareMoney(a, b)} but compare(b, a) = ${compareMoney(b, a)}`);
      }
      // Total: equality of order position implies equality of value at this basis.
      if (compareMoney(a, b) === 0 && formatMoneyAmount(a) !== formatMoneyAmount(b)) {
        problems.push(`compare(a, b) = 0 but ${formatMoneyAmount(a)} != ${formatMoneyAmount(b)}`);
      }
      // Transitive, over the sorted triple so the antecedent is always satisfied.
      const sorted = [a, b, c].sort((left, right) => compareMoney(left, right));
      const [low, middle, high] = sorted as [Money, Money, Money];
      if (compareMoney(low, middle) > 0 || compareMoney(middle, high) > 0 || compareMoney(low, high) > 0) {
        problems.push(`sorted triple is not ordered: ${sorted.map(canonical).join(' | ')}`);
      }
      // Consistent with subtraction: the order is the sign of the difference.
      if (compareMoney(a, b) !== compareMoney(subtractMoney(a, b), zero)) {
        problems.push(`compare(a, b) = ${compareMoney(a, b)} but sign(a - b) = ${compareMoney(subtractMoney(a, b), zero)}`);
      }
      // Translation invariant: adding the same value to both sides preserves order.
      if (compareMoney(addMoney(a, c), addMoney(b, c)) !== compareMoney(a, b)) {
        problems.push(`compare(a + c, b + c) = ${compareMoney(addMoney(a, c), addMoney(b, c))} but compare(a, b) = ${compareMoney(a, b)}`);
      }
      return problems;
    };
    const problems = evaluate(operands);
    if (problems.length > 0) {
      assert.fail(report({
        law: 'compareMoney is reflexive, antisymmetric, transitive, sign-consistent and translation-invariant',
        seed,
        index,
        operands,
        detail: `${problems.join('\n')}\ncurrency=${currency} basis=${basis}`,
        stillFails: (candidate) => evaluate(candidate).length > 0,
      }));
    }
  }
});

// ---------------------------------------------------------------------------
// Representation: normal form, formatting, JSON
// ---------------------------------------------------------------------------

test('LAW every constructed Money is in canonical normal form', () => {
  const { seed, rng } = context('money/normal-form');
  for (let index = 0; index < MONEY_LAW_CASES; index += 1) {
    const currency = rng.pick(CURRENCIES);
    const basis = rng.pick(ECONOMIC_BASES);
    const operands = [generateAmountText(rng)];
    const evaluate = (values: readonly string[]): readonly string[] => {
      const a = money(values[0] as string, currency, basis);
      const problems: string[] = [];
      if (a.scale > 0 && a.coefficient % 10n === 0n) problems.push('scale carries a representation-only trailing zero');
      if (a.coefficient === 0n && a.scale !== 0) problems.push('zero carries a non-zero scale');
      if (!Object.isFrozen(a)) problems.push('value is not frozen');
      if (a.currency !== currency || a.basis !== basis) problems.push('currency or basis was not preserved');
      return problems;
    };
    const problems = evaluate(operands);
    if (problems.length > 0) {
      assert.fail(report({
        law: 'money() returns a frozen, fully normalized value',
        seed,
        index,
        operands,
        detail: `${problems.join('\n')}\ncurrency=${currency} basis=${basis}`,
        stillFails: (candidate) => evaluate(candidate).length > 0,
      }));
    }
  }
});

test('LAW formatMoneyAmount round-trips through money()', () => {
  const { seed, rng } = context('formatMoneyAmount/round-trip');
  for (let index = 0; index < MONEY_LAW_CASES; index += 1) {
    const currency = rng.pick(CURRENCIES);
    const basis = rng.pick(ECONOMIC_BASES);
    const operands = [generateAmountText(rng)];
    const evaluate = (values: readonly string[]): [string, string] => {
      const a = money(values[0] as string, currency, basis);
      // The round trip is stated on the VALUE, not on the input string: '1.10'
      // and '-0' are legal inputs whose normal forms are '1.1' and '0', so a law
      // written as format(money(text)) === text would be asserting that the
      // module does not normalize, which is the opposite of what it guarantees.
      return [canonical(a), canonical(money(formatMoneyAmount(a), currency, basis))];
    };
    const [original, reparsed] = evaluate(operands);
    if (original !== reparsed) {
      assert.fail(report({
        law: 'money(formatMoneyAmount(a), currency, basis) === a',
        seed,
        index,
        operands,
        detail: `a          = ${original}\nre-parsed  = ${reparsed}\ncurrency=${currency} basis=${basis}`,
        stillFails: (candidate) => {
          const [x, y] = evaluate(candidate);
          return x !== y;
        },
      }));
    }
  }
});

test('LAW moneyToJson/moneyFromJson round-trips exactly, including scale and basis', () => {
  const { seed, rng } = context('moneyJson/round-trip');
  for (let index = 0; index < MONEY_LAW_CASES; index += 1) {
    const currency = rng.pick(CURRENCIES);
    const basis = rng.pick(ECONOMIC_BASES);
    const operands = [generateAmountText(rng)];
    const evaluate = (values: readonly string[]): readonly string[] => {
      const a = money(values[0] as string, currency, basis);
      const encoded = moneyToJson(a);
      const problems: string[] = [];
      if (canonical(moneyFromJson(encoded)) !== canonical(a)) problems.push('direct round trip lost the value');
      // Through real JSON text, because that is how the ledger and the wire
      // actually carry it: a coefficient that became a Number here would round.
      const throughText = moneyFromJson(JSON.parse(JSON.stringify(encoded)) as ReturnType<typeof moneyToJson>);
      if (canonical(throughText) !== canonical(a)) problems.push('round trip through JSON text lost the value');
      if (typeof encoded.coefficient !== 'string') problems.push('coefficient was not encoded as a string');
      if (encoded.scale !== a.scale) problems.push(`scale changed: ${encoded.scale} != ${a.scale}`);
      if (encoded.basis !== a.basis) problems.push(`basis changed: ${encoded.basis} != ${a.basis}`);
      if (encoded.currency !== a.currency) problems.push(`currency changed: ${encoded.currency} != ${a.currency}`);
      return problems;
    };
    const problems = evaluate(operands);
    if (problems.length > 0) {
      assert.fail(report({
        law: 'moneyFromJson(moneyToJson(a)) === a, exactly, including through JSON text',
        seed,
        index,
        operands,
        detail: `${problems.join('\n')}\ncurrency=${currency} basis=${basis}`,
        stillFails: (candidate) => evaluate(candidate).length > 0,
      }));
    }
  }
});

// ---------------------------------------------------------------------------
// Basis legality, derived from the exported array rather than hand-listed
// ---------------------------------------------------------------------------

/**
 * Every ORDERED pair of distinct bases, read off `ECONOMIC_BASES`.
 *
 * Derived rather than hand-listed on purpose: an eighth basis added to the
 * module is covered by this sweep on the day it is added, with no edit here. A
 * hand-written list would silently keep testing seven.
 */
const ORDERED_DISTINCT_BASIS_PAIRS: readonly (readonly [EconomicBasis, EconomicBasis])[] = ECONOMIC_BASES
  .flatMap((left) => ECONOMIC_BASES
    .filter((right) => right !== left)
    .map((right) => [left, right] as const));

test('LAW adding across any two distinct economic bases is refused', () => {
  // The count is asserted so that a basis being added, removed or renamed shows
  // up as a changed enumeration rather than as a quietly smaller sweep.
  assert.equal(ECONOMIC_BASES.length, 7);
  assert.equal(ORDERED_DISTINCT_BASIS_PAIRS.length, 42);

  const { seed, rng } = context('basis/cross-refusal');
  for (const [left, right] of ORDERED_DISTINCT_BASIS_PAIRS) {
    // Generated magnitudes, so the refusal cannot depend on the value: it is a
    // property of the basis pair alone.
    const a = money(generateAmountText(rng), 'USD', left);
    const b = money(generateAmountText(rng), 'USD', right);
    const detail = `seed ${seed}: ${canonical(a)} against ${canonical(b)}`;
    assert.throws(() => addMoney(a, b), /economic basis mismatch/, `addMoney accepted ${left} + ${right}\n${detail}`);
    assert.throws(() => subtractMoney(a, b), /economic basis mismatch/, `subtractMoney accepted ${left} - ${right}\n${detail}`);
    assert.throws(() => compareMoney(a, b), /economic basis mismatch/, `compareMoney accepted ${left} vs ${right}\n${detail}`);
  }
});

test('LAW adding across two distinct currencies is refused at every basis', () => {
  const { seed, rng } = context('currency/cross-refusal');
  for (const basis of ECONOMIC_BASES) {
    for (const left of CURRENCIES) {
      for (const right of CURRENCIES) {
        if (left === right) continue;
        const a = money(generateAmountText(rng), left, basis);
        const b = money(generateAmountText(rng), right, basis);
        const detail = `seed ${seed}: ${canonical(a)} against ${canonical(b)}`;
        assert.throws(() => addMoney(a, b), /currency mismatch/, `addMoney accepted ${left} + ${right} at ${basis}\n${detail}`);
        assert.throws(() => compareMoney(a, b), /currency mismatch/, `compareMoney accepted ${left} vs ${right} at ${basis}\n${detail}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Where the algebra stops being total
// ---------------------------------------------------------------------------

test('the coefficient ceiling is a real boundary, so addition is partial rather than total', () => {
  // Stated here, in the open, instead of being avoided by generating only small
  // values. `alignedCoefficients` multiplies the smaller-scaled operand by a
  // power of ten; `normalize` then refuses a coefficient wider than the limit.
  // A caller adding a maximum-width integer to a value carrying decimal places
  // gets a refusal, not a silently truncated total — which is the correct
  // behaviour for an exact type and the reason the generators above stay inside
  // a budget rather than pretending the ceiling is not there.
  const widest = money('9'.repeat(MAX_MONEY_COEFFICIENT_DIGITS), 'USD', 'billed');
  assert.equal(widest.coefficient.toString().length, MAX_MONEY_COEFFICIENT_DIGITS);
  assert.throws(
    () => addMoney(widest, money('0.01', 'USD', 'billed')),
    /coefficient exceeds/,
    'aligning a maximum-width coefficient against a scaled value must be refused, not truncated',
  );
  // The same pair at equal scale still works: it is the ALIGNMENT that overflows,
  // not the addition, and the message should stay honest about which.
  assert.equal(formatMoneyAmount(addMoney(widest, money('0', 'USD', 'billed'))), '9'.repeat(MAX_MONEY_COEFFICIENT_DIGITS));
});
