import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('J01/J02 remain explicit dependency gates rather than invented implementations', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'docs', 'program', 'J01-J02-DEPENDENCY-GATES.md'), 'utf8');
  for (const marker of ['causal-v3', 'propensity', 'overlap', 'doubly robust', 'safe', 'circuit breaker', 'no-action']) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(text, /not started/i);
  assert.match(text, /retrospective model comparisons.*not OPE/i);
});
