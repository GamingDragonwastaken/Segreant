/**
 * Pre-exposure blocked randomisation for the initial causal-study lane.
 *
 * Version 1 accepts exactly two equally probable arms. A full block is created
 * before its units execute, contains one recorded assignment per predeclared
 * unit, and retains local material for replay. It is a reproducibility control,
 * not a claim that an operator could never alter every local copy.
 */

import { randomBytes } from 'node:crypto';
import {
  canonicalJson,
  causalEventHash,
  isCausalIdentifier,
  isSha256,
  sha256,
  verifyCommittedCausalProtocol,
} from './protocol.ts';
import type {
  CausalAssignmentPlan,
  CausalDecisionRecord,
  CommittedCausalStudyProtocol,
} from './types.ts';

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
