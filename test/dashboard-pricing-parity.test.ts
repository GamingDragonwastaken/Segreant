import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capability, paritySummary } from '../src/dashboard/web/app/core/registry.ts';

const root = process.cwd();

test('Pricing is full only because the GUI runs the complete read-only coverage path', () => {
  const cap = capability('pricing');
  assert.ok(cap);
  assert.equal(cap.coverage, 'full');
  assert.equal(cap.consequence, 'read');
  const actions = readFileSync(join(root, 'src/dashboard/web/app/core/actions.ts'), 'utf8');
  assert.match(actions, /pricing:\s*\(cap\)/, 'pricing must have a browser action runner');
  assert.match(actions, /api\.pricingCoverage/);
  assert.match(actions, /does not rewrite the provenance shown for historical requests/);
  assert.match(actions, /Refreshing a rate card and repricing history are separate explicit actions/);
});

test('pricing parity promotion changes only the honest parity count', () => {
  assert.deepEqual(paritySummary(), { total: 45, full: 26, partial: 14, planned: 5 });
});
