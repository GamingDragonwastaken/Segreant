/**
 * Properties of the Shadow Price of Intelligence (src/value/marginal.ts).
 * The water-filling optimum + the shadow-price headline the allocation story rests on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowPriceOfIntelligence } from '../src/value/marginal.ts';

test('symmetric contexts ⟹ equal optimal split and (near) zero reallocation uplift', () => {
  const r = shadowPriceOfIntelligence([
    { key: 'a', costUsd: 10, realizedValueUsd: 6 },
    { key: 'b', costUsd: 10, realizedValueUsd: 6 },
  ]);
  const a = r.items.find((i) => i.key === 'a')!;
  const b = r.items.find((i) => i.key === 'b')!;
  assert.ok(Math.abs(a.optimalUsd - 10) < 1e-6 && Math.abs(b.optimalUsd - 10) < 1e-6);
  assert.ok(Math.abs(r.upliftUsd) < 1e-6, 'already optimal ⟹ no uplift');
});

test('concavity forbids winner-take-all: the better context gets more budget, never all of it', () => {
  const r = shadowPriceOfIntelligence(
    [
      { key: 'good', costUsd: 10, realizedValueUsd: 9 },
      { key: 'weak', costUsd: 10, realizedValueUsd: 3 },
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
    { key: 'a', costUsd: 5, realizedValueUsd: 4 },
    { key: 'b', costUsd: 15, realizedValueUsd: 3 },
    { key: 'c', costUsd: 8, realizedValueUsd: 7 },
  ]);
  assert.ok(r.optimalValueUsd >= r.currentValueUsd - 1e-9, `${r.optimalValueUsd} ≥ ${r.currentValueUsd}`);
  assert.ok(r.upliftUsd >= -1e-9);
});

test('the shadow price obeys μ = β·V*/B and sets paysAtMargin', () => {
  const r = shadowPriceOfIntelligence([
    { key: 'a', costUsd: 10, realizedValueUsd: 20 },
    { key: 'b', costUsd: 10, realizedValueUsd: 15 },
  ], { beta: 0.6 });
  assert.ok(Math.abs(r.shadowPriceUsd - (0.6 * r.optimalValueUsd) / r.budgetUsd) < 1e-9);
  assert.equal(r.paysAtMargin, r.shadowPriceUsd >= 1);
});

test('higher β (weaker diminishing returns) concentrates budget harder on the best context', () => {
  const cells = [
    { key: 'good', costUsd: 10, realizedValueUsd: 9 },
    { key: 'weak', costUsd: 10, realizedValueUsd: 3 },
  ];
  const low = shadowPriceOfIntelligence(cells, { beta: 0.3 });
  const high = shadowPriceOfIntelligence(cells, { beta: 0.8 });
  const shareGood = (r: ReturnType<typeof shadowPriceOfIntelligence>) => r.items.find((i) => i.key === 'good')!.optimalUsd / r.budgetUsd;
  assert.ok(shareGood(high) > shareGood(low), `β=0.8 concentrates more than β=0.3: ${shareGood(high)} > ${shareGood(low)}`);
});

test('degenerate input (no realized value anywhere) ⟹ status quo, shadow price 0', () => {
  const r = shadowPriceOfIntelligence([
    { key: 'a', costUsd: 10, realizedValueUsd: 0 },
    { key: 'b', costUsd: 5, realizedValueUsd: 0 },
  ]);
  assert.equal(r.shadowPriceUsd, 0);
  assert.equal(r.upliftUsd, 0);
  assert.ok(r.items.every((i) => i.deltaUsd === 0));
});
