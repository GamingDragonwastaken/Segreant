/** Test-only deterministic dependency and formula access for the inaccessible Store harness. */
import {
  deriveCausalAssignmentBlockV2Internal,
  verifyCausalAssignmentBlockV2Internal,
} from '../../src/store/causalInternal.ts';
import type { CommittedCausalStudyProtocolV2 } from '../../src/causal/types.ts';

export function deriveDeterministicCausalAssignmentV2(
  protocol: CommittedCausalStudyProtocolV2,
  input: {
    blockId: string;
    sequence: number;
    createdAtMs: number;
    unitIdDigests: string[];
    randomizationMaterial: Uint8Array;
  },
) {
  return deriveCausalAssignmentBlockV2Internal(protocol, input);
}

export function verifyDeterministicCausalAssignmentV2(
  protocol: unknown,
  block: unknown,
  randomizationMaterial: unknown,
): string[] {
  return verifyCausalAssignmentBlockV2Internal(protocol, block, randomizationMaterial);
}

export function createDeterministicCausalRng(source: Uint8Array): {
  randomBytes: (size: number) => Buffer;
  calls: () => number;
  issuedBuffers: () => Buffer[];
} {
  const template = Buffer.from(source);
  const issued: Buffer[] = [];
  let callCount = 0;
  return {
    randomBytes(size: number): Buffer {
      if (size !== template.byteLength) throw new Error('unexpected deterministic causal RNG size');
      callCount += 1;
      const result = Buffer.from(template);
      issued.push(result);
      return result;
    },
    calls: () => callCount,
    issuedBuffers: () => issued,
  };
}
