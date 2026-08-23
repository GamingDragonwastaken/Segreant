/**
 * The causal-study lane must prove its own boundaries. These are deliberately
 * negative-heavy: an ordinary scenario, altered assignment, incomplete
 * outcome, plan deviation, or modeled cost must fail before claim language is
 * reachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockedAssignmentPlan, verifyBlockedAssignmentPlan } from '../src/causal/assignment.ts';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import { causalEventHash, commitCausalProtocol, protocolHash, validateCausalProtocol } from '../src/causal/protocol.ts';
import { qualifyCausalStudy } from '../src/causal/qualification.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  type CausalExecutionRecord,
  type CausalOutcomeRecord,
  type CausalStudyData,
  type CausalStudyProtocolDraft,
} from '../src/causal/types.ts';

const H = (char: string): string => char.repeat(64);

function modelDraft(overrides: Partial<CausalStudyProtocolDraft> = {}): CausalStudyProtocolDraft {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION,
    studyId: 'study-model',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: { cohortId: 'cohort-a', unitOfAssignment: 'task', contextSchemaId: 'task-v1' },
    arms: [
      { armId: 'candidate', role: 'candidate', executionPlanHash: H('a'), providerId: 'provider-a', modelId: 'model-new' },
      { armId: 'control', role: 'control', executionPlanHash: H('b'), providerId: 'provider-a', modelId: 'model-old' },
    ],
    allocation: { method: 'blocked_randomized_equal_allocation', probabilityPerArm: 0.5, blockSize: 4 },
    costOutcome: { metricId: 'direct_cost_usd', boundsUsd: { low: 0, high: 100 }, acceptedSourceClasses: ['actual_observed'] },
    qualityOutcome: { metricId: 'verified_quality', bounds: { low: 0, high: 1 }, evidenceClass: 'deterministic', nonInferiorityMargin: 0.05 },
    economicOutcome: null,
    analysis: { estimand: 'intention_to_treat', confidenceLevel: 0.95, minCompletedPerArm: 2, maxMissingFractionPerArm: 0.25 },
    ...overrides,
  };
}

function event<T extends Record<string, unknown>>(input: T): T & { eventHash: string } {
  return { ...input, eventHash: causalEventHash(input) };
}

function completedData(): CausalStudyData {
  const protocol = commitCausalProtocol(modelDraft(), 1_700_000_000_100);
  const plan = createBlockedAssignmentPlan(protocol, {
    blockId: 'block-1',
    createdAtMs: 1_700_000_000_200,
    unitIdHashes: [H('1'), H('2'), H('3'), H('4')],
    randomizationMaterial: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  const executions: CausalExecutionRecord[] = [];
  const outcomes: CausalOutcomeRecord[] = [];
  for (const decision of plan.decisions) {
    const arm = protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId)!;
    const execution = event({
      executionId: 'exec:' + decision.decisionId,
      decisionId: decision.decisionId,
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      startedAtMs: decision.assignedAtMs + 1,
      completedAtMs: decision.assignedAtMs + 2,
      assignedExecutionPlanHash: arm.executionPlanHash,
      actualExecutionPlanHash: arm.executionPlanHash,
      adherence: 'confirmed' as const,
      requestIds: ['request:' + decision.decisionId],
      directAiCostUsd: decision.assignedArmId === 'candidate' ? 5 : 12,
      directCostSourceClass: 'actual_observed' as const,
      priceLineageHashes: [H('c')],
      fullArmCostUsd: null,
      fullCostSourceClass: 'incomplete_or_unknown' as const,
      previousEventHash: decision.eventHash,
    });
    executions.push(execution);
    outcomes.push(event({
      outcomeId: 'outcome:' + decision.decisionId,
      decisionId: decision.decisionId,
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      observedAtMs: execution.completedAtMs + 1,
      maturity: 'matured' as const,
      qualityValue: 0.9,
      qualityEvidenceClass: 'deterministic' as const,
      economicValueUsd: null,
      economicEvidenceClass: null,
      outcomeEvidenceRefs: ['evidence:' + decision.decisionId],
      missingReason: null,
      previousEventHash: execution.eventHash,
    }));
  }
  return { protocol, decisions: plan.decisions, executions, outcomes };
}

test('causal protocol commits a deterministic structural hash and rejects raw/free-text identifiers', () => {
  const draft = modelDraft();
  assert.deepEqual(validateCausalProtocol(draft), []);
  const committed = commitCausalProtocol(draft, 1_700_000_000_100);
  assert.equal(committed.protocolHash, protocolHash(draft));
  assert.ok(Object.isFrozen(committed));

  const changed = modelDraft({ eligibility: { cohortId: 'cohort-b', unitOfAssignment: 'task', contextSchemaId: 'task-v1' } });
  assert.notEqual(protocolHash(changed), committed.protocolHash);

  const malformed = modelDraft({ eligibility: { cohortId: 'raw prompt: send password', unitOfAssignment: 'task', contextSchemaId: 'task-v1' } });
  assert.ok(validateCausalProtocol(malformed).some((error) => /eligibility/i.test(error)));
});

test('blocked assignment is replayable, balanced, and invalidates tampering', () => {
  const protocol = commitCausalProtocol(modelDraft(), 1_700_000_000_100);
  const plan = createBlockedAssignmentPlan(protocol, {
    blockId: 'block-1',
    createdAtMs: 1_700_000_000_200,
    unitIdHashes: [H('1'), H('2'), H('3'), H('4')],
    randomizationMaterial: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  assert.deepEqual(verifyBlockedAssignmentPlan(protocol, plan), []);
  assert.equal(plan.decisions.filter((decision) => decision.assignedArmId === 'candidate').length, 2);
  assert.equal(plan.decisions.filter((decision) => decision.assignedArmId === 'control').length, 2);
  assert.ok(plan.decisions.every((decision) => decision.propensity === 0.5));

  const altered = { ...plan, decisions: plan.decisions.map((decision) => ({ ...decision })) };
  altered.decisions[0]!.assignedArmId = altered.decisions[0]!.assignedArmId === 'candidate' ? 'control' : 'candidate';
  assert.ok(verifyBlockedAssignmentPlan(protocol, altered).some((error) => /replay/i.test(error)));
});

test('complete randomized evidence qualifies as a study but interval gates still control claims', () => {
  const data = completedData();
  const qualification = qualifyCausalStudy(data);
  assert.equal(qualification.state, 'qualified');
  assert.equal(qualification.evidenceGrade, 'randomized_causal');

  const estimate = estimateCausalStudy(data);
  assert.equal(estimate.qualification.state, 'qualified');
  assert.equal(estimate.allowedClaim, 'not_established', 'four units cannot earn a low-cost claim from a wide predeclared range');
  assert.equal(estimate.qualityNonInferiorityPassed, false, 'the conservative interval also governs quality language');
});

test('plan deviation, pending outcome, and modeled cost each invalidate or withhold causal evidence', () => {
  const deviated = completedData();
  deviated.executions[0]!.actualExecutionPlanHash = H('f');
  assert.equal(qualifyCausalStudy(deviated).state, 'invalid');

  const pending = completedData();
  pending.outcomes[0]!.maturity = 'pending';
  pending.outcomes[0]!.eventHash = causalEventHash({ ...pending.outcomes[0]!, eventHash: undefined });
  assert.equal(qualifyCausalStudy(pending).state, 'collecting');

  const modeled = completedData();
  modeled.executions[0]!.directCostSourceClass = 'modeled_price_card';
  modeled.executions[0]!.eventHash = causalEventHash({ ...modeled.executions[0]!, eventHash: undefined });
  assert.equal(qualifyCausalStudy(modeled).state, 'invalid');
});

test('AI-versus-incumbent claim requires its extra economic/full-cost protocol fields', () => {
  const missingEconomic = modelDraft({ question: 'ai_vs_incumbent_net_benefit' });
  assert.ok(validateCausalProtocol(missingEconomic).some((error) => /economic outcome/i.test(error)));

  const missingNoAiControl = modelDraft({
    question: 'ai_vs_incumbent_net_benefit',
    arms: [
      { armId: 'ai', role: 'ai', executionPlanHash: H('a'), providerId: 'provider-a', modelId: 'model-new' },
      { armId: 'candidate', role: 'candidate', executionPlanHash: H('b'), providerId: null, modelId: null },
    ],
    economicOutcome: {
      metricId: 'economic_value_usd',
      boundsUsd: { low: 0, high: 100 },
      evidenceClass: 'deterministic',
      fullCostAccountingRequired: true,
    },
  });
  assert.ok(validateCausalProtocol(missingNoAiControl).some((error) => /incumbent|no_ai/i.test(error)));
});
