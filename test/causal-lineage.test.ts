/**
 * T-069: Store-internal causal request/realization lineage.
 *
 * These tests intentionally exercise only metadata and scalar evidence.  A
 * binding must never contain prompts, source text, or realization unit_json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { causalExecutionV2EventHash, causalTerminalOutcomeV2EventHash, decodeCausalExecutionV2, ordinaryLedgerVerifierHash } from '../src/causal/records.ts';
import { commitCausalProtocol } from '../src/causal/protocol.ts';
import {
  appendCausalLineageBindingV2,
  causalRequestPricingDigestV2,
  validateCausalLineageBindingV2,
  causalLineageBindingDigestV2,
  causalRealizationSnapshotDigestV2,
  type CausalLineageBindingV2,
} from '../src/store/causalLineage.ts';
import { type CausalExecutionRecordV2, type CausalStudyProtocolDraftV2, type CommittedCausalStudyProtocolV2 } from '../src/causal/types.ts';
import { Store, type RequestRow } from '../src/store/db.ts';
import { causalQualificationV2 } from '../src/store/causal.ts';

const H = (char: string): string => char.repeat(64);
const D = (char: string): string => 'sha256:' + H(char);
const COMMIT = 'a'.repeat(40);

function protocol(studyId: string): CommittedCausalStudyProtocolV2 {
  const draft: CausalStudyProtocolDraftV2 = {
    type: 'fiscus.causal-study',
    version: 2,
    studyId,
    seriesId: 'series:' + studyId.slice(studyId.indexOf(':') + 1),
    studyVersion: 1,
    ownerId: 'owner:test',
    scopeId: 'scope:test',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:test',
      contextSchemaId: 'schema:test',
      unitOfAssignment: 'task',
      inclusionRuleIds: ['rule:include'],
      exclusionRuleIds: [],
    },
    studyWindow: { startsAtMs: 1_700_000_001_000, endsAtMs: null },
    stoppingRule: { kind: 'fixed_enrollment', maxAssignments: 4 },
    arms: [
      { armId: 'arm:test', role: 'candidate', executionPlanDigest: D('1'), providerId: 'provider:openai', modelId: 'model:test' },
      { armId: 'arm:control', role: 'control', executionPlanDigest: D('2'), providerId: 'provider:openai', modelId: 'model:control' },
    ],
    allocation: { method: 'blocked_randomized_equal_allocation', probabilityPerArm: 0.5, blockSize: 4 },
    costOutcome: {
      metricId: 'metric:direct-cost-usd',
      currency: 'USD',
      boundsUsd: { low: 0, high: 100 },
      acceptedSourceClasses: ['actual_observed'],
      priceLineageRule: 'every_included_cost_has_retained_sha256_lineage',
    },
    qualityOutcome: {
      metricId: 'metric:quality',
      collectionMethodId: 'method:deterministic',
      bounds: { low: 0, high: 1 },
      evidenceClass: 'deterministic',
      nonInferiorityMargin: 0.05,
    },
    economicOutcome: null,
    analysis: {
      estimand: 'intention_to_treat',
      confidenceLevel: 0.95,
      minCompletedPerArm: 1,
      maxMissingFractionPerArm: 0.25,
      exclusionPolicyId: 'policy:fixed',
    },
    dataGovernance: {
      minimizedSourceIds: ['source:ledger-metadata'],
      retentionClassId: 'retention:causal-minimal',
      egressReceiptDigests: [],
    },
    claimTemplateIds: {
      qualified: 'claim:qualified',
      inconclusive: 'claim:inconclusive',
      invalid: 'claim:invalid',
    },
  };
  return commitCausalProtocol(draft, 1_700_000_000_500) as CommittedCausalStudyProtocolV2;
}

function requestRow(
  requestId: string,
  tsEpochMs: number,
  declarationId: string,
  provider: string,
  model: string,
  costUsd = 1,
): RequestRow {
  return {
    requestId,
    sessionId: 'session:lineage',
    tsEpochMs,
    provider,
    model,
    project: 'project:lineage',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 10,
    via: 'proxy',
    pricing: {
      costBasis: 'tool_reported_unverified',
      rateCardSha256: null,
      rateCardSourceKind: 'none',
      rateMatchKind: 'reported',
      rateMatchProvider: null,
      rateMatchModel: null,
    },
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: declarationId,
    attributionBasis: 'client_declared',
  };
}

function appendFixture(store: Store, studyId: string): {
  protocol: CommittedCausalStudyProtocolV2;
  execution: CausalExecutionRecordV2;
  binding: CausalLineageBindingV2;
} {
  const committed = protocol(studyId);
  assert.equal(store.registerCausalProtocol(committed), 'created');
  const declaration = store.setOpenAiScope({
    billingAccountRef: 'acct:lineage',
    providerProjectRef: 'project:lineage',
    upstreamBase: 'https://api.openai.com/v1',
    declaredAtMs: 1_700_000_001_000,
    activatedAtMs: 1_700_000_001_000,
  });
  const assignment = store.assignCausalBlockV2({
    studyId,
    blockId: 'block:lineage',
    createdAtMs: 1_700_000_001_001,
    unitIdDigests: [D('3'), D('4'), D('5'), D('6')],
  });
  const decision = assignment.block.decisions[0]!;
  const assignedArm = committed.arms.find((arm) => arm.armId === decision.assignedArmId)!;
  const verifierMaterial = {
    type: 'fiscus.causal-ordinary-ledger-verifier' as const,
    version: 2 as const,
    state: 'unresolved' as const,
    checkedAtMs: null,
    requestCount: 0 as const,
    evidenceManifestHash: null,
    reasonCodes: ['task4_not_implemented' as const],
  };
  const executionMaterial: Omit<CausalExecutionRecordV2, 'eventHash'> = {
    type: 'fiscus.causal-execution',
    version: 2,
    executionId: 'execution:lineage',
    decisionId: decision.decisionId,
    studyId,
    protocolHash: committed.protocolHash,
    startedAtMs: decision.assignedAtMs + 1,
    completedAtMs: decision.assignedAtMs + 5,
    assignedExecutionPlanDigest: assignedArm.executionPlanDigest,
    actualExecutionPlanDigest: assignedArm.executionPlanDigest,
    adherence: 'confirmed',
    requestIds: ['request:lineage'],
    directAiCostUsd: 1,
    directCostSourceClass: 'actual_observed',
    priceLineageDigests: [causalRequestPricingDigestV2({
      requestId: 'request:lineage',
      tsEpochMs: decision.assignedAtMs + 2,
      provider: assignedArm.providerId!,
      model: assignedArm.modelId!,
      project: 'project:lineage',
      costMicros: 1_000_000,
      costBasis: 'tool_reported_unverified',
      rateCardSha256: null,
      rateCardSourceKind: 'none',
      rateMatchKind: 'reported',
      rateMatchProvider: null,
      rateMatchModel: null,
      scopeCaptureStatus: 'declared_unverified',
      providerScopeDeclarationId: declaration.declarationId,
    })],
    fullArmCostUsd: null,
    fullCostSourceClass: 'incomplete_or_unknown',
    ordinaryLedgerVerifier: {
      ...verifierMaterial,
      resultHash: ordinaryLedgerVerifierHash(verifierMaterial),
    },
    previousEventHash: decision.eventHash,
  };
  const execution: CausalExecutionRecordV2 = {
    ...executionMaterial,
    eventHash: causalExecutionV2EventHash(executionMaterial),
  };
  decodeCausalExecutionV2(execution);
  assert.equal(store.appendCausalExecutionV2(execution), 'created');
  const outcomeMaterial = {
    type: 'fiscus.causal-terminal-outcome' as const,
    version: 2 as const,
    outcomeId: 'outcome:lineage',
    decisionId: decision.decisionId,
    studyId,
    protocolHash: committed.protocolHash,
    observedAtMs: execution.completedAtMs + 1,
    maturity: 'matured' as const,
    qualityValue: 0.9,
    qualityEvidenceClass: 'deterministic' as const,
    economicValueUsd: null,
    economicEvidenceClass: null,
    outcomeEvidenceDigests: [D('8')],
    censoredReason: null,
    invalidReason: null,
    previousEventHash: execution.eventHash,
  };
  assert.equal(store.appendCausalTerminalOutcomeV2({ ...outcomeMaterial, eventHash: causalTerminalOutcomeV2EventHash(outcomeMaterial) }), 'created');
  store.insertRequest(requestRow(
    'request:lineage',
    execution.startedAtMs + 1,
    declaration.declarationId,
    assignedArm.providerId!,
    assignedArm.modelId!,
  ));
  store.raw().prepare(
    `INSERT INTO realization_units
       (commit_hash, project, ts_epoch_ms, computed_at_ms, attributed_cost_usd, maturing, realized, unit_json, cost_scope, cost_stale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(COMMIT, 'project:lineage', execution.completedAtMs + 2, execution.completedAtMs + 3, 1, 0, 1, '{}', 'project', 0);
  const realizationSnapshotDigest = causalRealizationSnapshotDigestV2({
    commitHash: COMMIT,
    project: 'project:lineage',
    tsEpochMs: execution.completedAtMs + 2,
    computedAtMs: execution.completedAtMs + 3,
    attributedCostUsd: 1,
    maturing: false,
    realized: true,
    costScope: 'project',
    costStale: false,
  });
  const bindingMaterial = {
    type: 'fiscus.causal-lineage-binding' as const,
    version: 2 as const,
    bindingId: 'lineage:lineage',
    studyId,
    protocolHash: committed.protocolHash,
    decisionId: decision.decisionId,
    executionId: execution.executionId,
    outcomeId: 'outcome:lineage',
    unitIdDigest: decision.unitIdDigest,
    requestIds: [...execution.requestIds],
    realizationCommitHash: COMMIT,
    realizationSnapshotDigest,
  };
  const binding: CausalLineageBindingV2 = {
    ...bindingMaterial,
    bindingDigest: causalLineageBindingDigestV2(bindingMaterial),
  };
  return { protocol: committed, execution, binding };
}

/** Fill the remaining randomized decisions so qualification reaches its
 * inconclusive gate instead of the earlier collecting state. */
function completeRemainingFixture(store: Store, committed: CommittedCausalStudyProtocolV2): void {
  const declaration = store.raw().prepare(
    'SELECT declaration_id AS declarationId FROM provider_scope_declarations ORDER BY declared_at_ms LIMIT 1',
  ).get() as { declarationId: string };
  const decisions = store.raw().prepare(
    `SELECT decision_json AS decisionJson FROM causal_decisions_v2
       WHERE study_id = ? ORDER BY block_sequence, decision_index`,
  ).all(committed.studyId) as Array<{ decisionJson: string }>;
  for (const [index, row] of decisions.entries()) {
    if (index === 0) continue;
    const decision = JSON.parse(row.decisionJson) as {
      decisionId: string;
      assignedArmId: string;
      assignedAtMs: number;
      eventHash: string;
      unitIdDigest: string;
    };
    const arm = committed.arms.find((candidate) => candidate.armId === decision.assignedArmId)!;
    const verifierMaterial = {
      type: 'fiscus.causal-ordinary-ledger-verifier' as const,
      version: 2 as const,
      state: 'unresolved' as const,
      checkedAtMs: null,
      requestCount: 0 as const,
      evidenceManifestHash: null,
      reasonCodes: ['task4_not_implemented' as const],
    };
    const executionMaterial: Omit<CausalExecutionRecordV2, 'eventHash'> = {
      type: 'fiscus.causal-execution',
      version: 2,
      executionId: `execution:lineage-${index}`,
      decisionId: decision.decisionId,
      studyId: committed.studyId,
      protocolHash: committed.protocolHash,
      startedAtMs: decision.assignedAtMs + 1,
      completedAtMs: decision.assignedAtMs + 5,
      assignedExecutionPlanDigest: arm.executionPlanDigest,
      actualExecutionPlanDigest: arm.executionPlanDigest,
      adherence: 'confirmed',
      requestIds: [`request:lineage-${index}`],
      directAiCostUsd: 1,
      directCostSourceClass: 'actual_observed',
      priceLineageDigests: [D('9')],
      fullArmCostUsd: null,
      fullCostSourceClass: 'incomplete_or_unknown',
      ordinaryLedgerVerifier: {
        ...verifierMaterial,
        resultHash: ordinaryLedgerVerifierHash(verifierMaterial),
      },
      previousEventHash: decision.eventHash,
    };
    const execution = { ...executionMaterial, eventHash: causalExecutionV2EventHash(executionMaterial) };
    decodeCausalExecutionV2(execution);
    assert.equal(store.appendCausalExecutionV2(execution), 'created');
    const outcomeMaterial = {
      type: 'fiscus.causal-terminal-outcome' as const,
      version: 2 as const,
      outcomeId: `outcome:lineage-${index}`,
      decisionId: decision.decisionId,
      studyId: committed.studyId,
      protocolHash: committed.protocolHash,
      observedAtMs: execution.completedAtMs + 1,
      maturity: 'matured' as const,
      qualityValue: 0.9,
      qualityEvidenceClass: 'deterministic' as const,
      economicValueUsd: null,
      economicEvidenceClass: null,
      outcomeEvidenceDigests: [D('8')],
      censoredReason: null,
      invalidReason: null,
      previousEventHash: execution.eventHash,
    };
    assert.equal(store.appendCausalTerminalOutcomeV2({
      ...outcomeMaterial,
      eventHash: causalTerminalOutcomeV2EventHash(outcomeMaterial),
    }), 'created');
    store.insertRequest(requestRow(
      `request:lineage-${index}`,
      execution.startedAtMs + 1,
      declaration.declarationId,
      arm.providerId!,
      arm.modelId!,
    ));
  }
}

test('T-069 RED/GREEN contract: unresolved ordinary ledger evidence cannot validate a lineage binding', () => {
  const store = new Store(':memory:');
  try {
    const fixture = appendFixture(store, 'study:lineage-unresolved');
    const result = validateCausalLineageBindingV2(store.raw(), fixture.binding);
    assert.equal(result.state, 'invalid');
    assert.ok(result.reasonCodes.includes('ledger_verification_unresolved'), result.reasonCodes.join(','));
    assert.equal(result.bindingDigest, fixture.binding.bindingDigest);
    assert.equal(result.requestCount, 1);
    assert.equal(result.actualCostUsd, null);
  } finally {
    store.close();
  }
});

test('T-069 appends one scalar sidecar, authenticates idempotent reload, and preserves the unresolved ledger gate', () => {
  const store = new Store(':memory:');
  try {
    const fixture = appendFixture(store, 'study:lineage-sidecar');
    assert.equal(store.appendCausalLineageBindingV2(fixture.binding), 'created');
    assert.equal(store.appendCausalLineageBindingV2(fixture.binding), 'existing');
    assert.deepEqual(store.causalLineageBindingsV2(fixture.protocol.studyId), [fixture.binding]);

    const row = store.raw().prepare(
      `SELECT request_ids_json AS requestIdsJson, binding_json AS bindingJson
         FROM causal_lineage_bindings_v2 WHERE binding_id = ?`,
    ).get(fixture.binding.bindingId) as { requestIdsJson: string; bindingJson: string };
    assert.equal(row.requestIdsJson, '["request:lineage"]');
    assert.doesNotMatch(row.bindingJson, /prompt|source|unit_json/i);
    const validation = validateCausalLineageBindingV2(store.raw(), fixture.binding);
    assert.equal(validation.state, 'invalid');
    assert.deepEqual(validation.reasonCodes, ['ledger_verification_unresolved']);
  } finally {
    store.close();
  }
});

test('T-069 sidecar update and delete are refused by physical append-only triggers', () => {
  const store = new Store(':memory:');
  try {
    const fixture = appendFixture(store, 'study:lineage-immutable');
    assert.equal(appendCausalLineageBindingV2(store.raw(), fixture.binding), 'created');
    assert.throws(
      () => store.raw().prepare(
        'UPDATE causal_lineage_bindings_v2 SET binding_json = binding_json WHERE binding_id = ?',
      ).run(fixture.binding.bindingId),
      /causal evidence is append-only/i,
    );
    assert.throws(
      () => store.raw().prepare(
        'DELETE FROM causal_lineage_bindings_v2 WHERE binding_id = ?',
      ).run(fixture.binding.bindingId),
      /causal evidence is append-only/i,
    );
    assert.equal(
      (store.raw().prepare('SELECT COUNT(*) AS count FROM causal_lineage_bindings_v2').get() as { count: number }).count,
      1,
    );
  } finally {
    store.close();
  }
});

test('T-069 sidecar reload fails closed when canonical JSON is tampered behind a restored trigger', () => {
  const store = new Store(':memory:');
  try {
    const fixture = appendFixture(store, 'study:lineage-tamper');
    assert.equal(appendCausalLineageBindingV2(store.raw(), fixture.binding), 'created');
    const row = store.raw().prepare(
      'SELECT binding_json AS bindingJson FROM causal_lineage_bindings_v2 WHERE binding_id = ?',
    ).get(fixture.binding.bindingId) as { bindingJson: string };
    const altered = row.bindingJson.replace('lineage:lineage', 'lineage:tampered');
    assert.notEqual(altered, row.bindingJson);
    store.raw().prepare('DROP TRIGGER causal_no_update_causal_lineage_bindings_v2').run();
    store.raw().prepare(
      'UPDATE causal_lineage_bindings_v2 SET binding_json = ? WHERE binding_id = ?',
    ).run(altered, fixture.binding.bindingId);
    store.raw().prepare(
      `CREATE TRIGGER causal_no_update_causal_lineage_bindings_v2
         BEFORE UPDATE ON causal_lineage_bindings_v2
         BEGIN SELECT RAISE(ABORT, 'causal evidence is append-only'); END`,
    ).run();
    assert.throws(
      () => store.causalLineageBindingsV2(fixture.protocol.studyId),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && (error as { code?: unknown }).code === 'CAUSAL_INTEGRITY_FAILURE',
    );
  } finally {
    store.close();
  }
});

test('T-069 qualification rejects a semantically invalid persisted sidecar before pending evidence can hide it', () => {
  const store = new Store(':memory:');
  try {
    const fixture = appendFixture(store, 'study:lineage-qualification-tamper');
    assert.equal(store.appendCausalLineageBindingV2(fixture.binding), 'created');
    store.raw().prepare(
      `UPDATE requests SET via = 'import', estimated = 1, cost_basis = 'local_list_price',
         rate_card_source_kind = 'bundled', rate_match_kind = 'exact_provider',
         scope_capture_status = 'unscoped', provider_scope_declaration_id = NULL
       WHERE request_id = ?`,
    ).run('request:lineage');
    const result = causalQualificationV2(store.raw(), fixture.protocol.studyId);
    assert.equal(result.state, 'invalid');
    assert.ok(result.reasons.includes('V2 request-to-realization lineage binding failed validation'));
  } finally {
    store.close();
  }
});

test('T-069 rejects imported, modeled, unpriced, or scope-unresolved request rows', () => {
  const store = new Store(':memory:');
  try {
    const fixture = appendFixture(store, 'study:lineage-request-gates');
    const request = store.raw().prepare('SELECT request_id FROM requests WHERE request_id = ?').get('request:lineage') as { request_id: string };
    assert.equal(request.request_id, 'request:lineage');
    store.raw().prepare(
      `UPDATE requests SET via = 'import', estimated = 1, cost_basis = 'local_list_price',
         rate_card_source_kind = 'bundled', rate_match_kind = 'exact_provider',
         scope_capture_status = 'unscoped', provider_scope_declaration_id = NULL
       WHERE request_id = ?`,
    ).run('request:lineage');
    const result = validateCausalLineageBindingV2(store.raw(), fixture.binding);
    assert.equal(result.state, 'invalid');
    assert.ok(result.reasonCodes.includes('request_cost_evidence_unaccepted'), result.reasonCodes.join(','));
    assert.ok(result.reasonCodes.includes('request_scope_unresolved'));
  } finally {
    store.close();
  }
});

test('T-069 binding shape rejects raw prompts/source/unit_json and realization snapshots fail closed on mutation', () => {
  const store = new Store(':memory:');
  try {
    const fixture = appendFixture(store, 'study:lineage-minimal');
    const forbidden = { ...fixture.binding, prompt: 'secret' } as unknown;
    const rejected = validateCausalLineageBindingV2(store.raw(), forbidden);
    assert.equal(rejected.state, 'invalid');
    assert.ok(rejected.reasonCodes.includes('binding_shape_invalid'));
    assert.deepEqual(Object.keys(fixture.binding).sort(), [
      'bindingDigest', 'bindingId', 'decisionId', 'executionId', 'outcomeId',
      'protocolHash', 'realizationCommitHash', 'realizationSnapshotDigest',
      'requestIds', 'studyId', 'type', 'unitIdDigest', 'version',
    ]);
    store.raw().prepare('UPDATE realization_units SET realized = 0 WHERE commit_hash = ?').run(COMMIT);
    const mutated = validateCausalLineageBindingV2(store.raw(), fixture.binding);
    assert.equal(mutated.state, 'invalid');
    assert.ok(mutated.reasonCodes.includes('realization_not_mature'), mutated.reasonCodes.join(','));
    assert.ok(mutated.reasonCodes.includes('realization_snapshot_digest_mismatch'));
  } finally {
    store.close();
  }
});

test('T-069 binding validation contains hostile proxy and symbol shapes', () => {
  const store = new Store(':memory:');
  try {
    const throwing = new Proxy({}, {
      get() {
        throw new Error('binding getter must not escape');
      },
      ownKeys() {
        throw new Error('binding keys must not escape');
      },
    });
    assert.doesNotThrow(() => validateCausalLineageBindingV2(store.raw(), throwing));
    assert.equal(validateCausalLineageBindingV2(store.raw(), throwing).reasonCodes[0], 'binding_shape_invalid');

    const symbolBinding = { [Symbol('unexpected')]: true };
    assert.doesNotThrow(() => validateCausalLineageBindingV2(store.raw(), symbolBinding));
    assert.equal(validateCausalLineageBindingV2(store.raw(), symbolBinding).reasonCodes[0], 'binding_shape_invalid');
  } finally {
    store.close();
  }
});

test('T-069 qualification remains inconclusive until the append-only lineage binding exists', () => {
  const store = new Store(':memory:');
  try {
    const fixture = appendFixture(store, 'study:lineage-qualification');
    completeRemainingFixture(store, fixture.protocol);
    const result = causalQualificationV2(store.raw(), fixture.protocol.studyId);
    assert.equal(result.state, 'inconclusive');
    assert.ok(result.reasons.includes('V2 request-to-realization lineage binding is not persisted'));
  } finally {
    store.close();
  }
});
