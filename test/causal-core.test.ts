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
import {
  causalEventHash,
  commitCausalProtocol,
  isCausalProtocolMutationEligible,
  protocolHash,
  validateCausalProtocol,
  verifyCommittedCausalProtocol,
} from '../src/causal/protocol.ts';
import { qualifyCausalStudy } from '../src/causal/qualification.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  CAUSAL_PROTOCOL_VERSION_V2,
  type CommittedCausalStudyProtocolV2,
  type CausalExecutionRecord,
  type CausalOutcomeRecord,
  type CausalStudyData,
  type CausalStudyProtocolDraft,
  type CausalStudyProtocolDraftV2,
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

const D = (char: string): string => 'sha256:' + H(char);

function v2Draft(overrides: Partial<CausalStudyProtocolDraftV2> = {}): CausalStudyProtocolDraftV2 {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION_V2,
    studyId: 'study:model-cost',
    seriesId: 'series:model-cost',
    studyVersion: 1,
    ownerId: 'owner:finops',
    scopeId: 'scope:repo-a',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:eligible-a',
      contextSchemaId: 'schema:task-v2',
      unitOfAssignment: 'task',
      inclusionRuleIds: ['rule:active', 'rule:consented'],
      exclusionRuleIds: ['rule:prior-exposure'],
    },
    studyWindow: { startsAtMs: 1_700_000_001_000, endsAtMs: null },
    stoppingRule: { kind: 'fixed_enrollment', maxAssignments: 4 },
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
    ...overrides,
  };
}

function aiV2Draft(overrides: Partial<CausalStudyProtocolDraftV2> = {}): CausalStudyProtocolDraftV2 {
  return v2Draft({
    studyId: 'study:ai-net-benefit',
    seriesId: 'series:ai-net-benefit',
    question: 'ai_vs_incumbent_net_benefit',
    arms: [
      { armId: 'arm:ai', role: 'ai', executionPlanDigest: D('c'), providerId: 'provider:alpha', modelId: 'model:new' },
      { armId: 'arm:incumbent', role: 'incumbent', executionPlanDigest: D('d'), providerId: null, modelId: null },
    ],
    economicOutcome: {
      metricId: 'metric:net-benefit-usd',
      collectionMethodId: 'method:reconciled-ledger',
      currency: 'USD',
      boundsUsd: { low: -100, high: 200 },
      evidenceClass: 'independent_operational',
      fullCostAccountingRequired: true,
    },
    ...overrides,
  });
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

test('v2 protocol validates, commits its frozen domain-separated hash, and rejects shape drift', () => {
  const draft = v2Draft();
  assert.deepEqual(validateCausalProtocol(draft), []);
  assert.equal(
    protocolHash(draft),
    'sha256:534831a0f8a642aa153c901a7315f86430af8a253aa1cd68136d688a4ea3f4ff',
  );

  const committed = commitCausalProtocol(draft, 1_700_000_000_500);
  assert.equal(committed.version, 2);
  assert.equal(committed.protocolHash, protocolHash(draft));
  assert.deepEqual(verifyCommittedCausalProtocol(committed), []);
  assert.ok(Object.isFrozen(committed));
  assert.ok(Object.isFrozen(committed.eligibility));

  const extra = { ...v2Draft(), rawPrompt: 'do not retain this' } as CausalStudyProtocolDraftV2;
  assert.ok(validateCausalProtocol(extra).some((error) => /protocol has unsupported field: rawPrompt/i.test(error)));

  const missing = structuredClone(v2Draft()) as CausalStudyProtocolDraftV2;
  delete (missing as unknown as Record<string, unknown>).ownerId;
  assert.ok(validateCausalProtocol(missing).some((error) => /protocol is missing required field: ownerId/i.test(error)));

  const nestedExtra = structuredClone(v2Draft()) as CausalStudyProtocolDraftV2;
  (nestedExtra.analysis as unknown as Record<string, unknown>).postHocWinner = true;
  assert.ok(validateCausalProtocol(nestedExtra).some((error) => /analysis has unsupported field: postHocWinner/i.test(error)));
});

test('v2 protocol public wrappers fail closed for invalid roots and unsupported runtime versions', () => {
  const invalidRoots: unknown[] = [null, undefined, true, 42, 'protocol', [], {}];
  for (const value of invalidRoots) {
    let validation: string[] = [];
    assert.doesNotThrow(() => { validation = validateCausalProtocol(value as never); });
    assert.ok(validation.length > 0, 'validation must reject ' + String(value));

    let verification: string[] = [];
    assert.doesNotThrow(() => { verification = verifyCommittedCausalProtocol(value as never); });
    assert.ok(verification.length > 0, 'verification must reject ' + String(value));

    for (const operation of [
      () => protocolHash(value as never),
      () => commitCausalProtocol(value as never, 1_700_000_000_500),
    ]) {
      assert.throws(operation, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof TypeError, false);
        assert.match(error.message, /causal protocol/i);
        return true;
      });
    }
  }

  const unsupportedDraft = { ...modelDraft(), version: 3 };
  assert.ok(validateCausalProtocol(unsupportedDraft as never).some((error) => /unsupported.*version/i.test(error)));
  assert.throws(() => protocolHash(unsupportedDraft as never), /unsupported.*version/i);
  assert.throws(() => commitCausalProtocol(unsupportedDraft as never, 1_700_000_000_100), /unsupported.*version/i);

  const unsupportedCommitted = { ...commitCausalProtocol(modelDraft(), 1_700_000_000_100), version: 3 };
  assert.ok(verifyCommittedCausalProtocol(unsupportedCommitted as never).some((error) => /unsupported.*version/i.test(error)));
});

test('v2 protocol hash exact-decodes the public document before projecting material', () => {
  const cases: Array<{
    name: string;
    mutate: (draft: CausalStudyProtocolDraftV2 & Record<string, unknown>) => void;
    expected: RegExp;
  }> = [
    { name: 'root extra', mutate: (draft) => { draft.rawPrompt = 'hidden prompt'; }, expected: /unsupported field: rawPrompt/i },
    { name: 'nested extra', mutate: (draft) => { (draft.analysis as unknown as Record<string, unknown>).winner = 'candidate'; }, expected: /analysis has unsupported field: winner/i },
    { name: 'credential scalar', mutate: (draft) => { draft.ownerId = 'owner:password123'; }, expected: /ownerId.*credential/i },
    {
      name: 'local judge',
      mutate: (draft) => {
        (draft.qualityOutcome as unknown as Record<string, unknown>).evidenceClass = 'local_ai_judge';
      },
      expected: /qualityOutcome\.evidenceClass.*local_ai_judge/i,
    },
    {
      name: 'sparse set',
      mutate: (draft) => { delete draft.eligibility.inclusionRuleIds[0]; },
      expected: /inclusionRuleIds.*sparse/i,
    },
    { name: 'unsupported version', mutate: (draft) => { (draft as Record<string, unknown>).version = 9; }, expected: /unsupported.*version/i },
  ];

  for (const { name, mutate, expected } of cases) {
    const draft = structuredClone(v2Draft()) as CausalStudyProtocolDraftV2 & Record<string, unknown>;
    mutate(draft);
    assert.throws(() => protocolHash(draft as never), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TypeError, false);
      assert.match(error.message, /cannot hash causal protocol/i);
      assert.match(error.message, expected, name);
      return true;
    });
  }

  assert.equal(
    protocolHash(v2Draft()),
    'sha256:534831a0f8a642aa153c901a7315f86430af8a253aa1cd68136d688a4ea3f4ff',
  );
});

test('v2 protocol positive integers are safe and preserve valid domain limits', () => {
  assert.deepEqual(validateCausalProtocol(v2Draft({ studyVersion: Number.MAX_SAFE_INTEGER })), []);
  assert.deepEqual(validateCausalProtocol(v2Draft({
    stoppingRule: { kind: 'fixed_enrollment', maxAssignments: Number.MAX_SAFE_INTEGER - 1 },
    allocation: { method: 'blocked_randomized_equal_allocation', probabilityPerArm: 0.5, blockSize: 2 },
    analysis: {
      ...v2Draft().analysis,
      minCompletedPerArm: Number.MAX_SAFE_INTEGER,
    },
  })), []);

  const invalidCases: Array<{
    name: string;
    mutate: (draft: CausalStudyProtocolDraftV2) => void;
    expected: RegExp;
  }> = [
    { name: 'unsafe study version', mutate: (draft) => { draft.studyVersion = Number.MAX_SAFE_INTEGER + 1; }, expected: /studyVersion.*safe integer/i },
    { name: 'fractional study version', mutate: (draft) => { draft.studyVersion = 1.5; }, expected: /studyVersion.*safe integer/i },
    { name: 'unsafe maximum assignments', mutate: (draft) => { draft.stoppingRule.maxAssignments = Number.MAX_SAFE_INTEGER + 1; }, expected: /maxAssignments.*safe integer/i },
    { name: 'fractional maximum assignments', mutate: (draft) => { draft.stoppingRule.maxAssignments = 4.5; }, expected: /maxAssignments.*safe integer/i },
    { name: 'unsafe block size', mutate: (draft) => { draft.allocation.blockSize = Number.MAX_SAFE_INTEGER + 1; }, expected: /blockSize.*safe integer/i },
    { name: 'fractional block size', mutate: (draft) => { draft.allocation.blockSize = 4.5; }, expected: /blockSize.*safe integer/i },
    { name: 'unsafe sample floor', mutate: (draft) => { draft.analysis.minCompletedPerArm = Number.MAX_SAFE_INTEGER + 1; }, expected: /minCompletedPerArm.*safe integer/i },
    { name: 'fractional sample floor', mutate: (draft) => { draft.analysis.minCompletedPerArm = 2.5; }, expected: /minCompletedPerArm.*safe integer/i },
    { name: 'max not divisible by block', mutate: (draft) => { draft.stoppingRule.maxAssignments = 6; }, expected: /maxAssignments.*multiple.*blockSize/i },
  ];

  for (const { name, mutate, expected } of invalidCases) {
    const draft = structuredClone(v2Draft());
    mutate(draft);
    const errors = validateCausalProtocol(draft);
    assert.ok(errors.some((error) => expected.test(error)), name + ': ' + errors.join('; '));
  }
});

const malformedV2StudyWindowCases: Array<{
  name: string;
  mutate: (draft: Record<string, unknown>) => void;
}> = [
  { name: 'missing', mutate: (draft) => { delete draft.studyWindow; } },
  { name: 'null', mutate: (draft) => { draft.studyWindow = null; } },
  { name: 'scalar', mutate: (draft) => { draft.studyWindow = 'not-a-window'; } },
  { name: 'empty object', mutate: (draft) => { draft.studyWindow = {}; } },
  { name: 'missing startsAtMs', mutate: (draft) => { draft.studyWindow = { endsAtMs: null }; } },
];

for (const { name, mutate } of malformedV2StudyWindowCases) {
  test(`v2 protocol commitment rejects ${name} studyWindow as a protocol error`, () => {
    const draft = structuredClone(v2Draft()) as unknown as Record<string, unknown>;
    mutate(draft);

    assert.throws(() => commitCausalProtocol(draft as never, 1_700_000_000_500), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TypeError, false);
      assert.match(error.message, /^cannot commit causal protocol:/);
      assert.match(error.message, /studyWindow/);
      return true;
    });
  });
}

test('v1 hash isolation preserves the frozen vector and makes retained v1 inspect-only', () => {
  const draft = modelDraft();
  assert.equal(protocolHash(draft), 'd96fa6e475eca79a4bfa618c503d68834febd69ea6a3b4a42d19a7e290b69b16');
  const committedV1 = commitCausalProtocol(draft, 1_700_000_000_100);
  assert.deepEqual(verifyCommittedCausalProtocol(committedV1), []);
  assert.equal(isCausalProtocolMutationEligible(committedV1), false);

  const committedV2 = commitCausalProtocol(v2Draft(), 1_700_000_000_500);
  assert.equal(isCausalProtocolMutationEligible(committedV2), true);
  assert.equal(protocolHash(draft), 'd96fa6e475eca79a4bfa618c503d68834febd69ea6a3b4a42d19a7e290b69b16');
});

test('local_ai_judge is rejected for v2 quality and economic evidence at draft and commitment boundaries', () => {
  const quality = v2Draft({
    qualityOutcome: {
      ...v2Draft().qualityOutcome,
      evidenceClass: 'local_ai_judge',
    } as unknown as CausalStudyProtocolDraftV2['qualityOutcome'],
  });
  const qualityErrors = validateCausalProtocol(quality);
  assert.ok(qualityErrors.some((error) => /qualityOutcome\.evidenceClass.*local_ai_judge/i.test(error)));
  assert.throws(() => commitCausalProtocol(quality, 1_700_000_000_500), /local_ai_judge/i);

  const economic = aiV2Draft({
    economicOutcome: {
      ...aiV2Draft().economicOutcome!,
      evidenceClass: 'local_ai_judge',
    } as unknown as CausalStudyProtocolDraftV2['economicOutcome'],
  });
  const economicErrors = validateCausalProtocol(economic);
  assert.ok(economicErrors.some((error) => /economicOutcome\.evidenceClass.*local_ai_judge/i.test(error)));
  assert.throws(() => commitCausalProtocol(economic, 1_700_000_000_500), /local_ai_judge/i);

  const committed = commitCausalProtocol(aiV2Draft(), 1_700_000_000_500) as CommittedCausalStudyProtocolV2;
  const forged = structuredClone(committed);
  (forged.economicOutcome as unknown as Record<string, unknown>).evidenceClass = 'local_ai_judge';
  assert.ok(verifyCommittedCausalProtocol(forged).some((error) => /economicOutcome\.evidenceClass.*local_ai_judge/i.test(error)));
});

test('strict causal strings, digests, sets, timestamps, and closed v2 grammar fail at the boundary', () => {
  const shortestNamespacedId = v2Draft({ studyId: 'a:b' });
  assert.deepEqual(validateCausalProtocol(shortestNamespacedId), [], 'the exact NamespacedId grammar allows a one-letter namespace');

  const cases: Array<{
    name: string;
    mutate: (draft: CausalStudyProtocolDraftV2) => void;
    expected: RegExp;
  }> = [
    { name: 'uppercase namespace', mutate: (draft) => { draft.studyId = 'Study:upper'; }, expected: /studyId/i },
    { name: 'missing namespace', mutate: (draft) => { draft.ownerId = 'finops'; }, expected: /ownerId/i },
    { name: 'URL', mutate: (draft) => { draft.scopeId = 'scope:https://example.test'; }, expected: /scopeId.*URL|scopeId.*safe/i },
    { name: 'path', mutate: (draft) => { draft.eligibility.cohortId = 'cohort:..\\secret'; }, expected: /cohortId.*path|cohortId.*safe/i },
    { name: 'control', mutate: (draft) => { draft.eligibility.contextSchemaId = 'schema:line\nfeed'; }, expected: /contextSchemaId.*control|contextSchemaId.*safe/i },
    { name: 'credential', mutate: (draft) => { draft.ownerId = 'owner:api_key'; }, expected: /ownerId.*credential|ownerId.*safe/i },
    { name: 'credential keyword with suffix', mutate: (draft) => { draft.ownerId = 'owner:password123'; }, expected: /ownerId.*credential|ownerId.*safe/i },
    { name: 'uppercase digest', mutate: (draft) => { draft.arms[0]!.executionPlanDigest = 'sha256:' + 'A'.repeat(64); }, expected: /executionPlanDigest/i },
    { name: 'unsorted set', mutate: (draft) => { draft.eligibility.inclusionRuleIds = ['rule:z', 'rule:a']; }, expected: /inclusionRuleIds.*sorted/i },
    { name: 'duplicate set', mutate: (draft) => { draft.dataGovernance.minimizedSourceIds = ['source:a', 'source:a']; }, expected: /minimizedSourceIds.*duplicate/i },
    { name: 'unsafe timestamp', mutate: (draft) => { draft.createdAtMs = Number.MAX_SAFE_INTEGER + 1; }, expected: /createdAtMs/i },
    { name: 'wrong currency', mutate: (draft) => { (draft.costOutcome as unknown as Record<string, unknown>).currency = 'EUR'; }, expected: /costOutcome\.currency/i },
    { name: 'wrong price lineage rule', mutate: (draft) => { (draft.costOutcome as unknown as Record<string, unknown>).priceLineageRule = 'trust_me'; }, expected: /priceLineageRule/i },
    { name: 'invalid stopping rule', mutate: (draft) => { draft.stoppingRule.maxAssignments = null; }, expected: /stoppingRule/i },
    { name: 'duplicate claim template', mutate: (draft) => { draft.claimTemplateIds.invalid = draft.claimTemplateIds.qualified; }, expected: /claimTemplateIds.*distinct/i },
  ];

  for (const { name, mutate, expected } of cases) {
    const draft = structuredClone(v2Draft());
    mutate(draft);
    const errors = validateCausalProtocol(draft);
    assert.ok(errors.some((error) => expected.test(error)), name + ': ' + errors.join('; '));
  }

  const sparse = structuredClone(v2Draft());
  delete sparse.eligibility.inclusionRuleIds[0];
  assert.ok(validateCausalProtocol(sparse).some((error) => /inclusionRuleIds.*sparse/i.test(error)));
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
