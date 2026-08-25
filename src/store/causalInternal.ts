/**
 * Test-only frozen v2 assignment formula reference.
 *
 * Production Store code does not import this module. tsconfig.build.json excludes
 * it, so no raw material, deterministic derivation, replay, or fault surface is
 * emitted under dist or included in the package.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { canonicalJson, sha256, verifyCommittedCausalProtocol } from '../causal/protocol.ts';
import type {
  CausalAssignmentBlockV2,
  CausalAssignmentManifestV2,
  CausalAssignmentPlanV2,
  CausalAssignmentRequestV2,
  CausalAssignmentResultV2,
  CausalDecisionRecordV2,
  CommittedCausalStudyProtocolV2,
} from '../causal/types.ts';

const ID_RE = /^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ENTROPY_BYTES = 32;
const INPUT_KEYS = ['blockId', 'sequence', 'createdAtMs', 'unitIdDigests', 'randomizationMaterial'] as const;
const REQUEST_KEYS = ['studyId', 'blockId', 'createdAtMs', 'unitIdDigests'] as const;
const PLAN_KEYS = [
  'type', 'version', 'studyId', 'blockId', 'protocolHash', 'sequence',
  'createdAtMs', 'blockRoot', 'unitIdDigests', 'randomizationMaterialDigest',
  'allocationHash', 'decisionIds', 'firstDecisionHash', 'lastDecisionHash',
  'planHash',
] as const;
const DECISION_KEYS = [
  'type', 'version', 'decisionId', 'studyId', 'blockId', 'protocolHash',
  'blockSequence', 'decisionIndex', 'unitIdDigest', 'assignedAtMs',
  'assignedArmId', 'propensity', 'blockRoot', 'planHash', 'allocationHash',
  'randomizationMaterialDigest', 'previousEventHash', 'eventHash',
] as const;

interface DerivationInputV2 {
  blockId: string;
  sequence: number;
  createdAtMs: number;
  unitIdDigests: string[];
  randomizationMaterial: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return Object.keys(value).every((key) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 3
    && value.length <= 160
    && ID_RE.test(value)
    && !/(?:bearer|basic)(?:[._-]|$)|api[_-]?key|secret|password|token|(?:^|:)(?:sk|rk|pk)-/i.test(value)
    && !/^[^.]+\.[^.]+\.[^.]+$/.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  errors: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(label + ' must be an object');
    return false;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(label + ' is missing required field: ' + key);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push(label + ' has unsupported field: ' + key);
  }
  return true;
}

function uint64Be(value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

function domainHash(domain: string, material: unknown): string {
  return 'sha256:' + createHash('sha256')
    .update(domain + '\n2\n' + canonicalJson(material))
    .digest('hex');
}

function blockRoot(protocol: CommittedCausalStudyProtocolV2, blockId: string): string {
  return 'sha256:' + sha256(canonicalJson({
    domain: 'fiscus.causal.assignment-block-root',
    version: 1,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
  }));
}

function materialDigest(material: Uint8Array): string {
  return 'sha256:' + createHash('sha256')
    .update(Buffer.from('fiscus.causal.randomization-material\n1\n'))
    .update(uint64Be(material.byteLength))
    .update(material)
    .digest('hex');
}

function decisionId(
  protocol: CommittedCausalStudyProtocolV2,
  blockId: string,
  blockSequence: number,
  decisionIndex: number,
  unitIdDigest: string,
): string {
  return 'decision:' + sha256(canonicalJson({
    domain: 'fiscus.causal.decision-id',
    version: 1,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
    blockSequence,
    decisionIndex,
    unitIdDigest,
  }));
}

function shuffledArms(
  protocol: CommittedCausalStudyProtocolV2,
  blockId: string,
  root: string,
  sequence: number,
  unitIdDigests: string[],
  material: Uint8Array,
): string[] {
  const orderedArmIds = protocol.arms.map((arm) => arm.armId);
  const arms: string[] = [];
  const repetitions = unitIdDigests.length / orderedArmIds.length;
  for (const armId of orderedArmIds) {
    for (let index = 0; index < repetitions; index += 1) arms.push(armId);
  }
  const context = canonicalJson({
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
    blockRoot: root,
    sequence,
    unitIdDigests,
    orderedArmIds,
  });
  let counter = 0;
  const nextWord = (): number => {
    const result = createHash('sha256')
      .update(Buffer.from('fiscus.causal.assignment-shuffle\n2\n'))
      .update(uint64Be(material.byteLength))
      .update(material)
      .update(uint64Be(Buffer.byteLength(context)))
      .update(context)
      .update(uint64Be(counter))
      .digest()
      .readUInt32BE(0);
    counter += 1;
    return result;
  };
  for (let index = arms.length - 1; index > 0; index -= 1) {
    const range = index + 1;
    const acceptanceLimit = Math.floor(0x1_0000_0000 / range) * range;
    let word = nextWord();
    while (word >= acceptanceLimit) word = nextWord();
    const swapIndex = word % range;
    const current = arms[index]!;
    arms[index] = arms[swapIndex]!;
    arms[swapIndex] = current;
  }
  return arms;
}

function allocationHash(
  protocol: CommittedCausalStudyProtocolV2,
  blockId: string,
  root: string,
  sequence: number,
  assignments: Array<{
    decisionIndex: number;
    unitIdDigest: string;
    assignedArmId: string;
    propensity: 0.5;
  }>,
  randomizationMaterialDigest: string,
): string {
  return domainHash('fiscus.causal.assignment-allocation', {
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
    blockRoot: root,
    sequence,
    assignments,
    randomizationMaterialDigest,
  });
}

function planHash(
  protocol: CommittedCausalStudyProtocolV2,
  material: {
    blockId: string;
    blockRoot: string;
    sequence: number;
    createdAtMs: number;
    randomizationMaterialDigest: string;
    allocationHash: string;
    unitIdDigests: string[];
    decisionIds: string[];
  },
): string {
  return domainHash('fiscus.causal.assignment-plan', {
    type: 'fiscus.causal-assignment-plan',
    version: 2,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId: material.blockId,
    blockRoot: material.blockRoot,
    blockSequence: material.sequence,
    createdAtMs: material.createdAtMs,
    randomizationMaterialDigest: material.randomizationMaterialDigest,
    allocationHash: material.allocationHash,
    unitIdDigests: material.unitIdDigests,
    decisionIds: material.decisionIds,
    allocation: {
      method: protocol.allocation.method,
      blockSize: protocol.allocation.blockSize,
      probabilityPerArm: protocol.allocation.probabilityPerArm,
      orderedArmIds: protocol.arms.map((arm) => arm.armId),
    },
  });
}

function decisionHash(decision: Record<string, unknown>): string {
  const { eventHash: _eventHash, ...material } = decision;
  return domainHash('fiscus.causal.decision', material);
}

function validateDerivationInput(protocol: CommittedCausalStudyProtocolV2, input: unknown): string[] {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (protocol?.version !== 2) errors.push('v2 assignment requires a committed v2 protocol');
  if (errors.length > 0) return errors;
  if (!exactRecord(input, INPUT_KEYS, 'v2 assignment input', errors)) return errors;
  if (!safeId(input.blockId)) errors.push('blockId must be a safe namespaced identifier');
  if (!positiveSafeInteger(input.sequence)) errors.push('sequence must be a positive safe integer');
  if (!positiveSafeInteger(input.createdAtMs)) {
    errors.push('createdAtMs must be a positive safe-integer epoch timestamp');
  } else {
    if (input.createdAtMs < protocol.studyWindow.startsAtMs) errors.push('assignment must not precede the study window');
    if (protocol.studyWindow.endsAtMs !== null && input.createdAtMs > protocol.studyWindow.endsAtMs) {
      errors.push('assignment must not follow the study window');
    }
  }
  if (!denseArray(input.unitIdDigests)) {
    errors.push('unitIdDigests must be a dense ordered array');
  } else {
    if (input.unitIdDigests.length !== protocol.allocation.blockSize) {
      errors.push('unitIdDigests must contain exactly the committed protocol block size');
    }
    if (!input.unitIdDigests.every(digest)) errors.push('unitIdDigests must contain lowercase namespaced SHA-256 digests');
    if (new Set(input.unitIdDigests).size !== input.unitIdDigests.length) errors.push('unitIdDigests must be unique within the ordered block');
  }
  if (!(input.randomizationMaterial instanceof Uint8Array) || input.randomizationMaterial.byteLength !== ENTROPY_BYTES) {
    errors.push('randomization material must be exactly 32 raw bytes');
  }
  return errors;
}

/** Pure formula executor. It is reachable only through this non-package module. */
export function deriveCausalAssignmentBlockV2Internal(
  protocol: CommittedCausalStudyProtocolV2,
  input: DerivationInputV2,
): CausalAssignmentBlockV2 {
  const errors = validateDerivationInput(protocol, input);
  if (errors.length > 0) throw new Error('cannot derive v2 blocked causal assignment: ' + errors.join('; '));

  const material = Buffer.from(input.randomizationMaterial);
  const root = blockRoot(protocol, input.blockId);
  const randomizationMaterialDigest = materialDigest(material);
  const assignedArmIds = shuffledArms(protocol, input.blockId, root, input.sequence, input.unitIdDigests, material);
  const decisionIds = input.unitIdDigests.map((unitIdDigest, index) => decisionId(
    protocol,
    input.blockId,
    input.sequence,
    index + 1,
    unitIdDigest,
  ));
  const assignments = input.unitIdDigests.map((unitIdDigest, index) => ({
    decisionIndex: index + 1,
    unitIdDigest,
    assignedArmId: assignedArmIds[index]!,
    propensity: 0.5 as const,
  }));
  const allocation = allocationHash(protocol, input.blockId, root, input.sequence, assignments, randomizationMaterialDigest);
  const plan = planHash(protocol, {
    blockId: input.blockId,
    blockRoot: root,
    sequence: input.sequence,
    createdAtMs: input.createdAtMs,
    randomizationMaterialDigest,
    allocationHash: allocation,
    unitIdDigests: input.unitIdDigests,
    decisionIds,
  });

  const decisions: CausalDecisionRecordV2[] = [];
  let previousEventHash = root;
  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index]!;
    const materialDecision: Omit<CausalDecisionRecordV2, 'eventHash'> = {
      type: 'fiscus.causal-decision',
      version: 2,
      decisionId: decisionIds[index]!,
      studyId: protocol.studyId,
      blockId: input.blockId,
      protocolHash: protocol.protocolHash,
      blockSequence: input.sequence,
      decisionIndex: index + 1,
      unitIdDigest: assignment.unitIdDigest,
      assignedAtMs: input.createdAtMs,
      assignedArmId: assignment.assignedArmId,
      propensity: 0.5,
      blockRoot: root,
      planHash: plan,
      allocationHash: allocation,
      randomizationMaterialDigest,
      previousEventHash,
    };
    const decision: CausalDecisionRecordV2 = {
      ...materialDecision,
      eventHash: decisionHash(materialDecision),
    };
    decisions.push(decision);
    previousEventHash = decision.eventHash;
  }

  return {
    plan: {
      type: 'fiscus.causal-assignment-plan',
      version: 2,
      studyId: protocol.studyId,
      blockId: input.blockId,
      protocolHash: protocol.protocolHash,
      sequence: input.sequence,
      createdAtMs: input.createdAtMs,
      blockRoot: root,
      unitIdDigests: [...input.unitIdDigests],
      randomizationMaterialDigest,
      allocationHash: allocation,
      decisionIds,
      firstDecisionHash: decisions[0]!.eventHash,
      lastDecisionHash: decisions.at(-1)!.eventHash,
      planHash: plan,
    },
    decisions,
  };
}

function validatePlanShape(plan: unknown, errors: string[]): plan is Record<string, unknown> {
  if (!exactRecord(plan, PLAN_KEYS, 'v2 assignment plan', errors)) return false;
  if (plan.type !== 'fiscus.causal-assignment-plan') errors.push('v2 assignment plan type is invalid');
  if (plan.version !== 2) errors.push('v2 assignment plan version is invalid');
  for (const [field, value] of [['studyId', plan.studyId], ['blockId', plan.blockId]] as const) {
    if (!safeId(value)) errors.push('v2 assignment plan ' + field + ' is invalid');
  }
  for (const [field, value] of [
    ['protocolHash', plan.protocolHash], ['blockRoot', plan.blockRoot],
    ['randomizationMaterialDigest', plan.randomizationMaterialDigest],
    ['allocationHash', plan.allocationHash], ['firstDecisionHash', plan.firstDecisionHash],
    ['lastDecisionHash', plan.lastDecisionHash], ['planHash', plan.planHash],
  ] as const) {
    if (!digest(value)) errors.push('v2 assignment plan ' + field + ' is invalid');
  }
  if (!positiveSafeInteger(plan.sequence)) errors.push('v2 assignment plan sequence must be a positive safe integer');
  if (!positiveSafeInteger(plan.createdAtMs)) errors.push('v2 assignment plan createdAtMs must be a positive safe integer');
  if (!denseArray(plan.unitIdDigests) || !plan.unitIdDigests.every(digest)) {
    errors.push('v2 assignment plan unitIdDigests must be a dense digest array');
  } else if (new Set(plan.unitIdDigests).size !== plan.unitIdDigests.length) {
    errors.push('v2 assignment plan unitIdDigests contain a duplicate');
  }
  if (!denseArray(plan.decisionIds) || !plan.decisionIds.every(safeId)) {
    errors.push('v2 assignment plan decisionIds must be a dense namespaced-ID array');
  } else if (new Set(plan.decisionIds).size !== plan.decisionIds.length) {
    errors.push('v2 assignment plan decisionIds contain a duplicate');
  }
  return true;
}

function validateDecisionShape(decision: unknown, index: number, errors: string[]): decision is Record<string, unknown> {
  const label = 'v2 assignment decision[' + String(index) + ']';
  if (!exactRecord(decision, DECISION_KEYS, label, errors)) return false;
  if (decision.type !== 'fiscus.causal-decision') errors.push(label + ' type is invalid');
  if (decision.version !== 2) errors.push(label + ' version is invalid');
  for (const [field, value] of [
    ['decisionId', decision.decisionId], ['studyId', decision.studyId],
    ['blockId', decision.blockId], ['assignedArmId', decision.assignedArmId],
  ] as const) {
    if (!safeId(value)) errors.push(label + ' ' + field + ' is invalid');
  }
  for (const [field, value] of [
    ['protocolHash', decision.protocolHash], ['unitIdDigest', decision.unitIdDigest],
    ['blockRoot', decision.blockRoot], ['planHash', decision.planHash],
    ['allocationHash', decision.allocationHash],
    ['randomizationMaterialDigest', decision.randomizationMaterialDigest],
    ['previousEventHash', decision.previousEventHash], ['eventHash', decision.eventHash],
  ] as const) {
    if (!digest(value)) errors.push(label + ' ' + field + ' is invalid');
  }
  if (!positiveSafeInteger(decision.blockSequence)) errors.push(label + ' blockSequence must be a positive safe integer');
  if (!positiveSafeInteger(decision.decisionIndex)) errors.push(label + ' decisionIndex must be a positive safe integer');
  if (!positiveSafeInteger(decision.assignedAtMs)) errors.push(label + ' assignedAtMs must be a positive safe integer');
  if (decision.propensity !== 0.5) errors.push(label + ' propensity must equal the committed protocol probability 0.5');
  return true;
}

/** Replay from Store-retained private entropy; not a supported package API. */
export function verifyCausalAssignmentBlockV2Internal(
  protocol: unknown,
  block: unknown,
  randomizationMaterial: unknown,
): string[] {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (errors.length > 0) return errors;
  if (!isRecord(protocol) || protocol.version !== 2) {
    errors.push('v2 assignment replay requires a committed v2 protocol');
    return errors;
  }
  const protocolV2 = protocol as unknown as CommittedCausalStudyProtocolV2;
  if (!exactRecord(block, ['plan', 'decisions'], 'v2 assignment block', errors)) return errors;
  const planValid = validatePlanShape(block.plan, errors);
  if (!denseArray(block.decisions)) {
    errors.push('v2 assignment block decisions must be a dense ordered array');
    return errors;
  }
  const decisionsValid = block.decisions.map((decision, index) => validateDecisionShape(decision, index, errors));
  if (!(randomizationMaterial instanceof Uint8Array) || randomizationMaterial.byteLength !== ENTROPY_BYTES) {
    errors.push('retained private entropy must be exactly 32 raw bytes');
  }
  if (!planValid) return errors;

  const candidate = block.plan as Record<string, unknown>;
  if (candidate.studyId !== protocolV2.studyId) errors.push('assignment plan study identity does not match the committed protocol');
  if (candidate.protocolHash !== protocolV2.protocolHash) errors.push('assignment plan protocol identity does not match the committed protocol');
  if (Array.isArray(candidate.unitIdDigests) && candidate.unitIdDigests.length !== protocolV2.allocation.blockSize) {
    errors.push('assignment plan unit count does not match the committed protocol block size');
  }
  if (block.decisions.length !== (Array.isArray(candidate.unitIdDigests) ? candidate.unitIdDigests.length : -1)
      || block.decisions.length !== (Array.isArray(candidate.decisionIds) ? candidate.decisionIds.length : -1)) {
    errors.push('assignment plan↔decision bijection requires exactly one decision per ordered unit and decision ID');
  }
  const actualDecisionIds = block.decisions.filter(isRecord).map((decision) => decision.decisionId);
  if (new Set(actualDecisionIds).size !== actualDecisionIds.length) errors.push('assignment decisions contain a duplicate decisionId');

  const canDerive = safeId(candidate.blockId)
    && positiveSafeInteger(candidate.sequence)
    && positiveSafeInteger(candidate.createdAtMs)
    && denseArray(candidate.unitIdDigests)
    && candidate.unitIdDigests.length === protocolV2.allocation.blockSize
    && candidate.unitIdDigests.every(digest)
    && new Set(candidate.unitIdDigests).size === candidate.unitIdDigests.length
    && randomizationMaterial instanceof Uint8Array
    && randomizationMaterial.byteLength === ENTROPY_BYTES;
  if (!canDerive) return errors;
  const typedPlan = candidate as unknown as CausalAssignmentPlanV2;

  let expected: CausalAssignmentBlockV2;
  try {
    expected = deriveCausalAssignmentBlockV2Internal(protocolV2, {
      blockId: typedPlan.blockId,
      sequence: typedPlan.sequence,
      createdAtMs: typedPlan.createdAtMs,
      unitIdDigests: [...typedPlan.unitIdDigests],
      randomizationMaterial,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return errors;
  }

  if (typedPlan.blockRoot !== expected.plan.blockRoot) errors.push('assignment block root does not match its study/protocol/block domain');
  if (typedPlan.randomizationMaterialDigest !== expected.plan.randomizationMaterialDigest) {
    errors.push('assignment randomization material digest does not match retained private entropy');
  }
  if (typedPlan.allocationHash !== expected.plan.allocationHash) errors.push('assignment allocation hash does not replay');
  if (typedPlan.planHash !== expected.plan.planHash) errors.push('assignment plan hash does not replay');
  if (canonicalJson(typedPlan.unitIdDigests) !== canonicalJson(expected.plan.unitIdDigests)) {
    errors.push('assignment ordered unit digests do not replay');
  }
  if (canonicalJson(typedPlan.decisionIds) !== canonicalJson(expected.plan.decisionIds)) {
    errors.push('assignment decisionIds do not preserve the plan↔decision bijection and order');
  }
  if (typedPlan.firstDecisionHash !== expected.plan.firstDecisionHash) errors.push('assignment first decision anchor does not replay');
  if (typedPlan.lastDecisionHash !== expected.plan.lastDecisionHash) errors.push('assignment last decision anchor does not replay');

  for (let index = 0; index < block.decisions.length; index += 1) {
    const decision = block.decisions[index];
    if (!decisionsValid[index] || !isRecord(decision)) continue;
    const expectedDecision = expected.decisions[index];
    if (!expectedDecision) {
      errors.push('assignment decision[' + String(index) + '] has no plan entry');
      continue;
    }
    const label = 'assignment decision[' + String(index) + ']';
    if (decision.decisionId !== typedPlan.decisionIds[index]) errors.push(label + ' violates the ordered plan↔decision bijection');
    if (decision.decisionIndex !== index + 1) errors.push(label + ' decisionIndex is not gap-free plan order');
    if (decision.unitIdDigest !== typedPlan.unitIdDigests[index]) errors.push(label + ' unit digest does not match plan order');
    if (decision.studyId !== protocolV2.studyId || decision.protocolHash !== protocolV2.protocolHash) {
      errors.push(label + ' study/protocol identity is contradictory');
    }
    if (decision.blockId !== typedPlan.blockId || decision.blockSequence !== typedPlan.sequence) {
      errors.push(label + ' block identity or sequence is contradictory');
    }
    if (decision.blockRoot !== typedPlan.blockRoot) errors.push(label + ' block root is contradictory');
    if (decision.randomizationMaterialDigest !== typedPlan.randomizationMaterialDigest) errors.push(label + ' material digest is contradictory');
    if (decision.allocationHash !== typedPlan.allocationHash) errors.push(label + ' allocation hash is contradictory');
    if (decision.planHash !== typedPlan.planHash) errors.push(label + ' plan hash is contradictory');
    if (decision.assignedAtMs !== typedPlan.createdAtMs) errors.push(label + ' assignedAtMs must equal assignment plan createdAtMs');
    const previousDecision = block.decisions[index - 1];
    const expectedPredecessor = index === 0
      ? typedPlan.blockRoot
      : isRecord(previousDecision) ? previousDecision.eventHash : undefined;
    if (decision.previousEventHash !== expectedPredecessor) errors.push(label + ' immediate predecessor is invalid');
    if (decision.eventHash !== decisionHash(decision)) errors.push(label + ' event hash does not verify');
    if (canonicalJson(decision) !== canonicalJson(expectedDecision)) errors.push(label + ' does not replay from the retained entropy and protocol');
  }

  const firstActual = block.decisions[0];
  const lastActual = block.decisions.at(-1);
  const firstHash = isRecord(firstActual) ? firstActual.eventHash : undefined;
  const lastHash = isRecord(lastActual) ? lastActual.eventHash : undefined;
  if (typedPlan.firstDecisionHash !== firstHash) errors.push('assignment firstDecisionHash is not the derived first decision anchor');
  if (typedPlan.lastDecisionHash !== lastHash) errors.push('assignment lastDecisionHash is not the derived last decision anchor');
  return errors;
}
