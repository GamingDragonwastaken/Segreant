/**
 * Properties of empirical-Bayes reliability shrinkage (src/value/reliability.ts).
 * These pin the behavior the "trust in proportion to evidence" claim rests on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBetaPrior, shrinkRate, reliability } from '../src/value/reliability.ts';

test('under-dispersed cells (all the same rate) ⟹ maximal shrinkage strength — the spread is pure noise', () => {
  const prior = estimateBetaPrior([{ k: 6, n: 10 }, { k: 6, n: 10 }, { k: 6, n: 10 }], { maxStrength: 1000 });
  assert.equal(prior.strength, 1000);
  assert.ok(Math.abs(prior.mean - 0.6) < 1e-9);
});

test('extremely over-dispersed cells (0/10 and 10/10) ⟹ minimal shrinkage — the differences are real', () => {
  const prior = estimateBetaPrior([{ k: 0, n: 10 }, { k: 10, n: 10 }], { minStrength: 1, maxStrength: 1000 });
  assert.equal(prior.strength, 1); // clamped to the floor: heavy real variation, trust the cells
});

test('shrinkage pulls a tiny sample toward the mean but barely moves a large one (the batting-average fix)', () => {
  const prior = { mean: 0.6, strength: 10 };
  const small = shrinkRate(2, 2, prior); // raw 100%
  const large = shrinkRate(140, 200, prior); // raw 70%
  assert.ok(small < 1 && small > prior.mean, `2/2 pulled below raw toward mean: ${small}`);
  assert.ok(Math.abs(small - 0.667) < 1e-3, `(2+6)/(2+10)=0.667, got ${small}`);
  assert.ok(Math.abs(large - 0.7) < 0.02, `200 units barely move: ${large}`);
  // The raw ranking says the 2/2 cell (100%) beats the 200-unit cell (70%);
  // after shrinkage the well-evidenced cell is (correctly) ranked at least as high.
  assert.ok(large > small, `reliability flips the noisy winner: large ${large} > small ${small}`);
});

test('reliability is the evidence weight n/(n+κ): rises with n, always in [0,1]', () => {
  const prior = { mean: 0.5, strength: 20 };
  const r2 = reliability(2, prior);
  const r200 = reliability(200, prior);
  assert.ok(r2 >= 0 && r2 <= 1 && r200 >= 0 && r200 <= 1);
  assert.ok(r200 > r2, `more data ⟹ more trust: ${r200} > ${r2}`);
  assert.ok(Math.abs(r2 - 2 / 22) < 1e-9 && Math.abs(r200 - 200 / 220) < 1e-9);
});

test('a moderately-dispersed set yields a finite, in-bounds prior with the pooled mean', () => {
  const prior = estimateBetaPrior(
    [{ k: 10, n: 20 }, { k: 12, n: 20 }, { k: 14, n: 20 }, { k: 13, n: 20 }, { k: 11, n: 20 }],
    { minStrength: 1, maxStrength: 1000 },
  );
  assert.ok(prior.strength >= 1 && prior.strength <= 1000);
  assert.ok(Math.abs(prior.mean - 60 / 100) < 1e-9); // pooled 60/100
});

test('degenerate input (a single cell) falls back to a strong prior, never an invented spread', () => {
  const prior = estimateBetaPrior([{ k: 3, n: 4 }], { maxStrength: 1000 });
  assert.equal(prior.strength, 1000);
});
