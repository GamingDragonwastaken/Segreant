/**
 * The local causal evidence ledger must survive a real SQLite round-trip and
 * must reject mutation after commitment. This is a local reproducibility
 * control, deliberately not represented as independent tamper-proofing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockedAssignmentPlan } from '../src/causal/assignment.ts';
import { causalEventHash, commitCausalProtocol } from '../src/causal/protocol.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  type CausalExecutionRecord,
  type CausalOutcomeRecord,
  type CausalStudyProtocolDraft,
} from '../src/causal/types.ts';
import { Store } from '../src/store/db.ts';

const H = (char: string): string => char.repeat(64);

function protocolDraft(): CausalStudyProtocolDraft {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION,
    studyId: 'study-store',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: { cohortId: 'cohort-store', unitOfAssignment: 'task', contextSchemaId: 'task-v1' },
    arms: [
      { armId: 'candidate', role: 'candidate', executionPlanHash: H('a'), providerId: 'provider-a', modelId: 'model-new' },
      { armId: 'control', role: 'control', executionPlanHash: H('b'), providerId: 'provider-a', modelId: 'model-old' },
    ],
    allocation: { method: 'blocked_randomized_equal_allocation', probabilityPerArm: 0.5, blockSize: 4 },
    costOutcome: { metricId: 'direct_cost_usd', boundsUsd: { low: 0, high: 100 }, acceptedSourceClasses: ['actual_observed'] },
    qualityOutcome: { metricId: 'verified_quality', bounds: { low: 0, high: 1 }, evidenceClass: 'deterministic', nonInferiorityMargin: 0.05 },
    economicOutcome: null,
    analysis: { estimand: 'intention_to_treat', confidenceLevel: 0.95, minCompletedPerArm: 2, maxMissingFractionPerArm: 0.25 },
  };
}

function event<T extends Record<string, unknown>>(input: T): T & { eventHash: string } {
  return { ...input, eventHash: causalEventHash(input) };
}

test('causal evidence persists as append-only local protocol, allocation, events, and analysis', () => {
  const store = new Store(':memory:');
  try {
    const protocol = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    assert.equal(store.registerCausalProtocol(protocol), 'existing');

    const plan = createBlockedAssignmentPlan(protocol, {
      blockId: 'block-store',
      createdAtMs: 1_700_000_000_200,
      unitIdHashes: [H('1'), H('2'), H('3'), H('4')],
      randomizationMaterial: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    assert.equal(store.saveCausalAssignmentPlan(plan), 'created');
    assert.equal(store.saveCausalAssignmentPlan(plan), 'existing');

    for (const decision of plan.decisions) {
      const arm = protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId)!;
      const execution: CausalExecutionRecord = event({
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
      assert.equal(store.appendCausalExecution(execution), 'created');
      assert.equal(store.appendCausalExecution(execution), 'existing');
      const outcome: CausalOutcomeRecord = event({
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
      });
      assert.equal(store.appendCausalOutcome(outcome), 'created');
      assert.equal(store.appendCausalOutcome(outcome), 'existing');
    }

    const data = store.causalStudyData(protocol.studyId);
    assert.ok(data);
    assert.equal(data.decisions.length, 4);
    assert.equal(data.executions.length, 4);
    assert.equal(data.outcomes.length, 4);

    const snapshot = store.saveCausalAnalysis(protocol.studyId, 'analysis:study-store:1', 1_700_000_000_500);
    assert.equal(snapshot.estimate.qualification.state, 'qualified');
    assert.equal(store.causalAnalysisSnapshots(protocol.studyId).length, 1);
    assert.deepEqual(store.causalStudySummaries(), [{
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      committedAtMs: protocol.committedAtMs,
      decisions: 4,
      executions: 4,
      outcomes: 4,
      latestAnalysis: {
        analysisId: 'analysis:study-store:1',
        computedAtMs: 1_700_000_000_500,
        state: 'qualified',
      },
    }]);

    assert.throws(
      () => store.raw().prepare('UPDATE causal_protocols SET protocol_json = ?').run('{}'),
      /append-only/i,
    );
    assert.throws(
      () => store.raw().prepare('DELETE FROM causal_decisions').run(),
      /append-only/i,
    );
  } finally {
    store.close();
  }
});

test('outcome rows cannot bypass the stored execution event', () => {
  const store = new Store(':memory:');
  try {
    const protocol = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    store.registerCausalProtocol(protocol);
    const fake = event({
      outcomeId: 'outcome-fake',
      decisionId: 'decision-missing',
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      observedAtMs: 1_700_000_000_300,
      maturity: 'matured' as const,
      qualityValue: 0.9,
      qualityEvidenceClass: 'deterministic' as const,
      economicValueUsd: null,
      economicEvidenceClass: null,
      outcomeEvidenceRefs: ['evidence-fake'],
      missingReason: null,
      previousEventHash: H('a'),
    });
    assert.throws(() => store.appendCausalOutcome(fake), /stored execution/i);
  } finally {
    store.close();
  }
});
