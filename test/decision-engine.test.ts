import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  certifyDecision,
  minimaxRegret,
  valueOfInformation,
  preferenceRobustness,
  buildUtilityIntervalProblem,
  type ActionUtilityInterval,
} from '../src/decision/engine.ts';

const actions: ActionUtilityInterval[] = [
  { action: 'keep-premium', low: 12, high: 18 },
  { action: 'route-cheap', low: 2, high: 10 },
  { action: 'pause', low: -1, high: 4 },
];

test('decision certificate proves robust dominance only when lower bound beats every rival upper bound', () => {
  const certificate = certifyDecision(actions);
  assert.equal(certificate.status, 'proven_dominant');
  assert.equal(certificate.action, 'keep-premium');
  assert.equal(certificate.margin, 2);
});

test('overlapping utility intervals remain undetermined rather than becoming a recommendation disguised as proof', () => {
  const certificate = certifyDecision([
    { action: 'a', low: 1, high: 9 },
    { action: 'b', low: 4, high: 10 },
  ]);
  assert.equal(certificate.status, 'undetermined');
  assert.equal(certificate.action, null);
  assert.equal(certificate.margin, null);
});

test('minimax regret is explicit about the rectangular interval uncertainty set', () => {
  const result = minimaxRegret([
    { action: 'a', low: 5, high: 9 },
    { action: 'b', low: 7, high: 8 },
  ]);
  assert.equal(result.assumption, 'rectangular_interval_uncertainty');
  assert.deepEqual(result.maxRegretByAction, { a: 3, b: 2 });
  assert.deepEqual(result.actions, ['b']);
  assert.equal(result.minimaxRegret, 2);
});

test('value of information prices expected decision-loss reduction and subtracts measurement cost', () => {
  const voi = valueOfInformation({
    currentExpectedUtilities: { a: 4.5, b: 4.5 },
    posteriorScenarios: [
      { probability: 0.5, expectedUtilities: { a: 8, b: 2 } },
      { probability: 0.5, expectedUtilities: { a: 1, b: 7 } },
    ],
    measurementCost: 1,
  });
  // Scenario-implied prior tie = 4.5. With information: 0.5*8 + 0.5*7 = 7.5. Gross VOI 3, net 2.
  assert.equal(voi.currentOptimalExpectedUtility, 4.5);
  assert.equal(voi.informedOptimalExpectedUtility, 7.5);
  assert.equal(voi.grossValue, 3);
  assert.equal(voi.netValue, 2);
});

test('value of information rejects an independently supplied prior that disagrees with the scenario mixture', () => {
  assert.throws(() => valueOfInformation({
    currentExpectedUtilities: { a: 5, b: 4 },
    posteriorScenarios: [
      { probability: 0.5, expectedUtilities: { a: 8, b: 2 } },
      { probability: 0.5, expectedUtilities: { a: 1, b: 7 } },
    ],
    measurementCost: 0,
  }), /inconsistent.*scenario/i);
});

test('value of information derives the prior from scenarios when no compatibility assertion is supplied', () => {
  const voi = valueOfInformation({
    posteriorScenarios: [
      { probability: 0.5, expectedUtilities: { a: 8, b: 2 } },
      { probability: 0.5, expectedUtilities: { a: 1, b: 7 } },
    ],
    measurementCost: 0,
  });
  assert.deepEqual(voi.priorExpectedUtilities, { a: 4.5, b: 4.5 });
  assert.equal(voi.currentOptimalExpectedUtility, 4.5);
  assert.deepEqual(voi.currentOptimalActions, ['a', 'b']);
  assert.equal(voi.grossValue, 3);
});

test('deterministic perfect information has zero gross value before measurement cost', () => {
  const voi = valueOfInformation({
    posteriorScenarios: [{ probability: 1, expectedUtilities: { a: 8, b: 2 } }],
    measurementCost: 0,
  });
  assert.equal(voi.grossValue, 0);
  assert.equal(voi.netValue, 0);
});

test('measurement cost can make net VoI negative without changing gross VoI', () => {
  const voi = valueOfInformation({
    posteriorScenarios: [
      { probability: 0.5, expectedUtilities: { a: 8, b: 2 } },
      { probability: 0.5, expectedUtilities: { a: 1, b: 7 } },
    ],
    measurementCost: 4,
  });
  assert.equal(voi.grossValue, 3);
  assert.equal(voi.netValue, -1);
});

test('finite coherent scenario mixtures never produce negative gross VoI', () => {
  const probabilities = [0.2, 0.3, 0.5];
  for (let seed = 1; seed <= 50; seed += 1) {
    const scenarios = probabilities.map((probability, index) => ({
      probability,
      expectedUtilities: {
        a: ((seed * 17 + index * 11) % 29) - 7,
        b: ((seed * 13 + index * 19) % 31) - 9,
        c: ((seed * 23 + index * 7) % 37) - 12,
      },
    }));
    const voi = valueOfInformation({ posteriorScenarios: scenarios, measurementCost: 0 });
    assert.ok(voi.grossValue >= 0, `seed ${seed} produced negative gross VoI`);
  }
});

test('VoI fails closed when finite inputs would overflow an expected utility', () => {
  assert.throws(() => valueOfInformation({
    posteriorScenarios: [
      { probability: 0.5, expectedUtilities: { a: Number.MAX_VALUE, b: 0 } },
      { probability: 0.5, expectedUtilities: { a: Number.MAX_VALUE, b: 0 } },
    ],
    measurementCost: 0,
  }), /safe utility range/i);
});

test('value of information validates probabilities and identical action sets', () => {
  assert.throws(() => valueOfInformation({
    currentExpectedUtilities: { a: 1 },
    posteriorScenarios: [{ probability: 0.8, expectedUtilities: { a: 1 } }],
    measurementCost: 0,
  }), /probabilities must sum to 1/);

  assert.throws(() => valueOfInformation({
    currentExpectedUtilities: { a: 1, b: 2 },
    posteriorScenarios: [{ probability: 1, expectedUtilities: { a: 3 } }],
    measurementCost: 0,
  }), /same action set/);
});

test('decision inputs reject inverted/non-finite utility intervals', () => {
  assert.throws(() => certifyDecision([{ action: 'a', low: 2, high: 1 }]), /low must be <= high/);
  assert.throws(() => minimaxRegret([{ action: 'a', low: Number.NaN, high: 1 }]), /finite/);
});

test('interval problems refuse unjustified point utilities', () => {
  assert.throws(() => buildUtilityIntervalProblem([
    { action: 'keep', utility: 10 },
    { action: 'switch', utility: 8 },
  ]), /point utilities require an explicit uncertainty bound/i);
});

test('preference robustness returns an action stable across every admissible preference', () => {
  const result = preferenceRobustness([
    { preferenceId: 'risk-averse', utilities: { ship: 8, wait: 4 } },
    { preferenceId: 'growth-oriented', utilities: { ship: 10, wait: 6 } },
  ]);
  assert.equal(result.status, 'stable');
  assert.deepEqual(result.robustOptimalActions, ['ship']);
  assert.deepEqual(result.optimalActionsByPreference, {
    'growth-oriented': ['ship'],
    'risk-averse': ['ship'],
  });
});

test('preference robustness refuses to force an action when admissible preferences disagree', () => {
  const result = preferenceRobustness([
    { preferenceId: 'cost-first', utilities: { ship: 6, wait: 9 } },
    { preferenceId: 'quality-first', utilities: { ship: 10, wait: 7 } },
  ]);
  assert.equal(result.status, 'preference_sensitive');
  assert.deepEqual(result.robustOptimalActions, []);
  assert.deepEqual(result.optimalActionsByPreference, {
    'cost-first': ['wait'],
    'quality-first': ['ship'],
  });
});

test('preference robustness preserves ties and rejects incomplete preference sets', () => {
  const tied = preferenceRobustness([
    { preferenceId: 'declared', utilities: { ship: 5, wait: 5 } },
  ]);
  assert.equal(tied.status, 'stable');
  assert.deepEqual(tied.robustOptimalActions, ['ship', 'wait']);

  assert.throws(() => preferenceRobustness([
    { preferenceId: 'same', utilities: { ship: 1 } },
    { preferenceId: 'same', utilities: { ship: 2 } },
  ]), /duplicate preferenceId/);
  assert.throws(() => preferenceRobustness([
    { preferenceId: 'one', utilities: { ship: 1, wait: 2 } },
    { preferenceId: 'two', utilities: { ship: 1 } },
  ]), /same action set/);
  assert.throws(() => preferenceRobustness([
    { preferenceId: '__proto__', utilities: { ship: 1 } },
  ]), /forbidden object key/);
});
