import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const matrix = readFileSync(join(ROOT, 'docs', 'program', 'MARKET-CAPABILITY-MATRIX.md'), 'utf8');
const originality = readFileSync(join(ROOT, 'docs', 'program', 'ORIGINALITY-SUBSTITUTION-REVIEW.md'), 'utf8');

test('J05 market matrix is current-source, capability-specific, and refuses unsupported superiority claims', () => {
  for (const marker of ['Langfuse', 'Datadog', 'Vanta', 'FOCUS', 'OpenTelemetry', 'OpenCost', 'Kubecost', 'watsonx.governance', 'Build / interoperate / refuse']) {
    assert.match(matrix, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(matrix, /does not establish market share, superiority/i);
  assert.match(matrix, /exact Money/i);
  assert.match(matrix, /Refuse/i);
});

test('J06 review separates standards, Segreant-specific semantics, combinations, and unproven novelty', () => {
  for (const marker of ['Substitution test', 'Standardized, not novel', 'Segreant-specific semantics', 'Potentially distinctive combination', 'Not currently proven', 'Complexity-theater guard', 'Independent scholarly and market critique', 'Pre-claim review gate']) {
    assert.match(originality, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(originality, /not a novel theorem/i);
  assert.match(originality, /not currently proven/i);
  assert.match(originality, /doubly robust/i);
});

