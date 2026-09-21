import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessInferenceFamily, type InferenceFamilyInput } from '../src/causal/family.ts';

function input(overrides: Partial<InferenceFamilyInput> = {}): InferenceFamilyInput {
  return {
    familyId: 'family-1',
    targetFamilywiseErrorRate: 0.05,
    dependence: 'arbitrary',
    studies: [
      { studyId: 'study-a', plannedActs: 2 },
      { studyId: 'study-b', plannedActs: 2 },
    ],
    ...overrides,
  };
}

test('arbitrary-dependence family uses a conservative cross-study union bound', () => {
  const result = assessInferenceFamily(input());
  assert.equal(result.status, 'review_only');
  assert.equal(result.totalPlannedActs, 4);
  assert.equal(result.method, 'bonferroni');
  assert.equal(result.perActAlpha, 0.0125);
  assert.match(result.assumptions.join(' '), /arbitrary dependence/i);
});

test('independence mode uses the declared Sidak family rule and states its assumption', () => {
  const result = assessInferenceFamily(input({ dependence: 'independent' }));
  assert.equal(result.method, 'sidak_independence');
  assert.ok(result.perActAlpha > 0.0125);
  assert.match(result.assumptions.join(' '), /independence/i);
  assert.ok(result.nonClaims.some((claim) => /not proof|validated/i.test(claim)));
});

test('an unvalidated correlation matrix is refused rather than treated as adjustment evidence', () => {
  assert.throws(
    () => assessInferenceFamily(input({ dependence: 'declared_correlation', correlationUpperBounds: [[1, 0.2], [0.2, 1]] })),
    /correlation.*not implemented|refuse/i,
  );
});

test('family rejects duplicate studies and invalid planned acts', () => {
  assert.throws(() => assessInferenceFamily(input({ studies: [{ studyId: 'study-a', plannedActs: 1 }, { studyId: 'study-a', plannedActs: 1 }] })), /duplicate/i);
  assert.throws(() => assessInferenceFamily(input({ studies: [{ studyId: 'study-a', plannedActs: 0 }, { studyId: 'study-b', plannedActs: 1 }] })), /plannedActs/i);
});

