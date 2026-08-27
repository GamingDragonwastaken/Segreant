/**
 * Store-owned independent causal producer integration.
 *
 * The fixture deliberately contains only scalar metadata.  It proves that a
 * prospective unit can be assigned before exposure, then independently
 * derived from retained rows and atomically attached to a mature lineage
 * binding without making an invoice, causal-effect, or financial-value claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  causalExecutionV2EventHash,
  causalTerminalOutcomeV2EventHash,
} from '../src/causal/records.ts';
import {
  canonicalJson,
  commitCausalProtocol,
  sha256,
} from '../src/causal/protocol.ts';
import { independentCausalUnitIdDigestV2 } from '../src/causal/identity.ts';
import { verifiedOrdinaryLedgerVerifier } from '../src/causal/ledger.ts';
import type {
  CausalExecutionRecordV2,
  CausalStudyProtocolDraftV2,
  CommittedCausalStudyProtocolV2,
} from '../src/causal/types.ts';
import {
  causalRequestPricingDigestV2,
  validateCausalLineageBindingV2,
} from '../src/store/causalLineage.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

const D = (char: string): string => 'sha256:' + char.repeat(64);
const STUDY_ID = 'study:producer-store';
const COMMIT_HASH = 'a'.repeat(40);
const PROJECT = 'project:producer-store';
const ASSIGNED_AT_MS = 1_700_000_001_001;
const REQUEST_AT_MS = ASSIGNED_AT_MS + 3;
const COMPLETED_AT_MS = ASSIGNED_AT_MS + 5;
const REALIZATION_AT_MS = ASSIGNED_AT_MS + 7;
const COMPUTED_AT_MS = ASSIGNED_AT_MS + 8;

function protocol(): CommittedCausalStudyProtocolV2 {
  const draft: CausalStudyProtocolDraftV2 = {
    type: 'fiscus.causal-study',
    version: 2,
    studyId: STUDY_ID,
    seriesId: 'series:producer-store',
    studyVersion: 1,
    ownerId: 'owner:test',
    scopeId: 'scope:producer-store',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:producer-store',
      contextSchemaId: 'schema:producer-store',
      unitOfAssignment: 'task',
      inclusionRuleIds: ['rule:include'],
      exclusionRuleIds: [],
    },
    studyWindow: { startsAtMs: 1_700_000_001_000, endsAtMs: null },
    stoppingRule: { kind: 'fixed_enrollment', maxAssignments: 4 },
    arms: [
      {
        armId: 'arm:producer-candidate',
        role: 'candidate',
        executionPlanDigest: D('1'),
        providerId: 'provider:openai',
        modelId: 'model:producer',
      },
      {
        armId: 'arm:producer-control',
        role: 'control',
        executionPlanDigest: D('2'),
        providerId: 'provider:openai',
        modelId: 'model:control',
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
  provider: string,
  model: string,
  declarationId: string,
): RequestRow {
  return {
    requestId,
    sessionId: 'session:producer-store',
    tsEpochMs: REQUEST_AT_MS,
    provider,
    model,
    project: PROJECT,
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 1,
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

function subjectDigest(subject: string): string {
  return 'sha256:' + sha256('fiscus.causal.commit-subject\n1\n' + subject);
}

test('Store-owned producer derives and atomically persists an independent scalar unit', () => {
  const store = new Store(':memory:');
  try {
    const committed = protocol();
    assert.equal(store.registerCausalProtocol(committed), 'created');
    const declaration = store.setOpenAiScope({
      billingAccountRef: 'acct:producer-store',
      providerProjectRef: PROJECT,
      upstreamBase: 'https://api.openai.com/v1',
      declaredAtMs: 1_700_000_001_000,
      activatedAtMs: 1_700_000_001_000,
    });

    const subject = 'producer integration fixture';
    store.insertCommit({
      commitHash: COMMIT_HASH,
      project: PROJECT,
      tsEpochMs: REALIZATION_AT_MS,
      linesAdded: 10,
      linesDeleted: 2,
      filesChanged: 1,
      subject,
    });
    const unitIdDigest = independentCausalUnitIdDigestV2({
      studyId: STUDY_ID,
      commitHash: COMMIT_HASH,
      project: PROJECT,
      tsEpochMs: REALIZATION_AT_MS,
      linesAdded: 10,
      linesDeleted: 2,
      filesChanged: 1,
      subjectDigest: subjectDigest(subject),
    });

    const assignment = store.assignCausalBlockV2({
      studyId: STUDY_ID,
      blockId: 'block:producer-store',
      createdAtMs: ASSIGNED_AT_MS,
      unitIdDigests: [unitIdDigest, D('b'), D('c'), D('d')],
    });
    const decision = assignment.block.decisions[0]!;
    assert.equal(decision.unitIdDigest, unitIdDigest);
    const assignedArm = committed.arms.find((arm) => arm.armId === decision.assignedArmId)!;
    assert.ok(assignedArm.providerId && assignedArm.modelId);

    const requestId = 'request:producer-store';
    store.insertRequest(requestRow(requestId, assignedArm.providerId!, assignedArm.modelId!, declaration.declarationId));
    const priceDigest = causalRequestPricingDigestV2({
      requestId,
      tsEpochMs: REQUEST_AT_MS,
      provider: assignedArm.providerId!,
      model: assignedArm.modelId!,
      project: PROJECT,
      costMicros: 1_000_000,
      costBasis: 'tool_reported_unverified',
      rateCardSha256: null,
      rateCardSourceKind: 'none',
      rateMatchKind: 'reported',
      rateMatchProvider: null,
      rateMatchModel: null,
      scopeCaptureStatus: 'declared_unverified',
      providerScopeDeclarationId: declaration.declarationId,
    });
    const ledger = verifiedOrdinaryLedgerVerifier({
      requests: [{
        requestId,
        tsEpochMs: REQUEST_AT_MS,
        provider: assignedArm.providerId!,
        model: assignedArm.modelId!,
        project: PROJECT,
        costUsd: 1,
        estimated: false,
        via: 'proxy',
        statusCode: 200,
        costBasis: 'tool_reported_unverified',
        rateCardSha256: null,
        rateCardSourceKind: 'none',
        rateMatchKind: 'reported',
        rateMatchProvider: null,
        rateMatchModel: null,
        scopeCaptureStatus: 'declared_unverified',
        providerScopeDeclarationId: declaration.declarationId,
      }],
      expected: {
        providerId: assignedArm.providerId!,
        modelId: assignedArm.modelId!,
        startedAtMs: ASSIGNED_AT_MS + 1,
        completedAtMs: COMPLETED_AT_MS,
        directCostUsd: 1,
        scopeDeclarationId: declaration.declarationId,
        priceLineageDigests: [priceDigest],
      },
      checkedAtMs: COMPUTED_AT_MS + 1,
    });

    const executionMaterial: Omit<CausalExecutionRecordV2, 'eventHash'> = {
      type: 'fiscus.causal-execution',
      version: 2,
      executionId: 'execution:producer-store',
      decisionId: decision.decisionId,
      studyId: STUDY_ID,
      protocolHash: committed.protocolHash,
      startedAtMs: ASSIGNED_AT_MS + 1,
      completedAtMs: COMPLETED_AT_MS,
      assignedExecutionPlanDigest: assignedArm.executionPlanDigest,
      actualExecutionPlanDigest: assignedArm.executionPlanDigest,
      adherence: 'confirmed',
      requestIds: [requestId],
      directAiCostUsd: 1,
      directCostSourceClass: 'actual_observed',
      priceLineageDigests: [priceDigest],
      fullArmCostUsd: null,
      fullCostSourceClass: 'incomplete_or_unknown',
      ordinaryLedgerVerifier: ledger,
      previousEventHash: decision.eventHash,
    };
    const execution: CausalExecutionRecordV2 = {
      ...executionMaterial,
      eventHash: causalExecutionV2EventHash(executionMaterial),
    };
    assert.equal(store.appendCausalExecutionV2(execution), 'created');

    const outcomeMaterial = {
      type: 'fiscus.causal-terminal-outcome' as const,
      version: 2 as const,
      outcomeId: 'outcome:producer-store',
      decisionId: decision.decisionId,
      studyId: STUDY_ID,
      protocolHash: committed.protocolHash,
      observedAtMs: COMPLETED_AT_MS + 1,
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
    store.saveRealizationUnits([{
      commitHash: COMMIT_HASH,
      project: PROJECT,
      tsEpochMs: REALIZATION_AT_MS,
      computedAtMs: COMPUTED_AT_MS,
      attributedCostUsd: 1,
      maturing: false,
      realized: true,
      unitJson: '{}',
      costScope: 'project',
    }]);

    const input = {
      studyId: STUDY_ID,
      decisionId: decision.decisionId,
      executionId: execution.executionId,
      outcomeId: outcomeMaterial.outcomeId,
      realizationCommitHash: COMMIT_HASH,
      bindingId: 'lineage:producer-store',
      checkedAtMs: COMPUTED_AT_MS + 1,
    } as const;
    const prepared = store.prepareIndependentCausalLineageBindingV2(input);
    assert.equal(prepared.state, 'ready', prepared.reasonCodes.join(','));
    assert.equal(prepared.unitIdDigest, unitIdDigest);
    assert.equal(prepared.ledger?.state, 'verified');
    assert.equal(prepared.ledger?.requestCount, 1);
    assert.ok(prepared.binding);
    assert.ok(prepared.evidence);
    assert.equal(prepared.evidence?.identityMaterial, 'retained_git_commit_scalars');
    assert.equal(prepared.evidence?.ledgerManifestHash, prepared.ledger?.evidenceManifestHash);
    assert.doesNotMatch(canonicalJson(prepared), /prompt|sourceText|output|secret|apiKey|unit_json/i);

    const appended = store.appendIndependentCausalLineageBindingV2(input);
    assert.equal(appended.state, 'ready');
    assert.equal(appended.binding?.bindingId, 'lineage:producer-store');
    assert.equal(
      (store.raw().prepare('SELECT causal_unit_id_digest AS digest FROM realization_units WHERE commit_hash = ?').get(COMMIT_HASH) as { digest: string }).digest,
      unitIdDigest,
    );
    assert.equal(
      (store.raw().prepare('SELECT COUNT(*) AS count FROM causal_lineage_bindings_v2').get() as { count: number }).count,
      1,
    );
    assert.equal(store.appendIndependentCausalLineageBindingV2(input).binding?.bindingId, 'lineage:producer-store');
    assert.equal(
      (store.raw().prepare('SELECT COUNT(*) AS count FROM causal_lineage_bindings_v2').get() as { count: number }).count,
      1,
    );
    const validation = validateCausalLineageBindingV2(store.raw(), appended.binding);
    assert.equal(validation.state, 'valid', validation.reasonCodes.join(','));
    assert.deepEqual(validation.reasonCodes, []);

    // The retained identity is recomputable, so a post-append commit mutation
    // cannot silently leave a valid-looking lineage record behind.
    store.raw().prepare('UPDATE git_commits SET lines_added = ? WHERE commit_hash = ?').run(11, COMMIT_HASH);
    const tampered = store.prepareIndependentCausalLineageBindingV2(input);
    assert.equal(tampered.state, 'blocked');
    assert.ok(tampered.reasonCodes.includes('identity_not_assigned'));
    assert.ok(tampered.reasonCodes.includes('identity_conflict'));
    const afterTamper = validateCausalLineageBindingV2(store.raw(), appended.binding);
    assert.equal(afterTamper.state, 'invalid');
    assert.ok(afterTamper.reasonCodes.includes('realization_unit_identity_unverified'));
  } finally {
    store.close();
  }
});
