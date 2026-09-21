import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('J01 is a completed review-only OPE boundary and J02 remains an explicit no-action gate', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'docs', 'program', 'J01-J02-DEPENDENCY-GATES.md'), 'utf8');
  for (const marker of ['causal-v3', 'propensity', 'overlap', 'doubly robust', 'safe', 'circuit breaker', 'no-action']) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(text, /not[_ ]started|blocked_external/i);
  assert.match(text, /retrospective model comparisons.*not OPE/i);
  assert.match(text, /COMPLETED/i);
  assert.match(text, /RED-first coverage is\s+13\/13/i);
  assert.match(text, /pure evidence\s+boundary/i);
  assert.match(text, /exploration.*budget.*tail-risk/i);
});
