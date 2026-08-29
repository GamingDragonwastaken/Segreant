import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExactCost, type ExactModelRate, type ExactNormalizedUsage } from '../src/cost/exactPricing.ts';
import { formatMoneyAmount } from '../src/economics/money.ts';

const rate: ExactModelRate = {
  input: '5',
  output: '25',
  cache_write_5m: '6.25',
  cache_write_1h: '10',
  cache_read: '0.5',
};

const usage: ExactNormalizedUsage = {
  inputTokens: 200_000,
  outputTokens: 100_000,
  cacheWriteTokens: 50_000,
  cacheReadTokens: 10_000,
  cacheWriteTtl: '5m',
};

test('exact pricing computes each token component and total without floating point', () => {
  const result = computeExactCost(rate, usage, 'list');
  assert.equal(formatMoneyAmount(result.components.input), '1');
  assert.equal(formatMoneyAmount(result.components.output), '2.5');
  assert.equal(formatMoneyAmount(result.components.cacheWrite), '0.3125');
  assert.equal(formatMoneyAmount(result.components.cacheRead), '0.005');
  assert.equal(formatMoneyAmount(result.total), '3.8175');
  assert.equal(result.total.currency, 'USD');
  assert.equal(result.total.basis, 'list');
});

test('exact pricing derives cache fallback multipliers as exact decimals', () => {
  const result = computeExactCost(
    { input: '0.1', output: '0.2' },
    { inputTokens: 3, outputTokens: 7, cacheWriteTokens: 4, cacheReadTokens: 5 },
    'estimated',
  );
  // write = 0.1 * 1.25 = 0.125; read = 0.1 * 0.1 = 0.01
  assert.equal(formatMoneyAmount(result.components.input), '0.0000003');
  assert.equal(formatMoneyAmount(result.components.output), '0.0000014');
  assert.equal(formatMoneyAmount(result.components.cacheWrite), '0.0000005');
  assert.equal(formatMoneyAmount(result.components.cacheRead), '0.00000005');
  assert.equal(formatMoneyAmount(result.total), '0.00000225');
});

test('exact pricing preserves high-precision decimal rates and arbitrary exact totals', () => {
  const result = computeExactCost(
    { input: '0.000001', output: '0.000003' },
    { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
    'list',
  );
  assert.equal(formatMoneyAmount(result.total), '0.000000000004');
});

test('exact pricing rejects numeric rates, fractional token counts, unknown fields, and invalid TTLs', () => {
  assert.throws(
    () => computeExactCost({ input: 0.1, output: '1' } as never, usage, 'list'),
    /plain decimal|string/i,
  );
  assert.throws(
    () => computeExactCost(rate, { ...usage, inputTokens: 0.5 } as never, 'list'),
    /safe integer|token/i,
  );
  assert.throws(
    () => computeExactCost({ ...rate, extra: 'ignored' } as never, usage, 'list'),
    /unknown.*field/i,
  );
  assert.throws(
    () => computeExactCost(rate, { ...usage, cacheWriteTtl: '2h' } as never, 'list'),
    /cacheWriteTtl|TTL/i,
  );
});
