import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimProfile,
  mergeClaimProfiles,
  type ClaimProfileInput,
} from '../src/epistemic/profile.ts';

const base: ClaimProfileInput = {
  epistemic: 'supported',
  integrity: 'verified',
  authenticity: 'provider_authenticated',
  scope: 'established',
  coverage: 'complete',
  measurement: 'validated',
  causality: 'none',
  monetaryBasis: 'billed',
  finality: 'final',
  decisionFitness: 'not_assessed',
};

test('claim profile keeps trust dimensions separate instead of collapsing them into established:boolean', () => {
  const p = claimProfile(base);
  assert.equal(p.epistemic, 'supported');
  assert.equal(p.integrity, 'verified');
  assert.equal(p.authenticity, 'provider_authenticated');
  assert.equal(p.causality, 'none');
  assert.equal(p.decisionFitness, 'not_assessed');
  assert.equal('established' in p, false);
});

test('high integrity cannot substitute for missing authenticity or construct validity', () => {
  const p = claimProfile({ ...base, authenticity: 'unknown', measurement: 'proxy_unvalidated' });
  assert.equal(p.integrity, 'verified');
  assert.equal(p.authenticity, 'unknown');
  assert.equal(p.measurement, 'proxy_unvalidated');
});

test('merging profiles preserves the weakest independent trust dimension and conflict in epistemic evidence', () => {
  const merged = mergeClaimProfiles(
    claimProfile(base),
    claimProfile({
      ...base,
      epistemic: 'refuted',
      integrity: 'unknown',
      authenticity: 'self_asserted',
      coverage: 'partial',
      measurement: 'proxy_validated',
      finality: 'provisional',
    }),
  );
  assert.equal(merged.epistemic, 'conflicted');
  assert.equal(merged.integrity, 'unknown');
  assert.equal(merged.authenticity, 'self_asserted');
  assert.equal(merged.coverage, 'partial');
  assert.equal(merged.measurement, 'proxy_validated');
  assert.equal(merged.finality, 'provisional');
});

test('claim profile refuses unknown enum strings at runtime', () => {
  assert.throws(
    () => claimProfile({ ...base, finality: 'definitely-final' as never }),
    /invalid finality/,
  );
});
