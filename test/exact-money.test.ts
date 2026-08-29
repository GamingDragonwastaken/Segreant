import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMoney,
  compareMoney,
  formatMoneyAmount,
  MAX_MONEY_COEFFICIENT_DIGITS,
  MAX_MONEY_SCALE,
  money,
  moneyFromJson,
  moneyToJson,
  negateMoney,
  subtractMoney,
} from '../src/economics/money.ts';

test('Money parses decimal strings exactly and removes representation-only trailing zeros', () => {
  const amount = money('123.450000', 'USD', 'billed');
  assert.equal(amount.coefficient, 12345n);
  assert.equal(amount.scale, 2);
  assert.equal(amount.currency, 'USD');
  assert.equal(amount.basis, 'billed');
  assert.equal(formatMoneyAmount(amount), '123.45');
});

test('Money arithmetic is exact for decimal values that binary floating point cannot represent exactly', () => {
  const oneTenth = money('0.1', 'USD', 'effective');
  const twoTenths = money('0.2', 'USD', 'effective');
  assert.equal(formatMoneyAmount(addMoney(oneTenth, twoTenths)), '0.3');
  assert.equal(formatMoneyAmount(subtractMoney(money('1', 'USD', 'effective'), money('0.9', 'USD', 'effective'))), '0.1');
});

test('Money remains exact beyond JavaScript Number safe-integer range', () => {
  const huge = money('900719925474099312345678.123456789', 'USD', 'billed');
  const cent = money('0.01', 'USD', 'billed');
  assert.equal(formatMoneyAmount(addMoney(huge, cent)), '900719925474099312345678.133456789');
});

test('Money arithmetic refuses currency and economic-basis laundering', () => {
  assert.throws(
    () => addMoney(money('1', 'USD', 'billed'), money('1', 'EUR', 'billed')),
    /currency mismatch/,
  );
  assert.throws(
    () => addMoney(money('1', 'USD', 'billed'), money('1', 'USD', 'allocated')),
    /economic basis mismatch/,
  );
});

test('Money comparison aligns decimal scales exactly and preserves signs', () => {
  assert.equal(compareMoney(money('1.20', 'USD', 'billed'), money('1.2', 'USD', 'billed')), 0);
  assert.equal(compareMoney(money('-0.01', 'USD', 'billed'), money('0', 'USD', 'billed')), -1);
  assert.equal(formatMoneyAmount(negateMoney(money('12.34', 'USD', 'billed'))), '-12.34');
});

test('Money JSON uses strings for arbitrary-precision coefficients and round-trips losslessly', () => {
  const original = money('-12345678901234567890.000000001', 'USD', 'full_cost');
  const encoded = moneyToJson(original);
  assert.equal(typeof encoded.coefficient, 'string');
  assert.deepEqual(moneyFromJson(encoded), original);
});

test('Money rejects floats, exponent notation, invalid currency codes, and negative scales on decoding', () => {
  assert.throws(() => money('1e-6', 'USD', 'billed'), /plain decimal/);
  assert.throws(() => money('NaN', 'USD', 'billed'), /plain decimal/);
  assert.throws(() => money('1', 'usd', 'billed'), /currency/);
  assert.throws(
    () => moneyFromJson({ coefficient: '1', scale: -1, currency: 'USD', basis: 'billed' }),
    /scale/,
  );
});

test('Money rejects coercible currencies and hostile exact-value sizes', () => {
  assert.throws(
    () => money('1', { toString: () => 'USD' } as never, 'billed'),
    /currency/,
  );
  assert.throws(
    () => moneyFromJson({ coefficient: '1', scale: MAX_MONEY_SCALE + 1, currency: 'USD', basis: 'billed' }),
    /scale|maximum/i,
  );
  assert.throws(
    () => moneyFromJson({ coefficient: '1'.repeat(MAX_MONEY_COEFFICIENT_DIGITS + 1), scale: 0, currency: 'USD', basis: 'billed' }),
    /coefficient|maximum|size/i,
  );
});
