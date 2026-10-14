import { test } from 'node:test';
import assert from 'node:assert/strict';
import { share } from '../src/dashboard/web/app/core/fmt.ts';

test('a part that is not zero never prints as 0%, and a part short of the whole never prints as 100%', () => {
  // $0.21 of $12,345,700.80, and the remainder.
  const small = 0.21 / 12_345_700.8;
  assert.equal(share(small), '<1%');
  assert.equal(share(1 - small), '>99%');
  assert.equal(share(small, 1), '<0.1%');
  assert.equal(share(1 - small, 1), '>99.9%');
  // $21.90 unallocated out of $12,345,700.80, at the preview's one decimal.
  assert.equal(share(21.9 / 12_345_700.8, 1), '<0.1%');
});

test('exact ends and ordinary parts print as plain percentages', () => {
  assert.equal(share(0), '0%');
  assert.equal(share(1), '100%');
  assert.equal(share(0.5), '50%');
  assert.equal(share(0.004), '<1%');
  assert.equal(share(0.005), '1%');
  assert.equal(share(0.994), '99%');
  assert.equal(share(0.995), '>99%');
  assert.equal(share(0.25, 1), '25.0%');
  assert.equal(share(null), '—');
  assert.equal(share(Number.NaN), '—');
});
