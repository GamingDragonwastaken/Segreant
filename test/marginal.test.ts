/**
 * Properties of the Shadow Price of Intelligence (src/value/marginal.ts).
 * The water-filling optimum + the shadow-price headline the allocation story rests on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowPriceOfIntelligence } from '../src/value/marginal.ts';

test('symmetric contexts ⟹ equal optimal split and (near) zero reallocation uplift', () => {
  const r = shadowPriceOfIntelligence([
    { key: 'a', costUsd: 10, spendOnRealizedUnitsUsd: 6 },
    { key: 'b', costUsd: 10, spendOnRealizedUnitsUsd: 6 },
  ]);
  const a = r.items.find((i) => i.key === 'a')!;
  const b = r.items.find((i) => i.key === 'b')!;
  assert.ok(Math.abs(a.optimalUsd - 10) < 1e-6 && Math.abs(b.optimalUsd - 10) < 1e-6);
  assert.ok(Math.abs(r.upliftUsd) < 1e-6, 'already optimal ⟹ no uplift');
});

test('concavity forbids winner-take-all: the better context gets more budget, never all of it', () => {
  const r = shadowPriceOfIntelligence(
    [
      { key: 'good', costUsd: 10, spendOnRealizedUnitsUsd: 9 },
      { key: 'weak', costUsd: 10, spendOnRealizedUnitsUsd: 3 },
    ],
    { beta: 0.5 },
  );
  const good = r.items.find((i) => i.key === 'good')!;
  const weak = r.items.find((i) => i.key === 'weak')!;
  assert.ok(Math.abs(good.optimalUsd - 18) < 1e-6, `good→18, got ${good.optimalUsd}`);
  assert.ok(Math.abs(weak.optimalUsd - 2) < 1e-6, `weak→2, got ${weak.optimalUsd}`);
  assert.ok(good.optimalUsd < r.budgetUsd, 'never the whole budget');
  assert.ok(weak.optimalUsd > 0, 'the weak context is starved, not zeroed');
});

test('reallocating the SAME budget optimally never lowers modeled value (V* ≥ V0)', () => {
  const r = shadowPriceOfIntelligence([
    { key: 'a', costUsd: 5, spendOnRealizedUnitsUsd: 4 },
    { key: 'b', costUsd: 15, spendOnRealizedUnitsUsd: 3 },
    { key: 'c', costUsd: 8, spendOnRealizedUnitsUsd: 7 },
  ]);
  assert.ok(r.optimalValueUsd >= r.currentValueUsd - 1e-9, `${r.optimalValueUsd} ≥ ${r.currentValueUsd}`);
  assert.ok(r.upliftUsd >= -1e-9);
});

test('the shadow price obeys μ = β·V*/B and sets paysAtMargin', () => {
  const r = shadowPriceOfIntelligence([
    { key: 'a', costUsd: 10, spendOnRealizedUnitsUsd: 20 },
    { key: 'b', costUsd: 10, spendOnRealizedUnitsUsd: 15 },
  ], { beta: 0.6 });
  assert.ok(Math.abs(r.shadowPriceUsd - (0.6 * r.optimalValueUsd) / r.budgetUsd) < 1e-9);
  assert.equal(r.paysAtMargin, r.shadowPriceUsd >= 1);
});

test('higher β (weaker diminishing returns) concentrates budget harder on the best context', () => {
  const cells = [
    { key: 'good', costUsd: 10, spendOnRealizedUnitsUsd: 9 },
    { key: 'weak', costUsd: 10, spendOnRealizedUnitsUsd: 3 },
  ];
  const low = shadowPriceOfIntelligence(cells, { beta: 0.3 });
  const high = shadowPriceOfIntelligence(cells, { beta: 0.8 });
  const shareGood = (r: ReturnType<typeof shadowPriceOfIntelligence>) => r.items.find((i) => i.key === 'good')!.optimalUsd / r.budgetUsd;
  assert.ok(shareGood(high) > shareGood(low), `β=0.8 concentrates more than β=0.3: ${shareGood(high)} > ${shareGood(low)}`);
});

test('degenerate input (no realized value anywhere) ⟹ status quo, shadow price 0', () => {
  const r = shadowPriceOfIntelligence([
    { key: 'a', costUsd: 10, spendOnRealizedUnitsUsd: 0 },
    { key: 'b', costUsd: 5, spendOnRealizedUnitsUsd: 0 },
  ]);
  assert.equal(r.shadowPriceUsd, 0);
  assert.equal(r.upliftUsd, 0);
  assert.ok(r.items.every((i) => i.deltaUsd === 0));
});

// ---- β estimated from the org's own curvature (within-context, aᵢ cancels) ----

test('estimateBeta: recovers the true elasticity exactly, regardless of context quality spread', async () => {
  const { estimateBetaFromPairs } = await import('../src/value/marginal.ts');
  const beta = 0.6;
  // Wildly different aᵢ per context — the pooled-regression confounder. Within-
  // context slopes cancel aᵢ, so recovery must be EXACT on noiseless data.
  const pairs = [0.5, 2, 7, 20, 55].map((a, i) => {
    const s1 = 4 + i;
    const s2 = s1 * 2.5;
    return { key: `c${i}`, spend1: s1, value1: a * s1 ** beta, spend2: s2, value2: a * s2 ** beta };
  });
  const est = estimateBetaFromPairs(pairs);
  assert.ok(est.beta !== null && Math.abs(est.beta - beta) < 1e-12, `recovered ${est.beta}`);
  assert.equal(est.usablePairs, 5);
});

test('estimateBeta: median is robust to a minority of contexts whose quality shifted', async () => {
  const { estimateBetaFromPairs } = await import('../src/value/marginal.ts');
  const beta = 0.5;
  const clean = [1, 3, 9, 27].map((a, i) => {
    const s1 = 5 + i;
    const s2 = s1 * 3;
    return { key: `ok${i}`, spend1: s1, value1: a * s1 ** beta, spend2: s2, value2: a * s2 ** beta };
  });
  // One context whose quality collapsed between windows (aᵢ NOT stable) — an
  // outlier slope the median must shrug off.
  const shifted = { key: 'shifted', spend1: 5, value1: 5 * 5 ** beta, spend2: 15, value2: 0.4 * 15 ** beta };
  const est = estimateBetaFromPairs([...clean, shifted]);
  assert.ok(est.beta !== null && Math.abs(est.beta - beta) < 1e-9, `median unmoved: ${est.beta}`);
});

test('estimateBeta: honest refusals — too few pairs, unmoved spend, or non-concave data → null', async () => {
  const { estimateBetaFromPairs } = await import('../src/value/marginal.ts');
  // Two usable pairs is not enough for a median worth trusting.
  const thin = estimateBetaFromPairs([
    { key: 'a', spend1: 5, value1: 3, spend2: 15, value2: 6 },
    { key: 'b', spend1: 5, value1: 3, spend2: 15, value2: 5 },
  ]);
  assert.equal(thin.beta, null);
  assert.match(thin.how, /need ≥3/);

  // Spend that barely moved identifies nothing.
  const flat = estimateBetaFromPairs(
    [1, 2, 3, 4].map((i) => ({ key: `f${i}`, spend1: 10, value1: 5, spend2: 10.2, value2: 5.1 })),
  );
  assert.equal(flat.beta, null);

  // Linear value (slope 1) means no diminishing returns detected — refuse to
  // "estimate" a concavity the data rejects; the caller keeps the default.
  const linear = estimateBetaFromPairs(
    [1, 2, 3, 4].map((i) => ({ key: `l${i}`, spend1: 5 + i, value1: (5 + i) * 2, spend2: (5 + i) * 3, value2: (5 + i) * 3 * 2 })),
  );
  assert.equal(linear.beta, null);
  assert.match(linear.how, /unconfirmed/);
});

test('estimateBeta: an estimated β threads into the shadow price with its provenance disclosed', async () => {
  const { estimateBetaFromPairs, shadowPriceOfIntelligence } = await import('../src/value/marginal.ts');
  const beta = 0.7;
  const pairs = [1, 4, 16].map((a, i) => {
    const s1 = 6 + i;
    const s2 = s1 * 2;
    return { key: `p${i}`, spend1: s1, value1: a * s1 ** beta, spend2: s2, value2: a * s2 ** beta };
  });
  const est = estimateBetaFromPairs(pairs);
  assert.ok(est.beta !== null);
  const r = shadowPriceOfIntelligence(
    [
      { key: 'x', costUsd: 10, spendOnRealizedUnitsUsd: 8 },
      { key: 'y', costUsd: 10, spendOnRealizedUnitsUsd: 4 },
    ],
    { beta: est.beta, betaHow: est.how },
  );
  assert.ok(Math.abs(r.beta - beta) < 1e-9);
  assert.ok(r.assumptions[0]!.includes('own cost→value curvature'), 'provenance travels with the number');
});
