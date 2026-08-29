import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  certifyDecision,
  minimaxRegret,
  valueOfInformation,
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
    currentExpectedUtilities: { a: 5, b: 4 },
    posteriorScenarios: [
      { probability: 0.5, expectedUtilities: { a: 8, b: 2 } },
      { probability: 0.5, expectedUtilities: { a: 1, b: 7 } },
    ],
    measurementCost: 1,
  });
  // Current best = 5. With information: 0.5*8 + 0.5*7 = 7.5. Gross VOI 2.5, net 1.5.
  assert.equal(voi.currentOptimalExpectedUtility, 5);
  assert.equal(voi.informedOptimalExpectedUtility, 7.5);
  assert.equal(voi.grossValue, 2.5);
  assert.equal(voi.netValue, 1.5);
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
