/**
 * Shared randomized-study fixtures for the causal lane.
 *
 * These were local to `test/causal-core.test.ts` until a second file needed a
 * QUALIFIED study — the state where a causal claim becomes reachable, and
 * therefore the state every test about that boundary has to construct. Copying
 * a hundred and fifty lines of protocol, assignment chain, execution and
 * outcome records into a second file is how two suites quietly stop testing the
 * same study, so they live here instead.
 *
 * `completedData` is the small four-unit study: valid, qualified, and
 * deliberately too small to earn any claim. `repeatedCostQualityData` expands
 * it to 500 units per arm without touching the registered protocol, which is
 * what makes the pre-declared intervals narrow enough for the joint rule to be
 * reachable in either direction.
 */

import { createRetainedCausalV1AssignmentFixture } from './causalV1Fixture.ts';
import { causalEventHash, commitCausalProtocol } from '../../src/causal/protocol.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  type CausalDecisionRecord,
  type CausalExecutionRecord,
  type CausalOutcomeRecord,
  type CausalStudyData,
  type CausalStudyProtocolDraft,
} from '../../src/causal/types.ts';

export const H = (char: string): string => char.repeat(64);

export function modelDraft(overrides: Partial<CausalStudyProtocolDraft> = {}): CausalStudyProtocolDraft {
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

export function completedData(protocolDraft: CausalStudyProtocolDraft = modelDraft()): CausalStudyData {
  const protocol = commitCausalProtocol(protocolDraft, 1_700_000_000_100);
  const plan = createRetainedCausalV1AssignmentFixture(protocol, {
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

/** Expand the small fixture into independent-looking blocked observations for
 * interval-boundary tests without changing the registered protocol. */
export function repeatedCostQualityData(qualityCandidate: number, qualityControl: number, candidateCost = 1, controlCost = 99): CausalStudyData {
  const base = completedData();
  const decisions: CausalDecisionRecord[] = [];
  const executions: CausalExecutionRecord[] = [];
  const outcomes: CausalOutcomeRecord[] = [];
  for (let repeat = 0; repeat < 250; repeat += 1) {
    for (let index = 0; index < base.decisions.length; index += 1) {
      const sourceDecision = base.decisions[index]!;
      const decisionCore = {
        ...sourceDecision,
        decisionId: `${sourceDecision.decisionId}:r${repeat}`,
        randomizationBlockId: `block:${repeat}`,
        unitIdHash: H(((repeat * base.decisions.length + index) % 16).toString(16)),
        assignedAtMs: sourceDecision.assignedAtMs + repeat * 10_000,
        previousEventHash: base.protocol.protocolHash,
      };
      const decision = { ...decisionCore, eventHash: causalEventHash({ ...decisionCore, eventHash: undefined }) };
      decisions.push(decision);

      const sourceExecution = base.executions[index]!;
      const executionCore = {
        ...sourceExecution,
        executionId: `${sourceExecution.executionId}:r${repeat}`,
        decisionId: decision.decisionId,
        startedAtMs: decision.assignedAtMs + 1,
        completedAtMs: decision.assignedAtMs + 2,
        directAiCostUsd: decision.assignedArmId === 'candidate' ? candidateCost : controlCost,
        previousEventHash: decision.eventHash,
      };
      const execution = { ...executionCore, eventHash: causalEventHash({ ...executionCore, eventHash: undefined }) };
      executions.push(execution);

      const sourceOutcome = base.outcomes[index]!;
      const outcomeCore = {
        ...sourceOutcome,
        outcomeId: `${sourceOutcome.outcomeId}:r${repeat}`,
        decisionId: decision.decisionId,
        observedAtMs: execution.completedAtMs + 1,
        qualityValue: decision.assignedArmId === 'candidate' ? qualityCandidate : qualityControl,
        previousEventHash: execution.eventHash,
      };
      outcomes.push({ ...outcomeCore, eventHash: causalEventHash({ ...outcomeCore, eventHash: undefined }) });
    }
  }
  return { protocol: base.protocol, decisions, executions, outcomes };
}
