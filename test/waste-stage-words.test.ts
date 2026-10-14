/**
 * The Value page's "where the work stopped" table is keyed by `diedAt`, the
 * FIRST FAILED gate (src/value/gates.ts). Its plain labels once read "stopped
 * after surviving in production" for work that failed the survival check, so a
 * failure was worded as the success it was not. Every bucket the realization
 * report can emit must have a label, and each label must name what went wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_LADDER } from '../src/value/gates.ts';

const value = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'views', 'value.ts'), 'utf8');

function failedAtMap(): Record<string, string> {
  const m = value.match(/const FAILED_AT: Record<string, string> = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'value.ts must define FAILED_AT, the plain words for the first failed step');
  const out: Record<string, string> = {};
  for (const line of m![1]!.split('\n')) {
    const kv = line.match(/^\s*(\w+):\s*'([^']*)',?\s*$/);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}

test('every waste bucket has a plain label', () => {
  const map = failedAtMap();
  for (const stage of [...GATE_LADDER, 'unverified', 'conflicted']) {
    assert.ok(map[stage], `no plain label for the "${stage}" bucket`);
  }
});

test('a failed step is never worded as the step having happened', () => {
  const map = failedAtMap();
  assert.doesNotMatch(map.survived!, /surviv(ed|ing)\b(?! for)/i, 'failing the survival check is not "surviving"');
  assert.doesNotMatch(map.clean!, /without rework/i, 'failing the rework check is not "without rework"');
  assert.doesNotMatch(value, /stopped after \$\{/, 'the table must not prefix "stopped after" to a gate the unit failed');
});
