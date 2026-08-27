/**
 * Deterministic identity material for the local causal producer.
 *
 * A causal assignment must identify a unit before the outcome is known. The
 * producer therefore derives the identity from retained commit metadata and a
 * realization snapshot, never from prompts, source text, or a caller-selected
 * opaque assertion. The digest is a local reproducibility primitive, not an
 * external audit signature or proof that a human outcome is causal.
 */

import { canonicalJson, sha256 } from './protocol.ts';

export interface IndependentCausalUnitIdentityInputV2 {
  studyId: string;
  commitHash: string;
  project: string;
  tsEpochMs: number;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  subjectDigest: string | null;
}

/**
 * Produce the identity digest that a prospective assignment must use. Keeping
 * the source fields explicit makes the derivation reviewable and gives the
 * validator enough material to recompute it from retained rows.
 */
export function independentCausalUnitIdDigestV2(
  input: IndependentCausalUnitIdentityInputV2,
): string {
  return 'sha256:' + sha256(
    'fiscus.causal.independent-unit\n2\n' + canonicalJson(input),
  );
}

