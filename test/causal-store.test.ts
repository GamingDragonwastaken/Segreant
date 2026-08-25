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
import { canonicalJson, causalEventHash, commitCausalProtocol } from '../src/causal/protocol.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  CAUSAL_PROTOCOL_VERSION_V2,
  type CausalExecutionRecord,
  type CausalOutcomeRecord,
  type CausalStudyProtocolDraft,
  type CausalStudyProtocolDraftV2,
  type CommittedCausalStudyProtocolV2,
} from '../src/causal/types.ts';
import { Store } from '../src/store/db.ts';
import { causalV2SchemaAttestation, causalV2SchemaComplete } from '../src/store/schema.ts';
import { createRetainedCausalV1AssignmentFixture } from './support/causalV1Fixture.ts';

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
