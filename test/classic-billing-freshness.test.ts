/**
 * The classic dashboard's billing timestamps must render an UNKNOWN instant as
 * unknown. `Number(null)` is 0, which is finite, so the old formatter printed
 * "01/01/1970" for "Evidence imports: latest" on a ledger with no billing import.
 * The formatter is extracted from classic.html and run as written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'classic.html'), 'utf8');
const match = /const billingTime = \(ms\) => \{[\s\S]*?\n\};/.exec(html);
assert.ok(match, 'billingTime formatter present in classic.html');
const billingTime = new Function(`return (${match[0].replace(/^const billingTime = /, '').replace(/;$/, '')});`)() as (ms: unknown) => string;

test('classic billing: an unknown instant renders as unknown, never the 1970 epoch', () => {
  assert.equal(billingTime(null), '—', 'no import recorded (lastImportedAtMs null)');
  assert.equal(billingTime(undefined), '—', 'field absent from the row');
  assert.equal(billingTime(''), '—', 'empty string coerces to 0 under Number()');
  assert.equal(billingTime(0), '—', 'epoch 0 is not a recorded instant');
  assert.equal(billingTime(Number.NaN), '—');
});

test('classic billing: a recorded instant still renders as a date', () => {
  const rendered = billingTime(Date.UTC(2026, 9, 11, 10, 0, 0));
  assert.notEqual(rendered, '—');
  assert.match(rendered, /2026/);
});
