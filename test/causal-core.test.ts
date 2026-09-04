/**
 * The causal-study lane must prove its own boundaries. These are deliberately
 * negative-heavy: an ordinary scenario, altered assignment, incomplete
 * outcome, plan deviation, or modeled cost must fail before claim language is
 * reachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  verifyBlockedAssignmentPlan,
} from '../src/causal/assignment.ts';
import {
  deriveDeterministicCausalAssignmentV2 as deriveBlockedAssignmentPlanV2,
  verifyDeterministicCausalAssignmentV2 as verifyBlockedAssignmentPlanV2,
} from './support/causalDeterministicRng.ts';
import { createRetainedCausalV1AssignmentFixture } from './support/causalV1Fixture.ts';
import { completedData, modelDraft, repeatedCostQualityData } from './support/causalStudyFixture.ts';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import {
  getEstimandDefinition,
  RANDOMIZED_ITT_ESTIMAND_ID,
} from '../src/causal/estimand.ts';
import {
  canonicalJson,
  causalEventHash,
  commitCausalProtocol,
  isCausalProtocolMutationEligible,
  protocolHash,
  validateCausalProtocol,
  verifyCommittedCausalProtocol,
} from '../src/causal/protocol.ts';
import {
  qualifyCausalStudy,
} from '../src/causal/qualification.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  CAUSAL_PROTOCOL_VERSION_V2,
  type CausalAssignmentBlockV2,
  type CausalDecisionRecordV2,
  type CausalExecutionRecordV2,
  type CausalTerminalOutcomeRecordV2,
  type CausalDecisionRecord,
  type CommittedCausalStudyProtocolV2,
  type CausalExecutionRecord,
  type CausalOutcomeRecord,
  type CausalStudyData,
  type CausalStudyProtocolDraft,
  type CausalStudyProtocolDraftV2,
} from '../src/causal/types.ts';

const H = (char: string): string => char.repeat(64);


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


const V2_ASSIGNMENT_ENTROPY = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);

function v2AssignmentFixture(
  blockId = 'block:alpha',
  sequence = 1,
  unitIdDigests = [D('1'), D('2'), D('3'), D('4')],
): {
  protocol: CommittedCausalStudyProtocolV2;
  randomizationMaterial: Buffer;
  block: CausalAssignmentBlockV2;
} {
  const protocol = commitCausalProtocol(v2Draft(), 1_700_000_000_500);
  const randomizationMaterial = Buffer.from(V2_ASSIGNMENT_ENTROPY);
  const block = deriveBlockedAssignmentPlanV2(protocol, {
    blockId,
    sequence,
    createdAtMs: 1_700_000_001_000,
    unitIdDigests,
    randomizationMaterial,
  });
  return { protocol, randomizationMaterial, block };
}

function v2DecisionEventHashForTamper(decision: CausalDecisionRecordV2): string {
  const { eventHash: _eventHash, ...material } = decision;
  return 'sha256:' + createHash('sha256')
    .update('fiscus.causal.decision\n2\n' + canonicalJson(material))
    .digest('hex');
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

  const extra = { ...v2Draft(), rawPrompt: 'do not retain this' } as unknown as CausalStudyProtocolDraftV2;
  assert.ok(validateCausalProtocol(extra).some((error) => /protocol has unsupported field: rawPrompt/i.test(error)));

  const missing = structuredClone(v2Draft()) as CausalStudyProtocolDraftV2;
  delete (missing as unknown as Record<string, unknown>).ownerId;
  assert.ok(validateCausalProtocol(missing).some((error) => /protocol is missing required field: ownerId/i.test(error)));

  const nestedExtra = structuredClone(v2Draft()) as CausalStudyProtocolDraftV2;
  (nestedExtra.analysis as unknown as Record<string, unknown>).postHocWinner = true;
  assert.ok(validateCausalProtocol(nestedExtra).some((error) => /analysis has unsupported field: postHocWinner/i.test(error)));
});

test('v2 explicit joint rule is committed and cannot be altered after registration', () => {
  const draft = v2Draft({
    analysis: {
      ...v2Draft().analysis,
      jointInference: {
        method: 'bonferroni',
        endpointFamily: 'cost_quality',
        endpointCount: 2,
        alphaAllocation: 'equal',
        nonInferiorityMargin: 0.05,
        costSuperiorityThresholdUsd: 0,
        secondaryEndpointPolicy: 'none',
      },
    },
  });
  assert.deepEqual(validateCausalProtocol(draft), []);
  const committed = commitCausalProtocol(draft, 1_700_000_000_600);
  const tampered = structuredClone(committed) as unknown as Record<string, unknown>;
  ((tampered.analysis as Record<string, unknown>).jointInference as Record<string, unknown>).alphaAllocation = 'unequal';
  assert.ok(verifyCommittedCausalProtocol(tampered).some((error) => /hash|alpha|joint/i.test(error)));
});

test('policy-bearing V2 protocol accepts the exact bounded follow-up root field and hashes it', () => {
  const policyDraft = {
    ...v2Draft(),
    followUpWindowMs: 86_400_000,
  } as CausalStudyProtocolDraftV2;
  assert.deepEqual(validateCausalProtocol(policyDraft), []);
  const committed = commitCausalProtocol(policyDraft, 1_700_000_000_500) as CommittedCausalStudyProtocolV2;
  assert.equal(committed.followUpWindowMs, 86_400_000);
  assert.notEqual(committed.protocolHash, protocolHash(v2Draft()));
  assert.deepEqual(verifyCommittedCausalProtocol(committed), []);
});

test('policy-bearing V2 protocol rejects malformed values and non-root placement', () => {
  const malformed: unknown[] = [undefined, null, '86', false, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 31_536_000_001];
  for (const value of malformed) {
    const draft = { ...v2Draft(), followUpWindowMs: value } as unknown as CausalStudyProtocolDraftV2;
    assert.ok(validateCausalProtocol(draft).some((error) => /followUpWindowMs/i.test(error)), String(value));
    assert.throws(() => commitCausalProtocol(draft, 1_700_000_000_500), /followUpWindowMs/i, String(value));
  }

  const nested = { ...v2Draft(), studyWindow: { ...v2Draft().studyWindow, followUpWindowMs: 1000 } } as unknown as CausalStudyProtocolDraftV2;
  assert.ok(validateCausalProtocol(nested).some((error) => /unsupported field: followUpWindowMs/i.test(error)));
  assert.throws(() => protocolHash(nested), /unsupported field: followUpWindowMs/i);

  const changed = { ...v2Draft(), followUpWindowMs: 1001 } as unknown as CausalStudyProtocolDraftV2;
  assert.notEqual(protocolHash({ ...v2Draft(), followUpWindowMs: 1000 } as unknown as CausalStudyProtocolDraftV2), protocolHash(changed));
});

test('policy-bearing V2 protocol rejects inherited, accessor, proxy, and symbol root shapes without coercion', () => {
  const inherited = Object.create({ followUpWindowMs: 1000 }) as Record<string, unknown>;
  Object.assign(inherited, v2Draft());
  assert.ok(validateCausalProtocol(inherited).length > 0);

  let getterCalls = 0;
  const accessor = { ...v2Draft(), followUpWindowMs: 1000 } as Record<string, unknown>;
  Object.defineProperty(accessor, 'followUpWindowMs', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 1000;
    },
  });
  assert.ok(validateCausalProtocol(accessor).some((error) => /accessor|followUpWindowMs/i.test(error)));
  assert.equal(getterCalls, 0);

  let coercionCalls = 0;
  const coercible = {
    [Symbol.toPrimitive]() {
      coercionCalls += 1;
      throw new Error('coercion must not run');
    },
  };
  const coercibleDraft = { ...v2Draft(), followUpWindowMs: coercible } as unknown as CausalStudyProtocolDraftV2;
  assert.ok(validateCausalProtocol(coercibleDraft).some((error) => /followUpWindowMs/i.test(error)));
  assert.equal(coercionCalls, 0);

  const proxied = new Proxy({ ...v2Draft(), followUpWindowMs: 1000 }, {
    getOwnPropertyDescriptor() {
      throw new Error('proxy descriptor must not escape the validation boundary');
    },
  });
  assert.doesNotThrow(() => validateCausalProtocol(proxied));
  assert.ok(validateCausalProtocol(proxied).length > 0);

  const symbolRoot = { ...v2Draft(), followUpWindowMs: 1000, [Symbol('unexpected')]: true } as unknown as CausalStudyProtocolDraftV2;
  assert.ok(validateCausalProtocol(symbolRoot).some((error) => /symbol|unsupported/i.test(error)));
});

test('legacy and policy-bearing V2 commitments retain exact hash separation when the policy field is altered', () => {
  const legacy = commitCausalProtocol(v2Draft(), 1_700_000_000_500) as CommittedCausalStudyProtocolV2;
  const policy = commitCausalProtocol({ ...v2Draft(), followUpWindowMs: 86_400_000 } as CausalStudyProtocolDraftV2, 1_700_000_000_500) as CommittedCausalStudyProtocolV2;
  assert.deepEqual(verifyCommittedCausalProtocol(legacy), []);
  assert.deepEqual(verifyCommittedCausalProtocol(policy), []);
  assert.notEqual(legacy.protocolHash, policy.protocolHash);
  assert.ok(verifyCommittedCausalProtocol({ ...legacy, followUpWindowMs: 86_400_000 } as unknown as CommittedCausalStudyProtocolV2).length > 0);
  const removed = { ...policy } as Record<string, unknown>;
  delete removed.followUpWindowMs;
  assert.ok(verifyCommittedCausalProtocol(removed).length > 0);
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

test('v2 protocol public wrappers contain a throwing runtime-version getter', () => {
  const hostile = new Proxy({ version: 2 }, {
    get() {
      throw new Error('runtime version getter must not escape');
    },
  });
  assert.doesNotThrow(() => validateCausalProtocol(hostile));
  assert.match(validateCausalProtocol(hostile)[0] ?? '', /unsupported|object/i);
  assert.doesNotThrow(() => verifyCommittedCausalProtocol(hostile));
  assert.equal(isCausalProtocolMutationEligible(hostile), false);
  assert.throws(() => protocolHash(hostile), (error: unknown) =>
    error instanceof Error && !(error instanceof TypeError) && /cannot hash causal protocol/i.test(error.message));
  assert.throws(() => commitCausalProtocol(hostile, 1_700_000_000_500), (error: unknown) =>
    error instanceof Error && !(error instanceof TypeError) && /cannot commit causal protocol/i.test(error.message));
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

test('v2 assignment block root is independent, protocol-derived, and acyclic', () => {
  const first = v2AssignmentFixture();
  const second = v2AssignmentFixture('block:beta', 2, [D('5'), D('6'), D('7'), D('8')]);

  assert.equal(first.block.plan.blockRoot, 'sha256:3910ebf11cb3a210cf0e8cc54796d4f80e48645fba61641c2c35613829d14cd3');
  assert.equal(first.block.plan.randomizationMaterialDigest, 'sha256:26e709bf388301641591771e7faf8b781a27e8617a52fc5bf68165bb016b74a9');
  assert.equal(first.block.plan.allocationHash, 'sha256:2c49dcd28a9ece58810933201eee73a4796c293f624539440278403c2562fa03');
  assert.equal(first.block.plan.planHash, 'sha256:77b9957c2d971f1c1038de34ade78a820e7af5acd66be22ad1a2f80abd4156a2');
  assert.equal(first.block.plan.firstDecisionHash, 'sha256:645f36837e8ac3f52b80faab82e82dd67711beebf57c35e6df997d2eb9ca8793');
  assert.equal(first.block.plan.lastDecisionHash, 'sha256:4e8fa3e5cbfdaa8819bf5a44a8416acd81c7381b42c926377bc444441e93c6f6');
  assert.deepEqual(
    first.block.decisions.map((decision) => decision.assignedArmId),
    ['arm:candidate', 'arm:candidate', 'arm:control', 'arm:control'],
  );

  assert.notEqual(second.block.plan.blockRoot, first.block.plan.blockRoot);
  assert.equal(first.block.decisions[0]!.previousEventHash, first.block.plan.blockRoot);
  assert.equal(second.block.decisions[0]!.previousEventHash, second.block.plan.blockRoot);
  assert.notEqual(second.block.decisions[0]!.previousEventHash, first.block.plan.lastDecisionHash);
  assert.ok(first.block.decisions.every((decision) => decision.assignedAtMs === first.block.plan.createdAtMs));
  assert.deepEqual(verifyBlockedAssignmentPlanV2(first.protocol, first.block, first.randomizationMaterial), []);
  assert.deepEqual(verifyBlockedAssignmentPlanV2(second.protocol, second.block, second.randomizationMaterial), []);

  const forbiddenCallerFields = [
    { blockRoot: D('f') },
    { orderedArmIds: ['arm:control', 'arm:candidate'] },
    { probabilityPerArm: 0.5 },
  ];
  for (const extra of forbiddenCallerFields) {
    assert.throws(() => deriveBlockedAssignmentPlanV2(first.protocol, {
      blockId: 'block:forbidden',
      sequence: 3,
      createdAtMs: 1_700_000_001_000,
      unitIdDigests: [D('5'), D('6'), D('7'), D('8')],
      randomizationMaterial: first.randomizationMaterial,
      ...extra,
    } as never), /unsupported|caller|input/i);
  }
});

test('assignment bijection rejects missing extra duplicate and reordered records', () => {
  const { protocol, randomizationMaterial, block } = v2AssignmentFixture();
  const cases: Array<{
    name: string;
    mutate: (candidate: CausalAssignmentBlockV2) => void;
    expected: RegExp;
  }> = [
    { name: 'missing decision', mutate: (candidate) => { candidate.decisions.pop(); }, expected: /bijection|one decision|count/i },
    { name: 'extra decision', mutate: (candidate) => { candidate.decisions.push({ ...candidate.decisions[0]! }); }, expected: /bijection|one decision|count|duplicate/i },
    { name: 'duplicate decision id', mutate: (candidate) => { candidate.plan.decisionIds[1] = candidate.plan.decisionIds[0]!; }, expected: /decisionIds.*duplicate|bijection/i },
    { name: 'reordered decisions', mutate: (candidate) => { candidate.decisions.reverse(); }, expected: /order|bijection|index|replay/i },
    { name: 'reordered units', mutate: (candidate) => { candidate.plan.unitIdDigests.reverse(); }, expected: /unit|plan hash|replay/i },
    { name: 'extra plan key', mutate: (candidate) => { (candidate.plan as unknown as Record<string, unknown>).callerRoot = D('f'); }, expected: /plan.*unsupported field/i },
    { name: 'extra decision key', mutate: (candidate) => { (candidate.decisions[0] as unknown as Record<string, unknown>).rawUnitId = 'secret'; }, expected: /decision.*unsupported field/i },
    { name: 'missing plan key', mutate: (candidate) => { delete (candidate.plan as unknown as Record<string, unknown>).planHash; }, expected: /plan.*missing required field.*planHash/i },
    { name: 'missing decision key', mutate: (candidate) => { delete (candidate.decisions[0] as unknown as Record<string, unknown>).eventHash; }, expected: /decision.*missing required field.*eventHash/i },
  ];

  for (const { name, mutate, expected } of cases) {
    const candidate = structuredClone(block);
    mutate(candidate);
    const errors = verifyBlockedAssignmentPlanV2(protocol, candidate, randomizationMaterial);
    assert.ok(errors.some((error) => expected.test(error)), name + ': ' + errors.join('; '));
  }
});

test('assignment replay rejects root entropy material allocation plan event predecessor sequence identity and timestamp tampering', () => {
  const { protocol, randomizationMaterial, block } = v2AssignmentFixture();
  const alteredEntropy = Buffer.from(randomizationMaterial);
  alteredEntropy[0] = alteredEntropy[0]! ^ 0xff;

  const cases: Array<{
    name: string;
    mutate?: (candidate: CausalAssignmentBlockV2) => void;
    entropy?: Uint8Array;
    expected: RegExp;
  }> = [
    { name: 'root', mutate: (candidate) => { candidate.plan.blockRoot = D('9'); }, expected: /block root/i },
    { name: 'entropy', entropy: alteredEntropy, expected: /entropy|material/i },
    { name: 'material digest', mutate: (candidate) => { candidate.plan.randomizationMaterialDigest = D('8'); }, expected: /material/i },
    { name: 'allocation', mutate: (candidate) => { candidate.plan.allocationHash = D('7'); }, expected: /allocation/i },
    { name: 'plan', mutate: (candidate) => { candidate.plan.planHash = D('6'); }, expected: /plan hash/i },
    { name: 'event', mutate: (candidate) => { candidate.decisions[0]!.eventHash = D('5'); }, expected: /event|replay|anchor/i },
    { name: 'predecessor', mutate: (candidate) => { candidate.decisions[1]!.previousEventHash = D('4'); }, expected: /predecessor|event|replay/i },
    { name: 'sequence', mutate: (candidate) => { candidate.plan.sequence = 2; }, expected: /sequence|plan hash|allocation/i },
    { name: 'block identity', mutate: (candidate) => { candidate.plan.blockId = 'block:other'; }, expected: /block|root|identity/i },
    { name: 'protocol identity', mutate: (candidate) => { candidate.plan.protocolHash = D('3'); }, expected: /protocol|identity/i },
  ];

  for (const { name, mutate, entropy, expected } of cases) {
    const candidate = structuredClone(block);
    mutate?.(candidate);
    const errors = verifyBlockedAssignmentPlanV2(protocol, candidate, entropy ?? randomizationMaterial);
    assert.ok(errors.some((error) => expected.test(error)), name + ': ' + errors.join('; '));
  }

  const selfConsistentTimestampRewrite = structuredClone(block);
  let previousEventHash = selfConsistentTimestampRewrite.plan.blockRoot;
  for (const decision of selfConsistentTimestampRewrite.decisions) {
    decision.assignedAtMs += 1;
    decision.previousEventHash = previousEventHash;
    decision.eventHash = v2DecisionEventHashForTamper(decision);
    previousEventHash = decision.eventHash;
  }
  selfConsistentTimestampRewrite.plan.firstDecisionHash = selfConsistentTimestampRewrite.decisions[0]!.eventHash;
  selfConsistentTimestampRewrite.plan.lastDecisionHash = selfConsistentTimestampRewrite.decisions.at(-1)!.eventHash;
  assert.equal(selfConsistentTimestampRewrite.plan.planHash, block.plan.planHash);
  const timestampErrors = verifyBlockedAssignmentPlanV2(protocol, selfConsistentTimestampRewrite, randomizationMaterial);
  assert.ok(timestampErrors.some((error) => /assignedAtMs.*createdAtMs|timestamp.*plan/i.test(error)), timestampErrors.join('; '));
});

const malformedV2AssignmentProtocolCases: Array<{
  name: string;
  mutate: (protocol: Record<string, unknown>) => void;
}> = [
  { name: 'missing studyWindow', mutate: (protocol) => { delete protocol.studyWindow; } },
  { name: 'null studyWindow', mutate: (protocol) => { protocol.studyWindow = null; } },
  { name: 'scalar studyWindow', mutate: (protocol) => { protocol.studyWindow = 'not-a-window'; } },
  { name: 'array studyWindow', mutate: (protocol) => { protocol.studyWindow = []; } },
  { name: 'partial studyWindow', mutate: (protocol) => { protocol.studyWindow = { startsAtMs: 1_700_000_001_000 }; } },
  { name: 'missing allocation', mutate: (protocol) => { delete protocol.allocation; } },
  { name: 'null allocation', mutate: (protocol) => { protocol.allocation = null; } },
  { name: 'scalar allocation', mutate: (protocol) => { protocol.allocation = 'not-an-allocation'; } },
  { name: 'array allocation', mutate: (protocol) => { protocol.allocation = []; } },
  { name: 'partial allocation', mutate: (protocol) => { protocol.allocation = { blockSize: 4 }; } },
  { name: 'missing arms', mutate: (protocol) => { delete protocol.arms; } },
  { name: 'null arms', mutate: (protocol) => { protocol.arms = null; } },
  { name: 'scalar arms', mutate: (protocol) => { protocol.arms = 'not-arms'; } },
  { name: 'empty arms array', mutate: (protocol) => { protocol.arms = []; } },
  {
    name: 'partial arms array',
    mutate: (protocol) => {
      protocol.arms = [(protocol.arms as unknown[])[0]];
    },
  },
];

for (const { name, mutate } of malformedV2AssignmentProtocolCases) {
  test(`assignment replay and derivation reject ${name} without raw TypeError`, () => {
    const { protocol, block, randomizationMaterial } = v2AssignmentFixture();
    const malformed = structuredClone(protocol) as unknown as Record<string, unknown>;
    mutate(malformed);
    const input = {
      blockId: 'block:malformed-protocol',
      sequence: 2,
      createdAtMs: 1_700_000_001_000,
      unitIdDigests: [D('5'), D('6'), D('7'), D('8')],
      randomizationMaterial,
    };

    assert.throws(() => deriveBlockedAssignmentPlanV2(malformed as never, input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TypeError, false);
      assert.match(error.message, /^cannot derive v2 blocked causal assignment:/);
      return true;
    });

    let replayErrors: string[] = [];
    assert.doesNotThrow(() => {
      replayErrors = verifyBlockedAssignmentPlanV2(malformed, block, randomizationMaterial);
    });
    assert.ok(replayErrors.length > 0);
    assert.ok(replayErrors.some((error) => /protocol|studyWindow|allocation|arms/i.test(error)), replayErrors.join('; '));
  });
}

test('blocked assignment is replayable, balanced, and invalidates tampering', () => {
  const protocol = commitCausalProtocol(modelDraft(), 1_700_000_000_100);
  const plan = createRetainedCausalV1AssignmentFixture(protocol, {
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

test('retained v1 replay independently guards malformed unit arrays without throwing', () => {
  const protocol = commitCausalProtocol(modelDraft(), 1_700_000_000_100);
  const plan = createRetainedCausalV1AssignmentFixture(protocol, {
    blockId: 'block-v1-malformed-units',
    createdAtMs: 1_700_000_000_200,
    unitIdHashes: [H('1'), H('2'), H('3'), H('4')],
    randomizationMaterial: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });

  for (const unitIdHashes of [null, undefined, 42, 'not-an-array']) {
    let errors: string[] = [];
    assert.doesNotThrow(() => {
      errors = verifyBlockedAssignmentPlan(protocol, { ...plan, unitIdHashes });
    });
    assert.ok(errors.length > 0);
    assert.ok(errors.some((error) => /unit|array|block contract/i.test(error)), errors.join('; '));
  }
  assert.deepEqual(verifyBlockedAssignmentPlan(protocol, plan), []);
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

test('causal study estimates carry the registered estimand id and exact definition', () => {
  const estimate = estimateCausalStudy(completedData());
  assert.equal(estimate.estimandId, RANDOMIZED_ITT_ESTIMAND_ID);
  assert.strictEqual(estimate.estimandDefinition, getEstimandDefinition(RANDOMIZED_ITT_ESTIMAND_ID));
  assert.equal(estimate.estimandDefinition?.analysis, 'intention_to_treat');
});

test('an unsupported runtime estimand is marked unknown rather than assigned a made-up registry id', () => {
  const data = completedData();
  const unsupported = structuredClone(data) as CausalStudyData;
  (unsupported.protocol.analysis as unknown as Record<string, unknown>).estimand = 'per_protocol';

  const estimate = estimateCausalStudy(unsupported);

  assert.equal(estimate.qualification.state, 'invalid');
  assert.equal(estimate.estimandId, null);
  assert.equal(estimate.estimandDefinition, null);
  assert.match(estimate.limitations.join(' '), /estimand.*registered|registered.*estimand/i);
});

test('a non-v1 protocol shape cannot inherit the v1 estimand identity', () => {
  const data = completedData();
  const unsupported = structuredClone(data) as CausalStudyData;
  (unsupported.protocol as unknown as Record<string, unknown>).version = 2;

  const estimate = estimateCausalStudy(unsupported);

  assert.equal(estimate.qualification.state, 'invalid');
  assert.equal(estimate.estimandId, null);
  assert.equal(estimate.estimandDefinition, null);
});

test('joint causal inference reports an immutable Bonferroni rule and endpoint confidence', () => {
  const draft = modelDraft() as unknown as Record<string, unknown>;
  const analysis = draft.analysis as Record<string, unknown>;
  analysis.jointInference = {
    method: 'bonferroni',
    endpointFamily: 'cost_quality',
    endpointCount: 2,
    alphaAllocation: 'equal',
    nonInferiorityMargin: 0.05,
    costSuperiorityThresholdUsd: 0,
    secondaryEndpointPolicy: 'none',
  };
  assert.deepEqual(validateCausalProtocol(draft), [], 'the joint rule is part of the pre-registered protocol shape');
  const committed = commitCausalProtocol(draft);
  const tampered = structuredClone(committed) as unknown as Record<string, unknown>;
  ((tampered.analysis as Record<string, unknown>).jointInference as Record<string, unknown>).endpointCount = 1;
  assert.ok(verifyCommittedCausalProtocol(tampered).some((error) => /hash|endpoint|joint/i.test(error)));

  const estimate = estimateCausalStudy(completedData(draft as unknown as CausalStudyProtocolDraft));
  assert.equal(estimate.jointInference.method, 'bonferroni');
  assert.equal(estimate.jointInference.endpointFamily, 'cost_quality');
  assert.equal(estimate.jointInference.endpointCount, 2);
  assert.equal(estimate.jointInference.alphaAllocation, 'equal');
  assert.equal(estimate.jointInference.nonInferiorityMargin, 0.05);
  assert.equal(estimate.jointInference.costSuperiorityThresholdUsd, 0);
  assert.equal(estimate.jointInference.secondaryEndpointPolicy, 'none');
  assert.equal(estimate.jointInference.overallConfidenceLevel, 0.95);
  assert.equal(estimate.jointInference.endpointConfidenceLevel, 0.975);
  assert.equal(estimate.jointInference.ruleSource, 'protocol');
});

test('joint cost-quality claim cannot borrow two independent full-alpha intervals', () => {
  const data = repeatedCostQualityData(0.545, 0.455);
  const qualification = qualifyCausalStudy(data);
  assert.equal(qualification.state, 'qualified', qualification.reasons.slice(0, 5).join('; '));
  const estimate = estimateCausalStudy(data);
  assert.equal(estimate.lowerCostPassed, true, 'the large cohort establishes cost superiority under either conservative level');
  assert.equal(estimate.qualityNonInferiorityPassed, false, 'the joint endpoint level must govern the conjunction');
  assert.equal(estimate.allowedClaim, 'not_established');

  // At the nominal 95% endpoint level this quality lower bound would clear the
  // 0.05 margin; the pre-registered two-endpoint Bonferroni level correctly
  // widens it enough to withhold the joint claim.
  const alpha = 1 - 0.95;
  const width = 1;
  const independentRadius = width * Math.sqrt(Math.log(4 / alpha) / (2 * 500)) * 2;
  const independentLower = 0.17 - independentRadius;
  assert.ok(independentLower > -0.05, `independent lower bound should clear the margin: ${independentLower}`);
  assert.ok(estimate.qualityEffect !== null && estimate.qualityEffect.lower <= -0.05);
});

test('joint cost-quality claim requires both endpoints even when quality alone passes', () => {
  const data = repeatedCostQualityData(0.9, 0.1, 49, 51);
  const qualification = qualifyCausalStudy(data);
  assert.equal(qualification.state, 'qualified', qualification.reasons.slice(0, 5).join('; '));
  const estimate = estimateCausalStudy(data);
  assert.equal(estimate.qualityNonInferiorityPassed, true, 'quality can pass on its own');
  assert.equal(estimate.lowerCostPassed, false, 'cost still fails');
  assert.equal(estimate.allowedClaim, 'not_established', 'the conjunction cannot pass when one endpoint fails');
});

test('joint quality boundary exactly at the registered margin is withheld', () => {
  const alpha = 1 - 0.975;
  const radius = 2 * Math.sqrt(Math.log(4 / alpha) / (2 * 500));
  const qualityControl = 0.4;
  const qualityCandidate = qualityControl - 0.05 + radius;
  const data = repeatedCostQualityData(qualityCandidate, qualityControl, 1, 99);
  const estimate = estimateCausalStudy(data);
  assert.ok(estimate.qualityEffect !== null);
  assert.ok(Math.abs(estimate.qualityEffect.lower + 0.05) < 1e-12, `lower=${estimate.qualityEffect.lower}`);
  assert.equal(estimate.qualityNonInferiorityPassed, false, 'strictly above the margin is required');
  assert.equal(estimate.allowedClaim, 'not_established');
});

test('joint bounded-outcome rule stays conservative in a deterministic null simulation', () => {
  const nextRandom = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  };

  const simulate = (seed: number): number => {
    const random = nextRandom(seed);
    let falseConjunctions = 0;
    for (let simulation = 0; simulation < 24; simulation += 1) {
      const data = repeatedCostQualityData(0.5, 0.5, 50, 50);
      const executionByDecision = new Map(data.executions.map((execution) => [execution.decisionId, execution]));
      for (const execution of data.executions) {
        const core = { ...execution, directAiCostUsd: random() * 100, eventHash: undefined };
        execution.directAiCostUsd = core.directAiCostUsd;
        execution.eventHash = causalEventHash(core);
      }
      for (const outcome of data.outcomes) {
        const execution = executionByDecision.get(outcome.decisionId)!;
        const core = { ...outcome, qualityValue: random(), previousEventHash: execution.eventHash, eventHash: undefined };
        outcome.qualityValue = core.qualityValue;
        outcome.previousEventHash = core.previousEventHash;
        outcome.eventHash = causalEventHash(core);
      }
      const estimate = estimateCausalStudy(data);
      if (estimate.allowedClaim === 'comparative_cost_quality_supported') falseConjunctions += 1;
    }
    return falseConjunctions;
  };

  const first = simulate(0xA061);
  assert.equal(first, simulate(0xA061), 'the calibration fixture must be reproducible');
  assert.ok(first <= 2, `the 95% family-wise rule should not produce repeated null conjunctions: ${first}/24`);
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
