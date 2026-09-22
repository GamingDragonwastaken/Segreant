/**
 * Small executable abstract checker for WP-R01/WP-R02.
 *
 * This is deliberately an assessment of preservation, not a truth prover. It
 * compares a proposed abstract ClaimProfile and its coordinates with the
 * conservative abstract profile supplied by cited evidence. Ordered profile
 * axes may only stay equal or become weaker; the four-valued epistemic state may
 * only contain polarities available in the cited evidence, and a conflict may
 * not be collapsed. Monetary bases are semantic alternatives, not a ladder.
 *
 * Coordinate relations come from the kernel's existing scope/grain primitives.
 * Natural coarsening/broadening and declared grain rollups are accepted. A
 * finer, narrower, disjoint, or otherwise incomparable coordinate needs an
 * exact typed CoordinateWitness from the existing derivation vocabulary.
 * None of these checks establishes that the proposition is true.
 */

import {
  AUTHENTICITY,
  CAUSALITY,
  COVERAGE,
  DECISION_FITNESS,
  FINALITY,
  INTEGRITY,
  MEASUREMENT,
  SCOPE_STATUS,
  mergeClaimProfiles,
  type ClaimProfile,
} from './profile.ts';
import { assessCoordinateDerivation, type ClaimCoordinates, type CoordinateWitness, type CoordinateWitnessKind } from './derivation.ts';
import { grainIsSupportedBy, type Grain } from './grain.ts';
import { scopeIsSupportedBy, type Scope } from './scope.ts';
import { informationLeq, type EpistemicState } from './state.ts';

/** The abstract information a transformation claims to preserve. */
export interface PreservationAbstract {
  readonly profile: ClaimProfile;
  readonly coordinates: ClaimCoordinates;
}

/** One cited evidence abstraction, identified for refusal diagnostics. */
export interface CitedEvidenceAbstract extends PreservationAbstract {
  readonly id: string;
}

export interface PreservationInput {
  readonly proposed: PreservationAbstract;
  readonly citedEvidence: ReadonlyArray<CitedEvidenceAbstract>;
  /** Existing exact coordinate relations that may discharge coordinate changes. */
  readonly coordinateWitnesses?: ReadonlyArray<CoordinateWitness>;
}

export type PreservationVerdict = 'allowed' | 'refused';

export type PreservationReasonCode =
  | 'no_cited_evidence'
  | 'epistemic_escalation'
  | 'epistemic_conflict_not_retained'
  | 'monetary_basis_incomparable'
  | 'integrity_escalation'
  | 'authenticity_escalation'
  | 'scope_profile_escalation'
  | 'coverage_escalation'
  | 'measurement_escalation'
  | 'causality_escalation'
  | 'finality_escalation'
  | 'decision_fitness_escalation'
  | 'grain_relation_missing'
  | 'scope_relation_missing'
  | 'duplicate_coordinate_witness';

export type PreservationAxis =
  | keyof ClaimProfile
  | 'grain'
  | 'coordinates';

export interface PreservationReason {
  readonly code: PreservationReasonCode;
  readonly axis: PreservationAxis;
  readonly message: string;
}

export interface PreservationAssessment {
  readonly allowed: boolean;
  readonly verdict: PreservationVerdict;
  /** The conservative profile abstracted from all cited evidence. */
  readonly evidenceProfile: ClaimProfile | null;
  /** Null means the proposed abstract was not preserved. */
  readonly preservedEpistemicState: EpistemicState | null;
  /** This checker never proves the proposition true. */
  readonly isProofOfTruth: false;
  readonly reasons: readonly PreservationReason[];
  /** Stable machine-readable reason codes for ordinary refusal. */
  readonly missingReasons: readonly PreservationReasonCode[];
  /** Coordinate witness kinds still needed, if any. */
  readonly missingWitnesses: readonly CoordinateWitnessKind[];
}

type OrderedProfileAxis =
  | 'integrity'
  | 'authenticity'
  | 'scope'
  | 'coverage'
  | 'measurement'
  | 'causality'
  | 'finality'
  | 'decisionFitness';

const ORDERED_PROFILE_AXES: ReadonlyArray<{
  readonly axis: OrderedProfileAxis;
  readonly order: readonly string[];
  readonly escalation: PreservationReasonCode;
}> = Object.freeze([
  { axis: 'integrity', order: INTEGRITY, escalation: 'integrity_escalation' },
  { axis: 'authenticity', order: AUTHENTICITY, escalation: 'authenticity_escalation' },
  { axis: 'scope', order: SCOPE_STATUS, escalation: 'scope_profile_escalation' },
  { axis: 'coverage', order: COVERAGE, escalation: 'coverage_escalation' },
  { axis: 'measurement', order: MEASUREMENT, escalation: 'measurement_escalation' },
  { axis: 'causality', order: CAUSALITY, escalation: 'causality_escalation' },
  { axis: 'finality', order: FINALITY, escalation: 'finality_escalation' },
  { axis: 'decisionFitness', order: DECISION_FITNESS, escalation: 'decision_fitness_escalation' },
]);

function unique<T>(values: ReadonlyArray<T>): T[] {
  return [...new Set(values)];
}

function coordinateWitnessIds(witnesses: ReadonlyArray<CoordinateWitness>): {
  readonly unique: readonly CoordinateWitness[];
  readonly duplicates: readonly string[];
} {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const uniqueWitnesses: CoordinateWitness[] = [];
  for (const witness of witnesses) {
    if (seen.has(witness.id)) {
      if (!duplicates.includes(witness.id)) duplicates.push(witness.id);
      continue;
    }
    seen.add(witness.id);
    uniqueWitnesses.push(witness);
  }
  return { unique: uniqueWitnesses, duplicates };
}

function coordinateAssessment(
  from: ClaimCoordinates,
  to: ClaimCoordinates,
  witnesses: ReadonlyArray<CoordinateWitness>,
): ReturnType<typeof assessCoordinateDerivation> | null {
  try {
    return assessCoordinateDerivation(from, to, witnesses);
  } catch {
    // A malformed witness is a refusal input, not a reason for the abstract
    // checker to throw while reporting the other missing obligations.
    return null;
  }
}

function coordinateKindFor(
  assessment: ReturnType<typeof assessCoordinateDerivation> | null,
  coordinate: 'grain' | 'scope',
): CoordinateWitnessKind | null {
  if (assessment === null) return null;
  const kinds: readonly CoordinateWitnessKind[] = coordinate === 'grain'
    ? ['grain_refinement', 'grain_aggregation', 'grain_bridge']
    : ['scope_filter', 'scope_coverage', 'scope_bridge'];
  return kinds.find((kind) => assessment.requiredWitnesses.includes(kind)) ?? null;
}

function coordinateWitnessSatisfied(
  assessments: ReadonlyArray<ReturnType<typeof assessCoordinateDerivation> | null>,
  coordinate: 'grain' | 'scope',
): boolean {
  const kinds: readonly CoordinateWitnessKind[] = coordinate === 'grain'
    ? ['grain_refinement', 'grain_aggregation', 'grain_bridge']
    : ['scope_filter', 'scope_coverage', 'scope_bridge'];
  return assessments.some((assessment) => assessment !== null && kinds.some((kind) => assessment.satisfiedWitnesses.includes(kind)));
}

function profileValue(profile: ClaimProfile, axis: OrderedProfileAxis): string {
  return profile[axis];
}

function grainSupportedByAny(proposed: Grain, citedEvidence: ReadonlyArray<CitedEvidenceAbstract>): boolean {
  return citedEvidence.some((source) => grainIsSupportedBy(proposed, source.coordinates.grain));
}

function scopeSupportedByAny(proposed: Scope, citedEvidence: ReadonlyArray<CitedEvidenceAbstract>): boolean {
  return citedEvidence.some((source) => scopeIsSupportedBy(proposed, source.coordinates.scope));
}

/**
 * Assess whether `proposed` is a non-escalating abstract transformation of its
 * cited evidence. Refusals are returned as data; this function does not throw
 * for an ordinary missing witness, unsupported axis, or absent citation.
 */
export function assessPreservation(input: PreservationInput): PreservationAssessment {
  const citedEvidence = input.citedEvidence;
  const proposed = input.proposed;
  const witnesses = input.coordinateWitnesses ?? [];
  const reasons: PreservationReason[] = [];
  const missingReasons: PreservationReasonCode[] = [];
  const missingWitnesses: CoordinateWitnessKind[] = [];
  const addReason = (code: PreservationReasonCode, axis: PreservationAxis, message: string): void => {
    if (!reasons.some((reason) => reason.code === code && reason.axis === axis)) {
      reasons.push(Object.freeze({ code, axis, message }));
    }
    if (!missingReasons.includes(code)) missingReasons.push(code);
  };
  const addMissingWitness = (kind: CoordinateWitnessKind): void => {
    if (!missingWitnesses.includes(kind)) missingWitnesses.push(kind);
  };

  if (citedEvidence.length === 0) {
    addReason('no_cited_evidence', 'coordinates', 'preservation requires at least one cited evidence abstract');
    return Object.freeze({
      allowed: false,
      verdict: 'refused',
      evidenceProfile: null,
      preservedEpistemicState: null,
      isProofOfTruth: false,
      reasons: Object.freeze(reasons),
      missingReasons: Object.freeze(missingReasons),
      missingWitnesses: Object.freeze(missingWitnesses),
    });
  }

  const evidenceProfile = citedEvidence
    .slice(1)
    .reduce((merged, source) => mergeClaimProfiles(merged, source.profile), citedEvidence[0]!.profile);
  const witnessData = coordinateWitnessIds(witnesses);
  if (witnessData.duplicates.length > 0) {
    addReason(
      'duplicate_coordinate_witness',
      'coordinates',
      `coordinate witness ids are duplicated: ${witnessData.duplicates.join(', ')}`,
    );
  }

  for (const axis of ORDERED_PROFILE_AXES) {
    const proposedValue = profileValue(proposed.profile, axis.axis);
    const evidenceValue = profileValue(evidenceProfile, axis.axis);
    if (axis.order.indexOf(proposedValue) > axis.order.indexOf(evidenceValue)) {
      addReason(
        axis.escalation,
        axis.axis,
        `proposed ${axis.axis} ${proposedValue} exceeds cited-evidence ceiling ${evidenceValue}`,
      );
    }
  }

  // Monetary basis names the economic quantity, not a degree of assurance.
  // Compare only with the abstract merge result; never rank one basis above another.
  if (proposed.profile.monetaryBasis !== evidenceProfile.monetaryBasis) {
    addReason(
      'monetary_basis_incomparable',
      'monetaryBasis',
      `proposed monetary basis ${proposed.profile.monetaryBasis} is incomparable with cited-evidence basis ${evidenceProfile.monetaryBasis}`,
    );
  }

  if (!informationLeq(proposed.profile.epistemic, evidenceProfile.epistemic)) {
    addReason(
      'epistemic_escalation',
      'epistemic',
      `proposed epistemic state ${proposed.profile.epistemic} contains polarity not present in cited evidence ${evidenceProfile.epistemic}`,
    );
  }
  if (evidenceProfile.epistemic === 'conflicted' && proposed.profile.epistemic !== 'conflicted') {
    addReason(
      'epistemic_conflict_not_retained',
      'epistemic',
      `cited evidence is conflicted and the proposed state ${proposed.profile.epistemic} would collapse that conflict`,
    );
  }

  const assessments = citedEvidence.map((source) => coordinateAssessment(
    source.coordinates,
    proposed.coordinates,
    witnessData.unique,
  ));

  if (!grainSupportedByAny(proposed.coordinates.grain, citedEvidence)) {
    const required = unique(assessments
      .map((assessment) => coordinateKindFor(assessment, 'grain'))
      .filter((kind): kind is CoordinateWitnessKind => kind !== null));
    if (!coordinateWitnessSatisfied(assessments, 'grain')) {
      for (const kind of required) addMissingWitness(kind);
      addReason(
        'grain_relation_missing',
        'grain',
        `proposed grain [${proposed.coordinates.grain.dimensions.join(', ')}] is not supplied by cited evidence or an exact typed relation`,
      );
    }
  }

  if (!scopeSupportedByAny(proposed.coordinates.scope, citedEvidence)) {
    const required = unique(assessments
      .map((assessment) => coordinateKindFor(assessment, 'scope'))
      .filter((kind): kind is CoordinateWitnessKind => kind !== null));
    if (!coordinateWitnessSatisfied(assessments, 'scope')) {
      for (const kind of required) addMissingWitness(kind);
      addReason(
        'scope_relation_missing',
        'scope',
        'proposed scope is not supplied by cited evidence or an exact typed relation',
      );
    }
  }

  const allowed = reasons.length === 0;
  return Object.freeze({
    allowed,
    verdict: allowed ? 'allowed' : 'refused',
    evidenceProfile,
    preservedEpistemicState: allowed ? proposed.profile.epistemic : null,
    isProofOfTruth: false,
    reasons: Object.freeze(reasons),
    missingReasons: Object.freeze(missingReasons),
    missingWitnesses: Object.freeze(missingWitnesses),
  });
}

/** Naming alias for callers that describe the check by its epistemic purpose. */
export const assessEpistemicPreservation = assessPreservation;
