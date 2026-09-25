import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEpistemicUxBundle,
  type EpistemicUxBundleInput,
} from '../src/epistemic/ux.ts';

const DIGEST = 'a'.repeat(64);
const MONEY = { coefficient: '1', scale: 0, currency: 'USD', basis: 'billed' as const };

function input(overrides: Partial<EpistemicUxBundleInput> = {}): EpistemicUxBundleInput {
  return {
    trace: {
      rootId: 'request-1',
      nodes: [
        { id: 'request-1', kind: 'request', amount: MONEY, sourceIds: [], recordedAtMs: 1 },
        { id: 'correction-1', kind: 'correction', amount: MONEY, sourceIds: ['request-1'], recordedAtMs: 2 },
        { id: 'allocation-1', kind: 'allocation', amount: MONEY, sourceIds: ['correction-1'], recordedAtMs: 3 },
      ],
    },
    support: { assumptions: ['assignment', 'outcome'], certified: true, supports: [['assignment', 'outcome']] },
    measureNext: {
      gaps: [
        { id: 'outcome', question: 'Which outcome was retained?', consequence: 'high', requiredEvidence: ['outcome-ledger'], cost: null },
        { id: 'context', question: 'Which context was present?', consequence: 'medium', requiredEvidence: ['context-ledger'], cost: 1 },
      ],
    },
    preferences: [
      { preferenceId: 'cost', utilities: { keep: 1, switch: 0 } },
      { preferenceId: 'quality', utilities: { keep: 0, switch: 1 } },
    ],
    ...overrides,
  };
}

test('epistemic UX bundle traces the dollar and preserves kernel support/countermodel semantics', () => {
  const result = buildEpistemicUxBundle(input());
  assert.equal(result.trace.status, 'complete');
  assert.deepEqual(result.trace.orderedNodeIds, ['request-1', 'correction-1', 'allocation-1']);
  assert.deepEqual(result.support.sets, [['assignment'], ['outcome']]);
  assert.equal(result.support.inertAssumptions?.length, 0);
  assert.equal(result.preferences.status, 'preference_sensitive');
  assert.equal(result.measureNext.status, 'review_only_unpriced');
  assert.equal(result.measureNext.gaps[0]?.id, 'outcome');
});

test('trace refuses a missing source and never turns a broken chain into a complete path', () => {
  const result = buildEpistemicUxBundle(input({
    trace: {
      rootId: 'allocation-1',
      nodes: [{ id: 'allocation-1', kind: 'allocation', amount: MONEY, sourceIds: ['missing'], recordedAtMs: 3 }],
    },
  }));
  assert.equal(result.trace.status, 'withheld');
  assert.deepEqual(result.trace.missingSourceIds, ['missing']);
});

test('measure-next stays qualitative when acquisition cost or a prior is absent', () => {
  const result = buildEpistemicUxBundle(input({
    measureNext: { gaps: [{ id: 'z', question: 'z?', consequence: 'low', requiredEvidence: ['z'], cost: null }] },
  }));
  assert.equal(result.measureNext.status, 'review_only_unpriced');
  assert.match(result.measureNext.nonClaims.join(' '), /VoI|probability|prior/i);
});

test('epistemic UX CLI is a bounded review-only consumer', () => {
  const root = mkdtempSync(join(tmpdir(), 'segreant-epistemic-ux-'));
  const options = join(root, 'ux.json');
  try {
    writeFileSync(options, JSON.stringify(input()));
    const stdout = execFileSync(process.execPath, ['bin/segreant.mjs', 'evidence', 'ux', '--options', options, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const payload = JSON.parse(stdout) as { operation: string; bundle: { trace: { status: string } }; boundary: string };
    assert.equal(payload.operation, 'epistemic_ux_bundle');
    assert.equal(payload.bundle.trace.status, 'complete');
    assert.match(payload.boundary, /review-only/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
