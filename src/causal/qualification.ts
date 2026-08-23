/**
 * Pure qualification gates for local randomized-study evidence.
 *
 * This module deliberately prefers an explicit collecting, inconclusive, or
 * invalid result over a flattering conclusion. It makes no provider call and
 * never derives a causal state from ordinary Lift, a baseline, or a historic
 * model comparison.
 */

import {
  isCausalIdentifier,
  isSha256,
  verifyCausalEvent,
  verifyCommittedCausalProtocol,
} from './protocol.ts';
import type {
  ArmCounts,
  CausalDecisionRecord,
  CausalExecutionRecord,
  CausalOutcomeRecord,
  CausalQualification,
  CausalStudyData,
} from './types.ts';

function blankCounts(armIds: string[]): Record<string, ArmCounts> {
  return Object.fromEntries(armIds.map((armId) => [armId, {
    assigned: 0,
    completed: 0,
    missing: 0,
    adherenceConfirmed: 0,
  }]));
}

function qualification(
  state: CausalQualification['state'],
  reasons: string[],
  countsByArm: Record<string, ArmCounts>,
  includedDecisionIds: string[],
): CausalQualification {
  return {
    state,
    evidenceGrade: state === 'qualified'
      ? 'randomized_causal'
      : state === 'inconclusive'
        ? 'randomized_inconclusive'
        : state === 'collecting'
          ? 'randomized_collecting'
          : 'not_identified',
    reasons,
    countsByArm,
    includedDecisionIds,
  };
}

function duplicateIds(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function finiteInBounds(value: number | null, bounds: { low: number; high: number }): boolean {
  return value !== null && Number.isFinite(value) && value >= bounds.low && value <= bounds.high;
}

function asEvent(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function sameStudy(
  value: { studyId: string; protocolHash: string },
  studyId: string,
  protocolHash: string,
): boolean {
  return value.studyId === studyId && value.protocolHash === protocolHash;
}

/**
 * Check whether a set of local records has earned a scoped randomized result.
 * A qualified protocol is not enough: execution, outcome, cost, and quality
 * records must all independently satisfy their declared gates.
 */
export function qualifyCausalStudy(data: CausalStudyData): CausalQualification {
  const protocolErrors = verifyCommittedCausalProtocol(data.protocol);
  const countsByArm = blankCounts(data.protocol.arms.map((arm) => arm.armId));
  if (protocolErrors.length > 0) return qualification('invalid', protocolErrors, countsByArm, []);

  const reasons: string[] = [];
  const { protocol, decisions, executions, outcomes } = data;
  const armIds = new Set(protocol.arms.map((arm) => arm.armId));

  for (const duplicate of duplicateIds(decisions.map((v) => v.decisionId))) reasons.push('duplicate decisionId: ' + duplicate);
  for (const duplicate of duplicateIds(executions.map((v) => v.executionId))) reasons.push('duplicate executionId: ' + duplicate);
  for (const duplicate of duplicateIds(outcomes.map((v) => v.outcomeId))) reasons.push('duplicate outcomeId: ' + duplicate);
  for (const duplicate of duplicateIds(executions.map((v) => v.decisionId))) reasons.push('multiple execution records for decisionId: ' + duplicate);
  for (const duplicate of duplicateIds(outcomes.map((v) => v.decisionId))) reasons.push('multiple outcome records for decisionId: ' + duplicate);

  const decisionById = new Map<string, CausalDecisionRecord>();
  for (const decision of decisions) {
    if (!sameStudy(decision, protocol.studyId, protocol.protocolHash) ||
        !isCausalIdentifier(decision.decisionId) ||
        !isSha256(decision.unitIdHash) ||
        !isCausalIdentifier(decision.randomizationBlockId) ||
        !armIds.has(decision.assignedArmId) ||
        decision.propensity !== protocol.allocation.probabilityPerArm ||
        !isSha256(decision.allocationHash) ||
        !isSha256(decision.randomizationMaterialSha256) ||
        !isSha256(decision.previousEventHash) ||
        !Number.isInteger(decision.assignedAtMs) ||
        decision.assignedAtMs < protocol.committedAtMs ||
        !verifyCausalEvent(asEvent(decision))) {
      reasons.push('decision ' + decision.decisionId + ' has invalid study, assignment, timestamp, or event integrity');
      continue;
    }
    decisionById.set(decision.decisionId, decision);
  }

  const decisionHashes = new Set([...decisionById.values()].map((decision) => decision.eventHash));
  for (const decision of decisionById.values()) {
    if (decision.previousEventHash !== protocol.protocolHash && !decisionHashes.has(decision.previousEventHash)) {
      reasons.push('decision ' + decision.decisionId + ' has an unresolvable event-chain predecessor');
    }
    const count = countsByArm[decision.assignedArmId]!;
    count.assigned += 1;
  }

  const executionByDecision = new Map<string, CausalExecutionRecord>();
  for (const execution of executions) {
    const decision = decisionById.get(execution.decisionId);
    if (!decision) {
      reasons.push('execution ' + execution.executionId + ' does not bind a valid decision');
      continue;
    }
    if (!sameStudy(execution, protocol.studyId, protocol.protocolHash) ||
        !isCausalIdentifier(execution.executionId) ||
        !isSha256(execution.assignedExecutionPlanHash) ||
        (execution.actualExecutionPlanHash !== null && !isSha256(execution.actualExecutionPlanHash)) ||
        !isSha256(execution.previousEventHash) ||
        execution.previousEventHash !== decision.eventHash ||
        !Number.isInteger(execution.startedAtMs) ||
        !Number.isInteger(execution.completedAtMs) ||
        execution.startedAtMs < decision.assignedAtMs ||
        execution.completedAtMs < execution.startedAtMs ||
        !verifyCausalEvent(asEvent(execution))) {
      reasons.push('execution ' + execution.executionId + ' has invalid lineage, timestamps, or event integrity');
      continue;
    }
    const arm = protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId)!;
    if (execution.assignedExecutionPlanHash !== arm.executionPlanHash ||
        execution.actualExecutionPlanHash !== arm.executionPlanHash ||
        execution.adherence !== 'confirmed') {
      reasons.push('execution ' + execution.executionId + ' does not confirm the assigned intervention plan');
      continue;
    }
    if (execution.directAiCostUsd === null ||
        !finiteInBounds(execution.directAiCostUsd, protocol.costOutcome.boundsUsd) ||
        !protocol.costOutcome.acceptedSourceClasses.includes(execution.directCostSourceClass as 'actual_reconciled' | 'actual_observed') ||
        execution.priceLineageHashes.length === 0 ||
        !execution.priceLineageHashes.every(isSha256)) {
      reasons.push('execution ' + execution.executionId + ' has no acceptable actual direct-cost evidence');
      continue;
    }
    if (protocol.question === 'ai_vs_incumbent_net_benefit' &&
        (execution.fullArmCostUsd === null ||
          !finiteInBounds(execution.fullArmCostUsd, protocol.costOutcome.boundsUsd) ||
          !protocol.costOutcome.acceptedSourceClasses.includes(execution.fullCostSourceClass as 'actual_reconciled' | 'actual_observed'))) {
      reasons.push('execution ' + execution.executionId + ' has no acceptable full-cost evidence');
      continue;
    }
    executionByDecision.set(execution.decisionId, execution);
    countsByArm[decision.assignedArmId]!.adherenceConfirmed += 1;
  }

  const outcomeByDecision = new Map<string, CausalOutcomeRecord>();
  let pending = false;
  for (const outcome of outcomes) {
    const execution = executionByDecision.get(outcome.decisionId);
    if (!execution) {
      reasons.push('outcome ' + outcome.outcomeId + ' does not bind a qualifying execution');
      continue;
    }
    if (!sameStudy(outcome, protocol.studyId, protocol.protocolHash) ||
        !isCausalIdentifier(outcome.outcomeId) ||
        !isSha256(outcome.previousEventHash) ||
        outcome.previousEventHash !== execution.eventHash ||
        !Number.isInteger(outcome.observedAtMs) ||
        outcome.observedAtMs < execution.completedAtMs ||
        !verifyCausalEvent(asEvent(outcome))) {
      reasons.push('outcome ' + outcome.outcomeId + ' has invalid lineage, timestamp, or event integrity');
      continue;
    }
    if (outcome.maturity === 'pending') {
      pending = true;
      continue;
    }
    if (outcome.maturity !== 'matured') {
      reasons.push('outcome ' + outcome.outcomeId + ' is not matured');
      continue;
    }
    if (!finiteInBounds(outcome.qualityValue, protocol.qualityOutcome.bounds) ||
        outcome.qualityEvidenceClass !== protocol.qualityOutcome.evidenceClass ||
        outcome.outcomeEvidenceRefs.length === 0 ||
        !outcome.outcomeEvidenceRefs.every(isCausalIdentifier)) {
      reasons.push('outcome ' + outcome.outcomeId + ' has no qualifying quality evidence');
      continue;
    }
    if (protocol.question === 'ai_vs_incumbent_net_benefit') {
      const economic = protocol.economicOutcome!;
      if (!finiteInBounds(outcome.economicValueUsd, economic.boundsUsd) ||
          outcome.economicEvidenceClass !== economic.evidenceClass) {
        reasons.push('outcome ' + outcome.outcomeId + ' has no qualifying economic-value evidence');
        continue;
      }
    }
    outcomeByDecision.set(outcome.decisionId, outcome);
  }

  for (const decision of decisionById.values()) {
    const count = countsByArm[decision.assignedArmId]!;
    if (executionByDecision.has(decision.decisionId) && outcomeByDecision.has(decision.decisionId)) {
      count.completed += 1;
    } else {
      count.missing += 1;
      if (!executionByDecision.has(decision.decisionId) || !outcomeByDecision.has(decision.decisionId)) pending = true;
    }
  }

  for (const [armId, count] of Object.entries(countsByArm)) {
    if (count.assigned === 0) reasons.push('arm ' + armId + ' has zero assignment support');
  }

  if (reasons.length > 0) return qualification('invalid', reasons, countsByArm, []);
  if (decisions.length === 0 || pending) {
    return qualification('collecting', ['Protocol is valid but outcomes/execution are still incomplete.'], countsByArm, []);
  }
  for (const [armId, count] of Object.entries(countsByArm)) {
    if (count.assigned > 0 && count.missing / count.assigned > protocol.analysis.maxMissingFractionPerArm) {
      reasons.push('arm ' + armId + ' exceeds its declared missingness limit');
    }
  }
  if (reasons.length > 0) return qualification('invalid', reasons, countsByArm, []);
  const underpowered = Object.entries(countsByArm)
    .filter(([, count]) => count.completed < protocol.analysis.minCompletedPerArm)
    .map(([armId, count]) => 'arm ' + armId + ' has ' + String(count.completed) + ' completed units; requires ' + String(protocol.analysis.minCompletedPerArm));
  if (underpowered.length > 0) return qualification('inconclusive', underpowered, countsByArm, []);

  return qualification('qualified', [], countsByArm, [...decisionById.keys()].sort());
}
