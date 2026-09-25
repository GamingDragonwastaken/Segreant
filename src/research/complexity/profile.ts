/**
 * Research-only complexity profile foundation (WP-J03).
 *
 * This module records content-free structural/execution observables without
 * collapsing them into a scalar score, routing recommendation, budget action,
 * or causal explanation. It is intentionally outside `src/` production
 * consumers and emits an uncalibrated research profile until prospective data
 * and the ten promotion gates exist.
 */

import { createHash } from 'node:crypto';

export interface ComplexityProfileInput {
  readonly profileId: string;
  readonly subject: string;
  readonly evaluatedAt: string;
  readonly structural: {
    readonly added: number;
    readonly deleted: number;
    readonly files: number;
    readonly contextTokens: number;
    readonly taskType: string;
    readonly toolCount: number;
  };
  readonly execution: {
    readonly requestCount: number;
    readonly totalTokens: number;
    readonly reasoningTokens: number;
    readonly durationMs: number;
    readonly retryCount: number;
  };
}

export interface ComplexityProfile {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly evaluatedAt: string;
  readonly subject: string;
  readonly structural: {
    readonly diffVolume: { readonly added: number; readonly deleted: number; readonly files: number };
    readonly contextTokens: number;
    readonly taskType: string;
    readonly toolCount: number;
  };
  readonly execution: {
    readonly requestCount: number;
    readonly totalTokens: number;
    readonly reasoningTokens: number;
    readonly durationMs: number;
    readonly retryCount: number;
  };
  readonly epistemic: {
    readonly predictiveUncertainty: null;
    readonly poolUncertainty: null;
    readonly estimationMethod: 'not_estimated';
  };
  readonly modelSensitivity: {
    readonly performanceDispersion: null;
    readonly candidatePairwiseSeparation: Readonly<Record<string, never>>;
  };
  readonly predictedCompute: null;
  readonly confidence: {
    readonly calibrationStatus: 'uncalibrated_research';
    readonly coverageInterval: null;
  };
  readonly provenance: {
    readonly estimatorId: 'structural_execution_observables_v1';
    readonly estimatorVersion: '1';
    readonly inputDigest: `sha256:${string}`;
    readonly calibrationDatasetId: null;
  };
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a bounded identifier`);
  }
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function inputDigest(input: ComplexityProfileInput): `sha256:${string}` {
  const canonical = JSON.stringify({
    profileId: input.profileId,
    subject: input.subject,
    evaluatedAt: input.evaluatedAt,
    structural: input.structural,
    execution: input.execution,
  });
  return `sha256:${createHash('sha256').update(`segreant.complexity\n1\n${canonical}`, 'utf8').digest('hex')}`;
}

export function buildComplexityProfile(input: ComplexityProfileInput): ComplexityProfile {
  if (input === null || typeof input !== 'object') throw new Error('complexity profile input must be an object');
  identifier(input.profileId, 'profileId');
  identifier(input.subject, 'subject');
  if (typeof input.evaluatedAt !== 'string' || !Number.isFinite(Date.parse(input.evaluatedAt))) {
    throw new Error('evaluatedAt must be an ISO timestamp');
  }
  const structural = input.structural;
  const execution = input.execution;
  if (structural === null || typeof structural !== 'object' || execution === null || typeof execution !== 'object') {
    throw new Error('structural and execution observables are required');
  }
  for (const [key, value] of Object.entries(structural)) {
    if (key !== 'taskType') nonNegativeInteger(value, `structural.${key}`);
  }
  if (typeof structural.taskType !== 'string' || structural.taskType.trim() === '') throw new Error('structural.taskType is required');
  for (const [key, value] of Object.entries(execution)) nonNegativeInteger(value, `execution.${key}`);
  if (execution.reasoningTokens > execution.totalTokens) throw new Error('execution.reasoningTokens cannot exceed totalTokens');
  const profile: ComplexityProfile = {
    schemaVersion: 1,
    profileId: input.profileId,
    evaluatedAt: input.evaluatedAt,
    subject: input.subject,
    structural: {
      diffVolume: { added: structural.added, deleted: structural.deleted, files: structural.files },
      contextTokens: structural.contextTokens,
      taskType: structural.taskType,
      toolCount: structural.toolCount,
    },
    execution: { ...execution },
    epistemic: { predictiveUncertainty: null, poolUncertainty: null, estimationMethod: 'not_estimated' },
    modelSensitivity: { performanceDispersion: null, candidatePairwiseSeparation: {} },
    predictedCompute: null,
    confidence: { calibrationStatus: 'uncalibrated_research', coverageInterval: null },
    provenance: {
      estimatorId: 'structural_execution_observables_v1',
      estimatorVersion: '1',
      inputDigest: inputDigest(input),
      calibrationDatasetId: null,
    },
  };
  return Object.freeze(profile);
}

