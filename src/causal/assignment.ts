/**
 * Pre-exposure blocked randomisation for the initial causal-study lane.
 *
 * Version 1 accepts exactly two equally probable arms. A full block is created
 * before its units execute, contains one recorded assignment per predeclared
 * unit, and retains local material for replay. It is a reproducibility control,
 * not a claim that an operator could never alter every local copy.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  canonicalJson,
  causalEventHash,
  isCausalIdentifier,
  isSha256,
  sha256,
  verifyCommittedCausalProtocol,
} from './protocol.ts';
import type {
  CausalAssignmentBlockV2,
  CausalAssignmentPlan,
  CausalAssignmentPlanV2,
  CausalDecisionRecord,
  CausalDecisionRecordV2,
  CommittedCausalStudyProtocol,
  CommittedCausalStudyProtocolV2,
} from './types.ts';

export interface BlockedAssignmentDerivationInputV2 {
  blockId: string;
  sequence: number;
  createdAtMs: number;
  unitIdDigests: string[];
  /** Slice 2 pure derivation input; Slice 3 moves this behind atomic Store ownership. */
  randomizationMaterial: Uint8Array;
}

export interface BlockedAssignmentInput {
  blockId: string;
  createdAtMs?: number;
  /**
   * Pseudonymous SHA-256 unit identifiers, supplied in the predeclared block
   * order. Raw task text is intentionally not accepted.
   */
  unitIdHashes: string[];
  /**
   * Test seam only. Production takes 32 bytes from Node's cryptographic source.
   */
  randomizationMaterial?: Uint8Array;
  /** First event's local chain predecessor; defaults to the committed protocol hash. */
  initialPreviousEventHash?: string;
}

function finitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function unit32(material: Uint8Array, context: string, counter: number): number {
  const hash = Buffer.from(sha256(Buffer.concat([Buffer.from(material), Buffer.from(context + ':' + String(counter))])), 'hex');
  return hash.readUInt32BE(0);
}

function shuffle<T>(values: T[], material: Uint8Array, context: string): T[] {
  const result = [...values];
  let counter = 0;
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor((unit32(material, context, counter) / 0x1_0000_0000) * (i + 1));
    const next = result[i]!;
    result[i] = result[j]!;
    result[j] = next;
    counter += 1;
  }
  return result;
}

function allocationHash(
  protocol: CommittedCausalStudyProtocol,
  blockId: string,
  unitIdHashes: string[],
  assignedArmIds: string[],
  materialSha256: string,
): string {
  return sha256(JSON.stringify({
    protocolHash: protocol.protocolHash,
    blockId,
    unitIdHashes,
    assignedArmIds,
    materialSha256,
  }));
}

function buildDecision(input: Omit<CausalDecisionRecord, 'eventHash'>): CausalDecisionRecord {
  return { ...input, eventHash: causalEventHash(input) };
}

/**
 * Produce and retain a complete, balanced assignment block. The function makes
 * no network call and does not alter provider routing.
 */
export function createBlockedAssignmentPlan(
  protocol: CommittedCausalStudyProtocol,
  input: BlockedAssignmentInput,
): CausalAssignmentPlan {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (!isCausalIdentifier(input.blockId)) errors.push('blockId must be a compact identifier');
  if (!Array.isArray(input.unitIdHashes) || input.unitIdHashes.length !== protocol.allocation.blockSize) {
    errors.push('unitIdHashes must contain exactly the predeclared block size');
  } else {
    if (new Set(input.unitIdHashes).size !== input.unitIdHashes.length) errors.push('unitIdHashes must be unique within a block');
    if (!input.unitIdHashes.every(isSha256)) errors.push('unitIdHashes must be SHA-256 pseudonyms');
  }
  const createdAtMs = input.createdAtMs ?? Date.now();
  if (!finitePositiveInteger(createdAtMs) || createdAtMs < protocol.committedAtMs) {
    errors.push('assignment must be created at or after protocol commitment');
  }
  const initialPreviousEventHash = input.initialPreviousEventHash ?? protocol.protocolHash;
  if (!isSha256(initialPreviousEventHash)) errors.push('initialPreviousEventHash must be a SHA-256 hash');
  const material = input.randomizationMaterial ?? randomBytes(32);
  if (material.length < 16) errors.push('randomisation material must have at least 16 bytes');
  if (errors.length > 0) throw new Error('cannot create blocked causal assignment: ' + errors.join('; '));

  const arms = protocol.arms.map((arm) => arm.armId);
  const repetitions = input.unitIdHashes.length / arms.length;
  const balancedArms: string[] = [];
  for (const armId of arms) {
    for (let i = 0; i < repetitions; i += 1) balancedArms.push(armId);
  }
  const materialSha256 = sha256(material);
  const assignedArmIds = shuffle(balancedArms, material, protocol.protocolHash + ':' + input.blockId);
  const blockAllocationHash = allocationHash(protocol, input.blockId, input.unitIdHashes, assignedArmIds, materialSha256);
  const decisions: CausalDecisionRecord[] = [];
  let previousEventHash = initialPreviousEventHash;
  for (let index = 0; index < input.unitIdHashes.length; index += 1) {
    const decision = buildDecision({
      decisionId: 'decision:' + protocol.studyId + ':' + input.blockId + ':' + String(index + 1),
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      unitIdHash: input.unitIdHashes[index]!,
      assignedAtMs: createdAtMs,
      randomizationBlockId: input.blockId,
      assignedArmId: assignedArmIds[index]!,
      propensity: protocol.allocation.probabilityPerArm,
      allocationHash: blockAllocationHash,
      randomizationMaterialSha256: materialSha256,
      previousEventHash,
    });
    decisions.push(decision);
    previousEventHash = decision.eventHash;
  }
  return {
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId: input.blockId,
    createdAtMs,
    unitIdHashes: [...input.unitIdHashes],
    randomizationMaterialHex: Buffer.from(material).toString('hex'),
    randomizationMaterialSha256: materialSha256,
    allocationHash: blockAllocationHash,
    decisions,
  };
}

/** Replay an exported local assignment block and return every integrity defect. */
export function verifyBlockedAssignmentPlan(
  protocol: CommittedCausalStudyProtocol,
  plan: CausalAssignmentPlan,
): string[] {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (plan.studyId !== protocol.studyId || plan.protocolHash !== protocol.protocolHash) {
    errors.push('assignment plan is bound to another study or protocol');
    return errors;
  }
  if (!isSha256(plan.randomizationMaterialSha256) ||
      !/^[a-f0-9]+$/i.test(plan.randomizationMaterialHex) ||
      plan.randomizationMaterialHex.length % 2 !== 0) {
    errors.push('assignment plan randomisation material is malformed');
    return errors;
  }
  const material = Buffer.from(plan.randomizationMaterialHex, 'hex');
  if (sha256(material) !== plan.randomizationMaterialSha256) errors.push('assignment material does not match its recorded SHA-256');
  if (plan.decisions.length !== plan.unitIdHashes.length) errors.push('assignment plan must contain one decision per unit');
  const firstPrevious = plan.decisions[0]?.previousEventHash ?? protocol.protocolHash;
  let replay: CausalAssignmentPlan | null = null;
  try {
    replay = createBlockedAssignmentPlan(protocol, {
      blockId: plan.blockId,
      createdAtMs: plan.createdAtMs,
      unitIdHashes: plan.unitIdHashes,
      randomizationMaterial: material,
      initialPreviousEventHash: firstPrevious,
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (!replay) return errors;
  if (replay.allocationHash !== plan.allocationHash) errors.push('assignment allocation hash does not replay');
  if (canonicalJson(replay.decisions) !== canonicalJson(plan.decisions)) {
    errors.push('assignment decisions do not replay from the recorded material');
  }
  return errors;
}

const V2_ID_RE = /^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
const V2_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const V2_ENTROPY_BYTES = 32;
const V2_PLAN_KEYS = [
  'type', 'version', 'studyId', 'blockId', 'protocolHash', 'sequence',
  'createdAtMs', 'blockRoot', 'unitIdDigests', 'randomizationMaterialDigest',
  'allocationHash', 'decisionIds', 'firstDecisionHash', 'lastDecisionHash',
  'planHash',
] as const;
const V2_DECISION_KEYS = [
  'type', 'version', 'decisionId', 'studyId', 'blockId', 'protocolHash',
  'blockSequence', 'decisionIndex', 'unitIdDigest', 'assignedAtMs',
  'assignedArmId', 'propensity', 'blockRoot', 'planHash', 'allocationHash',
  'randomizationMaterialDigest', 'previousEventHash', 'eventHash',
] as const;
const V2_INPUT_KEYS = [
  'blockId', 'sequence', 'createdAtMs', 'unitIdDigests',
  'randomizationMaterial',
] as const;

function isRecordV2(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSafeIntegerV2(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isDenseArrayV2(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return Object.keys(value).every((key) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length);
}

function isNamespacedIdV2(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 3
    && value.length <= 160
    && V2_ID_RE.test(value)
    && !/(?:bearer|basic)(?:[._-]|$)|api[_-]?key|secret|password|token|(?:^|:)(?:sk|rk|pk)-/i.test(value)
    && !/^[^.]+\.[^.]+\.[^.]+$/.test(value);
}

function isDigestV2(value: unknown): value is string {
  return typeof value === 'string' && V2_DIGEST_RE.test(value);
}

function exactRecordV2(
  value: unknown,
  keys: readonly string[],
  label: string,
  errors: string[],
): value is Record<string, unknown> {
  if (!isRecordV2(value)) {
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

function uint64BeV2(value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

function domainHashV2(domain: string, material: unknown): string {
  return 'sha256:' + createHash('sha256')
    .update(domain + '\n2\n' + canonicalJson(material))
    .digest('hex');
}

function blockRootV2(protocol: CommittedCausalStudyProtocolV2, blockId: string): string {
  return 'sha256:' + sha256(canonicalJson({
    domain: 'fiscus.causal.assignment-block-root',
    version: 1,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
  }));
}

function randomizationMaterialDigestV2(material: Uint8Array): string {
  return 'sha256:' + createHash('sha256')
    .update(Buffer.from('fiscus.causal.randomization-material\n1\n'))
    .update(uint64BeV2(material.byteLength))
    .update(material)
    .digest('hex');
}

function decisionIdV2(
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

function shuffledArmIdsV2(
  protocol: CommittedCausalStudyProtocolV2,
  blockId: string,
  blockRoot: string,
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
    blockRoot,
    sequence,
    unitIdDigests,
    orderedArmIds,
  });
  let counter = 0;
  const nextWord = (): number => {
    const digest = createHash('sha256')
      .update(Buffer.from('fiscus.causal.assignment-shuffle\n2\n'))
      .update(uint64BeV2(material.byteLength))
      .update(material)
      .update(uint64BeV2(Buffer.byteLength(context)))
      .update(context)
      .update(uint64BeV2(counter))
      .digest();
    counter += 1;
    return digest.readUInt32BE(0);
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

function allocationHashV2(
  protocol: CommittedCausalStudyProtocolV2,
  blockId: string,
  blockRoot: string,
  sequence: number,
  assignments: Array<{
    decisionIndex: number;
    unitIdDigest: string;
    assignedArmId: string;
    propensity: 0.5;
  }>,
  randomizationMaterialDigest: string,
): string {
  return domainHashV2('fiscus.causal.assignment-allocation', {
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
    blockRoot,
    sequence,
    assignments,
    randomizationMaterialDigest,
  });
}

function planHashV2(
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
  return domainHashV2('fiscus.causal.assignment-plan', {
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

function decisionEventHashV2(decision: Record<string, unknown>): string {
  const { eventHash: _eventHash, ...material } = decision;
  return domainHashV2('fiscus.causal.decision', material);
}

function validateDerivationInputV2(
  protocol: CommittedCausalStudyProtocolV2,
  input: unknown,
): string[] {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (protocol?.version !== 2) errors.push('v2 assignment requires a committed v2 protocol');
  if (errors.length > 0) return errors;
  if (!exactRecordV2(input, V2_INPUT_KEYS, 'v2 assignment input', errors)) return errors;
  if (!isNamespacedIdV2(input.blockId)) errors.push('blockId must be a safe namespaced identifier');
  if (!positiveSafeIntegerV2(input.sequence)) errors.push('sequence must be a positive safe integer');
  if (!positiveSafeIntegerV2(input.createdAtMs)) {
    errors.push('createdAtMs must be a positive safe-integer epoch timestamp');
  } else if (protocol?.version === 2) {
    if (input.createdAtMs < protocol.studyWindow.startsAtMs) errors.push('assignment must not precede the study window');
    if (protocol.studyWindow.endsAtMs !== null && input.createdAtMs > protocol.studyWindow.endsAtMs) {
      errors.push('assignment must not follow the study window');
    }
  }
  if (!isDenseArrayV2(input.unitIdDigests)) {
    errors.push('unitIdDigests must be a dense ordered array');
  } else if (protocol?.version === 2) {
    if (input.unitIdDigests.length !== protocol.allocation.blockSize) {
      errors.push('unitIdDigests must contain exactly the committed protocol block size');
    }
    if (!input.unitIdDigests.every(isDigestV2)) errors.push('unitIdDigests must contain lowercase namespaced SHA-256 digests');
    if (new Set(input.unitIdDigests).size !== input.unitIdDigests.length) errors.push('unitIdDigests must be unique within the ordered block');
  }
  if (!(input.randomizationMaterial instanceof Uint8Array) || input.randomizationMaterial.byteLength !== V2_ENTROPY_BYTES) {
    errors.push('randomization material must be exactly 32 raw bytes');
  }
  return errors;
}

/**
 * Pure Slice 2 derivation contract. This is not the production allocation
 * ceremony: Slice 3 moves entropy generation and this derivation behind atomic
 * Store write ownership before any allocation may be disclosed.
 */
export function deriveBlockedAssignmentPlanV2(
  protocol: CommittedCausalStudyProtocolV2,
  input: BlockedAssignmentDerivationInputV2,
): CausalAssignmentBlockV2 {
  const errors = validateDerivationInputV2(protocol, input);
  if (errors.length > 0) throw new Error('cannot derive v2 blocked causal assignment: ' + errors.join('; '));

  const material = Buffer.from(input.randomizationMaterial);
  const blockRoot = blockRootV2(protocol, input.blockId);
  const randomizationMaterialDigest = randomizationMaterialDigestV2(material);
  const assignedArmIds = shuffledArmIdsV2(
    protocol,
    input.blockId,
    blockRoot,
    input.sequence,
    input.unitIdDigests,
    material,
  );
  const decisionIds = input.unitIdDigests.map((unitIdDigest, index) => decisionIdV2(
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
  const allocationHash = allocationHashV2(
    protocol,
    input.blockId,
    blockRoot,
    input.sequence,
    assignments,
    randomizationMaterialDigest,
  );
  const planHash = planHashV2(protocol, {
    blockId: input.blockId,
    blockRoot,
    sequence: input.sequence,
    createdAtMs: input.createdAtMs,
    randomizationMaterialDigest,
    allocationHash,
    unitIdDigests: input.unitIdDigests,
    decisionIds,
  });

  const decisions: CausalDecisionRecordV2[] = [];
  let previousEventHash = blockRoot;
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
      blockRoot,
      planHash,
      allocationHash,
      randomizationMaterialDigest,
      previousEventHash,
    };
    const decision: CausalDecisionRecordV2 = {
      ...materialDecision,
      eventHash: decisionEventHashV2(materialDecision),
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
      blockRoot,
      unitIdDigests: [...input.unitIdDigests],
      randomizationMaterialDigest,
      allocationHash,
      decisionIds,
      firstDecisionHash: decisions[0]!.eventHash,
      lastDecisionHash: decisions.at(-1)!.eventHash,
      planHash,
    },
    decisions,
  };
}

function validatePlanShapeV2(plan: unknown, errors: string[]): plan is Record<string, unknown> {
  if (!exactRecordV2(plan, V2_PLAN_KEYS, 'v2 assignment plan', errors)) return false;
  if (plan.type !== 'fiscus.causal-assignment-plan') errors.push('v2 assignment plan type is invalid');
  if (plan.version !== 2) errors.push('v2 assignment plan version is invalid');
  for (const [field, value] of [
    ['studyId', plan.studyId],
    ['blockId', plan.blockId],
  ] as const) {
    if (!isNamespacedIdV2(value)) errors.push('v2 assignment plan ' + field + ' is invalid');
  }
  for (const [field, value] of [
    ['protocolHash', plan.protocolHash],
    ['blockRoot', plan.blockRoot],
    ['randomizationMaterialDigest', plan.randomizationMaterialDigest],
    ['allocationHash', plan.allocationHash],
    ['firstDecisionHash', plan.firstDecisionHash],
    ['lastDecisionHash', plan.lastDecisionHash],
    ['planHash', plan.planHash],
  ] as const) {
    if (!isDigestV2(value)) errors.push('v2 assignment plan ' + field + ' is invalid');
  }
  if (!positiveSafeIntegerV2(plan.sequence)) errors.push('v2 assignment plan sequence must be a positive safe integer');
  if (!positiveSafeIntegerV2(plan.createdAtMs)) errors.push('v2 assignment plan createdAtMs must be a positive safe integer');
  if (!isDenseArrayV2(plan.unitIdDigests) || !plan.unitIdDigests.every(isDigestV2)) {
    errors.push('v2 assignment plan unitIdDigests must be a dense digest array');
  } else if (new Set(plan.unitIdDigests).size !== plan.unitIdDigests.length) {
    errors.push('v2 assignment plan unitIdDigests contain a duplicate');
  }
  if (!isDenseArrayV2(plan.decisionIds) || !plan.decisionIds.every(isNamespacedIdV2)) {
    errors.push('v2 assignment plan decisionIds must be a dense namespaced-ID array');
  } else if (new Set(plan.decisionIds).size !== plan.decisionIds.length) {
    errors.push('v2 assignment plan decisionIds contain a duplicate');
  }
  return true;
}

function validateDecisionShapeV2(decision: unknown, index: number, errors: string[]): decision is Record<string, unknown> {
  const label = 'v2 assignment decision[' + String(index) + ']';
  if (!exactRecordV2(decision, V2_DECISION_KEYS, label, errors)) return false;
  if (decision.type !== 'fiscus.causal-decision') errors.push(label + ' type is invalid');
  if (decision.version !== 2) errors.push(label + ' version is invalid');
  for (const [field, value] of [
    ['decisionId', decision.decisionId],
    ['studyId', decision.studyId],
    ['blockId', decision.blockId],
    ['assignedArmId', decision.assignedArmId],
  ] as const) {
    if (!isNamespacedIdV2(value)) errors.push(label + ' ' + field + ' is invalid');
  }
  for (const [field, value] of [
    ['protocolHash', decision.protocolHash],
    ['unitIdDigest', decision.unitIdDigest],
    ['blockRoot', decision.blockRoot],
    ['planHash', decision.planHash],
    ['allocationHash', decision.allocationHash],
    ['randomizationMaterialDigest', decision.randomizationMaterialDigest],
    ['previousEventHash', decision.previousEventHash],
    ['eventHash', decision.eventHash],
  ] as const) {
    if (!isDigestV2(value)) errors.push(label + ' ' + field + ' is invalid');
  }
  if (!positiveSafeIntegerV2(decision.blockSequence)) errors.push(label + ' blockSequence must be a positive safe integer');
  if (!positiveSafeIntegerV2(decision.decisionIndex)) errors.push(label + ' decisionIndex must be a positive safe integer');
  if (!positiveSafeIntegerV2(decision.assignedAtMs)) errors.push(label + ' assignedAtMs must be a positive safe integer');
  if (decision.propensity !== 0.5) errors.push(label + ' propensity must equal the committed protocol probability 0.5');
  return true;
}

/** Replay a v2 assignment from the Store-retained private entropy bytes. */
export function verifyBlockedAssignmentPlanV2(
  protocol: unknown,
  block: unknown,
  randomizationMaterial: unknown,
): string[] {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (errors.length > 0) return errors;
  if (!isRecordV2(protocol) || protocol.version !== 2) {
    errors.push('v2 assignment replay requires a committed v2 protocol');
    return errors;
  }
  const protocolV2 = protocol as unknown as CommittedCausalStudyProtocolV2;
  if (!exactRecordV2(block, ['plan', 'decisions'], 'v2 assignment block', errors)) return errors;
  const planValid = validatePlanShapeV2(block.plan, errors);
  if (!isDenseArrayV2(block.decisions)) {
    errors.push('v2 assignment block decisions must be a dense ordered array');
    return errors;
  }
  const decisionsValid = block.decisions.map((decision, index) => validateDecisionShapeV2(decision, index, errors));
  if (!(randomizationMaterial instanceof Uint8Array) || randomizationMaterial.byteLength !== V2_ENTROPY_BYTES) {
    errors.push('retained private entropy must be exactly 32 raw bytes');
  }
  if (!planValid) return errors;

  const plan = block.plan as Record<string, unknown>;
  if (plan.studyId !== protocolV2.studyId) errors.push('assignment plan study identity does not match the committed protocol');
  if (plan.protocolHash !== protocolV2.protocolHash) errors.push('assignment plan protocol identity does not match the committed protocol');
  if (Array.isArray(plan.unitIdDigests) && plan.unitIdDigests.length !== protocolV2.allocation.blockSize) {
    errors.push('assignment plan unit count does not match the committed protocol block size');
  }
  if (block.decisions.length !== (Array.isArray(plan.unitIdDigests) ? plan.unitIdDigests.length : -1)
      || block.decisions.length !== (Array.isArray(plan.decisionIds) ? plan.decisionIds.length : -1)) {
    errors.push('assignment plan↔decision bijection requires exactly one decision per ordered unit and decision ID');
  }
  const actualDecisionIds = block.decisions
    .filter(isRecordV2)
    .map((decision) => decision.decisionId);
  if (new Set(actualDecisionIds).size !== actualDecisionIds.length) errors.push('assignment decisions contain a duplicate decisionId');

  const canDerive = isNamespacedIdV2(plan.blockId)
    && positiveSafeIntegerV2(plan.sequence)
    && positiveSafeIntegerV2(plan.createdAtMs)
    && isDenseArrayV2(plan.unitIdDigests)
    && plan.unitIdDigests.length === protocolV2.allocation.blockSize
    && plan.unitIdDigests.every(isDigestV2)
    && new Set(plan.unitIdDigests).size === plan.unitIdDigests.length
    && randomizationMaterial instanceof Uint8Array
    && randomizationMaterial.byteLength === V2_ENTROPY_BYTES;
  if (!canDerive) return errors;
  const typedPlan = plan as unknown as CausalAssignmentPlanV2;

  let expected: CausalAssignmentBlockV2;
  try {
    expected = deriveBlockedAssignmentPlanV2(protocolV2, {
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
    if (!decisionsValid[index] || !isRecordV2(decision)) continue;
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
      : isRecordV2(previousDecision) ? previousDecision.eventHash : undefined;
    if (decision.previousEventHash !== expectedPredecessor) errors.push(label + ' immediate predecessor is invalid');
    if (decision.eventHash !== decisionEventHashV2(decision)) errors.push(label + ' event hash does not verify');
    if (canonicalJson(decision) !== canonicalJson(expectedDecision)) errors.push(label + ' does not replay from the retained entropy and protocol');
  }

  const firstActualDecision = block.decisions[0];
  const lastActualDecision = block.decisions.at(-1);
  const firstActualHash = isRecordV2(firstActualDecision) ? firstActualDecision.eventHash : undefined;
  const lastActualHash = isRecordV2(lastActualDecision) ? lastActualDecision.eventHash : undefined;
  if (typedPlan.firstDecisionHash !== firstActualHash) errors.push('assignment firstDecisionHash is not the derived first decision anchor');
  if (typedPlan.lastDecisionHash !== lastActualHash) errors.push('assignment lastDecisionHash is not the derived last decision anchor');
  return errors;
}
