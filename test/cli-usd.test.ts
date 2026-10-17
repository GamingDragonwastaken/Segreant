import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usd } from '../src/cli/ui.ts';

test('usd: thousands are grouped, negatives keep their precision, small amounts keep theirs', () => {
  assert.equal(usd(4195.19), '$4,195.19');
  assert.equal(usd(12.5), '$12.50');
  assert.equal(usd(-5), '-$5.00', 'a credit is not $-5.000000');
  assert.equal(usd(-1234.5), '-$1,234.50');
  assert.equal(usd(0.4912), '$0.4912');
  assert.equal(usd(-0.0049), '-$0.004900');
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(-0), '$0.00');
});
