import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOpe,
  type OpeEvaluationInput,
  type OpeObservation,
  OpeValidationError,
} from '../src/causal/ope.ts';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function observation(overrides: Partial<OpeObservation> = {}): OpeObservation {
  return {
    observationId: 'obs-1',
    unitId: 'unit-1',
    actionId: 'model-a',
    treatmentId: 'treatment-model-a',
    reward: 0.8,
    actionAtMs: 1_000,
    outcomeAtMs: 2_000,
    context: { schemaId: 'context-v1', digest: DIGEST_A, observedAtMs: 900 },
    loggingPolicy: { policyId: 'logging', version: '1', digest: DIGEST_A, propensity: 0.5 },
    targetPolicy: { policyId: 'target', version: '1', digest: DIGEST_B, probability: 0.75 },
    ...overrides,
  };
}

function input(overrides: Partial<OpeEvaluationInput> = {}): OpeEvaluationInput {
  return {
    estimator: 'ips',
    observations: [observation()],
    rewardBounds: { low: 0, high: 1 },
    overlap: { minLoggingPropensity: 0.05, maxImportanceWeight: 20 },
    policyConstraints: {
      policy: { policyId: 'target', version: '1', digest: DIGEST_B },
      mode: 'epsilon_greedy',
      explorationRate: 0.1,
      budgetUnitsPerObservationMax: 1,
      maxImportanceWeight: 20,
      maxTailContribution: 20,
    },
    ...overrides,
  };
}

test('OPE is a provenance-bound contract, not a retrospective model comparison', () => {
  const result = evaluateOpe(input({
    observations: [observation(), observation({ observationId: 'obs-2', unitId: 'unit-2', reward: 0.4 })],
  }));
  assert.equal(result.estimator, 'ips');
  assert.equal(result.status, 'supported');
  assert.equal(result.sampleSize, 2);
  assert.equal(result.provenance.targetPolicy.policyId, 'target');
  assert.match(result.provenance.digest, /^[a-f0-9]{64}$/);
  assert.ok(result.assumptions.some((item) => /logging policy probabilities/i.test(item)));
  assert.ok(result.nonClaims.some((item) => /not a causal treatment effect/i.test(item)));
});

test('importance sampling uses recorded action propensity and target probability', () => {
  const result = evaluateOpe(input({
    observations: [
      observation({ observationId: 'obs-a', reward: 1, loggingPolicy: { policyId: 'logging', version: '1', digest: DIGEST_A, propensity: 0.5 }, targetPolicy: { policyId: 'target', version: '1', digest: DIGEST_B, probability: 0.5 } }),
      observation({ observationId: 'obs-b', unitId: 'unit-b', reward: 0, loggingPolicy: { policyId: 'logging', version: '1', digest: DIGEST_A, propensity: 0.25 }, targetPolicy: { policyId: 'target', version: '1', digest: DIGEST_B, probability: 0.5 } }),
    ],
  }));
  // (1 * 1 + 0 * 2) / 2, deliberately not a normalized score.
  assert.equal(result.estimate, 0.5);
  assert.equal(result.maxImportanceWeight, 2);
  assert.equal(result.clipping.applied, false);
});

test('self-normalized importance sampling states its different estimand', () => {
  const result = evaluateOpe(input({
    estimator: 'self_normalized_ips',
    observations: [
      observation({ observationId: 'obs-a', reward: 1, targetPolicy: { policyId: 'target', version: '1', digest: DIGEST_B, probability: 0.5 }, loggingPolicy: { policyId: 'logging', version: '1', digest: DIGEST_A, propensity: 0.5 } }),
      observation({ observationId: 'obs-b', unitId: 'unit-b', reward: 0, targetPolicy: { policyId: 'target', version: '1', digest: DIGEST_B, probability: 0.5 }, loggingPolicy: { policyId: 'logging', version: '1', digest: DIGEST_A, propensity: 0.25 } }),
    ],
  }));
  assert.equal(result.estimate, 1 / 3);
  assert.match(result.assumptions.join(' '), /self-normalized/i);
});

test('missing treatment identity, propensity, or target policy evidence is refused', () => {
  for (const [label, change] of [
    ['treatment identity', { treatmentId: '' }],
    ['logging propensity', { loggingPolicy: { policyId: 'logging', version: '1', digest: DIGEST_A, propensity: 0 } }],
    ['target policy version', { targetPolicy: { policyId: 'target', version: '', digest: DIGEST_B, probability: 0.5 } }],
  ] as const) {
    assert.throws(
      () => evaluateOpe(input({ observations: [observation(change)] })),
      (error: unknown) => error instanceof OpeValidationError && error.code === 'OPE_EVIDENCE_MISSING',
      label,
    );
  }
});

test('overlap is a hard support condition, not a warning hidden beside an estimate', () => {
  assert.throws(
    () => evaluateOpe(input({
      observations: [observation({ loggingPolicy: { policyId: 'logging', version: '1', digest: DIGEST_A, propensity: 0.001 } })],
    })),
    (error: unknown) => error instanceof OpeValidationError && error.code === 'OPE_OVERLAP_UNSUPPORTED',
  );
});

test('post-treatment context and outcome timing cannot enter the OPE evidence set', () => {
  assert.throws(
    () => evaluateOpe(input({ observations: [observation({ context: { schemaId: 'context-v1', digest: DIGEST_A, observedAtMs: 1_001 } })] })),
    (error: unknown) => error instanceof OpeValidationError && error.code === 'OPE_POST_TREATMENT_LEAKAGE',
  );
  assert.throws(
    () => evaluateOpe(input({ observations: [observation({ outcomeAtMs: 999 })] })),
    (error: unknown) => error instanceof OpeValidationError && error.code === 'OPE_POST_TREATMENT_LEAKAGE',
  );
});

test('clipping is explicit and never presented as unbiased evidence', () => {
  const result = evaluateOpe(input({
    clipping: { maxWeight: 2, rationale: 'bounded-tail-risk-v1' },
    observations: [observation({ targetPolicy: { policyId: 'target', version: '1', digest: DIGEST_B, probability: 1 }, loggingPolicy: { policyId: 'logging', version: '1', digest: DIGEST_A, propensity: 0.1 } })],
  }));
  assert.equal(result.clipping.applied, true);
  assert.equal(result.clipping.clippedObservations, 1);
  assert.equal(result.clipping.biasStatus, 'not_identified_without_tail_model');
  assert.match(result.limitations.join(' '), /clipping/i);
});

test('doubly robust evaluation requires and carries an independently identified outcome-model provenance', () => {
  const row = observation({
    reward: 0.9,
    outcomeModel: {
      modelId: 'q-model', version: '7', digest: DIGEST_A,
      targetExpectedReward: 0.6, loggedExpectedReward: 0.4, observedAtMs: 800,
    },
  });
  const result = evaluateOpe(input({ estimator: 'doubly_robust', observations: [row] }));
  assert.equal(result.estimate, 0.6 + (0.75 / 0.5) * (0.9 - 0.4));
  assert.equal(result.provenance.outcomeModel?.modelId, 'q-model');
  assert.ok(result.assumptions.some((item) => /outcome model/i.test(item)));

  assert.throws(
    () => evaluateOpe(input({ estimator: 'doubly_robust', observations: [observation()] })),
    (error: unknown) => error instanceof OpeValidationError && error.code === 'OPE_MODEL_PROVENANCE_MISSING',
  );
});

test('doubly robust rows cannot mix outcome-model identities', () => {
  const make = (id: string, observationId: string): OpeObservation => observation({
    observationId,
    outcomeModel: { modelId: id, version: '1', digest: DIGEST_A, targetExpectedReward: 0.5, loggedExpectedReward: 0.5, observedAtMs: 800 },
  });
  assert.throws(
    () => evaluateOpe(input({ estimator: 'doubly_robust', observations: [make('q-a', 'obs-a'), make('q-b', 'obs-b')] })),
    (error: unknown) => error instanceof OpeValidationError && error.code === 'OPE_MODEL_PROVENANCE_CONFLICT',
  );
});

test('OPE binds a declared exploration/budget/tail policy to the target policy identity', () => {
  const result = evaluateOpe(input());
  assert.equal(result.policyConstraints.mode, 'epsilon_greedy');
  assert.equal(result.policyConstraints.explorationRate, 0.1);
  assert.equal(result.policyConstraints.maxImportanceWeight, 20);
  assert.equal(result.policyConstraints.maxTailContribution, 20);
  assert.throws(
    () => evaluateOpe(input({
      policyConstraints: {
        ...input().policyConstraints,
        policy: { policyId: 'different', version: '1', digest: DIGEST_B },
      },
    })),
    (error: unknown) => error instanceof OpeValidationError && error.code === 'OPE_POLICY_CONFLICT',
  );
});
