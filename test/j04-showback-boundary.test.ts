import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('J04 records showback foundations without turning allocation into capital or causation', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'docs', 'program', 'J04-AI-CAPITAL-SHOWBACK-BOUNDARY.md'), 'utf8');
  assert.match(text, /showback_only|showback/i);
  assert.match(text, /does\s+not settle money/i);
  assert.match(text, /no-causation/i);
  assert.match(text, /committed capacity/i);
  assert.match(text, /conservation/i);
  assert.match(text, /chargeback/i);
});
