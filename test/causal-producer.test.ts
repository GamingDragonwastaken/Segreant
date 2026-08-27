import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  causalExecutionV2EventHash,
  causalTerminalOutcomeV2EventHash,
  ordinaryLedgerVerifierHash,
} from '../src/causal/records.ts';
import {
  canonicalJson,
  commitCausalProtocol,
  sha256,
} from '../src/causal/protocol.ts';
import {
  causalProducerIdentityMaterialDigestV1,
  produceCausalUnitReceiptV1,
  verifyCausalProducerReceiptV1,
  type CausalProducerInputV1,
  type CausalProducerRequestSnapshotV1,
  type CausalProducerScopeSnapshotV1,
} from '../src/causal/producer.ts';
import { causalRequestPricingDigestV2 } from '../src/store/causalLineage.ts';
import type {
  CausalDecisionRecordV2,
  CausalExecutionRecordV2,
  CausalStudyProtocolDraftV2,
  CausalTerminalOutcomeRecordV2,
  CommittedCausalStudyProtocolV2,
} from '../src/causal/types.ts';

const D = (character: string): string => 'sha256:' + character.repeat(64);
const COMMIT = 'a'.repeat(40);
const START = 1_700_000_001_000;

function producerProtocol(): CommittedCausalStudyProtocolV2 {
  const draft: CausalStudyProtocolDraftV2 = {
    type: 'fiscus.causal-study',
    version: 2,
    studyId: 'study:producer',
    seriesId: 'series:producer',
    studyVersion: 1,
    ownerId: 'owner:test',
    scopeId: 'scope:producer',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:producer',
      contextSchemaId: 'schema:producer',
      unitOfAssignment: 'task',
      inclusionRuleIds: ['rule:include'],
      exclusionRuleIds: [],
    },
    studyWindow: { startsAtMs: START, endsAtMs: null },
    stoppingRule: { kind: 'fixed_enrollment', maxAssignments: 4 },
    arms: [
      {
        armId: 'arm:candidate',
        role: 'candidate',
        executionPlanDigest: D('1'),
        providerId: 'provider:openai',
        modelId: 'model:producer',
      },
      {
        armId: 'arm:control',
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

function providerScope(): CausalProducerScopeSnapshotV1 {
  return {
    declarationId: 'scope-declaration:producer',
    provider: 'openai',
    projectRef: 'project:producer',
    trust: 'operator_declared_unverified',
  };
}

function requestSnapshot(
  requestId: string,
  tsEpochMs: number,
  costMicros = 1_000_000,
): CausalProducerRequestSnapshotV1 {
  return {
    requestId,
    tsEpochMs,
    provider: 'provider:openai',
    model: 'model:producer',
    project: 'project:producer',
    costMicros,
    estimated: false,
    via: 'proxy',
    costBasis: 'tool_reported_unverified',
    rateCardSha256: null,
    rateCardSourceKind: 'none',
    rateMatchKind: 'reported',
    rateMatchProvider: null,
    rateMatchModel: null,
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: providerScope().declarationId,
  };
}

function decisionIdFor(
  protocol: CommittedCausalStudyProtocolV2,
  unitIdDigest: string,
  blockId = 'block:producer',
): string {
  return 'decision:' + sha256(canonicalJson({
    domain: 'fiscus.causal.decision-id',
    version: 1,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
    blockSequence: 1,
    decisionIndex: 1,
    unitIdDigest,
  }));
}

function decisionFor(
  protocol: CommittedCausalStudyProtocolV2,
  unitIdDigest: string,
): CausalDecisionRecordV2 {
  const material: Omit<CausalDecisionRecordV2, 'eventHash'> = {
    type: 'fiscus.causal-decision',
    version: 2,
    decisionId: decisionIdFor(protocol, unitIdDigest),
    studyId: protocol.studyId,
    blockId: 'block:producer',
    protocolHash: protocol.protocolHash,
    blockSequence: 1,
    decisionIndex: 1,
    unitIdDigest,
    assignedAtMs: START + 1,
    assignedArmId: 'arm:candidate',
    propensity: 0.5,
    blockRoot: D('3'),
    planHash: D('4'),
    allocationHash: D('5'),
    randomizationMaterialDigest: D('6'),
    previousEventHash: D('7'),
  };
  return {
    ...material,
    eventHash: 'sha256:' + sha256('fiscus.causal.decision\n2\n' + canonicalJson(material)),
  };
}

function executionFor(
  protocol: CommittedCausalStudyProtocolV2,
  decision: CausalDecisionRecordV2,
  request: CausalProducerRequestSnapshotV1,
  scope: CausalProducerScopeSnapshotV1,
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
  const pricingDigest = causalRequestPricingDigestV2({
    requestId: request.requestId,
    tsEpochMs: request.tsEpochMs,
    provider: request.provider,
    model: request.model,
    project: request.project,
    costMicros: request.costMicros,
    costBasis: request.costBasis,
    rateCardSha256: request.rateCardSha256,
    rateCardSourceKind: request.rateCardSourceKind,
    rateMatchKind: request.rateMatchKind,
    rateMatchProvider: request.rateMatchProvider,
    rateMatchModel: request.rateMatchModel,
    scopeCaptureStatus: request.scopeCaptureStatus,
    providerScopeDeclarationId: scope.declarationId,
  });
  const material: Omit<CausalExecutionRecordV2, 'eventHash'> = {
    type: 'fiscus.causal-execution',
    version: 2,
    executionId: 'execution:producer',
    decisionId: decision.decisionId,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    startedAtMs: decision.assignedAtMs + 1,
    completedAtMs: decision.assignedAtMs + 5,
    assignedExecutionPlanDigest: D('1'),
    actualExecutionPlanDigest: D('1'),
    adherence: 'confirmed',
    requestIds: [request.requestId],
    directAiCostUsd: request.costMicros / 1_000_000,
    directCostSourceClass: 'actual_observed',
    priceLineageDigests: [pricingDigest],
    fullArmCostUsd: null,
    fullCostSourceClass: 'incomplete_or_unknown',
    ordinaryLedgerVerifier: {
      ...verifierMaterial,
      resultHash: ordinaryLedgerVerifierHash(verifierMaterial),
    },
    previousEventHash: decision.eventHash,
  };
  return { ...material, eventHash: causalExecutionV2EventHash(material) };
}

function outcomeFor(
  protocol: CommittedCausalStudyProtocolV2,
  decision: CausalDecisionRecordV2,
  execution: CausalExecutionRecordV2,
  qualityValue = 0.9,
): CausalTerminalOutcomeRecordV2 {
  const material: Omit<CausalTerminalOutcomeRecordV2, 'eventHash'> = {
    type: 'fiscus.causal-terminal-outcome',
    version: 2,
    outcomeId: 'outcome:producer',
    decisionId: decision.decisionId,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    observedAtMs: execution.completedAtMs + 5,
    maturity: 'matured',
    qualityValue,
    qualityEvidenceClass: 'deterministic',
    economicValueUsd: null,
    economicEvidenceClass: null,
    outcomeEvidenceDigests: [D('8')],
    censoredReason: null,
    invalidReason: null,
    previousEventHash: execution.eventHash,
  };
  return { ...material, eventHash: causalTerminalOutcomeV2EventHash(material) };
}

function candidateFor(
  protocol: CommittedCausalStudyProtocolV2,
  unitIdDigest: string,
  requestId = 'request:producer',
  qualityValue = 0.9,
): CausalProducerInputV1 {
  const scope = providerScope();
  const request = requestSnapshot(requestId, START + 3);
  const decision = decisionFor(protocol, unitIdDigest);
  const execution = executionFor(protocol, decision, request, scope);
  const outcome = outcomeFor(protocol, decision, execution, qualityValue);
  return {
    protocol,
    decision,
    execution,
    outcome,
    requests: [request],
    scope,
    realization: {
      commitHash: COMMIT,
      project: scope.projectRef,
      tsEpochMs: execution.completedAtMs + 1,
      computedAtMs: execution.completedAtMs + 2,
      attributedCostUsd: 1,
      maturing: false,
      realized: true,
      costScope: 'project',
      costStale: false,
    },
    sequence: 1,
    previousReceiptHash: null,
  };
}

function validScenario(): {
  input: CausalProducerInputV1;
  provisional: ReturnType<typeof produceCausalUnitReceiptV1>;
  result: ReturnType<typeof produceCausalUnitReceiptV1>;
} {
  const protocol = producerProtocol();
  const provisionalInput = candidateFor(protocol, D('a'));
  const provisional = produceCausalUnitReceiptV1(provisionalInput);
  assert.ok(provisional.derivedUnitIdDigest);
  const input = candidateFor(protocol, provisional.derivedUnitIdDigest);
  const result = produceCausalUnitReceiptV1(input);
  return { input, provisional, result };
}

test('producer derives a deterministic scalar identity and emits a verifiable non-claim receipt', () => {
  const { input, result } = validScenario();
  assert.equal(result.state, 'produced');
  assert.equal(result.reasonCodes.length, 0);
  assert.equal(result.identityRelation, 'matched');
  assert.ok(result.derivedUnitIdDigest);
  assert.equal(result.derivedUnitIdDigest, result.assignedUnitIdDigest);
  assert.ok(result.receipt);
  assert.equal(result.receipt.claimStatus, 'not_established');
  assert.equal(result.receipt.ordinaryLedgerVerification, 'unresolved');
  assert.deepEqual(verifyCausalProducerReceiptV1(result.receipt), []);
  assert.equal(
    result.derivedUnitIdDigest,
    causalProducerIdentityMaterialDigestV1(input.protocol, input.scope, input.requests),
  );
  assert.doesNotMatch(JSON.stringify(result.receipt), /prompt|sourceText|unitJson|rawOutput/i);

  const replay = produceCausalUnitReceiptV1(input);
  assert.deepEqual(replay, result);
});

test('identity derivation is independent of post-treatment outcome values but sensitive to request membership', () => {
  const baseline = validScenario();
  const changedOutcome = candidateFor(
    baseline.input.protocol,
    baseline.result.assignedUnitIdDigest!,
    'request:producer',
    0.8,
  );
  const changedOutcomeResult = produceCausalUnitReceiptV1(changedOutcome);
  assert.equal(changedOutcomeResult.state, 'produced');
  assert.equal(changedOutcomeResult.derivedUnitIdDigest, baseline.result.derivedUnitIdDigest);
  assert.notEqual(changedOutcomeResult.receipt?.outcomeEvidenceDigest, baseline.result.receipt?.outcomeEvidenceDigest);
  assert.notEqual(changedOutcomeResult.receipt?.receiptHash, baseline.result.receipt?.receiptHash);

  const differentRequest = validScenarioForRequest('request:producer-other');
  assert.equal(differentRequest.result.state, 'produced');
  assert.notEqual(differentRequest.result.derivedUnitIdDigest, baseline.result.derivedUnitIdDigest);
});

function validScenarioForRequest(requestId: string): {
  input: CausalProducerInputV1;
  result: ReturnType<typeof produceCausalUnitReceiptV1>;
} {
  const protocol = producerProtocol();
  const provisionalInput = candidateFor(protocol, D('a'), requestId);
  const provisional = produceCausalUnitReceiptV1(provisionalInput);
  assert.ok(provisional.derivedUnitIdDigest);
  const input = candidateFor(protocol, provisional.derivedUnitIdDigest, requestId);
  return { input, result: produceCausalUnitReceiptV1(input) };
}

test('request cost, scope, and outcome lineage gates fail closed', () => {
  const { input } = validScenario();

  const wrongCost = {
    ...input,
    requests: [{ ...input.requests[0]!, costMicros: 2_000_000 }],
  };
  const costResult = produceCausalUnitReceiptV1(wrongCost);
  assert.notEqual(costResult.state, 'produced');
  assert.equal(costResult.receipt, null);
  assert.ok(costResult.reasonCodes.includes('request_total_cost_mismatch'));
  assert.equal(costResult.derivedUnitIdDigest, null);

  const wrongScope = {
    ...input,
    scope: { ...input.scope, projectRef: 'project:other' },
  };
  const scopeResult = produceCausalUnitReceiptV1(wrongScope);
  assert.equal(scopeResult.state, 'inconclusive');
  assert.equal(scopeResult.receipt, null);
  assert.ok(scopeResult.reasonCodes.includes('request_scope_insufficient'));

  const censoredMaterial: Omit<CausalTerminalOutcomeRecordV2, 'eventHash'> = {
    ...input.outcome,
    maturity: 'censored',
    qualityValue: null,
    qualityEvidenceClass: null,
    economicValueUsd: null,
    economicEvidenceClass: null,
    outcomeEvidenceDigests: [],
    censoredReason: 'follow_up_expired',
    invalidReason: null,
  };
  const censored = {
    ...input,
    outcome: {
      ...censoredMaterial,
      eventHash: causalTerminalOutcomeV2EventHash(censoredMaterial),
    },
  };
  const outcomeResult = produceCausalUnitReceiptV1(censored);
  assert.equal(outcomeResult.state, 'inconclusive');
  assert.equal(outcomeResult.receipt, null);
  assert.ok(outcomeResult.reasonCodes.includes('outcome_not_mature'));
});

test('assignment mismatch is surfaced as a conflict, never promoted to a receipt', () => {
  const { provisional } = validScenario();
  assert.equal(provisional.state, 'invalid');
  assert.equal(provisional.identityRelation, 'mismatched');
  assert.equal(provisional.receipt, null);
  assert.ok(provisional.derivedUnitIdDigest);
  assert.ok(provisional.reasonCodes.includes('assigned_identity_mismatch'));
});

test('raw-content fields and hostile shapes are rejected without echoing their values', () => {
  const { input } = validScenario();
  const secret = 'never-retain-this-prompt';
  const withSecret = {
    ...input,
    requests: [{ ...input.requests[0]!, prompt: secret }],
  };
  const rawResult = produceCausalUnitReceiptV1(withSecret);
  assert.equal(rawResult.state, 'invalid');
  assert.ok(rawResult.reasonCodes.includes('forbidden_input_field'));
  assert.doesNotMatch(JSON.stringify(rawResult), new RegExp(secret));

  const accessorInput = {
    ...input,
    requests: Object.defineProperty([...input.requests], '0', {
      enumerable: true,
      get: () => input.requests[0],
    }),
  };
  const accessorResult = produceCausalUnitReceiptV1(accessorInput);
    assert.equal(accessorResult.state, 'invalid');
  assert.ok(accessorResult.reasonCodes.includes('request_set_invalid'));
});

test('receipt sequence links are bounded and receipt tampering is detectable', () => {
  const first = validScenario().result;
  assert.ok(first.receipt);
  const secondInput = { ...validScenario().input, sequence: 2, previousReceiptHash: first.receipt.receiptHash };
  const second = produceCausalUnitReceiptV1(secondInput);
  assert.equal(second.state, 'produced');
  assert.equal(second.receipt?.sequence, 2);
  assert.equal(second.receipt?.previousReceiptHash, first.receipt.receiptHash);
  assert.deepEqual(verifyCausalProducerReceiptV1(second.receipt), []);

  const tampered = { ...first.receipt, producedAtMs: first.receipt.producedAtMs + 1 };
  assert.deepEqual(verifyCausalProducerReceiptV1(tampered), ['receipt_hash_mismatch']);

  const badFirstLink = produceCausalUnitReceiptV1({
    ...validScenario().input,
    previousReceiptHash: D('9'),
  });
  assert.equal(badFirstLink.state, 'invalid');
  assert.ok(badFirstLink.reasonCodes.includes('receipt_sequence_invalid'));
});
