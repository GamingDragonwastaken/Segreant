/**
 * Four-valued epistemic state.
 *
 * Truth and information are deliberately separated. A proposition can have no
 * evidence, only supporting evidence, only refuting evidence, or both. The
 * fourth case is conflict, not an invitation to overwrite one witness with the
 * other. This is the smallest primitive in the Trusted Epistemic Kernel.
 */

export const EPISTEMIC_STATES = ['unknown', 'supported', 'refuted', 'conflicted'] as const;
export type EpistemicState = (typeof EPISTEMIC_STATES)[number];

export interface EvidencePolarity {
  readonly support: boolean;
  readonly refute: boolean;
}

const POLARITY: Readonly<Record<EpistemicState, EvidencePolarity>> = Object.freeze({
  unknown: Object.freeze({ support: false, refute: false }),
  supported: Object.freeze({ support: true, refute: false }),
  refuted: Object.freeze({ support: false, refute: true }),
  conflicted: Object.freeze({ support: true, refute: true }),
});

export function statePolarity(state: EpistemicState): EvidencePolarity {
  const polarity = POLARITY[state];
  return { support: polarity.support, refute: polarity.refute };
}

export function stateFromPolarity(polarity: EvidencePolarity): EpistemicState {
  if (polarity.support) return polarity.refute ? 'conflicted' : 'supported';
  return polarity.refute ? 'refuted' : 'unknown';
}

/** Least upper bound in the information order: retain every observed polarity. */
export function informationJoin(a: EpistemicState, b: EpistemicState): EpistemicState {
  const ap = POLARITY[a];
  const bp = POLARITY[b];
  return stateFromPolarity({
    support: ap.support || bp.support,
    refute: ap.refute || bp.refute,
  });
}

/** `a <=_k b`: every polarity known in `a` is also known in `b`. */
export function informationLeq(a: EpistemicState, b: EpistemicState): boolean {
  const ap = POLARITY[a];
  const bp = POLARITY[b];
  return (!ap.support || bp.support) && (!ap.refute || bp.refute);
}

export function aggregateEvidence(evidence: ReadonlyArray<EvidencePolarity>): EpistemicState {
  let state: EpistemicState = 'unknown';
  for (const polarity of evidence) {
    state = informationJoin(state, stateFromPolarity(polarity));
  }
  return state;
}
