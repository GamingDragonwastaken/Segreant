import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  minimalInvalidatingAssumptionSets,
  type CertificationStructure,
} from '../src/epistemic/countermodel.ts';
import { minimalHittingSets } from '../src/epistemic/dag.ts';
import {
  decisionCertificationStructure,
  decisionInvalidatingAssumptionSets,
} from '../src/decision/countermodels.ts';
import { certifyDecision, type ActionUtilityInterval } from '../src/decision/engine.ts';

/**
 * One structure carries all three cases that matter.
 *
 * Certification holds while `A and B` holds, or while `A and C` holds. So:
 *   - `A` alone removes it — a singleton set;
 *   - `B` alone does not, and `C` alone does not, but `B` and `C` jointly do —
 *     one pair, no singleton;
 *   - `D` carries nothing, so its failure changes nothing and it must appear in
 *     no minimal set at all.
 */
const STRUCTURE: CertificationStructure = {
  assumptions: ['A', 'B', 'C', 'D'],
  certified: true,
  supports: [['A', 'B'], ['A', 'C']],
};

const DOMINANT_INTERVALS: readonly ActionUtilityInterval[] = [
  { action: 'model-a', low: 10, high: 12 },
  { action: 'model-b', low: 2, high: 4 },
];

const OVERLAPPING_INTERVALS: readonly ActionUtilityInterval[] = [
  { action: 'model-a', low: 1, high: 6 },
  { action: 'model-b', low: 2, high: 5 },
];

test('a minimal invalidating set is a singleton, a joint pair, or nothing at all', () => {
  const result = minimalInvalidatingAssumptionSets(STRUCTURE);

  assert.deepEqual(result.sets.map((set) => [...set]), [['A'], ['B', 'C']]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.emptyBecause, null);

  // A singleton for `B` or `C` would assert a fragility the structure denies.
  assert.equal(result.sets.some((set) => set.length === 1 && set[0] === 'B'), false);
  assert.equal(result.sets.some((set) => set.length === 1 && set[0] === 'C'), false);

  // `D` is load-bearing for nothing, and the result must say so rather than
  // leaving a reader to infer it from absence.
  assert.deepEqual(result.inertAssumptions, ['D']);
  assert.equal(result.sets.some((set) => set.includes('D')), false);
});

test('the enumeration bound is reported by the return value, never applied silently', () => {
  const wide: CertificationStructure = {
    assumptions: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
    certified: true,
    supports: [['a1', 'a2'], ['a3', 'a4'], ['a5', 'a6'], ['a7', 'a8']],
  };

  const complete = minimalInvalidatingAssumptionSets(wide, { limit: 64 });
  assert.equal(complete.truncated, false);
  assert.equal(complete.sets.length, 16);
  assert.deepEqual(complete.inertAssumptions, []);

  const capped = minimalInvalidatingAssumptionSets(wide, { limit: 4 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.limit, 4);
  assert.equal(capped.sets.length, 4);
  // A capped search cannot tell "in no minimal set" from "in a set we never
  // reached", so it must refuse to name inert assumptions rather than report a
  // prefix as the whole answer.
  assert.equal(capped.inertAssumptions, null);
});

test('an unstated or empty support is refused rather than quietly shrinking the answer', () => {
  assert.throws(
    () => minimalInvalidatingAssumptionSets({
      assumptions: ['A'],
      certified: true,
      supports: [['A', 'Z']],
    }),
    /does not state/,
  );

  assert.throws(
    () => minimalInvalidatingAssumptionSets({
      assumptions: ['A'],
      certified: true,
      supports: [[]],
    }),
    /at least one assumption/,
  );

  assert.throws(
    () => minimalInvalidatingAssumptionSets(STRUCTURE, { limit: 0 }),
    /positive integer/,
  );
});

test('no certification and no declared support are distinct emptinesses', () => {
  const uncertified = minimalInvalidatingAssumptionSets({ ...STRUCTURE, certified: false });
  assert.deepEqual(uncertified.sets, []);
  assert.equal(uncertified.emptyBecause, 'certification_not_in_force');
  assert.equal(uncertified.inertAssumptions, null);

  const unexamined = minimalInvalidatingAssumptionSets({
    assumptions: ['A', 'B'],
    certified: true,
    supports: [],
  });
  assert.deepEqual(unexamined.sets, []);
  assert.equal(unexamined.emptyBecause, 'no_supports_declared');
  assert.equal(unexamined.inertAssumptions, null);
});

test('the proven dominance certificate rests on two assumptions and not on the third', () => {
  const certificate = certifyDecision(DOMINANT_INTERVALS);
  assert.equal(certificate.status, 'proven_dominant');

  const structure = decisionCertificationStructure(certificate);
  assert.deepEqual(structure.assumptions, [...certificate.assumptions]);
  assert.equal(structure.certified, true);

  const result = decisionInvalidatingAssumptionSets(DOMINANT_INTERVALS);
  const bound = certificate.assumptions[0]!;
  const rectangular = certificate.assumptions[1]!;
  const criterion = certificate.assumptions[2]!;

  assert.deepEqual(result.sets.map((set) => [...set]).sort(), [[bound], [criterion]].sort());
  assert.equal(result.truncated, false);
  // Rectangularity is a regret assumption; `certifyDecision` compares one low
  // against every rival high and never uses it.
  assert.deepEqual(result.inertAssumptions, [rectangular]);
});

test('an undetermined certificate has no certification to invalidate', () => {
  const certificate = certifyDecision(OVERLAPPING_INTERVALS);
  assert.equal(certificate.status, 'undetermined');

  const result = decisionInvalidatingAssumptionSets(OVERLAPPING_INTERVALS);
  assert.deepEqual(result.sets, []);
  assert.equal(result.emptyBecause, 'certification_not_in_force');
  assert.equal(result.inertAssumptions, null);
  assert.deepEqual(result.assumptions, [...certificate.assumptions]);
});

test('invalidating sets and minimal cut sets are one hitting-set algorithm, not two', () => {
  const direct = minimalHittingSets([['A', 'B'], ['A', 'C']]);
  assert.equal(direct.truncated, false);
  assert.deepEqual(
    direct.sets.map((set) => [...set]),
    minimalInvalidatingAssumptionSets(STRUCTURE).sets.map((set) => [...set]),
  );
});
