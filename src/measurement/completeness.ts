/**
 * ISSUANCE CLASS: kernel_primitive — see `src/epistemic/issuance-map.ts`. This
 * produces the witness that lets a canonical boundary support a negative claim.
 * It issues nothing itself, so it can never be the place a stronger claim first
 * appears.
 *
 * Completeness witnesses for negative claims.
 *
 * Absence in an observation stream is not evidence of absence unless Fiscus has
 * positive evidence that the relevant source was complete for the event type,
 * scope, and time in question. Completeness is itself epistemic evidence and
 * therefore only the `supported` state qualifies an absence inference.
 *
 * COMPLETENESS ITSELF CAN BE CONTRADICTED (AII-003, WP-B03). A witness whose
 * state is `refuted` says the source did NOT completely cover that scope and
 * period. Such a witness used to be dropped by the same test that dropped an
 * irrelevant one, so a target with one supporting and one refuting witness
 * qualified on the strength of the supporter alone — a contradiction resolved
 * silently, in the most permissive direction available, at the gate that
 * decides whether "no incident was observed" may become "no incident
 * occurred".
 *
 * The two directions do not inherit the same way, and that asymmetry is the
 * whole of the fix:
 *
 *   COMPLETENESS INHERITS DOWNWARD. A source complete over the whole quarter
 *   is complete over March, so a supporting witness qualifies a target whose
 *   scope and period it CONTAINS.
 *
 *   INCOMPLETENESS INHERITS UPWARD. A source with a gap in March is incomplete
 *   over the quarter — but a gap somewhere in the quarter says nothing about
 *   March, because the gap may lie elsewhere. So a refuting witness bears on a
 *   target whose scope and period CONTAIN it.
 *
 * Treating refutation as the mirror image of support would be the more obvious
 * code and would refuse absence inferences that the evidence does not actually
 * contradict.
 */

import type { EpistemicState } from '../epistemic/state.ts';
import { scopeRelation, type Scope } from '../epistemic/scope.ts';
import { intervalRelation, type TimeInterval } from '../epistemic/time.ts';

export interface CompletenessWitnessInput {
  readonly id: string;
  readonly sourceId: string;
  readonly state: EpistemicState;
  readonly eventTypes: readonly string[];
  readonly scope: Scope;
  readonly period: TimeInterval;
}

export interface CompletenessWitness extends CompletenessWitnessInput {
  readonly eventTypes: readonly string[];
}

export interface NegativeClaimTarget {
  readonly eventType: string;
  readonly scope: Scope;
  readonly period: TimeInterval;
}

export interface CompletenessAssessment {
  readonly qualifiesAbsenceInference: boolean;
  readonly qualifyingWitnessIds: readonly string[];
  /**
   * Witnesses that bear against completeness of this target. Non-empty means
   * the sources disagree about whether the stream was complete, which is not
   * the same as their agreeing that it was not.
   */
  readonly conflictingWitnessIds: readonly string[];
  /**
   * Four-valued state of the completeness proposition itself, so a caller can
   * tell "no witness" from "witnesses that contradict each other" without
   * inferring either from the boolean.
   */
  readonly state: EpistemicState;
}

/** Negative event channels that must both be covered before coding `clean` can pass. */
export const CODING_CLEAN_COMPLETENESS_EVENT_TYPES = ['commit_reverted', 'linked_incident'] as const;
export type CodingCleanCompletenessEventType = (typeof CODING_CLEAN_COMPLETENESS_EVENT_TYPES)[number];

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

export function completenessWitness(input: CompletenessWitnessInput): CompletenessWitness {
  const id = nonEmpty(input.id, 'completeness witness id');
  const sourceId = nonEmpty(input.sourceId, 'completeness witness source id');
  if (input.eventTypes.length === 0) throw new Error('completeness witness requires at least one event type');
  const eventTypes = input.eventTypes.map((value) => nonEmpty(value, 'completeness witness event type')).sort();
  for (let i = 1; i < eventTypes.length; i++) {
    if (eventTypes[i] === eventTypes[i - 1]) throw new Error(`duplicate event type: ${eventTypes[i]}`);
  }
  return Object.freeze({
    id,
    sourceId,
    state: input.state,
    eventTypes: Object.freeze(eventTypes),
    scope: input.scope,
    period: input.period,
  });
}

function witnessCovers(target: NegativeClaimTarget, witness: CompletenessWitness): boolean {
  if (witness.state !== 'supported') return false;
  if (!witness.eventTypes.includes(target.eventType)) return false;

  const scopeCoverage = scopeRelation(witness.scope, target.scope);
  if (scopeCoverage !== 'equal' && scopeCoverage !== 'broader') return false;

  const timeCoverage = intervalRelation(witness.period, target.period);
  return timeCoverage === 'equal' || timeCoverage === 'contains';
}

/**
 * Does this witness bear AGAINST the target's completeness?
 *
 * Only `refuted` and `conflicted` witnesses can, and only when their own scope
 * and period sit inside the target's — see the asymmetry in the module comment.
 * A `conflicted` witness counts here because a source whose own completeness is
 * contradicted cannot license an absence inference either.
 */
function witnessRefutes(target: NegativeClaimTarget, witness: CompletenessWitness): boolean {
  if (witness.state !== 'refuted' && witness.state !== 'conflicted') return false;
  if (!witness.eventTypes.includes(target.eventType)) return false;

  const scopeCoverage = scopeRelation(witness.scope, target.scope);
  if (scopeCoverage !== 'equal' && scopeCoverage !== 'narrower') return false;

  const timeCoverage = intervalRelation(witness.period, target.period);
  return timeCoverage === 'equal' || timeCoverage === 'within';
}

export function assessCompleteness(
  target: NegativeClaimTarget,
  witnesses: ReadonlyArray<CompletenessWitness>,
): CompletenessAssessment {
  const eventType = nonEmpty(target.eventType, 'negative-claim event type');
  const canonicalTarget = { ...target, eventType };
  const qualifyingWitnessIds = witnesses
    .filter((witness) => witnessCovers(canonicalTarget, witness))
    .map((witness) => witness.id)
    .sort();
  const conflictingWitnessIds = witnesses
    .filter((witness) => witnessRefutes(canonicalTarget, witness))
    .map((witness) => witness.id)
    .sort();

  const supported = qualifyingWitnessIds.length > 0;
  const refuted = conflictingWitnessIds.length > 0;
  const state: EpistemicState = supported
    ? (refuted ? 'conflicted' : 'supported')
    : (refuted ? 'refuted' : 'unknown');

  return Object.freeze({
    // Only an uncontradicted `supported` licenses reading absence as a
    // negative. A contradiction about whether the source was complete leaves
    // the negative claim unearned — which is the conservative direction, and
    // the only one consistent with refusing to infer absence in the first
    // place.
    qualifiesAbsenceInference: state === 'supported',
    qualifyingWitnessIds: Object.freeze(qualifyingWitnessIds),
    conflictingWitnessIds: Object.freeze(conflictingWitnessIds),
    state,
  });
}
