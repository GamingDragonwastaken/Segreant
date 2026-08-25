/**
 * Test-only constructor for retained version-1 assignment evidence.
 *
 * Production may decode and replay these historical rows but cannot allocate
 * new version-1 assignments. This fixture therefore requires explicit
 * deterministic material and is excluded from the production build/package.
 */

import {
  causalEventHash,
  sha256,
} from '../../src/causal/protocol.ts';
import type {
  CausalAssignmentPlan,
  CausalDecisionRecord,
  CommittedCausalStudyProtocol,
} from '../../src/causal/types.ts';

export interface RetainedCausalV1AssignmentFixtureInput {
  blockId: string;
  createdAtMs: number;
  unitIdHashes: string[];
  randomizationMaterial: Uint8Array;
  initialPreviousEventHash?: string;
}

function unit32(material: Uint8Array, context: string, counter: number): number {
  const hash = Buffer.from(sha256(Buffer.concat([
    Buffer.from(material),
    Buffer.from(context + ':' + String(counter)),
  ])), 'hex');
  return hash.readUInt32BE(0);
}

function shuffle<T>(values: T[], material: Uint8Array, context: string): T[] {
  const result = [...values];
  let counter = 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(
      (unit32(material, context, counter) / 0x1_0000_0000) * (index + 1),
    );
    const current = result[index]!;
    result[index] = result[swapIndex]!;
    result[swapIndex] = current;
    counter += 1;
  }
  return result;
}

export function createRetainedCausalV1AssignmentFixture(
  protocol: CommittedCausalStudyProtocol,
  input: RetainedCausalV1AssignmentFixtureInput,
): CausalAssignmentPlan {
  const materialSha256 = sha256(input.randomizationMaterial);
  const arms = protocol.arms.map((arm) => arm.armId);
  const balancedArms = arms.flatMap((armId) =>
    Array.from({ length: input.unitIdHashes.length / arms.length }, () => armId),
  );
  const assignedArmIds = shuffle(
    balancedArms,
    input.randomizationMaterial,
    protocol.protocolHash + ':' + input.blockId,
  );
  const allocationHash = sha256(JSON.stringify({
    protocolHash: protocol.protocolHash,
    blockId: input.blockId,
    unitIdHashes: input.unitIdHashes,
    assignedArmIds,
    materialSha256,
  }));
  const decisions: CausalDecisionRecord[] = [];
  let previousEventHash = input.initialPreviousEventHash ?? protocol.protocolHash;
  for (let index = 0; index < input.unitIdHashes.length; index += 1) {
    const material = {
      decisionId: 'decision:' + protocol.studyId + ':' + input.blockId + ':' + String(index + 1),
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      unitIdHash: input.unitIdHashes[index]!,
      assignedAtMs: input.createdAtMs,
      randomizationBlockId: input.blockId,
      assignedArmId: assignedArmIds[index]!,
      propensity: protocol.allocation.probabilityPerArm,
      allocationHash,
      randomizationMaterialSha256: materialSha256,
      previousEventHash,
    };
    const decision = { ...material, eventHash: causalEventHash(material) };
    decisions.push(decision);
    previousEventHash = decision.eventHash;
  }
  return {
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId: input.blockId,
    createdAtMs: input.createdAtMs,
    unitIdHashes: [...input.unitIdHashes],
    randomizationMaterialHex: Buffer.from(input.randomizationMaterial).toString('hex'),
    randomizationMaterialSha256: materialSha256,
    allocationHash,
    decisions,
  };
}
