/**
 * Strict replay verification for retained version-1 assignment evidence.
 *
 * Version-2 assignment formula execution and private entropy now live solely
 * inside the atomic Store transaction implementation in store/causal.ts. New
 * version-1 allocation is forbidden; this module cannot create an assignment.
 */

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

const PLAN_KEYS = [
  'studyId', 'protocolHash', 'blockId', 'createdAtMs', 'unitIdHashes',
  'randomizationMaterialHex', 'randomizationMaterialSha256', 'allocationHash',
  'decisions',
] as const;

const DECISION_KEYS = [
  'decisionId', 'studyId', 'protocolHash', 'unitIdHash', 'assignedAtMs',
  'randomizationBlockId', 'assignedArmId', 'propensity', 'allocationHash',
  'randomizationMaterialSha256', 'previousEventHash', 'eventHash',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
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

function replayRetainedV1Plan(
  protocol: CommittedCausalStudyProtocol,
  plan: CausalAssignmentPlan,
  material: Uint8Array,
): { allocationHash: string; decisions: CausalDecisionRecord[] } {
  const arms = protocol.arms.map((arm) => arm.armId);
  const repetitions = plan.unitIdHashes.length / arms.length;
  const balancedArms: string[] = [];
  for (const armId of arms) {
    for (let i = 0; i < repetitions; i += 1) balancedArms.push(armId);
  }
  const materialSha256 = sha256(material);
  const assignedArmIds = shuffle(balancedArms, material, protocol.protocolHash + ':' + plan.blockId);
  const blockAllocationHash = allocationHash(
    protocol,
    plan.blockId,
    plan.unitIdHashes,
    assignedArmIds,
    materialSha256,
  );
  const decisions: CausalDecisionRecord[] = [];
  let previousEventHash = plan.decisions[0]?.previousEventHash ?? protocol.protocolHash;
  for (let index = 0; index < plan.unitIdHashes.length; index += 1) {
    const decisionMaterial: Omit<CausalDecisionRecord, 'eventHash'> = {
      decisionId: 'decision:' + protocol.studyId + ':' + plan.blockId + ':' + String(index + 1),
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      unitIdHash: plan.unitIdHashes[index]!,
      assignedAtMs: plan.createdAtMs,
      randomizationBlockId: plan.blockId,
      assignedArmId: assignedArmIds[index]!,
      propensity: protocol.allocation.probabilityPerArm,
      allocationHash: blockAllocationHash,
      randomizationMaterialSha256: materialSha256,
      previousEventHash,
    };
    const decision = { ...decisionMaterial, eventHash: causalEventHash(decisionMaterial) };
    decisions.push(decision);
    previousEventHash = decision.eventHash;
  }
  return { allocationHash: blockAllocationHash, decisions };
}

/** Replay a retained version-1 assignment block and return every defect. */
export function verifyBlockedAssignmentPlan(
  protocolValue: unknown,
  planValue: unknown,
): string[] {
  const errors = verifyCommittedCausalProtocol(protocolValue);
  if (!isRecord(protocolValue) || protocolValue.version !== 1) {
    errors.push('retained version-1 assignment replay requires an exact committed v1 protocol');
    return errors;
  }
  if (errors.length > 0) return errors;
  const protocol = protocolValue as unknown as CommittedCausalStudyProtocol;
  if (!isRecord(planValue) || !exactKeys(planValue, PLAN_KEYS)) {
    errors.push('retained version-1 assignment plan must have the exact record shape');
    return errors;
  }
  const plan = planValue as unknown as CausalAssignmentPlan;
  if (plan.studyId !== protocol.studyId || plan.protocolHash !== protocol.protocolHash) {
    errors.push('assignment plan is bound to another study or protocol');
    return errors;
  }
  if (!isCausalIdentifier(plan.blockId)
      || !finitePositiveInteger(plan.createdAtMs)
      || plan.createdAtMs < protocol.committedAtMs) {
    errors.push('retained assignment block identity or timestamp is invalid');
  }
  const unitIdHashesAreDense = denseArray(plan.unitIdHashes);
  if (!unitIdHashesAreDense
      || plan.unitIdHashes.length !== protocol.allocation.blockSize
      || !plan.unitIdHashes.every(isSha256)
      || new Set(plan.unitIdHashes).size !== plan.unitIdHashes.length) {
    errors.push('retained assignment units do not match the committed block contract');
  }
  const decisionsAreDense = denseArray(plan.decisions);
  if (!decisionsAreDense
      || !unitIdHashesAreDense
      || plan.decisions.length !== plan.unitIdHashes.length) {
    errors.push('assignment plan must contain one dense decision per unit');
  } else {
    for (const decision of plan.decisions) {
      if (!isRecord(decision) || !exactKeys(decision, DECISION_KEYS)) {
        errors.push('retained assignment decision must have the exact record shape');
        continue;
      }
      if (!isCausalIdentifier(decision.decisionId)
          || !isSha256(decision.unitIdHash)
          || !isCausalIdentifier(decision.assignedArmId)
          || !isSha256(decision.allocationHash)
          || !isSha256(decision.randomizationMaterialSha256)
          || !isSha256(decision.previousEventHash)
          || !isSha256(decision.eventHash)
          || !finitePositiveInteger(decision.assignedAtMs)) {
        errors.push('retained assignment decision contains an invalid scalar');
      }
    }
  }
  if (!isSha256(plan.randomizationMaterialSha256)
      || typeof plan.randomizationMaterialHex !== 'string'
      || !/^[a-f0-9]+$/.test(plan.randomizationMaterialHex)
      || plan.randomizationMaterialHex.length < 32
      || plan.randomizationMaterialHex.length % 2 !== 0
      || !isSha256(plan.allocationHash)) {
    errors.push('assignment plan randomisation material is malformed');
    return errors;
  }
  if (errors.length > 0) return errors;
  const material = Buffer.from(plan.randomizationMaterialHex, 'hex');
  try {
    if (sha256(material) !== plan.randomizationMaterialSha256) {
      errors.push('assignment material does not match its recorded SHA-256');
    }
    const replay = replayRetainedV1Plan(protocol, plan, material);
    if (replay.allocationHash !== plan.allocationHash) errors.push('assignment allocation hash does not replay');
    if (canonicalJson(replay.decisions) !== canonicalJson(plan.decisions)) {
      errors.push('assignment decisions do not replay from the recorded material');
    }
  } finally {
    material.fill(0);
  }
  return errors;
}
