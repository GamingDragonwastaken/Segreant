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
  return Object.freeze({
    qualifiesAbsenceInference: qualifyingWitnessIds.length > 0,
    qualifyingWitnessIds: Object.freeze(qualifyingWitnessIds),
  });
}
