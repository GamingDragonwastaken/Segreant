/**
 * The local causal evidence ledger must survive a real SQLite round-trip and
 * must reject mutation after commitment. This is a local reproducibility
 * control, deliberately not represented as independent tamper-proofing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { constants as sqliteConstants, DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import * as qualificationModule from '../src/causal/qualification.ts';
import { canonicalJson, causalEventHash, commitCausalProtocol } from '../src/causal/protocol.ts';
import {
  causalExecutionV2EventHash,
  causalTerminalOutcomeV2EventHash,
  decodeCausalTerminalOutcomeV2,
  ordinaryLedgerVerifierHash,
} from '../src/causal/records.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  CAUSAL_PROTOCOL_VERSION_V2,
  type CausalExecutionRecord,
  type CausalExecutionRecordV2,
  type CausalTerminalOutcomeRecordV2,
  type CausalOutcomeRecord,
  type CausalStudyProtocolDraft,
  type CausalStudyProtocolDraftV2,
  type CommittedCausalStudyProtocolV2,
} from '../src/causal/types.ts';
import { Store } from '../src/store/db.ts';
import { causalQualificationV2 } from '../src/store/causal.ts';
import { causalV2SchemaAttestation, causalV2SchemaComplete } from '../src/store/schema.ts';
import { createRetainedCausalV1AssignmentFixture } from './support/causalV1Fixture.ts';

const H = (char: string): string => char.repeat(64);

function withWallClock<T>(nowMs: number, action: () => T): T {
  const original = Date.now;
  Date.now = () => nowMs;
  try {
    return action();
  } finally {
    Date.now = original;
  }
}

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

test('retained version-1 causal evidence remains readable and append-only after becoming inspect-only', () => {
  const store = new Store(':memory:');
  try {
    const protocol = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    store.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));

    const plan = createRetainedCausalV1AssignmentFixture(protocol, {
      blockId: 'block-store',
      createdAtMs: 1_700_000_000_200,
      unitIdHashes: [H('1'), H('2'), H('3'), H('4')],
      randomizationMaterial: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    store.raw().prepare(
      'INSERT INTO causal_assignment_plans (study_id, block_id, protocol_hash, created_at_ms, allocation_hash, material_sha256, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(plan.studyId, plan.blockId, plan.protocolHash, plan.createdAtMs, plan.allocationHash, plan.randomizationMaterialSha256, JSON.stringify(plan));
    const insertDecision = store.raw().prepare(
      'INSERT INTO causal_decisions (decision_id, study_id, protocol_hash, assigned_at_ms, event_hash, decision_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const decision of plan.decisions) {
      insertDecision.run(decision.decisionId, decision.studyId, decision.protocolHash, decision.assignedAtMs, decision.eventHash, JSON.stringify(decision));
    }

    const executions: CausalExecutionRecord[] = [];
    const outcomes: CausalOutcomeRecord[] = [];
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
      executions.push(execution);
      store.raw().prepare(
        'INSERT INTO causal_executions (execution_id, decision_id, study_id, protocol_hash, completed_at_ms, event_hash, execution_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(execution.executionId, execution.decisionId, execution.studyId, execution.protocolHash, execution.completedAtMs, execution.eventHash, JSON.stringify(execution));
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
      outcomes.push(outcome);
      store.raw().prepare(
        'INSERT INTO causal_outcomes (outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, event_hash, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(outcome.outcomeId, outcome.decisionId, outcome.studyId, outcome.protocolHash, outcome.observedAtMs, outcome.eventHash, JSON.stringify(outcome));
    }

    const data = store.causalStudyData(protocol.studyId);
    assert.ok(data);
    assert.equal(data.decisions.length, 4);
    assert.equal(data.executions.length, 4);
    assert.equal(data.outcomes.length, 4);

    const snapshot = {
      analysisId: 'analysis:study-store:1',
      computedAtMs: 1_700_000_000_500,
      estimate: estimateCausalStudy({ protocol, decisions: plan.decisions, executions, outcomes }),
    };
    store.raw().prepare(
      'INSERT INTO causal_analysis_snapshots (analysis_id, study_id, protocol_hash, computed_at_ms, state, analysis_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(snapshot.analysisId, protocol.studyId, protocol.protocolHash, snapshot.computedAtMs, snapshot.estimate.qualification.state, JSON.stringify(snapshot));
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

test('version-1 outcome mutation is closed before lineage evaluation', () => {
  const store = new Store(':memory:');
  try {
    const protocol = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    store.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
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
    assert.throws(() => store.appendCausalOutcome(fake), /CAUSAL_LEGACY_INSPECT_ONLY|inspect-only/i);
  } finally {
    store.close();
  }
});

const D = (char: string): string => 'sha256:' + H(char);

function v2StoreProtocol(
  studyId = 'study:store-v2',
  maxAssignments = 12,
): CommittedCausalStudyProtocolV2 {
  const draft: CausalStudyProtocolDraftV2 = {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION_V2,
    studyId,
    seriesId: 'series:' + studyId.slice('study:'.length),
    studyVersion: 1,
    ownerId: 'owner:finops',
    scopeId: 'scope:store-tests',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:eligible',
      contextSchemaId: 'schema:task-v2',
      unitOfAssignment: 'task',
      inclusionRuleIds: ['rule:active'],
      exclusionRuleIds: [],
    },
    studyWindow: { startsAtMs: 1_700_000_001_000, endsAtMs: null },
    stoppingRule: { kind: 'fixed_enrollment', maxAssignments },
    arms: [
      {
        armId: 'arm:candidate',
        role: 'candidate',
        executionPlanDigest: D('a'),
        providerId: 'provider:alpha',
        modelId: 'model:new',
      },
      {
        armId: 'arm:control',
        role: 'control',
        executionPlanDigest: D('b'),
        providerId: 'provider:alpha',
        modelId: 'model:old',
      },
    ],
    allocation: {
      method: 'blocked_randomized_equal_allocation',
      probabilityPerArm: 0.5,
      blockSize: 4,
    },
    costOutcome: {
      metricId: 'metric:direct-cost-usd',
      currency: 'USD',
      boundsUsd: { low: 0, high: 100 },
      acceptedSourceClasses: ['actual_observed'],
      priceLineageRule: 'every_included_cost_has_retained_sha256_lineage',
    },
    qualityOutcome: {
      metricId: 'metric:verified-quality',
      collectionMethodId: 'method:deterministic-check',
      bounds: { low: 0, high: 1 },
      evidenceClass: 'deterministic',
      nonInferiorityMargin: 0.05,
    },
    economicOutcome: null,
    analysis: {
      estimand: 'intention_to_treat',
      confidenceLevel: 0.95,
      minCompletedPerArm: 2,
      maxMissingFractionPerArm: 0.25,
      exclusionPolicyId: 'policy:predeclared',
    },
    dataGovernance: {
      minimizedSourceIds: ['source:local-ledger'],
      retentionClassId: 'retention:causal-minimal',
      egressReceiptDigests: [],
    },
    claimTemplateIds: {
      qualified: 'claim:qualified-v2',
      inconclusive: 'claim:inconclusive-v2',
      invalid: 'claim:invalid-v2',
    },
  };
  return commitCausalProtocol(draft, 1_700_000_000_500) as CommittedCausalStudyProtocolV2;
}

function policyV2StoreProtocol(
  studyId = 'study:policy-store-v2',
  maxAssignments = 12,
  followUpWindowMs = 1_000,
  maxMissingFractionPerArm = 0.25,
): CommittedCausalStudyProtocolV2 {
  const base = v2StoreProtocol(studyId, maxAssignments);
  const {
    lifecycle: _lifecycle,
    committedAtMs: _committedAtMs,
    protocolHash: _protocolHash,
    ...draftBase
  } = base;
  return commitCausalProtocol({
    ...draftBase,
    followUpWindowMs,
    analysis: { ...draftBase.analysis, maxMissingFractionPerArm },
  } as CausalStudyProtocolDraftV2, base.committedAtMs) as CommittedCausalStudyProtocolV2;
}

function v2AiStoreProtocol(
  studyId = 'study:ai-store-v2',
  maxAssignments = 12,
): CommittedCausalStudyProtocolV2 {
  const base = v2StoreProtocol(studyId, maxAssignments);
  const {
    lifecycle: _lifecycle,
    committedAtMs: _committedAtMs,
    protocolHash: _protocolHash,
    ...draftBase
  } = base;
  const draft: CausalStudyProtocolDraftV2 = {
    ...draftBase,
    question: 'ai_vs_incumbent_net_benefit',
    arms: [
      { ...base.arms[0]!, role: 'ai' },
      { ...base.arms[1]!, role: 'incumbent' },
    ],
    economicOutcome: {
      metricId: 'metric:net-benefit',
      collectionMethodId: 'method:deterministic-economic',
      currency: 'USD',
      boundsUsd: { low: -100, high: 100 },
      evidenceClass: 'deterministic',
      fullCostAccountingRequired: true,
    },
  };
  return commitCausalProtocol(draft, base.committedAtMs) as CommittedCausalStudyProtocolV2;
}

interface RetainedProtocolRowFixture {
  name: string;
  studyId: string;
  protocolHash: string;
  committedAtMs: number;
  protocolJson: string;
  secrets: string[];
}

function assertProtocolIntegrityFailure(action: () => unknown, secrets: string[]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
    assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored causal protocol failed integrity verification');
    for (const secret of secrets) assert.doesNotMatch(error.message, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    assert.doesNotMatch(error.message, /protocol_json|sqlite|syntax|unexpected|rawPrompt|study-cross|ffff/i);
    return true;
  });
}

function protocolCorruptionFixtures(): RetainedProtocolRowFixture[] {
  const v1 = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
  const v2 = v2StoreProtocol('study:strict-row-v2');
  const v1Missing = structuredClone(v1) as unknown as Record<string, unknown>;
  delete v1Missing.analysis;
  const v2Missing = structuredClone(v2) as unknown as Record<string, unknown>;
  delete v2Missing.dataGovernance;
  const v1BadCommitment = { ...v1, protocolHash: H('e') };
  const v2BadCommitment = { ...v2, protocolHash: D('e') };
  const base = (
    name: string,
    protocol: typeof v1 | typeof v2,
    protocolJson: string,
    overrides: Partial<Pick<RetainedProtocolRowFixture, 'studyId' | 'protocolHash' | 'committedAtMs'>> = {},
    secrets: string[] = [],
  ): RetainedProtocolRowFixture => ({
    name,
    studyId: overrides.studyId ?? protocol.studyId,
    protocolHash: overrides.protocolHash ?? protocol.protocolHash,
    committedAtMs: overrides.committedAtMs ?? protocol.committedAtMs,
    protocolJson,
    secrets,
  });
  return [
    base('v1 physical study divergence / cross-study reproduction', v1, canonicalJson(v1), { studyId: 'study-cross-physical' }, ['study-cross-physical', v1.studyId]),
    base('v1 physical hash divergence', v1, canonicalJson(v1), { protocolHash: H('f') }, [H('f'), v1.protocolHash]),
    base('v1 physical time divergence', v1, canonicalJson(v1), { committedAtMs: 1_700_000_099_999 }, ['1700000099999']),
    base('v2 physical study divergence', v2, canonicalJson(v2), { studyId: 'study:physical-v2' }, ['study:physical-v2', v2.studyId]),
    base('v2 physical hash divergence', v2, canonicalJson(v2), { protocolHash: D('f') }, [D('f'), v2.protocolHash]),
    base('v2 physical time divergence', v2, canonicalJson(v2), { committedAtMs: 1_700_000_099_998 }, ['1700000099998']),
    base('malformed JSON', v1, '{"type":', {}, ['{"type":']),
    base('null JSON root', v1, 'null'),
    base('scalar JSON root', v1, '7'),
    base('array JSON root', v1, '[]'),
    base('v1 extra key', v1, canonicalJson({ ...v1, rawPrompt: 'credential-secret-v1' }), {}, ['credential-secret-v1']),
    base('v1 missing key', v1, canonicalJson(v1Missing)),
    base('unsupported version', v1, canonicalJson({ ...v1, version: 99 })),
    base('noncanonical v1 JSON', v1, JSON.stringify(v1)),
    base('invalid v1 commitment', v1BadCommitment, canonicalJson(v1BadCommitment)),
    base('v2 extra key', v2, canonicalJson({ ...v2, rawPrompt: 'credential-secret-v2' }), {}, ['credential-secret-v2']),
    base('v2 missing key', v2, canonicalJson(v2Missing)),
    base('noncanonical v2 JSON', v2, JSON.stringify(v2)),
    base('invalid v2 commitment', v2BadCommitment, canonicalJson(v2BadCommitment)),
  ];
}

test('strict causal protocol row integrity authenticates canonical physical identity and never hides corruption', () => {
  const canonicalV1 = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
  const validStore = new Store(':memory:');
  try {
    validStore.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(canonicalV1.studyId, canonicalV1.protocolHash, canonicalV1.committedAtMs, canonicalJson(canonicalV1));
    assert.equal(validStore.causalStudySummaries()[0]?.studyId, canonicalV1.studyId);
    assert.equal(validStore.causalStudyData(canonicalV1.studyId)?.protocol.protocolHash, canonicalV1.protocolHash);
  } finally {
    validStore.close();
  }

  const validV2 = v2StoreProtocol('study:strict-hidden-v2');
  const v2Store = new Store(':memory:');
  try {
    assert.equal(v2Store.registerCausalProtocol(validV2), 'created');
    assert.deepEqual(v2Store.causalStudySummaries(), []);
    assert.equal(v2Store.causalStudyData(validV2.studyId), null);
  } finally {
    v2Store.close();
  }

  for (const fixture of protocolCorruptionFixtures()) {
    const store = new Store(':memory:');
    try {
      store.raw().prepare(
        'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
      ).run(fixture.studyId, fixture.protocolHash, fixture.committedAtMs, fixture.protocolJson);
      assertProtocolIntegrityFailure(() => store.causalStudySummaries(), fixture.secrets);
      assertProtocolIntegrityFailure(() => store.causalStudyData(fixture.studyId), fixture.secrets);
    } finally {
      store.close();
    }
  }
});

function registerUnknown(store: Store, value: unknown): unknown {
  return (store as unknown as { registerCausalProtocol(value: unknown): unknown }).registerCausalProtocol(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function assertProtocolValidationFailure(action: () => unknown, secret: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'CausalProtocolValidationError');
    assert.equal((error as Error & { code?: string }).code, 'CAUSAL_PROTOCOL_INVALID');
    assert.equal(error.message, 'CAUSAL_PROTOCOL_INVALID: supplied causal protocol is invalid');
    assert.notEqual(error instanceof TypeError, true);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
}

function protocolDraftWithEconomicOutcome(): CausalStudyProtocolDraft {
  const draft = protocolDraft();
  draft.studyId = 'study-store-economic';
  draft.question = 'ai_vs_incumbent_net_benefit';
  draft.arms = [
    { armId: 'ai', role: 'ai', executionPlanHash: H('a'), providerId: 'provider-a', modelId: 'model-new' },
    { armId: 'no-ai', role: 'no_ai', executionPlanHash: H('b'), providerId: null, modelId: null },
  ];
  draft.economicOutcome = {
    metricId: 'economic_value_usd',
    boundsUsd: { low: -100, high: 100 },
    evidenceClass: 'deterministic',
    fullCostAccountingRequired: true,
  };
  return draft;
}

test('causal protocol registration applies exact v1 shape before legacy classification', () => {
  const store = new Store(':memory:');
  try {
    const v1 = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    const secret = 'registration-shape-secret';
    const clone = (): Record<string, unknown> => structuredClone(v1) as unknown as Record<string, unknown>;
    const fixtures: Array<{ name: string; value: unknown }> = [];
    const rootExtra = clone();
    rootExtra.unexpected = secret;
    fixtures.push({ name: 'root extra', value: rootExtra });
    const rootMissing = clone();
    delete rootMissing.analysis;
    fixtures.push({ name: 'root missing', value: rootMissing });

    const nestedTargets: Array<{
      name: string;
      key: string;
      target: (value: Record<string, unknown>) => Record<string, unknown>;
    }> = [
      { name: 'eligibility', key: 'cohortId', target: (value) => record(value.eligibility) },
      { name: 'arm', key: 'armId', target: (value) => record((value.arms as unknown[])[0]) },
      { name: 'allocation', key: 'method', target: (value) => record(value.allocation) },
      { name: 'cost outcome', key: 'metricId', target: (value) => record(value.costOutcome) },
      { name: 'cost bounds', key: 'low', target: (value) => record(record(value.costOutcome).boundsUsd) },
      { name: 'quality outcome', key: 'metricId', target: (value) => record(value.qualityOutcome) },
      { name: 'quality bounds', key: 'low', target: (value) => record(record(value.qualityOutcome).bounds) },
      { name: 'analysis', key: 'estimand', target: (value) => record(value.analysis) },
    ];
    for (const nested of nestedTargets) {
      const extra = clone();
      nested.target(extra).unexpected = secret;
      fixtures.push({ name: nested.name + ' extra', value: extra });
      const missing = clone();
      delete nested.target(missing)[nested.key];
      fixtures.push({ name: nested.name + ' missing', value: missing });
    }

    const economic = commitCausalProtocol(protocolDraftWithEconomicOutcome(), 1_700_000_000_100);
    const economicExtra = structuredClone(economic) as unknown as Record<string, unknown>;
    record(economicExtra.economicOutcome).unexpected = secret;
    fixtures.push({ name: 'economic outcome extra', value: economicExtra });
    const economicMissing = structuredClone(economic) as unknown as Record<string, unknown>;
    delete record(economicMissing.economicOutcome).metricId;
    fixtures.push({ name: 'economic outcome missing', value: economicMissing });

    for (const fixture of fixtures) {
      assertProtocolValidationFailure(() => registerUnknown(store, fixture.value), secret);
    }
    assert.equal(tableCount(store, 'causal_protocols'), 0, 'invalid exact-shape inputs must never mutate the Store');

    assert.throws(() => registerUnknown(store, v1), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'CAUSAL_LEGACY_INSPECT_ONLY');
      return true;
    }, 'an exact valid v1 protocol remains inspect-only');
    assert.equal(tableCount(store, 'causal_protocols'), 0);
  } finally {
    store.close();
  }
});

test('causal protocol registration validates unknown values before access and authenticates idempotence', () => {
  const store = new Store(':memory:');
  try {
    const invalidValues: unknown[] = [
      null,
      undefined,
      7,
      'protocol',
      [],
      {},
      { type: CAUSAL_PROTOCOL_TYPE, version: 2 },
      { type: CAUSAL_PROTOCOL_TYPE, version: 2, studyId: 'study:invalid' },
    ];
    for (const value of invalidValues) {
      assert.throws(() => registerUnknown(store, value), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'CausalProtocolValidationError');
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_PROTOCOL_INVALID');
        assert.equal(error.message, 'CAUSAL_PROTOCOL_INVALID: supplied causal protocol is invalid');
        assert.notEqual(error instanceof TypeError, true);
        return true;
      });
    }
    assert.equal(tableCount(store, 'causal_protocols'), 0);

    const v1 = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    assert.throws(() => registerUnknown(store, v1), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'CAUSAL_LEGACY_INSPECT_ONLY');
      return true;
    });
    assert.equal(tableCount(store, 'causal_protocols'), 0);

    const first = v2StoreProtocol('study:registration-boundary', 4);
    const different = v2StoreProtocol('study:registration-boundary', 8);
    assert.equal(registerUnknown(store, first), 'created');
    assert.equal(registerUnknown(store, structuredClone(first)), 'existing');
    assert.throws(() => registerUnknown(store, different), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'CAUSAL_IMMUTABLE_CONFLICT');
      assert.equal(error.message, 'CAUSAL_IMMUTABLE_CONFLICT: studyId is already committed with different immutable protocol content');
      return true;
    });

    store.raw().prepare('DROP TRIGGER causal_no_update_causal_protocols').run();
    store.raw().prepare('UPDATE causal_protocols SET committed_at_ms = ? WHERE study_id = ?')
      .run(first.committedAtMs + 1, first.studyId);
    assert.throws(() => registerUnknown(store, first), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
      assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored causal protocol failed integrity verification');
      return true;
    });
  } finally {
    store.close();
  }
});

test('causal protocol readers reject unsafe or non-integer SQLite committed timestamps before Number conversion', () => {
  const fixtures: Array<{ name: string; expression: string; parameter?: string }> = [
    { name: 'unsafe positive signed64', expression: '9223372036854775807' },
    { name: 'unsafe negative signed64', expression: '-9223372036854775808' },
    { name: 'real storage', expression: 'CAST(? AS REAL)', parameter: '1700000000500.5' },
    { name: 'text storage', expression: 'CAST(? AS TEXT)', parameter: 'not-an-integer' },
    { name: 'blob storage', expression: 'CAST(? AS BLOB)', parameter: '1700000000500' },
  ];
  for (const fixture of fixtures) {
    const store = new Store(':memory:');
    try {
      const protocol = v2StoreProtocol('study:timestamp-' + fixture.name.replace(/[^a-z0-9]+/g, '-'));
      store.raw().prepare(
        'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ' + fixture.expression + ', ?)',
      ).run(protocol.studyId, protocol.protocolHash, ...(fixture.parameter ? [fixture.parameter] : []), canonicalJson(protocol));

      const physical = store.raw().prepare(
        'SELECT typeof(committed_at_ms) AS storage_class, CAST(committed_at_ms AS TEXT) AS decimal_text FROM causal_protocols WHERE study_id = ?',
      ).get(protocol.studyId) as { storage_class: string; decimal_text: string };
      if (fixture.name.includes('signed64')) {
        assert.equal(physical.storage_class, 'integer', fixture.name + ' fixture must retain SQLite integer storage');
      } else {
        assert.notEqual(physical.storage_class, 'integer', fixture.name + ' fixture must not be normalized to integer');
      }
      assert.throws(() => store.causalStudyData(protocol.studyId), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
        assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored causal protocol failed integrity verification');
        assert.notEqual(error instanceof TypeError, true);
        assert.doesNotMatch(error.message, /9223372036854775807|9223372036854775808|ERR_OUT_OF_RANGE|sqlite/i);
        return true;
      });
      assert.throws(() => store.causalStudySummaries(), /CAUSAL_INTEGRITY_FAILURE/);
      assert.throws(() => registerUnknown(store, protocol), /CAUSAL_INTEGRITY_FAILURE/);
      assert.throws(() => store.causalAssignmentManifestV2(protocol.studyId), /CAUSAL_INTEGRITY_FAILURE/);
    } finally {
      store.close();
    }
  }
});

function insertStoredProtocolWithLatestAnalysis(
  store: Store,
  protocol: ReturnType<typeof commitCausalProtocol>,
  computedAtExpression: string,
): void {
  const committed = protocol as CommittedCausalStudyProtocolV2 | ReturnType<typeof commitCausalProtocol>;
  store.raw().prepare(
    'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
  ).run(committed.studyId, committed.protocolHash, committed.committedAtMs, canonicalJson(committed));
  store.raw().prepare(
    'INSERT INTO causal_analysis_snapshots (analysis_id, study_id, protocol_hash, computed_at_ms, state, analysis_json) VALUES (?, ?, ?, ' + computedAtExpression + ', ?, ?)',
  ).run(
    'analysis:latest', committed.studyId, committed.protocolHash, 'qualified',
    JSON.stringify({ secret: 'latest-analysis-secret' }),
  );
}

test('causal summary authenticates latest-analysis timestamp storage before Number conversion', () => {
  const validStore = new Store(':memory:');
  try {
    const valid = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    insertStoredProtocolWithLatestAnalysis(validStore, valid, '1700000000500');
    assert.deepEqual(validStore.causalStudySummaries()[0]?.latestAnalysis, {
      analysisId: 'analysis:latest',
      computedAtMs: 1_700_000_000_500,
      state: 'qualified',
    });
  } finally {
    validStore.close();
  }

  const noAnalysisStore = new Store(':memory:');
  try {
    const protocol = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    noAnalysisStore.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
    assert.equal(noAnalysisStore.causalStudySummaries()[0]?.latestAnalysis, null);
  } finally {
    noAnalysisStore.close();
  }

  const fixtures = [
    { name: 'unsafe positive signed64', expression: '9223372036854775807' },
    { name: 'unsafe negative signed64', expression: '-9223372036854775808' },
    { name: 'real storage', expression: 'CAST(1700000000500.5 AS REAL)' },
    { name: 'text storage', expression: "CAST('not-an-integer' AS TEXT)" },
    { name: 'blob storage', expression: "CAST('1700000000500' AS BLOB)" },
    { name: 'noncanonical text', expression: "CAST('1700000000500x' AS TEXT)" },
  ];
  for (const fixture of fixtures) {
    const store = new Store(':memory:');
    try {
      const protocol = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
      insertStoredProtocolWithLatestAnalysis(store, protocol, fixture.expression);
      assertProtocolIntegrityFailure(() => store.causalStudySummaries(), [
        'latest-analysis-secret', 'analysis:latest', protocol.protocolHash,
      ]);
    } finally {
      store.close();
    }
  }

  const nullStore = new Store(':memory:');
  try {
    const protocol = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    assert.throws(
      () => insertStoredProtocolWithLatestAnalysis(nullStore, protocol, 'NULL'),
      /NOT NULL/i,
      'the schema prevents a NULL latest-analysis timestamp from becoming a readable row',
    );
  } finally {
    nullStore.close();
  }
});

function assignmentRequest(
  blockId = 'block:store-a',
  unitChars = ['1', '2', '3', '4'],
): {
  studyId: string;
  blockId: string;
  createdAtMs: number;
  unitIdDigests: string[];
} {
  return {
    studyId: 'study:store-v2',
    blockId,
    createdAtMs: 1_700_000_001_000,
    unitIdDigests: unitChars.map(D),
  };
}

type AssignmentMethod = (input: ReturnType<typeof assignmentRequest>) => {
  status: 'created' | 'existing';
  block: { plan: { sequence: number }; decisions: Array<{ assignedArmId: string }> };
  manifest: {
    planCount: number;
    decisionCount: number;
    unitCount: number;
    plans: Array<{ sequence: number }>;
    decisions: Array<{ unitIdDigest: string }>;
    assignmentManifestHash: string;
  };
};

function assignmentMethod(store: Store): AssignmentMethod {
  const method = (store as unknown as { assignCausalBlockV2?: AssignmentMethod }).assignCausalBlockV2;
  assert.equal(typeof method, 'function', 'Store must expose the atomic v2 assignment operation');
  if (typeof method !== 'function') throw new Error('atomic v2 assignment operation is unavailable');
  return method.bind(store);
}

function tableCount(store: Store, table: string): number {
  const row = store.raw().prepare('SELECT COUNT(*) AS count FROM ' + table).get() as { count: number };
  return Number(row.count);
}

type ExecutionMethod = (record: unknown) => 'created' | 'existing';

function executionMethod(store: Store): ExecutionMethod {
  const method = (store as unknown as { appendCausalExecutionV2?: ExecutionMethod }).appendCausalExecutionV2;
  assert.equal(typeof method, 'function', 'Store must expose the internal v2 execution operation');
  if (typeof method !== 'function') throw new Error('internal v2 execution operation is unavailable');
  return method.bind(store);
}

function validExecutionV2(
  protocol: CommittedCausalStudyProtocolV2,
  decision: { decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string },
  executionId = 'execution:store-v2',
): CausalExecutionRecordV2 {
  const verifierMaterial = {
    type: 'fiscus.causal-ordinary-ledger-verifier' as const,
    version: 2 as const,
    state: 'unresolved' as const,
    checkedAtMs: null,
    requestCount: 0 as const,
    evidenceManifestHash: null,
    reasonCodes: ['task4_not_implemented' as const],
  };
  const arm = protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId)!;
  const material = {
    type: 'fiscus.causal-execution' as const,
    version: 2 as const,
    executionId,
    decisionId: decision.decisionId,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    startedAtMs: decision.assignedAtMs + 1,
    completedAtMs: decision.assignedAtMs + 2,
    assignedExecutionPlanDigest: arm.executionPlanDigest,
    actualExecutionPlanDigest: arm.executionPlanDigest,
    adherence: 'confirmed' as const,
    requestIds: [] as string[],
    directAiCostUsd: null,
    directCostSourceClass: 'incomplete_or_unknown' as const,
    priceLineageDigests: [] as string[],
    fullArmCostUsd: null,
    fullCostSourceClass: 'incomplete_or_unknown' as const,
    ordinaryLedgerVerifier: { ...verifierMaterial, resultHash: ordinaryLedgerVerifierHash(verifierMaterial) },
    previousEventHash: decision.eventHash,
  };
  return { ...material, eventHash: causalExecutionV2EventHash(material) };
}

type TerminalMaturity = CausalTerminalOutcomeRecordV2['maturity'];

function validTerminalOutcomeV2(
  protocol: CommittedCausalStudyProtocolV2,
  execution: CausalExecutionRecordV2,
  maturity: TerminalMaturity = 'matured',
  outcomeId = 'outcome:terminal-v2',
): CausalTerminalOutcomeRecordV2 {
  const material: Omit<CausalTerminalOutcomeRecordV2, 'eventHash'> = maturity === 'matured'
    ? {
      type: 'fiscus.causal-terminal-outcome',
      version: 2,
      outcomeId,
      decisionId: execution.decisionId,
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      observedAtMs: execution.completedAtMs + 1,
      maturity,
      qualityValue: 0.9,
      qualityEvidenceClass: protocol.qualityOutcome.evidenceClass,
      economicValueUsd: protocol.question === 'ai_vs_incumbent_net_benefit' ? 1 : null,
      economicEvidenceClass: protocol.economicOutcome?.evidenceClass ?? null,
      outcomeEvidenceDigests: [D('e')],
      censoredReason: null,
      invalidReason: null,
      previousEventHash: execution.eventHash,
    }
    : {
      type: 'fiscus.causal-terminal-outcome',
      version: 2,
      outcomeId,
      decisionId: execution.decisionId,
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      observedAtMs: execution.completedAtMs + 1,
      maturity,
      qualityValue: null,
      qualityEvidenceClass: null,
      economicValueUsd: null,
      economicEvidenceClass: null,
      outcomeEvidenceDigests: [],
      censoredReason: maturity === 'censored' ? 'not_observable' : null,
      invalidReason: maturity === 'invalid' ? 'integrity_failure' : null,
      previousEventHash: execution.eventHash,
    };
  return { ...material, eventHash: causalTerminalOutcomeV2EventHash(material) };
}

type TerminalOutcomeMethod = (record: unknown) => 'created' | 'existing';

function terminalOutcomeMethod(store: Store): TerminalOutcomeMethod {
  const method = (store as unknown as { appendCausalTerminalOutcomeV2?: TerminalOutcomeMethod }).appendCausalTerminalOutcomeV2;
  assert.equal(typeof method, 'function', 'Store must expose the internal v2 terminal outcome operation');
  if (typeof method !== 'function') throw new Error('internal v2 terminal outcome operation is unavailable');
  return method.bind(store);
}

interface QualificationFixture {
  protocol: CommittedCausalStudyProtocolV2;
  decisions: Array<{
    decisionId: string;
    assignedAtMs: number;
    assignedArmId: string;
    eventHash: string;
  }>;
  executions: CausalExecutionRecordV2[];
  outcomes: CausalTerminalOutcomeRecordV2[];
}

/** Build evidence through the Store mutation boundaries for qualification tests. */
function populateQualificationStudy(
  store: Store,
  studyId: string,
  options: {
    appendExecutions?: boolean;
    maturities?: Array<TerminalMaturity | undefined> | null
      | ((decision: { decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string }, index: number) => TerminalMaturity | undefined);
    protocol?: CommittedCausalStudyProtocolV2;
  } = {},
): QualificationFixture {
  const protocol = options.protocol ?? v2StoreProtocol(studyId);
  assert.equal(store.registerCausalProtocol(protocol), 'created');
  const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId });
  const decisions = assignment.block.decisions as Array<{
    decisionId: string;
    assignedAtMs: number;
    assignedArmId: string;
    eventHash: string;
  }>;
  const executions: CausalExecutionRecordV2[] = [];
  const outcomes: CausalTerminalOutcomeRecordV2[] = [];
  const appendExecution = executionMethod(store);
  const appendOutcome = terminalOutcomeMethod(store);
  const appendExecutions = options.appendExecutions ?? true;
  const maturities = options.maturities === undefined
    ? decisions.map(() => 'matured' as const)
    : options.maturities;
  for (const [index, decision] of decisions.entries()) {
    const incompleteExecution = validExecutionV2(protocol, decision, 'execution:qualification-matrix-' + index);
    const executionMaterial = {
      ...incompleteExecution,
      directAiCostUsd: 1,
      directCostSourceClass: 'actual_observed' as const,
      priceLineageDigests: [D('c')],
    };
    const execution = {
      ...executionMaterial,
      eventHash: causalExecutionV2EventHash(executionMaterial),
    };
    if (appendExecutions) {
      assert.equal(appendExecution(execution), 'created');
      executions.push(execution);
       const maturity = typeof maturities === 'function'
         ? maturities(decision, index)
         : maturities?.[index];
      if (maturity) {
        let outcome = validTerminalOutcomeV2(
          protocol,
          execution,
          maturity,
          'outcome:qualification-matrix-' + index,
        );
        if (outcome.maturity === 'censored' && Object.hasOwn(protocol, 'followUpWindowMs')) {
          const observedAtMs = execution.completedAtMs + protocol.followUpWindowMs!;
          const material = { ...outcome, observedAtMs };
          const { eventHash: _eventHash, ...eventMaterial } = material;
          outcome = { ...material, eventHash: causalTerminalOutcomeV2EventHash(eventMaterial) };
        }
        assert.equal(appendOutcome(outcome), 'created');
        outcomes.push(outcome);
      }
    }
  }
  return { protocol, decisions, executions, outcomes };
}

test('v2 qualification remains source-internal and has no raw snapshot issuer surface', async () => {
  assert.equal(Object.hasOwn(qualificationModule, 'issueAuthenticatedCausalStudyV2'), false);
  assert.equal(Object.hasOwn(qualificationModule, 'qualifyCausalStudyV2'), false);
  assert.equal(typeof (Store.prototype as unknown as { causalQualificationV2?: unknown }).causalQualificationV2, 'undefined');
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    exports?: Record<string, string>;
    name?: string;
  };
  assert.deepEqual(packageJson.exports, { './package.json': './package.json' });
  if (packageJson.name) {
    for (const specifier of [
      packageJson.name,
      packageJson.name + '/store/db.js',
      packageJson.name + '/dist/store/causal.js',
    ]) {
      await assert.rejects(import(specifier), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
        return true;
      });
    }
  }
});

test('v2 qualification remains inconclusive when positive cost claims have unresolved ledger verification', () => {
  const store = new Store(':memory:');
  try {
    const fixture = populateQualificationStudy(store, 'study:qualification-unresolved-ledger');
    const result = causalQualificationV2(store.raw(), fixture.protocol.studyId);
    assert.equal(result.state, 'inconclusive', result.reasons.join('; '));
    assert.match(result.reasons.join('; '), /ordinary ledger.*unresolved|task4_not_implemented/i);
  } finally {
    store.close();
  }
});

test('Store-authoritative v2 qualification reports zero assignments as collecting with zero counts', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol('study:qualification-zero');
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const result = causalQualificationV2(store.raw(), protocol.studyId);
    assert.equal(result.state, 'collecting');
    assert.deepEqual(result.countsByArm, {
      'arm:candidate': { assigned: 0, pending: 0, completed: 0, censored: 0, invalid: 0 },
      'arm:control': { assigned: 0, pending: 0, completed: 0, censored: 0, invalid: 0 },
    });
  } finally {
    store.close();
  }
});

test('Store-authoritative v2 qualification preserves absent execution and outcome as collecting pending evidence', () => {
  const noExecution = new Store(':memory:');
  try {
    const fixture = populateQualificationStudy(noExecution, 'study:qualification-no-execution', { appendExecutions: false });
    const result = causalQualificationV2(noExecution.raw(), fixture.protocol.studyId);
    assert.equal(result.state, 'collecting');
    assert.deepEqual(Object.values(result.countsByArm).map((count) => [count.assigned, count.pending, count.completed, count.censored, count.invalid]), [
      [2, 2, 0, 0, 0],
      [2, 2, 0, 0, 0],
    ]);
    assert.equal(tableCount(noExecution, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    noExecution.close();
  }

  const noOutcome = new Store(':memory:');
  try {
    const fixture = populateQualificationStudy(noOutcome, 'study:qualification-no-outcome', { maturities: null });
    const result = causalQualificationV2(noOutcome.raw(), fixture.protocol.studyId);
    assert.equal(result.state, 'collecting');
    assert.deepEqual(Object.values(result.countsByArm).map((count) => [count.assigned, count.pending, count.completed, count.censored, count.invalid]), [
      [2, 2, 0, 0, 0],
      [2, 2, 0, 0, 0],
    ]);
    assert.equal(tableCount(noOutcome, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    noOutcome.close();
  }
});

test('legacy V2 censoring is structurally invalid and never counted as missingness', () => {
  const store = new Store(':memory:');
  try {
    const fixture = populateQualificationStudy(store, 'study:qualification-legacy-censor', {
      maturities: null,
    });
    const censoredExecution = fixture.executions[0]!;
    const censoredOutcome = validTerminalOutcomeV2(
      fixture.protocol,
      censoredExecution,
      'censored',
      'outcome:qualification-legacy-censor',
    );
    store.raw().prepare(
      'INSERT INTO causal_terminal_outcomes_v2 ' +
      '(outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, maturity, previous_event_hash, event_hash, terminal_outcome_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      censoredOutcome.outcomeId,
      censoredOutcome.decisionId,
      censoredOutcome.studyId,
      censoredOutcome.protocolHash,
      censoredOutcome.observedAtMs,
      censoredOutcome.maturity,
      censoredOutcome.previousEventHash,
      censoredOutcome.eventHash,
      canonicalJson(censoredOutcome),
    );
    const result = causalQualificationV2(store.raw(), fixture.protocol.studyId);
    const censoredArm = fixture.decisions[0]!.assignedArmId;
    assert.equal(result.state, 'invalid');
    assert.equal(result.countsByArm[censoredArm]?.censored, 0);
    assert.equal(result.countsByArm[censoredArm]?.invalid, 1);
    assert.match(result.reasons.join('; '), /censored.*unsupported|invalid terminal/i);
  } finally {
    store.close();
  }
});

test('legacy V2 censoring is refused at the Store append boundary', () => {
  const store = new Store(':memory:');
  try {
    const fixture = populateQualificationStudy(store, 'study:append-legacy-censor', { maturities: null });
    const execution = fixture.executions[0]!;
    const outcome = validTerminalOutcomeV2(
      fixture.protocol,
      execution,
      'censored',
      'outcome:append-legacy-censor',
    );
    assert.throws(
      () => terminalOutcomeMethod(store)(outcome),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
        assert.equal(error.message, 'CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid');
        assert.doesNotMatch(error.message, /sqlite|SQLITE|outcome:append-legacy-censor/i);
        return true;
      },
    );
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    store.close();
  }
});

test('policy-bearing V2 censors enforce deadline, observation, replay, and zero-row rollback', () => {
  const initialWallClock = 1_700_000_001_000;
  withWallClock(initialWallClock, () => {
    const store = new Store(':memory:');
    try {
      const protocol = policyV2StoreProtocol('study:policy-append-boundary');
      assert.equal(store.registerCausalProtocol(protocol), 'created');
      const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId: protocol.studyId });
      const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
        decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
      };
      const execution = validExecutionV2(protocol, decision, 'execution:policy-append-boundary');
      assert.equal(executionMethod(store)(execution), 'created');
      const deadlineMs = execution.completedAtMs + protocol.followUpWindowMs!;
      const reobserve = (outcome: CausalTerminalOutcomeRecordV2, observedAtMs: number): CausalTerminalOutcomeRecordV2 => {
        const material = { ...outcome, observedAtMs };
        const { eventHash: _eventHash, ...eventMaterial } = material;
        return { ...material, eventHash: causalTerminalOutcomeV2EventHash(eventMaterial) };
      };
      const append = terminalOutcomeMethod(store);

      const preDeadline = reobserve(
        validTerminalOutcomeV2(protocol, execution, 'censored', 'outcome:policy-pre-deadline'),
        deadlineMs - 1,
      );
      withWallClock(deadlineMs - 1, () => {
        assert.throws(() => append(preDeadline), /CAUSAL_RECORD_INVALID/);
      });
      assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
      assert.equal(
        (store.raw().prepare('SELECT last_wall_ms FROM causal_clock_state').get() as { last_wall_ms: number }).last_wall_ms,
        initialWallClock,
        'a rejected append must roll back the captured wall-time floor',
      );

      const futureObserved = reobserve(
        validTerminalOutcomeV2(protocol, execution, 'censored', 'outcome:policy-future-observed'),
        deadlineMs + 1,
      );
      withWallClock(deadlineMs, () => {
        assert.throws(() => append(futureObserved), /CAUSAL_RECORD_INVALID/);
      });
      assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
      assert.equal(
        (store.raw().prepare('SELECT last_wall_ms FROM causal_clock_state').get() as { last_wall_ms: number }).last_wall_ms,
        initialWallClock,
        'a second rejected append must leave the floor unchanged',
      );

      const atDeadline = reobserve(
        validTerminalOutcomeV2(protocol, execution, 'censored', 'outcome:policy-at-deadline'),
        deadlineMs,
      );
      withWallClock(deadlineMs, () => assert.equal(append(atDeadline), 'created'));
      assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 1);
      withWallClock(deadlineMs + 1, () => assert.equal(append(atDeadline), 'existing'));
      assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 1);

      const afterDeadline = reobserve(
        validTerminalOutcomeV2(protocol, execution, 'censored', 'outcome:policy-after-deadline'),
        deadlineMs + 1,
      );
      withWallClock(deadlineMs + 1, () => assert.throws(() => append(afterDeadline), /CAUSAL_IMMUTABLE_CONFLICT/));
      assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 1);
    } finally {
      store.close();
    }
  });
});

test('policy-bearing qualification counts post-deadline censors and allows exact missingness equality', () => {
  const store = new Store(':memory:');
  try {
    const protocol = policyV2StoreProtocol('study:qualification-policy-equality', 12, 1_000, 0.5);
    const censoredArms = new Set<string>();
    const fixture = populateQualificationStudy(store, protocol.studyId, {
      protocol,
      maturities: (decision) => {
        if (censoredArms.has(decision.assignedArmId)) return 'matured';
        censoredArms.add(decision.assignedArmId);
        return 'censored';
      },
    });
    const result = causalQualificationV2(store.raw(), protocol.studyId);
    assert.equal(result.state, 'inconclusive', result.reasons.join('; '));
    for (const count of Object.values(result.countsByArm)) {
      assert.equal(count.assigned, 2);
      assert.equal(count.completed, 1);
      assert.equal(count.censored, 1);
      assert.equal(count.invalid, 0);
      assert.equal(count.pending, 0);
    }
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), fixture.outcomes.length);
  } finally {
    store.close();
  }
});

test('policy-bearing qualification rejects missingness greater than the committed ceiling', () => {
  const store = new Store(':memory:');
  try {
    const protocol = policyV2StoreProtocol('study:qualification-policy-over-ceiling', 12, 1_000, 0.25);
    const censoredArms = new Set<string>();
    const fixture = populateQualificationStudy(store, protocol.studyId, {
      protocol,
      maturities: (decision) => {
        if (censoredArms.has(decision.assignedArmId)) return 'matured';
        censoredArms.add(decision.assignedArmId);
        return 'censored';
      },
    });
    const result = causalQualificationV2(store.raw(), protocol.studyId);
    assert.equal(result.state, 'invalid', result.reasons.join('; '));
    assert.match(result.reasons.join('; '), /missingness exceeds/i);
    for (const count of Object.values(result.countsByArm)) {
      assert.equal(count.assigned, 2);
      assert.equal(count.completed, 1);
      assert.equal(count.censored, 1);
      assert.equal(count.invalid, 0);
      assert.equal(count.pending, 0);
    }
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), fixture.outcomes.length);
  } finally {
    store.close();
  }
});

test('policy-bearing qualification rejects retained pre-deadline and future-dated censors as integrity failures', () => {
  const deadlineMs = 1_700_000_002_002;
  for (const scenario of [
    { label: 'pre-deadline', setupNow: deadlineMs + 10, readNow: deadlineMs + 10, observedAtMs: deadlineMs - 1 },
    { label: 'future-dated', setupNow: deadlineMs, readNow: deadlineMs, observedAtMs: deadlineMs + 1 },
  ]) {
    const store = withWallClock(scenario.setupNow, () => {
      const value = new Store(':memory:');
      const protocol = policyV2StoreProtocol('study:qualification-policy-' + scenario.label);
      assert.equal(value.registerCausalProtocol(protocol), 'created');
      const assignment = assignmentMethod(value)({
        ...assignmentRequest('block:qualification-policy-' + scenario.label),
        studyId: protocol.studyId,
      });
      const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
        decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
      };
      const execution = validExecutionV2(protocol, decision, 'execution:qualification-policy-' + scenario.label);
      assert.equal(execution.completedAtMs + protocol.followUpWindowMs!, deadlineMs);
      assert.equal(executionMethod(value)(execution), 'created');
      const baseOutcome = validTerminalOutcomeV2(
        protocol,
        execution,
        'censored',
        'outcome:qualification-policy-' + scenario.label,
      );
      const material = { ...baseOutcome, observedAtMs: scenario.observedAtMs };
      const { eventHash: _eventHash, ...eventMaterial } = material;
      const outcome = { ...material, eventHash: causalTerminalOutcomeV2EventHash(eventMaterial) };
      value.raw().prepare(
        'INSERT INTO causal_terminal_outcomes_v2 ' +
        '(outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, maturity, previous_event_hash, event_hash, terminal_outcome_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ',
      ).run(
        outcome.outcomeId,
        outcome.decisionId,
        outcome.studyId,
        outcome.protocolHash,
        outcome.observedAtMs,
        outcome.maturity,
        outcome.previousEventHash,
        outcome.eventHash,
        canonicalJson(outcome),
      );
      return value;
    });
    try {
      withWallClock(scenario.readNow, () => assert.throws(
        () => causalQualificationV2(store.raw(), 'study:qualification-policy-' + scenario.label),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
          assert.match(error.message, /^CAUSAL_INTEGRITY_FAILURE: /);
          assert.doesNotMatch(error.message, /pre-deadline|future-dated|sqlite|outcome:qualification-policy/i);
          return true;
        },
      ));
    } finally {
      store.close();
    }
  }
});

test('policy-bearing qualification keeps absence pending after deadline and gives structural invalid precedence over pending', () => {
  const pending = new Store(':memory:');
  try {
    const protocol = policyV2StoreProtocol('study:qualification-policy-pending', 12, 1, 0.5);
    const fixture = populateQualificationStudy(pending, protocol.studyId, {
      protocol,
      maturities: null,
    });
    const result = causalQualificationV2(pending.raw(), protocol.studyId);
    assert.equal(result.state, 'collecting');
    assert.equal(result.reasons.some((reason) => /collecting|pending/i.test(reason)), true);
    assert.equal(tableCount(pending, 'causal_terminal_outcomes_v2'), 0);
    assert.equal(fixture.executions.length, 4);
  } finally {
    pending.close();
  }

  const precedence = new Store(':memory:');
  try {
    const protocol = policyV2StoreProtocol('study:qualification-policy-precedence', 12, 1_000, 0.5);
    const fixture = populateQualificationStudy(precedence, protocol.studyId, {
      protocol,
      maturities: ['invalid', undefined, 'matured', 'matured'],
    });
    const result = causalQualificationV2(precedence.raw(), protocol.studyId);
    const invalidArm = fixture.decisions[0]!.assignedArmId;
    const pendingArm = fixture.decisions[1]!.assignedArmId;
    assert.equal(result.state, 'invalid');
    assert.equal(result.countsByArm[invalidArm]?.invalid, 1);
    assert.equal(result.countsByArm[pendingArm]?.pending, 1);
  } finally {
    precedence.close();
  }
});

test('causal clock floor initializes exactly once, rejects rollback, accepts forward jumps, and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-clock-floor-'));
  const dbPath = join(dir, 'clock.sqlite');
  const initialWallClock = 1_700_000_001_000;
  let protocol: CommittedCausalStudyProtocolV2;
  let firstOutcome: CausalTerminalOutcomeRecordV2;
  let secondExecution: CausalExecutionRecordV2;
  let deadlineMs: number;
  try {
    withWallClock(initialWallClock, () => {
      const store = new Store(dbPath);
      try {
        const clockRows = store.raw().prepare(
          'SELECT clock_id, last_wall_ms FROM causal_clock_state',
        ).all() as Array<{ clock_id: string; last_wall_ms: number }>;
        assert.equal(clockRows.length, 1);
        assert.equal(clockRows[0]?.clock_id, 'causal-v2');
        assert.equal(clockRows[0]?.last_wall_ms, initialWallClock);
        protocol = policyV2StoreProtocol('study:clock-floor-restart');
        assert.equal(store.registerCausalProtocol(protocol), 'created');
        const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId: protocol.studyId });
        const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
          decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
        };
        const execution = validExecutionV2(protocol, decision, 'execution:clock-floor-first');
        assert.equal(executionMethod(store)(execution), 'created');
        deadlineMs = execution.completedAtMs + protocol.followUpWindowMs!;
        const material = { ...validTerminalOutcomeV2(protocol, execution, 'censored', 'outcome:clock-floor-first'), observedAtMs: deadlineMs };
        const { eventHash: _eventHash, ...eventMaterial } = material;
        firstOutcome = { ...material, eventHash: causalTerminalOutcomeV2EventHash(eventMaterial) };
        withWallClock(deadlineMs, () => assert.equal(terminalOutcomeMethod(store)(firstOutcome), 'created'));
        const floor = store.raw().prepare('SELECT last_wall_ms FROM causal_clock_state').get() as { last_wall_ms: number };
        assert.equal(floor.last_wall_ms, deadlineMs);
      } finally {
        store.close();
      }
    });

    withWallClock(deadlineMs! - 1, () => {
      const restarted = new Store(dbPath);
      try {
        assert.throws(
          () => terminalOutcomeMethod(restarted)(firstOutcome!),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
            assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 terminal outcome failed integrity verification');
            assert.doesNotMatch(error.message, /clock|sqlite|outcome:clock-floor-first/i);
            return true;
          },
        );
        assert.equal(tableCount(restarted, 'causal_terminal_outcomes_v2'), 1);
        assert.equal((restarted.raw().prepare('SELECT last_wall_ms FROM causal_clock_state').get() as { last_wall_ms: number }).last_wall_ms, deadlineMs);
      } finally {
        restarted.close();
      }
    });

    withWallClock(deadlineMs! + 10, () => {
      const forward = new Store(dbPath);
      try {
        assert.equal(terminalOutcomeMethod(forward)(firstOutcome!), 'existing');
        const secondAssignment = assignmentMethod(forward)({
          ...assignmentRequest('block:clock-floor-second', ['5', '6', '7', '8']),
          studyId: protocol!.studyId,
        });
        const decision = secondAssignment.block.decisions[0]! as typeof secondAssignment.block.decisions[number] & {
          decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
        };
        secondExecution = validExecutionV2(protocol!, decision, 'execution:clock-floor-second');
        assert.equal(executionMethod(forward)(secondExecution), 'created');
        const material = { ...validTerminalOutcomeV2(protocol!, secondExecution, 'censored', 'outcome:clock-floor-second'), observedAtMs: deadlineMs! + 10 };
        const { eventHash: _eventHash, ...eventMaterial } = material;
        const secondOutcome = { ...material, eventHash: causalTerminalOutcomeV2EventHash(eventMaterial) };
        assert.equal(terminalOutcomeMethod(forward)(secondOutcome), 'created');
        assert.equal((forward.raw().prepare('SELECT last_wall_ms FROM causal_clock_state').get() as { last_wall_ms: number }).last_wall_ms, deadlineMs! + 10);
      } finally {
        forward.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('causal qualification fails closed when the persisted clock floor is missing or duplicated', () => {
  const store = new Store(':memory:');
  try {
    const fixture = populateQualificationStudy(store, 'study:clock-corruption-append', { maturities: null });
    const validOutcome = validTerminalOutcomeV2(
      fixture.protocol,
      fixture.executions[0]!,
      'matured',
      'outcome:clock-corruption-append',
    );
    store.raw().prepare('DELETE FROM causal_clock_state').run();
    assert.throws(
      () => terminalOutcomeMethod(store)(validOutcome),
      /CAUSAL_INTEGRITY_FAILURE/,
      'append must fail closed when the persisted clock row is missing',
    );
    assert.throws(
      () => causalQualificationV2(store.raw(), fixture.protocol.studyId),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
        assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 qualification evidence failed integrity verification');
        assert.doesNotMatch(error.message, /clock|sqlite|causal_clock_state/i);
        return true;
      },
    );
    store.raw().prepare("INSERT INTO causal_clock_state (clock_id, last_wall_ms) VALUES (NULL, 0)").run();
    assert.throws(
      () => terminalOutcomeMethod(store)(validOutcome),
      /CAUSAL_INTEGRITY_FAILURE/,
      'append must fail closed when the persisted clock identity is corrupt',
    );
    assert.throws(() => causalQualificationV2(store.raw(), fixture.protocol.studyId), /CAUSAL_INTEGRITY_FAILURE/);
  } finally {
    store.close();
  }
});

test('multiple Store handles serialize terminal replay and preserve one monotonic floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-clock-handles-'));
  const dbPath = join(dir, 'clock-handles.sqlite');
  const initialWallClock = 1_700_000_001_000;
  withWallClock(initialWallClock, () => {
    const first = new Store(dbPath);
    const second = new Store(dbPath);
    try {
      const protocol = policyV2StoreProtocol('study:clock-handles');
      assert.equal(first.registerCausalProtocol(protocol), 'created');
      const assignment = assignmentMethod(first)({
        ...assignmentRequest('block:clock-handles'),
        studyId: protocol.studyId,
      });
      const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
        decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
      };
      const execution = validExecutionV2(protocol, decision, 'execution:clock-handles');
      assert.equal(executionMethod(first)(execution), 'created');
      const deadlineMs = execution.completedAtMs + protocol.followUpWindowMs!;
      const material = {
        ...validTerminalOutcomeV2(protocol, execution, 'censored', 'outcome:clock-handles'),
        observedAtMs: deadlineMs,
      };
      const { eventHash: _eventHash, ...eventMaterial } = material;
      const outcome = { ...material, eventHash: causalTerminalOutcomeV2EventHash(eventMaterial) };
      withWallClock(deadlineMs, () => {
        assert.equal(terminalOutcomeMethod(second)(outcome), 'created');
        assert.equal(terminalOutcomeMethod(first)(outcome), 'existing');
      });
      assert.equal(tableCount(first, 'causal_terminal_outcomes_v2'), 1);
      assert.equal(tableCount(second, 'causal_terminal_outcomes_v2'), 1);
      assert.equal(
        (first.raw().prepare('SELECT last_wall_ms FROM causal_clock_state').get() as { last_wall_ms: number }).last_wall_ms,
        deadlineMs,
      );
      assert.equal(
        (second.raw().prepare('SELECT last_wall_ms FROM causal_clock_state').get() as { last_wall_ms: number }).last_wall_ms,
        deadlineMs,
      );
    } finally {
      second.close();
      first.close();
    }
  });
  rmSync(dir, { recursive: true, force: true });
});

test('policy deadline overflow at MAX_SAFE_INTEGER fails closed for append and qualification', () => {
  const overflowCompletedAtMs = Number.MAX_SAFE_INTEGER - 500;
  const wallClock = overflowCompletedAtMs + 100;
  const base = policyV2StoreProtocol('study:policy-deadline-overflow', 4, 1_000);
  const {
    lifecycle: _lifecycle,
    committedAtMs: _committedAtMs,
    protocolHash: _protocolHash,
    ...draftBase
  } = base;
  const protocol = commitCausalProtocol({
    ...draftBase,
    studyWindow: { startsAtMs: overflowCompletedAtMs - 2, endsAtMs: null },
  } as CausalStudyProtocolDraftV2, base.committedAtMs) as CommittedCausalStudyProtocolV2;
  withWallClock(wallClock, () => {
    const store = new Store(':memory:');
    try {
      assert.equal(store.registerCausalProtocol(protocol), 'created');
      const assignment = assignmentMethod(store)({
        ...assignmentRequest('block:policy-deadline-overflow'),
        studyId: protocol.studyId,
        createdAtMs: overflowCompletedAtMs - 2,
      });
      const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
        decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
      };
      const execution = validExecutionV2(protocol, decision, 'execution:policy-deadline-overflow');
      assert.equal(execution.completedAtMs, overflowCompletedAtMs);
      assert.equal(executionMethod(store)(execution), 'created');
      const outcome = validTerminalOutcomeV2(protocol, execution, 'matured', 'outcome:policy-deadline-overflow');
      assert.throws(
        () => terminalOutcomeMethod(store)(outcome),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
          assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 terminal outcome failed integrity verification');
          assert.doesNotMatch(error.message, /MAX_SAFE|overflow|follow-up|sqlite|execution:policy-deadline-overflow/i);
          return true;
        },
      );
      assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
      assert.throws(
        () => causalQualificationV2(store.raw(), protocol.studyId),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
          assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 qualification evidence failed integrity verification');
          assert.doesNotMatch(error.message, /MAX_SAFE|overflow|follow-up|sqlite|execution:policy-deadline-overflow/i);
          return true;
        },
      );
    } finally {
      store.close();
    }
  });
});

test('V1 protocol is non-applicable to the V2 qualification reader and has no fallback', () => {
  const store = new Store(':memory:');
  try {
    const protocol = commitCausalProtocol({ ...protocolDraft(), studyId: 'study:qualification-v1' }, 1_700_000_000_100);
    store.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
    assert.throws(
      () => causalQualificationV2(store.raw(), protocol.studyId),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
        assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 qualification evidence failed integrity verification');
        return true;
      },
    );
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    store.close();
  }
});

test('Store-internal v2 qualification reads the complete manifested study and rejects a truncated decision lane', () => {
  const populateCompleteStudy = (store: Store, studyId: string): CommittedCausalStudyProtocolV2 => {
    const protocol = v2StoreProtocol(studyId);
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId });
    const appendExecution = executionMethod(store);
    const appendOutcome = terminalOutcomeMethod(store);
    for (const [index, decisionValue] of assignment.block.decisions.entries()) {
      const decision = decisionValue as typeof assignment.block.decisions[number] & {
        decisionId: string;
        assignedAtMs: number;
        eventHash: string;
      };
      const incompleteExecution = validExecutionV2(protocol, decision, 'execution:qualification-reader-' + index);
      const executionMaterial = {
        ...incompleteExecution,
        directAiCostUsd: 1,
        directCostSourceClass: 'actual_observed' as const,
        priceLineageDigests: [D('c')],
      };
      const execution = {
        ...executionMaterial,
        eventHash: causalExecutionV2EventHash(executionMaterial),
      };
      assert.equal(appendExecution(execution), 'created');
      assert.equal(
        appendOutcome(validTerminalOutcomeV2(protocol, execution, 'matured', 'outcome:qualification-reader-' + index)),
        'created',
      );
    }
    return protocol;
  };

  const complete = new Store(':memory:');
  try {
    const protocol = populateCompleteStudy(complete, 'study:qualification-reader');
    const result = causalQualificationV2(complete.raw(), protocol.studyId) as {
      studyId: string;
      protocolHash: string;
      state: string;
      reasons: string[];
      countsByArm: Record<string, {
        assigned: number;
        pending: number;
        completed: number;
        censored: number;
        invalid: number;
      }>;
      estimate?: unknown;
      claim?: unknown;
    };
    assert.equal(result.studyId, protocol.studyId);
    assert.equal(result.protocolHash, protocol.protocolHash);
    assert.equal(result.state, 'inconclusive', result.reasons.join('; '));
    assert.match(result.reasons.join('; '), /ordinary ledger.*unresolved/i);
    assert.deepEqual(result.countsByArm, {
      'arm:candidate': { assigned: 2, pending: 0, completed: 2, censored: 0, invalid: 0 },
      'arm:control': { assigned: 2, pending: 0, completed: 2, censored: 0, invalid: 0 },
    });
    assert.equal(result.estimate, undefined, 'qualification reader must not create an estimate');
    assert.equal(result.claim, undefined, 'qualification reader must not create a claim');

    const truncated = new Store(':memory:');
    try {
      const truncatedProtocol = populateCompleteStudy(truncated, 'study:qualification-reader-truncated');
      const decisionToDelete = truncated.raw().prepare(
        'SELECT decision_id FROM causal_decisions_v2 WHERE study_id = ? ORDER BY block_sequence, decision_index LIMIT 1',
      ).get(truncatedProtocol.studyId) as { decision_id: string };
      dropV2ImmutabilityTriggers(truncated.raw());
      truncated.raw().prepare('DELETE FROM causal_decisions_v2 WHERE decision_id = ?').run(decisionToDelete.decision_id);
      restoreV2ImmutabilityTriggers(truncated.raw());
      assert.equal(causalV2SchemaComplete(truncated.raw()), true, 'schema authority must be restored before the manifest test');
      assert.throws(
        () => causalQualificationV2(truncated.raw(), truncatedProtocol.studyId),
        /CAUSAL_INTEGRITY_FAILURE/,
        'a manifest/cardinality mismatch must fail closed as integrity failure',
      );
    } finally {
      truncated.close();
    }
  } finally {
    complete.close();
  }
});

test('Store-authoritative v2 qualification rejects duplicate, orphan, cross-study, wrong-protocol, and corrupted evidence', () => {
  const duplicateCases: Array<{
    label: string;
    table: 'causal_executions_v2' | 'causal_terminal_outcomes_v2';
  }> = [
    { label: 'duplicate execution topology', table: 'causal_executions_v2' },
    { label: 'duplicate terminal topology', table: 'causal_terminal_outcomes_v2' },
  ];
  for (const duplicateCase of duplicateCases) {
    const store = new Store(':memory:');
    try {
      const fixture = populateQualificationStudy(store, 'study:qualification-' + duplicateCase.table);
      const duplicateDb = duplicateQualificationRows(store, duplicateCase.table);
      expectCausalIntegrityFailure(
        () => causalQualificationV2(duplicateDb, fixture.protocol.studyId),
        duplicateCase.label,
      );
    } finally {
      store.close();
    }
  }

  const orphanExecution = new Store(':memory:');
  try {
    const fixture = populateQualificationStudy(orphanExecution, 'study:qualification-orphan-execution', { appendExecutions: false });
    const decision = fixture.decisions[0]!;
    const orphan = validExecutionV2(
      fixture.protocol,
      { ...decision, decisionId: 'decision:orphan', eventHash: D('p') },
      'execution:orphan',
    );
    insertRawExecutionV2(orphanExecution, orphan);
    expectCausalIntegrityFailure(
      () => causalQualificationV2(orphanExecution.raw(), fixture.protocol.studyId),
      'orphan execution row',
    );
  } finally {
    orphanExecution.close();
  }

  const orphanTerminal = new Store(':memory:');
  try {
    const fixture = populateQualificationStudy(orphanTerminal, 'study:qualification-orphan-terminal', { appendExecutions: false });
    const decision = fixture.decisions[0]!;
    const predecessor = validExecutionV2(
      fixture.protocol,
      { ...decision, decisionId: 'decision:orphan-terminal', eventHash: D('q') },
      'execution:orphan-terminal',
    );
    insertRawTerminalOutcomeV2(
      orphanTerminal,
      validTerminalOutcomeV2(fixture.protocol, predecessor, 'matured', 'outcome:orphan-terminal'),
    );
    expectCausalIntegrityFailure(
      () => causalQualificationV2(orphanTerminal.raw(), fixture.protocol.studyId),
      'orphan terminal row',
    );
  } finally {
    orphanTerminal.close();
  }

  for (const [label, corrupt] of [
    ['cross-study execution link', 'execution'] as const,
    ['wrong-protocol execution link', 'execution'] as const,
    ['cross-study terminal link', 'terminal'] as const,
    ['wrong-protocol terminal link', 'terminal'] as const,
  ]) {
    const store = new Store(':memory:');
    try {
      const fixture = populateQualificationStudy(store, 'study:qualification-' + label.replace(/[^a-z]+/g, '-'), {
        ...(corrupt === 'terminal' ? { maturities: null } : { appendExecutions: false }),
      });
      const decision = fixture.decisions[0]!;
      if (corrupt === 'execution') {
        const base = validExecutionV2(fixture.protocol, decision, 'execution:' + label.replace(/[^a-z]+/g, '-'));
        const changed = {
          ...base,
          ...(label.startsWith('cross') ? { studyId: 'study:foreign' } : { protocolHash: D('f') }),
        };
        insertRawExecutionV2(store, { ...changed, eventHash: causalExecutionV2EventHash(changed) });
      } else {
        const execution = fixture.executions[0]!;
        const base = validTerminalOutcomeV2(
          fixture.protocol,
          execution,
          'matured',
          'outcome:' + label.replace(/[^a-z]+/g, '-'),
        );
        const changed = {
          ...base,
          ...(label.startsWith('cross') ? { studyId: 'study:foreign' } : { protocolHash: D('f') }),
        };
        insertRawTerminalOutcomeV2(store, { ...changed, eventHash: causalTerminalOutcomeV2EventHash(changed) });
      }
      expectCausalIntegrityFailure(
        () => causalQualificationV2(store.raw(), fixture.protocol.studyId),
        label,
      );
    } finally {
      store.close();
    }
  }

  for (const [label, mutation] of [
    ['canonical terminal JSON corruption', (store: Store, fixture: QualificationFixture) => {
      dropV2UpdateTrigger(store.raw(), 'causal_terminal_outcomes_v2');
      store.raw().prepare('UPDATE causal_terminal_outcomes_v2 SET terminal_outcome_json = ? WHERE outcome_id = ?')
        .run('{"maturity":"matured"}', fixture.outcomes[0]!.outcomeId);
      restoreV2UpdateTrigger(store.raw(), 'causal_terminal_outcomes_v2');
    }],
    ['physical terminal identity corruption', (store: Store, fixture: QualificationFixture) => {
      dropV2UpdateTrigger(store.raw(), 'causal_terminal_outcomes_v2');
      store.raw().prepare('UPDATE causal_terminal_outcomes_v2 SET event_hash = ? WHERE outcome_id = ?')
        .run(D('f'), fixture.outcomes[0]!.outcomeId);
      restoreV2UpdateTrigger(store.raw(), 'causal_terminal_outcomes_v2');
    }],
  ] as const) {
    const store = new Store(':memory:');
    try {
      const fixture = populateQualificationStudy(store, 'study:qualification-' + label.replace(/[^a-z]+/g, '-'));
      mutation(store, fixture);
      assert.equal(causalV2SchemaComplete(store.raw()), true, label + ' must preserve exact schema authority');
      expectCausalIntegrityFailure(
        () => causalQualificationV2(store.raw(), fixture.protocol.studyId),
        label,
      );
    } finally {
      store.close();
    }
  }
});

test('atomic assignment persistence commits a complete replayable block before disclosure', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assign = assignmentMethod(store);
    const request = assignmentRequest();

    const created = assign(request);
    assert.equal(created.status, 'created');
    assert.equal(created.block.plan.sequence, 1);
    assert.deepEqual(
      [...created.block.decisions.map((decision) => decision.assignedArmId)].sort(),
      ['arm:candidate', 'arm:candidate', 'arm:control', 'arm:control'],
    );
    assert.equal(created.manifest.planCount, 1);
    assert.equal(created.manifest.decisionCount, 4);
    assert.equal(created.manifest.unitCount, 4);
    assert.match(created.manifest.assignmentManifestHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(tableCount(store, 'causal_assignment_plans_v2'), 1);
    assert.equal(tableCount(store, 'causal_decisions_v2'), 4);
    assert.equal(tableCount(store, 'causal_assignment_units_v2'), 4);
    assert.equal(tableCount(store, 'causal_assignment_manifests_v2'), 1);

    const replayed = assign(request);
    assert.equal(replayed.status, 'existing');
    assert.deepEqual(replayed, { ...created, status: 'existing' });
    assert.equal(tableCount(store, 'causal_assignment_manifests_v2'), 1);

    assert.throws(
      () => assign({ ...request, unitIdDigests: [D('5'), D('6'), D('7'), D('8')] }),
      /CAUSAL_IMMUTABLE_CONFLICT|immutable/i,
    );
    assert.throws(
      () => assign({ ...request, sequence: 99 } as never),
      /unsupported|sequence/i,
    );
  } finally {
    store.close();
  }
});

test('atomic assignment persistence backs up the first file migration and a second open is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-migration-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.prepare('CREATE TABLE legacy_probe (value TEXT NOT NULL)').run();
  legacy.prepare('INSERT INTO legacy_probe (value) VALUES (?)').run('retained');
  legacy.close();

  try {
    const first = new Store(dbPath);
    const evidence = (first as unknown as {
      causalMigrationBackupEvidence?: () => { path: string; sha256: string } | null;
    }).causalMigrationBackupEvidence?.();
    try {
      assert.ok(evidence, 'first file-backed v2 migration must report its verified SQLite backup');
      assert.equal(evidence.path.startsWith(dbPath + '.pre-causal-v2-'), true);
      assert.equal(existsSync(evidence.path), true);
      assert.equal(
        evidence.sha256,
        createHash('sha256').update(readFileSync(evidence.path)).digest('hex'),
      );
      const backup = new DatabaseSync(evidence.path, { readOnly: true });
      try {
        const quickCheck = backup.prepare('PRAGMA quick_check').get() as { quick_check: string };
        const retained = backup.prepare('SELECT value FROM legacy_probe').get() as { value: string };
        assert.equal(quickCheck.quick_check, 'ok');
        assert.equal(retained.value, 'retained');
      } finally {
        backup.close();
      }
      assert.equal((first.raw().prepare('SELECT value FROM legacy_probe').get() as { value: string }).value, 'retained');
      assert.equal(tableCount(first, 'causal_assignment_plans_v2'), 0);
    } finally {
      first.close();
    }

    const second = new Store(dbPath);
    try {
      assert.equal(second.causalMigrationBackupEvidence(), null);
      assert.equal((second.raw().prepare('SELECT value FROM legacy_probe').get() as { value: string }).value, 'retained');
      assert.equal(tableCount(second, 'causal_assignment_plans_v2'), 0);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('global study unit uniqueness holds across Store connections without consuming sequence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-unit-'));
  const dbPath = join(dir, 'ledger.sqlite');
  const first = new Store(dbPath);
  const second = new Store(dbPath);
  try {
    first.registerCausalProtocol(v2StoreProtocol());
    const firstResult = assignmentMethod(first)(assignmentRequest());
    assert.equal(firstResult.block.plan.sequence, 1);
    assert.throws(
      () => assignmentMethod(second)(assignmentRequest('block:store-b', ['4', '5', '6', '7'])),
      /CAUSAL_UNIT_ALREADY_ASSIGNED|already assigned|unique/i,
    );
    const secondResult = assignmentMethod(second)(assignmentRequest('block:store-c', ['5', '6', '7', '8']));
    assert.equal(secondResult.block.plan.sequence, 2);
    assert.equal(tableCount(first, 'causal_assignment_plans_v2'), 2);
    assert.equal(tableCount(first, 'causal_assignment_units_v2'), 8);
  } finally {
    second.close();
    first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function runAssignmentProcess(dbPath: string, request: ReturnType<typeof assignmentRequest>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const storeUrl = pathToFileURL(resolve('src/store/db.ts')).href;
  const source = [
    `import { Store } from ${JSON.stringify(storeUrl)}`,
    `const store = new Store(${JSON.stringify(dbPath)})`,
    'try {',
    `  const result = store.assignCausalBlockV2(${JSON.stringify(request)})`,
    "  process.stdout.write(JSON.stringify({ status: result.status, sequence: result.block.plan.sequence }))",
    '} catch (error) {',
    "  process.stderr.write(error instanceof Error ? error.message : String(error))",
    '  process.exitCode = 1',
    '} finally { store.close() }',
  ].join(';\n');
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', source]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
  });
}

test('assignment manifest is authoritative and concurrent processes allocate gap-free blocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-process-'));
  const dbPath = join(dir, 'ledger.sqlite');
  const setup = new Store(dbPath);
  try {
    setup.registerCausalProtocol(v2StoreProtocol('study:store-v2', 8));
  } finally {
    setup.close();
  }
  try {
    const results = await Promise.all([
      runAssignmentProcess(dbPath, assignmentRequest('block:process-a', ['1', '2', '3', '4'])),
      runAssignmentProcess(dbPath, assignmentRequest('block:process-b', ['5', '6', '7', '8'])),
    ]);
    assert.deepEqual(results.map((result) => result.code), [0, 0], JSON.stringify(results));
    assert.deepEqual(
      results.map((result) => JSON.parse(result.stdout).sequence).sort(),
      [1, 2],
    );

    const verify = new Store(dbPath);
    try {
      const manifest = (verify as unknown as {
        causalAssignmentManifestV2?: (studyId: string) => ReturnType<AssignmentMethod>['manifest'] | null;
      }).causalAssignmentManifestV2?.('study:store-v2');
      assert.ok(manifest, 'Store must expose the authoritative persisted assignment manifest');
      assert.equal(manifest.planCount, 2);
      assert.equal(manifest.decisionCount, 8);
      assert.equal(manifest.unitCount, 8);
      assert.deepEqual(manifest.plans.map((plan) => plan.sequence), [1, 2]);
      assert.equal(new Set(manifest.decisions.map((decision) => decision.unitIdDigest)).size, 8);
      assert.equal(tableCount(verify, 'causal_assignment_manifests_v2'), 2);
      assert.throws(
        () => verify.raw().prepare('DELETE FROM causal_assignment_manifests_v2').run(),
        /append-only/i,
      );
    } finally {
      verify.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allocation rollback leaves no rows and discloses no allocation at every SQLite write boundary', () => {
  const faultPoints = [
    { name: 'after_entropy_before_plan', timing: 'BEFORE', table: 'causal_assignment_plans_v2', when: '' },
    { name: 'after_plan', timing: 'AFTER', table: 'causal_assignment_plans_v2', when: '' },
    ...[1, 2, 3, 4].map((index) => ({
      name: 'after_decision_' + String(index),
      timing: 'AFTER',
      table: 'causal_decisions_v2',
      when: ' WHEN NEW.decision_index = ' + String(index),
    })),
    ...[1, 2, 3, 4].map((index) => ({
      name: 'after_unit_' + String(index),
      timing: 'AFTER',
      table: 'causal_assignment_units_v2',
      when: ' WHEN NEW.decision_id = (SELECT decision_id FROM causal_decisions_v2 WHERE decision_index = ' + String(index) + ' AND study_id = NEW.study_id)',
    })),
    { name: 'after_manifest', timing: 'AFTER', table: 'causal_assignment_manifests_v2', when: '' },
  ];

  for (const faultPoint of faultPoints) {
    const store = new Store(':memory:');
    try {
      store.registerCausalProtocol(v2StoreProtocol());
      store.raw().prepare(
        'CREATE TRIGGER injected_assignment_failure ' + faultPoint.timing + ' INSERT ON ' + faultPoint.table +
        faultPoint.when + " BEGIN SELECT RAISE(ABORT, 'injected assignment failure'); END",
      ).run();
      let thrown: unknown;
      try {
        assignmentMethod(store)(assignmentRequest());
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof Error, faultPoint.name + ' must fail');
      assert.equal((thrown as Error & { code?: string }).code, 'CAUSAL_ASSIGNMENT_ROLLED_BACK');
      assert.equal(
        thrown.message,
        'CAUSAL_ASSIGNMENT_ROLLED_BACK: assignment transaction rolled back without disclosing an allocation',
      );
      assert.doesNotMatch(thrown.message, /arm:candidate|arm:control|00010203/i);
      assert.equal(Object.hasOwn(thrown, 'block'), false);
      assert.equal(tableCount(store, 'causal_assignment_plans_v2'), 0);
      assert.equal(tableCount(store, 'causal_decisions_v2'), 0);
      assert.equal(tableCount(store, 'causal_assignment_units_v2'), 0);
      assert.equal(tableCount(store, 'causal_assignment_manifests_v2'), 0);
    } finally {
      store.close();
    }
  }
});

test('assignment rollback redacts SQLite dynamic RAISE content while rolling every row back', () => {
  const store = new Store(':memory:');
  try {
    store.registerCausalProtocol(v2StoreProtocol());
    store.raw().prepare(
      "CREATE TRIGGER injected_sensitive_assignment_failure AFTER INSERT ON causal_decisions_v2 " +
      "BEGIN SELECT RAISE(ABORT, 'injected failure arm=' || NEW.assigned_arm_id || " +
      "';unit=' || NEW.unit_id_digest || ';decision=' || NEW.decision_id); END",
    ).run();
    let thrown: unknown;
    try {
      assignmentMethod(store)(assignmentRequest());
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.equal((thrown as Error & { code?: string }).code, 'CAUSAL_ASSIGNMENT_ROLLED_BACK');
    assert.equal(
      thrown.message,
      'CAUSAL_ASSIGNMENT_ROLLED_BACK: assignment transaction rolled back without disclosing an allocation',
    );
    assert.doesNotMatch(
      thrown.message,
      /injected failure|arm:candidate|arm:control|sha256:|decision:|allocation=|material=|unit=/i,
    );
    assert.equal(tableCount(store, 'causal_assignment_plans_v2'), 0);
    assert.equal(tableCount(store, 'causal_decisions_v2'), 0);
    assert.equal(tableCount(store, 'causal_assignment_units_v2'), 0);
    assert.equal(tableCount(store, 'causal_assignment_manifests_v2'), 0);
  } finally {
    store.close();
  }
});

function dropV2ImmutabilityTriggers(db: DatabaseSync): void {
  for (const table of [
    'causal_assignment_plans_v2',
    'causal_decisions_v2',
    'causal_assignment_units_v2',
    'causal_assignment_manifests_v2',
  ]) {
    db.prepare('DROP TRIGGER causal_no_update_' + table).run();
    db.prepare('DROP TRIGGER causal_no_delete_' + table).run();
  }
}

function restoreV2ImmutabilityTriggers(db: DatabaseSync): void {
  for (const table of [
    'causal_assignment_plans_v2',
    'causal_decisions_v2',
    'causal_assignment_units_v2',
    'causal_assignment_manifests_v2',
  ]) {
    for (const operation of ['UPDATE', 'DELETE']) {
      const trigger = 'causal_no_' + operation.toLowerCase() + '_' + table;
      db.prepare(
        'CREATE TRIGGER ' + trigger + ' BEFORE ' + operation + ' ON ' + table +
        " BEGIN SELECT RAISE(ABORT, 'causal evidence is append-only'); END",
      ).run();
    }
  }
}

function dropV2UpdateTrigger(db: DatabaseSync, table: 'causal_executions_v2' | 'causal_terminal_outcomes_v2'): void {
  db.prepare('DROP TRIGGER causal_no_update_' + table).run();
}

function restoreV2UpdateTrigger(db: DatabaseSync, table: 'causal_executions_v2' | 'causal_terminal_outcomes_v2'): void {
  const trigger = 'causal_no_update_' + table;
  db.prepare(
    'CREATE TRIGGER ' + trigger + ' BEFORE UPDATE ON ' + table +
    " BEGIN SELECT RAISE(ABORT, 'causal evidence is append-only'); END",
  ).run();
}

function insertRawExecutionV2(store: Store, execution: CausalExecutionRecordV2): void {
  store.raw().prepare(
    'INSERT INTO causal_executions_v2 ' +
    '(execution_id, decision_id, study_id, protocol_hash, started_at_ms, completed_at_ms, previous_event_hash, event_hash, execution_json) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    execution.executionId,
    execution.decisionId,
    execution.studyId,
    execution.protocolHash,
    execution.startedAtMs,
    execution.completedAtMs,
    execution.previousEventHash,
    execution.eventHash,
    canonicalJson(execution),
  );
}

function insertRawTerminalOutcomeV2(store: Store, outcome: CausalTerminalOutcomeRecordV2): void {
  store.raw().prepare(
    'INSERT INTO causal_terminal_outcomes_v2 ' +
    '(outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, maturity, previous_event_hash, event_hash, terminal_outcome_json) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    outcome.outcomeId,
    outcome.decisionId,
    outcome.studyId,
    outcome.protocolHash,
    outcome.observedAtMs,
    outcome.maturity,
    outcome.previousEventHash,
    outcome.eventHash,
    canonicalJson(outcome),
  );
}

/** Test-only read seam that simulates a duplicate physical row without changing schema authority. */
function duplicateQualificationRows(
  store: Store,
  table: 'causal_executions_v2' | 'causal_terminal_outcomes_v2',
): DatabaseSync {
  const raw = store.raw();
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      if (!sql.includes('FROM ' + table + ' WHERE study_id')) return statement;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property === 'all') {
            return (...parameters: unknown[]) => {
              const all = Reflect.get(target, property, target) as (...args: unknown[]) => unknown[];
              const rows = all.apply(target, parameters);
              return [...rows, ...rows];
            };
          }
          return Reflect.get(target, property, target);
        },
      });
    },
  } as unknown as DatabaseSync;
}

function dropProtocolUpdateTrigger(db: DatabaseSync): void {
  db.prepare('DROP TRIGGER causal_no_update_causal_protocols').run();
}

function expectCausalIntegrityFailure(action: () => unknown, label: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, label + ' must fail closed');
  assert.equal(thrown instanceof TypeError, false, label + ' must not expose a raw TypeError');
  assert.equal(
    (thrown as Error & { code?: string }).code,
    'CAUSAL_INTEGRITY_FAILURE',
    label + ' must normalize to the public integrity code',
  );
}

test('retained v2 assignment identity requires exact physical protocol fields and canonical JSON bytes', () => {
  const cases: Array<{
    name: string;
    mutate: (db: DatabaseSync) => string;
  }> = [
    {
      name: 'protocol physical hash and time divergence',
      mutate: (db) => {
        db.prepare(
          'UPDATE causal_protocols SET protocol_hash = ?, committed_at_ms = ? WHERE study_id = ?',
        ).run(D('f'), 1_700_000_000_999, 'study:store-v2');
        return 'study:store-v2';
      },
    },
    {
      name: 'protocol physical study identity divergence',
      mutate: (db) => {
        db.prepare('UPDATE causal_protocols SET study_id = ? WHERE study_id = ?')
          .run('study:physical-divergence', 'study:store-v2');
        return 'study:physical-divergence';
      },
    },
    {
      name: 'noncanonical protocol JSON whitespace',
      mutate: (db) => {
        const row = db.prepare('SELECT protocol_json FROM causal_protocols WHERE study_id = ?')
          .get('study:store-v2') as { protocol_json: string };
        db.prepare('UPDATE causal_protocols SET protocol_json = ? WHERE study_id = ?')
          .run(' \n' + row.protocol_json, 'study:store-v2');
        return 'study:store-v2';
      },
    },
    {
      name: 'noncanonical plan JSON whitespace',
      mutate: (db) => {
        const row = db.prepare('SELECT plan_json FROM causal_assignment_plans_v2 WHERE study_id = ?')
          .get('study:store-v2') as { plan_json: string };
        db.prepare('UPDATE causal_assignment_plans_v2 SET plan_json = ? WHERE study_id = ?')
          .run(row.plan_json + '\n', 'study:store-v2');
        return 'study:store-v2';
      },
    },
    {
      name: 'noncanonical decision JSON whitespace',
      mutate: (db) => {
        const row = db.prepare('SELECT decision_json FROM causal_decisions_v2 WHERE study_id = ? LIMIT 1')
          .get('study:store-v2') as { decision_json: string };
        db.prepare('UPDATE causal_decisions_v2 SET decision_json = ? WHERE decision_id = ' +
          '(SELECT decision_id FROM causal_decisions_v2 WHERE study_id = ? ORDER BY decision_index LIMIT 1)')
          .run('\t' + row.decision_json, 'study:store-v2');
        return 'study:store-v2';
      },
    },
    {
      name: 'noncanonical manifest JSON whitespace',
      mutate: (db) => {
        const row = db.prepare('SELECT manifest_json FROM causal_assignment_manifests_v2 WHERE study_id = ?')
          .get('study:store-v2') as { manifest_json: string };
        db.prepare('UPDATE causal_assignment_manifests_v2 SET manifest_json = ? WHERE study_id = ?')
          .run('\r\n' + row.manifest_json, 'study:store-v2');
        return 'study:store-v2';
      },
    },
  ];

  const missed: string[] = [];
  for (const candidate of cases) {
    const store = new Store(':memory:');
    try {
      store.registerCausalProtocol(v2StoreProtocol());
      assignmentMethod(store)(assignmentRequest());
      dropProtocolUpdateTrigger(store.raw());
      dropV2ImmutabilityTriggers(store.raw());
      const studyId = candidate.mutate(store.raw());
      try {
        expectCausalIntegrityFailure(
          () => store.causalAssignmentManifestV2(studyId),
          candidate.name,
        );
      } catch (error) {
        missed.push(candidate.name + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    } finally {
      store.close();
    }
  }
  assert.deepEqual(missed, []);
});

test('retained v2 assignment corruption rejects invalid JSON roots and non-BLOB entropy without raw exceptions', () => {
  const cases: Array<{
    name: string;
    mutate: (db: DatabaseSync) => void;
  }> = [
    {
      name: 'null protocol JSON',
      mutate: (db) => db.prepare('UPDATE causal_protocols SET protocol_json = ? WHERE study_id = ?')
        .run('null', 'study:store-v2'),
    },
    {
      name: 'null plan JSON',
      mutate: (db) => db.prepare('UPDATE causal_assignment_plans_v2 SET plan_json = ? WHERE study_id = ?')
        .run('null', 'study:store-v2'),
    },
    {
      name: 'scalar decision JSON',
      mutate: (db) => db.prepare('UPDATE causal_decisions_v2 SET decision_json = ? WHERE study_id = ?')
        .run('42', 'study:store-v2'),
    },
    {
      name: 'array manifest JSON',
      mutate: (db) => db.prepare('UPDATE causal_assignment_manifests_v2 SET manifest_json = ? WHERE study_id = ?')
        .run('[]', 'study:store-v2'),
    },
    {
      name: 'TEXT stored in entropy BLOB column',
      mutate: (db) => db.prepare('UPDATE causal_assignment_plans_v2 SET entropy_blob = ? WHERE study_id = ?')
        .run('secret-unit=sha256:' + H('9'), 'study:store-v2'),
    },
  ];

  const missed: string[] = [];
  for (const candidate of cases) {
    const store = new Store(':memory:');
    try {
      store.registerCausalProtocol(v2StoreProtocol());
      assignmentMethod(store)(assignmentRequest());
      dropProtocolUpdateTrigger(store.raw());
      dropV2ImmutabilityTriggers(store.raw());
      candidate.mutate(store.raw());
      try {
        expectCausalIntegrityFailure(
          () => store.causalAssignmentManifestV2('study:store-v2'),
          candidate.name,
        );
      } catch (error) {
        missed.push(candidate.name + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    } finally {
      store.close();
    }
  }
  assert.deepEqual(missed, []);
});

test('assignment manifest rejects physical JSON divergence and non-authoritative generations before allocating again', () => {
  const store = new Store(':memory:');
  try {
    store.registerCausalProtocol(v2StoreProtocol());
    assignmentMethod(store)(assignmentRequest());
    dropV2ImmutabilityTriggers(store.raw());
    store.raw().prepare(
      'UPDATE causal_assignment_plans_v2 SET block_root = ? WHERE study_id = ? AND sequence = 1',
    ).run(D('f'), 'study:store-v2');
    const retained = store.raw().prepare(
      'SELECT protocol_hash, manifest_json FROM causal_assignment_manifests_v2 WHERE study_id = ? AND generation = 1',
    ).get('study:store-v2') as { protocol_hash: string; manifest_json: string };
    store.raw().prepare(
      'INSERT INTO causal_assignment_manifests_v2 (study_id, generation, protocol_hash, manifest_hash, manifest_json) VALUES (?, ?, ?, ?, ?)',
    ).run('study:store-v2', 2, retained.protocol_hash, D('e'), retained.manifest_json);

    assert.throws(
      () => store.causalAssignmentManifestV2('study:store-v2'),
      /CAUSAL_INTEGRITY_FAILURE|physical|generation|manifest/i,
    );
    assert.throws(
      () => assignmentMethod(store)(assignmentRequest('block:store-b', ['5', '6', '7', '8'])),
      /CAUSAL_INTEGRITY_FAILURE|physical|generation|manifest/i,
    );
    assert.equal(tableCount(store, 'causal_assignment_plans_v2'), 1);
    assert.equal(tableCount(store, 'causal_decisions_v2'), 4);
    assert.equal(tableCount(store, 'causal_assignment_units_v2'), 4);
  } finally {
    store.close();
  }
});

test('assignment manifest rejects missing prior generations and orphan physical rows', () => {
  const store = new Store(':memory:');
  try {
    store.registerCausalProtocol(v2StoreProtocol('study:store-v2', 8));
    assignmentMethod(store)(assignmentRequest());
    assignmentMethod(store)(assignmentRequest('block:store-b', ['5', '6', '7', '8']));
    dropV2ImmutabilityTriggers(store.raw());
    store.raw().prepare(
      'DELETE FROM causal_assignment_manifests_v2 WHERE study_id = ? AND generation = 1',
    ).run('study:store-v2');
    store.raw().prepare(
      'INSERT INTO causal_assignment_units_v2 (study_id, unit_id_digest, decision_id, block_id, block_sequence, claimed_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('study:store-v2', D('9'), 'decision:orphan', 'block:orphan', 3, 1_700_000_001_000);
    assert.throws(
      () => store.causalAssignmentManifestV2('study:store-v2'),
      /CAUSAL_INTEGRITY_FAILURE|generation|orphan|bijection|unit claim/i,
    );
  } finally {
    store.close();
  }
});

test('public assignment manifest reader observes one explicit SQLite snapshot during a writer commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-reader-snapshot-'));
  const dbPath = join(dir, 'ledger.sqlite');
  const setup = new Store(dbPath);
  setup.registerCausalProtocol(v2StoreProtocol('study:store-v2', 8));
  assignmentMethod(setup)(assignmentRequest());
  setup.close();

  const reader = new Store(dbPath);
  const writer = new Store(dbPath);
  let writerCommitted = false;
  try {
    reader.raw().setAuthorizer((actionCode, tableName) => {
      if (actionCode === sqliteConstants.SQLITE_READ
          && tableName === 'causal_assignment_units_v2'
          && !writerCommitted) {
        writerCommitted = true;
        assignmentMethod(writer)(assignmentRequest('block:store-b', ['5', '6', '7', '8']));
      }
      return sqliteConstants.SQLITE_OK;
    });
    const firstSnapshot = reader.causalAssignmentManifestV2('study:store-v2');
    assert.ok(firstSnapshot);
    assert.equal(writerCommitted, true);
    assert.equal(firstSnapshot.planCount, 1);
    reader.raw().setAuthorizer(null);
    const nextSnapshot = reader.causalAssignmentManifestV2('study:store-v2');
    assert.ok(nextSnapshot);
    assert.equal(nextSnapshot.planCount, 2);
  } finally {
    reader.raw().setAuthorizer(null);
    writer.close();
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy causal decision storage is not a source for v2 terminal records', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    assert.equal(assignmentMethod(store)(assignmentRequest()).status, 'created');
    const decisionRow = store.raw().prepare(
      'SELECT decision_json FROM causal_decisions ORDER BY decision_id LIMIT 1',
    ).get() as { decision_json: string } | undefined;
    assert.equal(decisionRow, undefined, 'v2 assignment must never be reinterpreted through legacy v1 decision JSON');
  } finally {
    store.close();
  }
});

test('strict causal execution v2 Store facade exists independently of legacy append helpers', () => {
  const store = new Store(':memory:');
  try {
    const method = (store as unknown as { appendCausalExecutionV2?: unknown }).appendCausalExecutionV2;
    assert.equal(typeof method, 'function', 'Slice 4 requires an explicit v2-only Store append boundary');
  } finally {
    store.close();
  }
});

test('terminal causal outcome rejects unknown roots and pending maturity before persistence', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)(assignmentRequest());
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const execution = validExecutionV2(protocol, decision, 'execution:terminal-red');
    assert.equal(executionMethod(store)(execution), 'created');

    const method = (store as unknown as { appendCausalTerminalOutcomeV2?: (record: unknown) => 'created' | 'existing' }).appendCausalTerminalOutcomeV2;
    assert.equal(typeof method, 'function', 'Slice 4 requires an explicit v2-only terminal outcome append boundary');
    if (typeof method !== 'function') throw new Error('internal v2 terminal outcome operation is unavailable');

    const pending = {
      type: 'fiscus.causal-terminal-outcome',
      version: 2,
      outcomeId: 'outcome:terminal-red',
      decisionId: decision.decisionId,
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      observedAtMs: execution.completedAtMs + 1,
      maturity: 'pending',
    };
    for (const malformed of [null, undefined, [], pending]) {
      assert.throws(() => method.call(store, malformed), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
        assert.equal(error.message, 'CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid');
        return true;
      });
    }
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    store.close();
  }
});

test('strict causal execution v2 appends only against an authenticated v2 decision and replays exactly', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)(assignmentRequest());
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const record = validExecutionV2(protocol, decision);
    const append = executionMethod(store);
    assert.equal(append(record), 'created');
    assert.equal(tableCount(store, 'causal_executions_v2'), 1);
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
    const retained = store.raw().prepare(
      'SELECT execution_id, decision_id, study_id, protocol_hash, started_at_ms, completed_at_ms, previous_event_hash, event_hash, execution_json FROM causal_executions_v2',
    ).get() as Record<string, unknown>;
    assert.equal(retained.execution_id, record.executionId);
    assert.equal(retained.decision_id, record.decisionId);
    assert.equal(retained.previous_event_hash, record.previousEventHash);
    assert.equal(retained.event_hash, record.eventHash);
    assert.equal(retained.execution_json, canonicalJson(record));
    assert.equal(append(record), 'existing');

    const changed = { ...record, completedAtMs: record.completedAtMs + 1 };
    assert.throws(
      () => append({ ...changed, eventHash: causalExecutionV2EventHash(changed) }),
      /CAUSAL_IMMUTABLE_CONFLICT/,
    );
    const duplicateDecision = validExecutionV2(protocol, decision, 'execution:store-v2-other');
    assert.throws(() => append(duplicateDecision), /CAUSAL_IMMUTABLE_CONFLICT/);
    assert.equal(tableCount(store, 'causal_executions_v2'), 1);
    assert.throws(
      () => store.raw().prepare('UPDATE causal_executions_v2 SET study_id = ?').run('study:tampered'),
      /append-only/i,
    );
    assert.throws(
      () => store.raw().prepare('DELETE FROM causal_executions_v2').run(),
      /append-only/i,
    );
  } finally {
    store.close();
  }
});

test('strict causal execution v2 rejects unknown roots and local judge verifier before mutation', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)(assignmentRequest());
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const record = validExecutionV2(protocol, decision);
    const append = executionMethod(store);
    for (const malformed of [null, undefined, [], { ...record, unexpected: 'secret' },
      { ...record, ordinaryLedgerVerifier: { ...record.ordinaryLedgerVerifier, unexpected: 'secret' } },
      { ...record, ordinaryLedgerVerifier: { ...record.ordinaryLedgerVerifier, state: 'verified' } },
      { ...record, ordinaryLedgerVerifier: { ...record.ordinaryLedgerVerifier, reasonCodes: ['local_ai_judge'] } }]) {
      assert.throws(() => append(malformed), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
        assert.equal(error.message, 'CAUSAL_RECORD_INVALID: causal execution record is invalid');
        return true;
      });
    }
    assert.equal(tableCount(store, 'causal_executions_v2'), 0);
  } finally {
    store.close();
  }
});

test('strict causal terminal outcome decoder rejects extra roots, hostile maturity coercion, and nested array fields', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)(assignmentRequest());
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const execution = validExecutionV2(protocol, decision, 'execution:terminal-decoder');
    assert.equal(executionMethod(store)(execution), 'created');
    const append = terminalOutcomeMethod(store);
    const valid = validTerminalOutcomeV2(protocol, execution);
    const nestedExtra = [...valid.outcomeEvidenceDigests] as string[] & { unexpected?: string };
    nestedExtra.unexpected = 'secret';
    const coercibleMaturity = {
      toString(): never {
        throw new Error('credential-secret');
      },
    };
    for (const malformed of [
      { ...valid, unexpected: 'secret' },
      { ...valid, outcomeEvidenceDigests: nestedExtra },
      { ...valid, maturity: coercibleMaturity },
    ]) {
      assert.throws(() => append(malformed), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
        assert.equal(error.message, 'CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid');
        assert.doesNotMatch(error.message, /credential-secret|toString|sqlite|SQL/i);
        return true;
      });
    }
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    store.close();
  }
});

test('strict causal terminal outcome v2 appends each terminal maturity and enforces immutable lineage replay', () => {
  const store = new Store(':memory:');
  try {
    const protocol = policyV2StoreProtocol('study:terminal-maturity-matrix');
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId: protocol.studyId });
    const appendExecution = executionMethod(store);
    const appendOutcome = terminalOutcomeMethod(store);
    const decisions = assignment.block.decisions.slice(0, 3) as Array<typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    }>;
    const executions = decisions.map((decision, index) => {
      const execution = validExecutionV2(protocol, decision, 'execution:terminal-maturity-' + index);
      assert.equal(appendExecution(execution), 'created');
      return execution;
    });
    const maturities: TerminalMaturity[] = ['matured', 'censored', 'invalid'];
    const outcomes = executions.map((execution, index) => {
      let outcome = validTerminalOutcomeV2(
        protocol,
        execution,
        maturities[index],
        'outcome:terminal-maturity-' + index,
      );
      if (outcome.maturity === 'censored') {
        const deadlineMs = execution.completedAtMs + protocol.followUpWindowMs!;
        const material = { ...outcome, observedAtMs: deadlineMs };
        const { eventHash: _eventHash, ...eventMaterial } = material;
        outcome = { ...material, eventHash: causalTerminalOutcomeV2EventHash(eventMaterial) };
      }
      assert.equal(appendOutcome(outcome), 'created');
      return outcome;
    });

    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 3);
    assert.deepEqual(
      (store.raw().prepare(
        'SELECT outcome_id, decision_id, maturity, previous_event_hash, event_hash FROM causal_terminal_outcomes_v2 ORDER BY outcome_id',
      ).all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
      outcomes.map((outcome) => ({
        outcome_id: outcome.outcomeId,
        decision_id: outcome.decisionId,
        maturity: outcome.maturity,
        previous_event_hash: outcome.previousEventHash,
        event_hash: outcome.eventHash,
      })),
    );
    assert.equal(appendOutcome(outcomes[0]), 'existing');

    const divergent = { ...outcomes[0]!, qualityValue: 0.8 };
    assert.throws(
      () => appendOutcome({ ...divergent, eventHash: causalTerminalOutcomeV2EventHash(divergent) }),
      /CAUSAL_IMMUTABLE_CONFLICT/,
    );
    const duplicateDecision = validTerminalOutcomeV2(
      protocol,
      executions[0]!,
      'matured',
      'outcome:terminal-maturity-other',
    );
    assert.throws(() => appendOutcome(duplicateDecision), /CAUSAL_IMMUTABLE_CONFLICT/);
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 3);

    assert.throws(
      () => store.raw().prepare('UPDATE causal_terminal_outcomes_v2 SET maturity = ?').run('censored'),
      /append-only/i,
    );
    assert.throws(
      () => store.raw().prepare('DELETE FROM causal_terminal_outcomes_v2').run(),
      /append-only/i,
    );
  } finally {
    store.close();
  }
});

test('strict causal terminal outcome v2 requires the authenticated execution predecessor and rejects V1 or local judge evidence', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol('study:terminal-lineage-boundary');
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId: protocol.studyId });
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const execution = validExecutionV2(protocol, decision, 'execution:terminal-lineage');
    assert.equal(executionMethod(store)(execution), 'created');
    const appendOutcome = terminalOutcomeMethod(store);
    const valid = validTerminalOutcomeV2(protocol, execution);

    const wrongPredecessor = { ...valid, previousEventHash: D('z') };
    assert.throws(
      () => appendOutcome({ ...wrongPredecessor, eventHash: causalTerminalOutcomeV2EventHash(wrongPredecessor) }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
        assert.equal(error.message, 'CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid');
        return true;
      },
    );

    const localJudge = {
      ...valid,
      qualityEvidenceClass: 'local_ai_judge',
    } as unknown as CausalTerminalOutcomeRecordV2;
    assert.throws(
      () => appendOutcome(localJudge),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
        assert.equal(error.message, 'CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid');
        return true;
      },
    );

    const legacyShape = {
      outcomeId: 'outcome:legacy-terminal',
      decisionId: decision.decisionId,
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      observedAtMs: execution.completedAtMs + 1,
      maturity: 'matured',
      qualityValue: 0.9,
      qualityEvidenceClass: 'deterministic',
      economicValueUsd: null,
      economicEvidenceClass: null,
      outcomeEvidenceRefs: [D('e')],
      missingReason: null,
      previousEventHash: execution.eventHash,
      eventHash: D('l'),
    };
    assert.throws(
      () => appendOutcome(legacyShape),
      /CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid/,
    );
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    store.close();
  }
});

test('strict causal terminal outcome v2 maps missing protocol and wrong study to the canonical input boundary', () => {
  const missingProtocolStore = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol('study:terminal-missing-protocol');
    const decision = {
      decisionId: 'decision:terminal-missing-protocol',
      assignedAtMs: protocol.studyWindow.startsAtMs,
      assignedArmId: protocol.arms[0]!.armId,
      eventHash: D('d'),
    };
    const execution = validExecutionV2(protocol, decision, 'execution:terminal-missing-protocol');
    const outcome = validTerminalOutcomeV2(
      protocol,
      execution,
      'matured',
      'outcome:terminal-missing-protocol',
    );
    assert.throws(
      () => terminalOutcomeMethod(missingProtocolStore)(outcome),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
        assert.equal(error.message, 'CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid');
        return true;
      },
    );
    assert.equal(tableCount(missingProtocolStore, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    missingProtocolStore.close();
  }

  const wrongStudyStore = new Store(':memory:');
  try {
    const retainedProtocol = v2StoreProtocol('study:terminal-retained-study');
    assert.equal(wrongStudyStore.registerCausalProtocol(retainedProtocol), 'created');
    const wrongStudyProtocol = v2StoreProtocol('study:terminal-wrong-study');
    const decision = {
      decisionId: 'decision:terminal-wrong-study',
      assignedAtMs: wrongStudyProtocol.studyWindow.startsAtMs,
      assignedArmId: wrongStudyProtocol.arms[0]!.armId,
      eventHash: D('d'),
    };
    const execution = validExecutionV2(wrongStudyProtocol, decision, 'execution:terminal-wrong-study');
    const outcome = validTerminalOutcomeV2(
      wrongStudyProtocol,
      execution,
      'matured',
      'outcome:terminal-wrong-study',
    );
    assert.throws(
      () => terminalOutcomeMethod(wrongStudyStore)(outcome),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
        assert.equal(error.message, 'CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid');
        return true;
      },
    );
    assert.equal(tableCount(wrongStudyStore, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    wrongStudyStore.close();
  }
});

test('strict causal terminal outcome v2 re-authenticates retained protocol and execution before writing', () => {
  for (const corruption of ['protocol', 'execution'] as const) {
    const store = new Store(':memory:');
    try {
      const protocol = v2StoreProtocol('study:terminal-retained-' + corruption);
      assert.equal(store.registerCausalProtocol(protocol), 'created');
      const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId: protocol.studyId });
      const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
        decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
      };
      const execution = validExecutionV2(protocol, decision, 'execution:terminal-retained-' + corruption);
      assert.equal(executionMethod(store)(execution), 'created');
      if (corruption === 'protocol') {
        dropProtocolUpdateTrigger(store.raw());
        store.raw().prepare("UPDATE causal_protocols SET protocol_json = '{'").run();
      } else {
        store.raw().prepare('DROP TRIGGER causal_no_update_causal_executions_v2').run();
        store.raw().prepare("UPDATE causal_executions_v2 SET execution_json = '{'").run();
      }
      const outcome = validTerminalOutcomeV2(protocol, execution, 'matured', 'outcome:terminal-retained-' + corruption);
      assert.throws(
        () => terminalOutcomeMethod(store)(outcome),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
          assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 terminal outcome failed integrity verification');
          assert.doesNotMatch(error.message, /sqlite|protocol_json|execution_json|terminal-retained/i);
          return true;
        },
        corruption,
      );
      assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
    } finally {
      store.close();
    }
  }
});

test('strict causal terminal outcome v2 rejects a self-consistent but protocol-invalid retained execution', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol('study:terminal-self-consistent-tamper');
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId: protocol.studyId });
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const execution = validExecutionV2(protocol, decision, 'execution:terminal-self-consistent-tamper');
    assert.equal(executionMethod(store)(execution), 'created');
    const tamperedMaterial = {
      ...execution,
      directAiCostUsd: 101,
      directCostSourceClass: 'actual_observed' as const,
      priceLineageDigests: [D('c')],
    };
    const tampered = { ...tamperedMaterial, eventHash: causalExecutionV2EventHash(tamperedMaterial) };
    store.raw().prepare('DROP TRIGGER causal_no_update_causal_executions_v2').run();
    store.raw().prepare(
      'UPDATE causal_executions_v2 SET event_hash = ?, execution_json = ? WHERE execution_id = ?',
    ).run(tampered.eventHash, canonicalJson(tampered), tampered.executionId);

    const outcome = validTerminalOutcomeV2(protocol, tampered, 'matured', 'outcome:terminal-self-consistent-tamper');
    assert.throws(
      () => terminalOutcomeMethod(store)(outcome),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
        assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 terminal outcome failed integrity verification');
        return true;
      },
    );
    assert.equal(tableCount(store, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    store.close();
  }
});

test('strict causal terminal outcome v2 detects retained-row corruption and rolls back injected failures', () => {
  const corrupted = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol('study:terminal-row-corruption');
    assert.equal(corrupted.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(corrupted)({ ...assignmentRequest(), studyId: protocol.studyId });
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const execution = validExecutionV2(protocol, decision, 'execution:terminal-row-corruption');
    assert.equal(executionMethod(corrupted)(execution), 'created');
    const outcome = validTerminalOutcomeV2(protocol, execution, 'matured', 'outcome:terminal-row-corruption');
    const append = terminalOutcomeMethod(corrupted);
    assert.equal(append(outcome), 'created');
    corrupted.raw().prepare('DROP TRIGGER causal_no_update_causal_terminal_outcomes_v2').run();
    corrupted.raw().prepare("UPDATE causal_terminal_outcomes_v2 SET terminal_outcome_json = '{'").run();
    corrupted.raw().prepare(
      "CREATE TRIGGER causal_no_update_causal_terminal_outcomes_v2 BEFORE UPDATE ON causal_terminal_outcomes_v2 BEGIN SELECT RAISE(ABORT, 'causal evidence is append-only'); END",
    ).run();
    assert.throws(
      () => append(outcome),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
        assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 terminal outcome failed integrity verification');
        assert.doesNotMatch(error.message, /terminal_outcome_json|sqlite|row-corruption/i);
        return true;
      },
    );
    assert.equal(tableCount(corrupted, 'causal_terminal_outcomes_v2'), 1);
  } finally {
    corrupted.close();
  }

  const rollback = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol('study:terminal-rollback');
    assert.equal(rollback.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(rollback)({ ...assignmentRequest(), studyId: protocol.studyId });
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const execution = validExecutionV2(protocol, decision, 'execution:terminal-rollback');
    assert.equal(executionMethod(rollback)(execution), 'created');
    const outcome = validTerminalOutcomeV2(protocol, execution, 'matured', 'outcome:terminal-rollback');
    rollback.raw().prepare(
      "CREATE TRIGGER injected_terminal_failure AFTER INSERT ON causal_terminal_outcomes_v2 BEGIN SELECT RAISE(ABORT, 'credential-secret'); END",
    ).run();
    const originalNow = Date.now;
    let wallClockReads = 0;
    Date.now = () => {
      wallClockReads += 1;
      return originalNow();
    };
    try {
      assert.throws(
        () => terminalOutcomeMethod(rollback)(outcome),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
          assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 terminal outcome failed integrity verification');
          assert.doesNotMatch(error.message, /credential-secret|terminal-rollback|sqlite|SQL/i);
          return true;
        },
      );
    } finally {
      Date.now = originalNow;
    }
    assert.equal(wallClockReads, 0, 'schema attestation must run before the Store-owned clock capture');
    assert.equal(tableCount(rollback, 'causal_terminal_outcomes_v2'), 0);
  } finally {
    rollback.close();
  }
});

test('strict causal execution v2 rejects non-null direct and full-arm costs without price lineage', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)(assignmentRequest());
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const record = validExecutionV2(protocol, decision, 'execution:cost-lineage');
    const append = executionMethod(store);
    const directCost = { ...record, directAiCostUsd: 1, directCostSourceClass: 'actual_observed' as const };
    assert.throws(
      () => append({ ...directCost, eventHash: causalExecutionV2EventHash(directCost) }),
      /CAUSAL_RECORD_INVALID/,
    );
    const fullCost = {
      ...record,
      fullArmCostUsd: 1,
      fullCostSourceClass: 'actual_observed' as const,
    };
    assert.throws(
      () => append({ ...fullCost, eventHash: causalExecutionV2EventHash(fullCost) }),
      /CAUSAL_RECORD_INVALID/,
    );
    assert.equal(tableCount(store, 'causal_executions_v2'), 0);
  } finally {
    store.close();
  }
});

test('strict causal execution v2 applies protocol question and declared cost bounds before insertion', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)(assignmentRequest());
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const record = validExecutionV2(protocol, decision, 'execution:model-full-cost');
    const modelFullCost = {
      ...record,
      fullArmCostUsd: 1,
      fullCostSourceClass: 'actual_observed' as const,
      priceLineageDigests: [D('c')],
    };
    assert.throws(
      () => executionMethod(store)({ ...modelFullCost, eventHash: causalExecutionV2EventHash(modelFullCost) }),
      /CAUSAL_RECORD_INVALID/,
    );
    assert.equal(tableCount(store, 'causal_executions_v2'), 0);
  } finally {
    store.close();
  }
});

test('strict causal execution v2 requires full-arm cost for AI-versus-incumbent protocols', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2AiStoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId: protocol.studyId });
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const record = validExecutionV2(protocol, decision, 'execution:ai-full-cost');
    const append = executionMethod(store);
    assert.throws(() => append(record), /CAUSAL_RECORD_INVALID/);
    const fullCost = {
      ...record,
      fullArmCostUsd: 1,
      fullCostSourceClass: 'actual_observed' as const,
      priceLineageDigests: [D('c')],
    };
    assert.equal(append({ ...fullCost, eventHash: causalExecutionV2EventHash(fullCost) }), 'created');
    assert.equal(tableCount(store, 'causal_executions_v2'), 1);
  } finally {
    store.close();
  }
});

test('strict causal execution v2 rejects direct and full-arm financial values outside the committed bounds or source classes', () => {
  const cases: Array<{
    name: string;
    protocol: CommittedCausalStudyProtocolV2;
    mutate: (record: CausalExecutionRecordV2) => CausalExecutionRecordV2;
  }> = [
    {
      name: 'direct cost above bound',
      protocol: v2StoreProtocol('study:financial-direct-bound'),
      mutate: (record) => ({
        ...record,
        directAiCostUsd: 101,
        directCostSourceClass: 'actual_observed',
        priceLineageDigests: [D('c')],
      }),
    },
    {
      name: 'direct source disallowed by protocol',
      protocol: v2StoreProtocol('study:financial-direct-source'),
      mutate: (record) => ({
        ...record,
        directAiCostUsd: 1,
        directCostSourceClass: 'actual_reconciled',
        priceLineageDigests: [D('c')],
      }),
    },
    {
      name: 'full-arm cost above bound',
      protocol: v2AiStoreProtocol('study:financial-full-bound'),
      mutate: (record) => ({
        ...record,
        fullArmCostUsd: 101,
        fullCostSourceClass: 'actual_observed',
        priceLineageDigests: [D('c')],
      }),
    },
    {
      name: 'full-arm source disallowed by protocol',
      protocol: v2AiStoreProtocol('study:financial-full-source'),
      mutate: (record) => ({
        ...record,
        fullArmCostUsd: 1,
        fullCostSourceClass: 'actual_reconciled',
        priceLineageDigests: [D('c')],
      }),
    },
  ];
  for (const financialCase of cases) {
    const store = new Store(':memory:');
    try {
      const { protocol } = financialCase;
      assert.equal(store.registerCausalProtocol(protocol), 'created');
      const assignment = assignmentMethod(store)({ ...assignmentRequest(), studyId: protocol.studyId });
      const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
        decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
      };
      const base = validExecutionV2(protocol, decision, 'execution:financial-' + financialCase.name.replaceAll(' ', '-'));
      const mutated = financialCase.mutate(base);
      assert.throws(
        () => executionMethod(store)({ ...mutated, eventHash: causalExecutionV2EventHash(mutated) }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as Error & { code?: string }).code, 'CAUSAL_RECORD_INVALID');
          assert.equal(error.message, 'CAUSAL_RECORD_INVALID: execution does not satisfy the stored protocol');
          return true;
        },
        financialCase.name,
      );
      assert.equal(tableCount(store, 'causal_executions_v2'), 0, financialCase.name);
    } finally {
      store.close();
    }
  }
});

test('strict causal execution v2 rolls back an injected failure without disclosing retained content', () => {
  const store = new Store(':memory:');
  try {
    const protocol = v2StoreProtocol();
    assert.equal(store.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(store)(assignmentRequest());
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const record = validExecutionV2(protocol, decision, 'execution:rollback');
    store.raw().prepare(
      "CREATE TRIGGER injected_execution_failure AFTER INSERT ON causal_executions_v2 BEGIN SELECT RAISE(ABORT, 'credential-secret'); END",
    ).run();
    assert.throws(() => executionMethod(store)(record), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'CAUSAL_APPEND_ROLLED_BACK');
      assert.equal(error.message, 'CAUSAL_APPEND_ROLLED_BACK: execution transaction rolled back without disclosing a causal record');
      assert.doesNotMatch(error.message, /credential-secret|execution:rollback|sqlite|SQL/i);
      return true;
    });
    assert.equal(tableCount(store, 'causal_executions_v2'), 0);
  } finally {
    store.close();
  }
});

test('strict causal execution v2 rejects malformed, noncanonical, unsafe, and physically divergent retained rows', () => {
  const variants: Array<{ name: string; mutate: (store: Store, record: CausalExecutionRecordV2) => void }> = [
    { name: 'malformed JSON', mutate: (store) => store.raw().prepare("UPDATE causal_executions_v2 SET execution_json = '{'").run() },
    { name: 'noncanonical JSON', mutate: (store, record) => store.raw().prepare('UPDATE causal_executions_v2 SET execution_json = ?').run(JSON.stringify(record)) },
    { name: 'unsafe timestamp storage', mutate: (store) => store.raw().prepare("UPDATE causal_executions_v2 SET started_at_ms = CAST('9007199254740992' AS INTEGER)").run() },
    { name: 'physical identity mismatch', mutate: (store) => store.raw().prepare('UPDATE causal_executions_v2 SET study_id = ?').run('study:corrupt') },
  ];
  for (const variant of variants) {
    const store = new Store(':memory:');
    try {
      const protocol = v2StoreProtocol();
      assert.equal(store.registerCausalProtocol(protocol), 'created');
      const assignment = assignmentMethod(store)(assignmentRequest());
      const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
        decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
      };
      const record = validExecutionV2(protocol, decision, 'execution:corrupt-' + variant.name.replaceAll(' ', '-'));
      assert.equal(executionMethod(store)(record), 'created');
      store.raw().prepare('DROP TRIGGER causal_no_update_causal_executions_v2').run();
      variant.mutate(store, record);
      assert.throws(() => executionMethod(store)(record), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CAUSAL_INTEGRITY_FAILURE');
        assert.equal(error.message, 'CAUSAL_INTEGRITY_FAILURE: stored v2 execution failed integrity verification');
        assert.doesNotMatch(error.message, /'|sqlite|execution_json|9007199254740992|study:corrupt/i);
        return true;
      }, variant.name);
    } finally {
      store.close();
    }
  }
});

test('version-1 causal records are inspect-only at every public Store mutation boundary', () => {
  const store = new Store(':memory:');
  try {
    const protocol = commitCausalProtocol(protocolDraft(), 1_700_000_000_100);
    const plan = createRetainedCausalV1AssignmentFixture(protocol, {
      blockId: 'block-store',
      createdAtMs: 1_700_000_000_200,
      unitIdHashes: [H('1'), H('2'), H('3'), H('4')],
      randomizationMaterial: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const decision = plan.decisions[0]!;
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
      directAiCostUsd: 5,
      directCostSourceClass: 'actual_observed' as const,
      priceLineageHashes: [H('c')],
      fullArmCostUsd: null,
      fullCostSourceClass: 'incomplete_or_unknown' as const,
      previousEventHash: decision.eventHash,
    });
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

    assert.throws(() => store.registerCausalProtocol(protocol), /CAUSAL_LEGACY_INSPECT_ONLY|inspect-only/i);
    store.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
    assert.throws(() => store.saveCausalAssignmentPlan(plan), /CAUSAL_LEGACY_INSPECT_ONLY|inspect-only/i);
    store.raw().prepare(
      'INSERT INTO causal_assignment_plans (study_id, block_id, protocol_hash, created_at_ms, allocation_hash, material_sha256, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(plan.studyId, plan.blockId, plan.protocolHash, plan.createdAtMs, plan.allocationHash, plan.randomizationMaterialSha256, JSON.stringify(plan));
    store.raw().prepare(
      'INSERT INTO causal_decisions (decision_id, study_id, protocol_hash, assigned_at_ms, event_hash, decision_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(decision.decisionId, decision.studyId, decision.protocolHash, decision.assignedAtMs, decision.eventHash, JSON.stringify(decision));
    assert.throws(() => store.appendCausalExecution(execution), /CAUSAL_LEGACY_INSPECT_ONLY|inspect-only/i);
    store.raw().prepare(
      'INSERT INTO causal_executions (execution_id, decision_id, study_id, protocol_hash, completed_at_ms, event_hash, execution_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(execution.executionId, execution.decisionId, execution.studyId, execution.protocolHash, execution.completedAtMs, execution.eventHash, JSON.stringify(execution));
    assert.throws(() => store.appendCausalOutcome(outcome), /CAUSAL_LEGACY_INSPECT_ONLY|inspect-only/i);
    store.raw().prepare(
      'INSERT INTO causal_outcomes (outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, event_hash, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(outcome.outcomeId, outcome.decisionId, outcome.studyId, outcome.protocolHash, outcome.observedAtMs, outcome.eventHash, JSON.stringify(outcome));
    assert.throws(
      () => store.saveCausalAnalysis(protocol.studyId, 'analysis:legacy:1', 1_700_000_000_500),
      /CAUSAL_LEGACY_INSPECT_ONLY|inspect-only/i,
    );
    assert.ok(store.causalStudyData(protocol.studyId));

    const v2 = v2StoreProtocol('study:store-v2', 4);
    assert.equal(store.registerCausalProtocol(v2), 'created');
    assert.equal(assignmentMethod(store)(assignmentRequest()).status, 'created');
  } finally {
    store.close();
  }
});

test('causal v2 migration fails atomically with a verified safe backup when an incomplete sentinel exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-migration-failure-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.prepare('CREATE TABLE legacy_probe (value TEXT NOT NULL)').run();
  legacy.prepare('INSERT INTO legacy_probe (value) VALUES (?)').run('retained');
  legacy.prepare('CREATE TABLE causal_assignment_plans_v2 (legacy_marker TEXT NOT NULL)').run();
  legacy.close();

  let opened: Store | null = null;
  let thrown: unknown;
  try {
    opened = new Store(dbPath);
  } catch (error) {
    thrown = error;
  } finally {
    opened?.close();
  }

  try {
    assert.ok(thrown instanceof Error, 'an incomplete migration sentinel must fail closed');
    assert.match(thrown.message, /CAUSAL_IO_FAILURE/i);
    assert.match(thrown.message, /verified backup|recovery/i);
    const backups = readdirSync(dir).filter((name) => name.startsWith('legacy.sqlite.pre-causal-v2-'));
    assert.equal(backups.length, 1);
    const backupPath = join(dir, backups[0]!);
    assert.equal(isAbsolute(backupPath), true);
    assert.equal(dirname(backupPath), dirname(dbPath));
    const stat = lstatSync(backupPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    const backupHash = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
    assert.match(backupHash, /^[a-f0-9]{64}$/);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal((backup.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok');
      assert.equal((backup.prepare('SELECT value FROM legacy_probe').get() as { value: string }).value, 'retained');
    } finally {
      backup.close();
    }

    const original = new DatabaseSync(dbPath);
    try {
      assert.equal((original.prepare('SELECT value FROM legacy_probe').get() as { value: string }).value, 'retained');
      const tables = original.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'causal_%_v2' ORDER BY name",
      ).all() as Array<{ name: string }>;
      assert.deepEqual(tables.map((row) => row.name), ['causal_assignment_plans_v2']);
      const columns = original.prepare('PRAGMA table_info(causal_assignment_plans_v2)').all() as Array<{ name: string }>;
      assert.deepEqual(columns.map((row) => row.name), ['legacy_marker']);
    } finally {
      original.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exact Slice 3 assignment schema is a named migration predecessor and upgrades both terminal tables atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-s3-predecessor-'));
  const dbPath = join(dir, 'slice3.sqlite');
  try {
    const seeded = new Store(dbPath);
    seeded.close();
    const stripSlice4 = new DatabaseSync(dbPath);
    try {
      stripSlice4.prepare('DROP TABLE causal_executions_v2').run();
      stripSlice4.prepare('DROP TABLE causal_terminal_outcomes_v2').run();
      assert.equal(causalV2SchemaAttestation(stripSlice4).state, 'exact-s3');
    } finally {
      stripSlice4.close();
    }
    const migrated = new Store(dbPath);
    try {
      assert.equal(migrated.causalMigrationBackupEvidence()?.path.startsWith(dbPath + '.pre-causal-v2-'), true);
      assert.equal(causalV2SchemaComplete(migrated.raw()), true);
      assert.equal(tableCount(migrated, 'causal_executions_v2'), 0);
      assert.equal(tableCount(migrated, 'causal_terminal_outcomes_v2'), 0);
      const triggers = migrated.raw().prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'causal_executions_v2' OR tbl_name = 'causal_terminal_outcomes_v2')",
      ).get() as { count: number };
      assert.equal(triggers.count, 4);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete pre-clock Slice 4 evidence schema migrates by adding only exact clock metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-pre-clock-'));
  const dbPath = join(dir, 'pre-clock.sqlite');
  try {
    const seeded = new Store(dbPath);
    const protocol = v2StoreProtocol('study:pre-clock-migration');
    assert.equal(seeded.registerCausalProtocol(protocol), 'created');
    const assignment = assignmentMethod(seeded)({
      ...assignmentRequest('block:pre-clock-migration'),
      studyId: protocol.studyId,
    });
    const decision = assignment.block.decisions[0]! as typeof assignment.block.decisions[number] & {
      decisionId: string; assignedAtMs: number; assignedArmId: string; eventHash: string;
    };
    const execution = validExecutionV2(protocol, decision, 'execution:pre-clock-migration');
    assert.equal(executionMethod(seeded)(execution), 'created');
    const outcome = validTerminalOutcomeV2(protocol, execution, 'matured', 'outcome:pre-clock-migration');
    assert.equal(terminalOutcomeMethod(seeded)(outcome), 'created');
    const before = {
      protocol: (seeded.raw().prepare('SELECT protocol_hash, protocol_json FROM causal_protocols WHERE study_id = ?')
        .get(protocol.studyId) as { protocol_hash: string; protocol_json: string }),
      execution: (seeded.raw().prepare('SELECT event_hash, execution_json FROM causal_executions_v2 WHERE execution_id = ?')
        .get(execution.executionId) as { event_hash: string; execution_json: string }),
      outcome: (seeded.raw().prepare('SELECT event_hash, terminal_outcome_json FROM causal_terminal_outcomes_v2 WHERE outcome_id = ?')
        .get(outcome.outcomeId) as { event_hash: string; terminal_outcome_json: string }),
    };
    seeded.close();

    const preClock = new DatabaseSync(dbPath);
    try {
      preClock.prepare('DROP TABLE causal_clock_state').run();
      assert.equal(causalV2SchemaAttestation(preClock).state, 'exact-pre-clock');
    } finally {
      preClock.close();
    }

    const migrated = new Store(dbPath);
    try {
      assert.equal(causalV2SchemaComplete(migrated.raw()), true);
      assert.equal(migrated.causalMigrationBackupEvidence()?.path.startsWith(dbPath + '.pre-causal-v2-'), true);
      const clockRows = migrated.raw().prepare(
        'SELECT clock_id, last_wall_ms FROM causal_clock_state',
      ).all() as Array<{ clock_id: string; last_wall_ms: number }>;
      assert.equal(clockRows.length, 1);
      assert.equal(clockRows[0]?.clock_id, 'causal-v2');
      assert.equal(Number.isSafeInteger(clockRows[0]?.last_wall_ms), true);
      const after = {
        protocol: (migrated.raw().prepare('SELECT protocol_hash, protocol_json FROM causal_protocols WHERE study_id = ?')
          .get(protocol.studyId) as { protocol_hash: string; protocol_json: string }),
        execution: (migrated.raw().prepare('SELECT event_hash, execution_json FROM causal_executions_v2 WHERE execution_id = ?')
          .get(execution.executionId) as { event_hash: string; execution_json: string }),
        outcome: (migrated.raw().prepare('SELECT event_hash, terminal_outcome_json FROM causal_terminal_outcomes_v2 WHERE outcome_id = ?')
          .get(outcome.outcomeId) as { event_hash: string; terminal_outcome_json: string }),
      };
      assert.deepEqual(after, before);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partial Slice 4 terminal schema is not adopted or repaired in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-s4-partial-'));
  const dbPath = join(dir, 'partial.sqlite');
  try {
    const seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TABLE causal_terminal_outcomes_v2').run();
    seeded.close();
    const retained = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(causalV2SchemaAttestation(retained).state, 'incomplete');
    } finally {
      retained.close();
    }
    assert.throws(() => new Store(dbPath), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CAUSAL_IO_FAILURE:/);
      assert.doesNotMatch(error.message, /CREATE TABLE|sqlite_master|trigger body/i);
      return true;
    });
    const original = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(causalV2SchemaAttestation(original).state, 'incomplete');
      const missing = original.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'causal_terminal_outcomes_v2'",
      ).get() as { present: number } | undefined;
      assert.equal(missing, undefined);
    } finally {
      original.close();
    }
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('partial.sqlite.pre-causal-v2-')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LOOKALIKE_V2_COLUMNS = {
  causal_assignment_plans_v2: [
    'study_id', 'block_id', 'protocol_hash', 'sequence', 'created_at_ms',
    'block_root', 'allocation_hash', 'material_digest', 'plan_hash',
    'entropy_blob', 'plan_json',
  ],
  causal_decisions_v2: [
    'decision_id', 'study_id', 'block_id', 'block_sequence', 'decision_index',
    'unit_id_digest', 'assigned_arm_id', 'event_hash', 'decision_json',
  ],
  causal_assignment_units_v2: [
    'study_id', 'unit_id_digest', 'decision_id', 'block_id', 'block_sequence',
    'claimed_at_ms',
  ],
  causal_assignment_manifests_v2: [
    'study_id', 'generation', 'protocol_hash', 'manifest_hash', 'manifest_json',
  ],
} as const;

function createExactNameUnsafeV2Lookalike(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(LOOKALIKE_V2_COLUMNS)) {
    db.prepare(
      'CREATE TABLE ' + table + ' (' + columns.map((column) => column + ' TEXT').join(', ') + ')',
    ).run();
    db.prepare(
      'CREATE TRIGGER causal_no_update_' + table + ' BEFORE UPDATE ON ' + table +
      ' BEGIN SELECT 1; END',
    ).run();
    db.prepare(
      'CREATE TRIGGER causal_no_delete_' + table + ' BEFORE DELETE ON ' + table +
      ' BEGIN SELECT 1; END',
    ).run();
  }
}

test('causal v2 schema attestation rejects exact-name nullable no-constraint tables and shadow triggers', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createExactNameUnsafeV2Lookalike(db);
    assert.equal(causalV2SchemaComplete(db), false);
  } finally {
    db.close();
  }
});

test('causal v2 schema attestation reports an extra-only generation as incomplete', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.prepare('CREATE TABLE causal_shadow_v2 (value TEXT)').run();
    const attestation = causalV2SchemaAttestation(db);
    assert.equal(attestation.state, 'incomplete');
    assert.ok(attestation.defectIds.includes('CAUSAL_V2_EXTRA_TABLE'));
    assert.equal(causalV2SchemaComplete(db), false);
  } finally {
    db.close();
  }
});

test('file-backed exact-name schema lookalike is backed up before atomic refusal and never opens operationally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-schema-lookalike-'));
  const dbPath = join(dir, 'lookalike.sqlite');
  const seed = new DatabaseSync(dbPath);
  createExactNameUnsafeV2Lookalike(seed);
  seed.prepare('CREATE TABLE retained_probe (value TEXT NOT NULL)').run();
  seed.prepare('INSERT INTO retained_probe (value) VALUES (?)').run('retained');
  seed.close();

  let opened: Store | null = null;
  let thrown: unknown;
  try {
    opened = new Store(dbPath);
  } catch (error) {
    thrown = error;
  } finally {
    opened?.close();
  }

  try {
    assert.equal(opened, null, 'unsafe lookalike must never become an operational Store');
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /CAUSAL_IO_FAILURE/i);
    assert.doesNotMatch(thrown.message, /CREATE TABLE|sqlite_master|trigger body/i);
    const backups = readdirSync(dir).filter((name) => name.startsWith('lookalike.sqlite.pre-causal-v2-'));
    assert.equal(backups.length, 1, 'verified backup must precede the failed additive repair');
    const backup = new DatabaseSync(join(dir, backups[0]!), { readOnly: true });
    try {
      assert.equal((backup.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok');
      assert.equal((backup.prepare('SELECT value FROM retained_probe').get() as { value: string }).value, 'retained');
      assert.equal(causalV2SchemaComplete(backup), false);
    } finally {
      backup.close();
    }
    const original = new DatabaseSync(dbPath);
    try {
      assert.equal((original.prepare('SELECT value FROM retained_probe').get() as { value: string }).value, 'retained');
      assert.equal(causalV2SchemaComplete(original), false);
      const rows = original.prepare('SELECT COUNT(*) AS count FROM causal_assignment_units_v2').get() as { count: number };
      assert.equal(rows.count, 0);
    } finally {
      original.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface CausalDdlAuthorityVariant {
  name: string;
  mutate(db: DatabaseSync): void;
  verifyPreserved(db: DatabaseSync): void;
}

function requiredSchemaSql(db: DatabaseSync, type: 'table' | 'index', name: string): string {
  const row = db.prepare(
    'SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?',
  ).get(type, name) as { sql: string | null } | undefined;
  assert.ok(row && typeof row.sql === 'string', 'expected retained sqlite_schema.sql for ' + type + ' ' + name);
  return row.sql;
}

function replaceRequired(source: string, expected: string, replacement: string): string {
  assert.ok(source.includes(expected), 'canonical DDL fixture is missing expected segment: ' + expected);
  return source.replace(expected, replacement);
}

function replaceRequiredPattern(source: string, expected: RegExp, replacement: string): string {
  const altered = source.replace(expected, replacement);
  assert.notEqual(altered, source, 'canonical DDL fixture is missing expected pattern: ' + String(expected));
  return altered;
}

function recreateAppendOnlyTriggers(db: DatabaseSync, table: string): void {
  for (const operation of ['UPDATE', 'DELETE'] as const) {
    db.prepare(
      'CREATE TRIGGER causal_no_' + operation.toLowerCase() + '_' + table +
      ' BEFORE ' + operation + ' ON ' + table +
      " BEGIN SELECT RAISE(ABORT, 'causal evidence is append-only'); END",
    ).run();
  }
}

function replaceTableDdl(
  db: DatabaseSync,
  table: string,
  transform: (sql: string) => string,
): void {
  const tableSql = requiredSchemaSql(db, 'table', table);
  const explicitIndexes = db.prepare(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
  ).all(table) as Array<{ name: string; sql: string }>;
  db.prepare('DROP TABLE ' + table).run();
  db.prepare(transform(tableSql)).run();
  for (const index of explicitIndexes) db.prepare(index.sql).run();
  recreateAppendOnlyTriggers(db, table);
}

function renameExplicitIndex(db: DatabaseSync, currentName: string, wrongName: string): void {
  const sql = requiredSchemaSql(db, 'index', currentName);
  db.prepare('DROP INDEX ' + currentName).run();
  db.prepare(replaceRequired(sql, currentName, wrongName)).run();
}

const CAUSAL_DDL_AUTHORITY_VARIANTS: CausalDdlAuthorityVariant[] = [
  {
    name: 'primary key ON CONFLICT REPLACE',
    mutate(db) {
      replaceTableDdl(db, 'causal_assignment_units_v2', (sql) => replaceRequired(
        sql,
        'PRIMARY KEY (study_id, unit_id_digest)',
        'PRIMARY KEY (study_id, unit_id_digest) ON CONFLICT REPLACE',
      ));
      const insert = db.prepare(
        'INSERT INTO causal_assignment_units_v2 ' +
        '(study_id, unit_id_digest, decision_id, block_id, block_sequence, claimed_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      );
      insert.run('study:ddl', D('1'), 'decision:first', 'block:first', 1, 1_700_000_001_000);
      insert.run('study:ddl', D('1'), 'decision:replacement', 'block:replacement', 2, 1_700_000_002_000);
    },
    verifyPreserved(db) {
      const rows = db.prepare(
        'SELECT decision_id FROM causal_assignment_units_v2 WHERE study_id = ? AND unit_id_digest = ?',
      ).all('study:ddl', D('1')) as Array<{ decision_id: string }>;
      assert.deepEqual(rows.map((row) => row.decision_id), ['decision:replacement']);
    },
  },
  ...(['IGNORE', 'REPLACE'] as const).map((policy): CausalDdlAuthorityVariant => ({
    name: 'unique sequence ON CONFLICT ' + policy,
    mutate(db) {
      replaceTableDdl(db, 'causal_assignment_plans_v2', (sql) => replaceRequired(
        sql,
        'UNIQUE (study_id, sequence)',
        'UNIQUE (study_id, sequence) ON CONFLICT ' + policy,
      ));
    },
    verifyPreserved(db) {
      assert.match(requiredSchemaSql(db, 'table', 'causal_assignment_plans_v2'), new RegExp('ON CONFLICT ' + policy));
    },
  })),
  {
    name: 'extra CHECK constraint',
    mutate(db) {
      replaceTableDdl(db, 'causal_assignment_units_v2', (sql) => {
        const close = sql.lastIndexOf(')');
        assert.ok(close > 0);
        return sql.slice(0, close) + ', CHECK (claimed_at_ms > 0)' + sql.slice(close);
      });
    },
    verifyPreserved(db) {
      assert.match(requiredSchemaSql(db, 'table', 'causal_assignment_units_v2'), /CHECK \(claimed_at_ms > 0\)/);
    },
  },
  {
    name: 'inline foreign key',
    mutate(db) {
      replaceTableDdl(db, 'causal_assignment_units_v2', (sql) => replaceRequiredPattern(
        sql,
        /decision_id\s+TEXT NOT NULL UNIQUE,/,
        'decision_id TEXT NOT NULL UNIQUE REFERENCES causal_decisions_v2(decision_id),',
      ));
    },
    verifyPreserved(db) {
      const foreignKeys = db.prepare('PRAGMA foreign_key_list(causal_assignment_units_v2)').all();
      assert.equal(foreignKeys.length, 1);
    },
  },
  {
    name: 'wrong decisions explicit index name',
    mutate(db) {
      renameExplicitIndex(db, 'idx_causal_decisions_v2_study', 'idx_wrong_decisions_v2_study');
    },
    verifyPreserved(db) {
      assert.match(requiredSchemaSql(db, 'index', 'idx_wrong_decisions_v2_study'), /idx_wrong_decisions_v2_study/);
    },
  },
  {
    name: 'wrong manifest explicit index name',
    mutate(db) {
      renameExplicitIndex(db, 'idx_causal_assignment_manifests_v2_current', 'idx_wrong_manifests_v2_current');
    },
    verifyPreserved(db) {
      assert.match(requiredSchemaSql(db, 'index', 'idx_wrong_manifests_v2_current'), /idx_wrong_manifests_v2_current/);
    },
  },
];

for (const variant of CAUSAL_DDL_AUTHORITY_VARIANTS) {
  test('causal v2 DDL authority rejects ' + variant.name + ' with backup-first atomic refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-ddl-authority-'));
    const dbPath = join(dir, 'authority.sqlite');
    try {
      const setup = new Store(dbPath);
      try {
        setup.raw().prepare('CREATE TABLE retained_ddl_probe (value TEXT NOT NULL)').run();
        setup.raw().prepare('INSERT INTO retained_ddl_probe (value) VALUES (?)').run(variant.name);
      } finally {
        setup.close();
      }

      const seed = new DatabaseSync(dbPath);
      try {
        variant.mutate(seed);
        assert.equal(causalV2SchemaComplete(seed), false, 'altered checked-in DDL must attest incomplete');
        variant.verifyPreserved(seed);
      } finally {
        seed.close();
      }

      let opened: Store | null = null;
      let thrown: unknown;
      try {
        opened = new Store(dbPath);
      } catch (error) {
        thrown = error;
      } finally {
        opened?.close();
      }
      assert.equal(opened, null, 'altered DDL must never reach an operational Store');
      assert.ok(thrown instanceof Error);
      assert.match(thrown.message, /CAUSAL_IO_FAILURE/i);
      assert.match(thrown.message, /verified backup|recovery/i);
      assert.doesNotMatch(thrown.message, /CREATE TABLE|CREATE INDEX|ON CONFLICT|CHECK|FOREIGN KEY/i);

      const backups = readdirSync(dir).filter((name) => name.startsWith('authority.sqlite.pre-causal-v2-'));
      assert.equal(backups.length, 1, 'verified backup must precede DDL-authority refusal');
      for (const candidate of [dbPath, join(dir, backups[0]!)]) {
        const retained = new DatabaseSync(candidate, { readOnly: true });
        try {
          assert.equal((retained.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok');
          assert.equal(
            (retained.prepare('SELECT value FROM retained_ddl_probe').get() as { value: string }).value,
            variant.name,
          );
          assert.equal(causalV2SchemaComplete(retained), false);
          variant.verifyPreserved(retained);
        } finally {
          retained.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

async function spawnStoreConstructorProbe(dbPath: string): Promise<{
  child: ReturnType<typeof spawn>;
  outcome: { opened: boolean; message: string };
  stderr: () => string;
}> {
  const storeUrl = pathToFileURL(resolve('src/store/db.ts')).href;
  const script = [
    'import { Store } from ' + JSON.stringify(storeUrl) + ';',
    'const dbPath = ' + JSON.stringify(dbPath) + ';',
    'let outcome;',
    'try {',
    '  const store = new Store(dbPath);',
    '  store.close();',
    "  outcome = { opened: true, message: '' };",
    '} catch (error) {',
    "  outcome = { opened: false, message: error instanceof Error ? error.message : String(error) };",
    '}',
    "process.stdout.write(JSON.stringify(outcome) + '\\n');",
    'process.stdin.resume();',
    "await new Promise((resolve) => process.stdin.once('end', resolve));",
  ].join('\n');
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--input-type=module',
    '--eval',
    script,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let standardError = '';
  child.stderr.on('data', (chunk: string) => {
    standardError += chunk;
  });
  const outcome = await new Promise<{ opened: boolean; message: string }>((resolveOutcome, rejectOutcome) => {
    let standardOutput = '';
    child.stdout.on('data', (chunk: string) => {
      standardOutput += chunk;
      const newline = standardOutput.indexOf('\n');
      if (newline === -1) return;
      try {
        resolveOutcome(JSON.parse(standardOutput.slice(0, newline)) as { opened: boolean; message: string });
      } catch (error) {
        rejectOutcome(error);
      }
    });
    child.once('error', rejectOutcome);
    child.once('exit', (code) => {
      rejectOutcome(new Error(
        'Store constructor probe exited before the hold release: ' + String(code) + ' ' + standardError,
      ));
    });
  });
  return { child, outcome, stderr: () => standardError };
}

async function stopStoreConstructorProbe(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
  });
  child.stdin!.end();
  await exited;
}

function renameExplicitIndexQuoted(db: DatabaseSync, currentName: string, hostileName: string): void {
  const sql = requiredSchemaSql(db, 'index', currentName);
  const quotedName = '"' + hostileName.replaceAll('"', '""') + '"';
  db.prepare('DROP INDEX ' + currentName).run();
  db.prepare(replaceRequired(sql, currentName, quotedName)).run();
}

for (const hostileName of ['odd index', 'odd)name', 'odd-name', 'odd.name']) {
  test('causal v2 hostile index metadata ' + JSON.stringify(hostileName) +
    ' is total, backed up, redacted, and closes the failed Store handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiscus-causal-hostile-index-'));
    const dbPath = join(dir, 'authority.sqlite');
    const renamedPath = dbPath + '.closed-handle-probe';
    let probe: Awaited<ReturnType<typeof spawnStoreConstructorProbe>> | null = null;
    try {
      const setup = new Store(dbPath);
      try {
        setup.raw().prepare('CREATE TABLE retained_hostile_index_probe (value TEXT NOT NULL)').run();
        setup.raw().prepare('INSERT INTO retained_hostile_index_probe (value) VALUES (?)').run(hostileName);
      } finally {
        setup.close();
      }

      let directState: string | null = null;
      let directError: string | null = null;
      const seed = new DatabaseSync(dbPath);
      try {
        renameExplicitIndexQuoted(seed, 'idx_causal_decisions_v2_study', hostileName);
        try {
          directState = causalV2SchemaAttestation(seed).state;
        } catch (error) {
          directError = error instanceof Error ? error.message : String(error);
        }
      } finally {
        seed.close();
      }

      probe = await spawnStoreConstructorProbe(dbPath);
      const failures: string[] = [];
      if (directError !== null) failures.push('direct attestation threw: ' + directError);
      if (directState !== 'incomplete') failures.push('direct attestation state was ' + String(directState));
      if (probe.outcome.opened) failures.push('hostile metadata opened an operational Store');
      if (!/^CAUSAL_IO_FAILURE:/.test(probe.outcome.message)) {
        failures.push('Store failure was not typed: ' + probe.outcome.message);
      }
      if (probe.outcome.message.includes(hostileName)) {
        failures.push('Store failure disclosed the hostile index name: ' + probe.outcome.message);
      }
      if (/\bnear\b|syntax|index_xinfo|sql logic|err_sqlite/i.test(probe.outcome.message)) {
        failures.push('Store failure disclosed raw SQLite diagnostics: ' + probe.outcome.message);
      }
      if (probe.stderr() !== '') failures.push('Store probe wrote stderr: ' + probe.stderr());

      const backups = readdirSync(dir).filter((name) => name.startsWith('authority.sqlite.pre-causal-v2-'));
      if (backups.length !== 1) failures.push('verified sibling backup count was ' + String(backups.length));
      if (backups.length === 1) {
        for (const candidate of [dbPath, join(dir, backups[0]!)]) {
          const retained = new DatabaseSync(candidate, { readOnly: true });
          try {
            const quickCheck = retained.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
            if (quickCheck?.quick_check !== 'ok') failures.push(candidate + ' failed quick_check');
            const probeRow = retained.prepare(
              'SELECT value FROM retained_hostile_index_probe',
            ).get() as { value: string } | undefined;
            if (probeRow?.value !== hostileName) failures.push(candidate + ' lost the retained probe');
            const indexRow = retained.prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND name = ?",
            ).get('causal_decisions_v2', hostileName) as { name: string } | undefined;
            if (indexRow?.name !== hostileName) failures.push(candidate + ' lost the hostile authority');
            const attestation = causalV2SchemaAttestation(retained);
            if (attestation.state !== 'incomplete') failures.push(candidate + ' no longer attested incomplete');
          } catch (error) {
            failures.push(candidate + ' was not preserved/readable: ' +
              (error instanceof Error ? error.message : String(error)));
          } finally {
            retained.close();
          }
        }
      }

      try {
        renameSync(dbPath, renamedPath);
        renameSync(renamedPath, dbPath);
      } catch (error) {
        failures.push('failed constructor retained an open database handle: ' +
          (error instanceof Error ? error.message : String(error)));
      } finally {
        if (!existsSync(dbPath) && existsSync(renamedPath)) renameSync(renamedPath, dbPath);
      }

      assert.deepEqual(failures, []);
    } finally {
      if (probe) await stopStoreConstructorProbe(probe.child);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
