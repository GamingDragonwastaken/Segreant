import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('J01 and J02 expose separate evidence and bounded action boundaries', () => {
  const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'program', 'J01-J02-DEPENDENCY-GATES.md'), 'utf8');
  const normalized = doc.replace(/\s+/g, ' ');
  for (const marker of [
    'propensity',
    'overlap',
    'doubly robust',
    'budget.dailyUsd',
    'safe baseline',
    'circuit breaker',
    'default no action',
    'explorationRateCap = 0',
    'operator/external override',
    'write-ahead',
  ]) {
    assert.ok(normalized.toLowerCase().includes(marker.toLowerCase()), `missing J01/J02 marker: ${marker}`);
  }
  assert.doesNotMatch(doc, /J02.*BLOCKED_EXTERNAL/i);
  assert.match(doc, /J01 and J02 are now `COMPLETED`/i);
  assert.match(doc, /retrospective model comparisons.*observational/i);
  assert.match(doc, /DecisionCertificate alone still cannot mutate/i);
});
