/**
 * Multi-axis claim profile.
 *
 * A claim is never reduced to `established: boolean`. Integrity,
 * authenticity, coverage, construct validity, causality, monetary basis,
 * finality, and decision fitness answer different questions and cannot
 * substitute for one another.
 */

import { informationJoin, type EpistemicState } from './state.ts';

export const INTEGRITY = ['unknown', 'unverifiable', 'verified'] as const;
export const AUTHENTICITY = ['unknown', 'self_asserted', 'pinned', 'provider_authenticated'] as const;
export const SCOPE_STATUS = ['unknown', 'incomplete', 'conditional', 'established'] as const;
export const COVERAGE = ['unknown', 'partial', 'complete'] as const;
export const MEASUREMENT = ['proxy_unvalidated', 'proxy_validated', 'validated'] as const;
export const CAUSALITY = ['none', 'observational', 'quasi_experimental', 'randomized'] as const;
export const MONETARY_BASIS = ['none', 'list', 'estimated', 'provider_observed', 'billed', 'effective', 'allocated', 'full_cost', 'mixed'] as const;
export const FINALITY = ['unknown', 'provisional', 'final'] as const;
export const DECISION_FITNESS = ['not_assessed', 'insufficient', 'sufficient'] as const;

export type IntegrityStatus = (typeof INTEGRITY)[number];
export type AuthenticityStatus = (typeof AUTHENTICITY)[number];
export type ScopeStatus = (typeof SCOPE_STATUS)[number];
export type CoverageStatus = (typeof COVERAGE)[number];
export type MeasurementStatus = (typeof MEASUREMENT)[number];
export type CausalityStatus = (typeof CAUSALITY)[number];
export type MonetaryBasisStatus = (typeof MONETARY_BASIS)[number];
export type FinalityStatus = (typeof FINALITY)[number];
export type DecisionFitnessStatus = (typeof DECISION_FITNESS)[number];

export interface ClaimProfileInput {
  readonly epistemic: EpistemicState;
  readonly integrity: IntegrityStatus;
  readonly authenticity: AuthenticityStatus;
  readonly scope: ScopeStatus;
  readonly coverage: CoverageStatus;
  readonly measurement: MeasurementStatus;
  readonly causality: CausalityStatus;
  readonly monetaryBasis: MonetaryBasisStatus;
  readonly finality: FinalityStatus;
  readonly decisionFitness: DecisionFitnessStatus;
}

export type ClaimProfile = Readonly<ClaimProfileInput>;

function assertMember<const T extends readonly string[]>(value: string, values: T, label: string): void {
  if (!values.includes(value as T[number])) throw new Error(`invalid ${label}: ${value}`);
}

export function claimProfile(input: ClaimProfileInput): ClaimProfile {
  assertMember(input.epistemic, ['unknown', 'supported', 'refuted', 'conflicted'] as const, 'epistemic state');
  assertMember(input.integrity, INTEGRITY, 'integrity');
  assertMember(input.authenticity, AUTHENTICITY, 'authenticity');
  assertMember(input.scope, SCOPE_STATUS, 'scope');
  assertMember(input.coverage, COVERAGE, 'coverage');
  assertMember(input.measurement, MEASUREMENT, 'measurement');
  assertMember(input.causality, CAUSALITY, 'causality');
  assertMember(input.monetaryBasis, MONETARY_BASIS, 'monetary basis');
  assertMember(input.finality, FINALITY, 'finality');
  assertMember(input.decisionFitness, DECISION_FITNESS, 'decision fitness');
  return Object.freeze({ ...input });
}

function weaker<T extends string>(a: T, b: T, order: readonly T[]): T {
  return order[Math.min(order.indexOf(a), order.indexOf(b))]!;
}

function mergeBasis(a: MonetaryBasisStatus, b: MonetaryBasisStatus): MonetaryBasisStatus {
  return a === b ? a : 'mixed';
}

/**
 * Conservative conjunction of evidence profiles. The epistemic axis accumulates
 * support/refutation; assurance axes retain the weaker guarantee. Monetary bases
 * are not ranked globally: unlike evidence strength they name different economic
 * semantics, so disagreement becomes `mixed` rather than an invented ordering.
 */
export function mergeClaimProfiles(a: ClaimProfile, b: ClaimProfile): ClaimProfile {
  return claimProfile({
    epistemic: informationJoin(a.epistemic, b.epistemic),
    integrity: weaker(a.integrity, b.integrity, INTEGRITY),
    authenticity: weaker(a.authenticity, b.authenticity, AUTHENTICITY),
    scope: weaker(a.scope, b.scope, SCOPE_STATUS),
    coverage: weaker(a.coverage, b.coverage, COVERAGE),
    measurement: weaker(a.measurement, b.measurement, MEASUREMENT),
    causality: weaker(a.causality, b.causality, CAUSALITY),
    monetaryBasis: mergeBasis(a.monetaryBasis, b.monetaryBasis),
    finality: weaker(a.finality, b.finality, FINALITY),
    decisionFitness: weaker(a.decisionFitness, b.decisionFitness, DECISION_FITNESS),
  });
}
