import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interval } from '../src/epistemic/time.ts';
import { money, formatMoneyAmount } from '../src/economics/money.ts';
import {
  exactRate,
  applyExactRate,
  rateToJson,
  rateFromJson,
} from '../src/economics/rate.ts';

test('exact rate is a rational with explicit source/target units and validity period', () => {
  const r = exactRate({
    numerator: 11n,
    denominator: 10n,
    sourceUnit: 'USD',
    targetUnit: 'EUR',
    validTime: interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
  });
  assert.equal(r.numerator, 11n);
  assert.equal(r.denominator, 10n);
  assert.equal(r.sourceUnit, 'USD');
  assert.equal(r.targetUnit, 'EUR');
});

test('applying a terminating rate is exact and requires matching source currency', () => {
  const r = exactRate({ numerator: 5n, denominator: 4n, sourceUnit: 'USD', targetUnit: 'EUR' });
  const converted = applyExactRate(money('12.40', 'USD', 'billed'), r, 'billed');
  assert.equal(converted.currency, 'EUR');
  assert.equal(formatMoneyAmount(converted), '15.5');
  assert.throws(() => applyExactRate(money('1', 'GBP', 'billed'), r, 'billed'), /source unit/);
});

test('non-terminating conversion refuses implicit rounding', () => {
  const oneThird = exactRate({ numerator: 1n, denominator: 3n, sourceUnit: 'USD', targetUnit: 'EUR' });
  assert.throws(
    () => applyExactRate(money('1', 'USD', 'billed'), oneThird, 'billed'),
    /non-terminating conversion requires an explicit quantization policy/,
  );
});

test('rate normalization and JSON round-trip are exact', () => {
  const r = exactRate({ numerator: -20n, denominator: -10n, sourceUnit: 'USD', targetUnit: 'EUR' });
  assert.equal(r.numerator, 2n);
  assert.equal(r.denominator, 1n);
  assert.deepEqual(rateFromJson(rateToJson(r)), r);
});

test('zero denominator and empty units are rejected', () => {
  assert.throws(() => exactRate({ numerator: 1n, denominator: 0n, sourceUnit: 'USD', targetUnit: 'EUR' }), /denominator/);
  assert.throws(() => exactRate({ numerator: 1n, denominator: 1n, sourceUnit: '', targetUnit: 'EUR' }), /source unit/);
});
