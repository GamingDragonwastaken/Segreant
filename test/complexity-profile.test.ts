import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComplexityProfile, type ComplexityProfileInput } from '../src/research/complexity/profile.ts';

function input(overrides: Partial<ComplexityProfileInput> = {}): ComplexityProfileInput {
  return {
    profileId: 'profile-1',
    subject: 'work-unit-1',
    evaluatedAt: '2026-09-21T00:00:00.000Z',
    structural: { added: 10, deleted: 2, files: 3, contextTokens: 1_000, taskType: 'feature', toolCount: 2 },
    execution: { requestCount: 4, totalTokens: 2_000, reasoningTokens: 500, durationMs: 1_000, retryCount: 1 },
    ...overrides,
  };
}

test('complexity profile is an isolated provenance-bearing vector, not a routing score', () => {
  const profile = buildComplexityProfile(input());
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.structural.diffVolume.added, 10);
  assert.equal(profile.execution.reasoningTokens, 500);
  assert.equal(profile.epistemic.predictiveUncertainty, null);
  assert.equal(profile.predictedCompute, null);
  assert.equal(profile.confidence.calibrationStatus, 'uncalibrated_research');
  assert.match(profile.provenance.inputDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!('score' in profile));
});

test('profile construction is deterministic and refuses impossible observables', () => {
  const a = buildComplexityProfile(input());
  const b = buildComplexityProfile(input());
  assert.deepEqual(a, b);
  assert.throws(() => buildComplexityProfile(input({ execution: { requestCount: -1, totalTokens: 1, reasoningTokens: 0, durationMs: 1, retryCount: 0 } })), /non-negative/i);
  assert.throws(() => buildComplexityProfile(input({ structural: { added: 1, deleted: 1, files: 1, contextTokens: 1, taskType: '', toolCount: 1 } })), /taskType/i);
});

