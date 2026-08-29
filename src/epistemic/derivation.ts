/**
 * Coordinate-level derivation legality.
 *
 * Grain and scope relations describe geometry; they do not grant permission.
 * Any coordinate change must carry a witness whose kind matches the exact
 * source and target coordinates. This is the first executable layer of the
 * No Granularity Laundering / No Scope Laundering laws.
 */

import { grainRelation, sameGrain, type Grain } from './grain.ts';
import { sameScope, scopeRelation, type Scope } from './scope.ts';

export interface ClaimCoordinates {
  readonly grain: Grain;
  readonly scope: Scope;
}

export const COORDINATE_WITNESS_KINDS = [
  'grain_refinement',
  'grain_aggregation',
  'grain_bridge',
  'scope_filter',
  'scope_coverage',
  'scope_bridge',
] as const;
export type CoordinateWitnessKind = (typeof COORDINATE_WITNESS_KINDS)[number];

export interface CoordinateWitness {
  readonly id: string;
  readonly kind: CoordinateWitnessKind;
  readonly from: ClaimCoordinates;
  readonly to: ClaimCoordinates;
}

export interface CoordinateDerivationAssessment {
  readonly allowed: boolean;
  readonly requiredWitnesses: readonly CoordinateWitnessKind[];
  readonly satisfiedWitnesses: readonly CoordinateWitnessKind[];
  readonly missingWitnesses: readonly CoordinateWitnessKind[];
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function sameCoordinates(a: ClaimCoordinates, b: ClaimCoordinates): boolean {
  return sameGrain(a.grain, b.grain) && sameScope(a.scope, b.scope);
}

export function coordinateWitness(input: CoordinateWitness): CoordinateWitness {
  return Object.freeze({
    id: nonEmpty(input.id, 'coordinate witness id'),
    kind: input.kind,
    from: input.from,
    to: input.to,
  });
}

function requiredCoordinateWitnesses(from: ClaimCoordinates, to: ClaimCoordinates): CoordinateWitnessKind[] {
  const required: CoordinateWitnessKind[] = [];

  const g = grainRelation(to.grain, from.grain);
  if (g === 'finer') required.push('grain_refinement');
  else if (g === 'coarser') required.push('grain_aggregation');
  else if (g === 'incomparable') required.push('grain_bridge');

  const s = scopeRelation(to.scope, from.scope);
  if (s === 'narrower') required.push('scope_filter');
  else if (s === 'broader') required.push('scope_coverage');
  else if (s === 'disjoint' || s === 'overlapping') required.push('scope_bridge');

  return required;
}

export function assessCoordinateDerivation(
  from: ClaimCoordinates,
  to: ClaimCoordinates,
  witnesses: ReadonlyArray<CoordinateWitness>,
): CoordinateDerivationAssessment {
  const ids = new Set<string>();
  for (const witness of witnesses) {
    if (ids.has(witness.id)) throw new Error(`duplicate witness id: ${witness.id}`);
    ids.add(witness.id);
  }

  const requiredWitnesses = requiredCoordinateWitnesses(from, to);
  const satisfiedWitnesses = requiredWitnesses.filter((kind) =>
    witnesses.some((witness) => witness.kind === kind && sameCoordinates(witness.from, from) && sameCoordinates(witness.to, to)),
  );
  const missingWitnesses = requiredWitnesses.filter((kind) => !satisfiedWitnesses.includes(kind));

  return Object.freeze({
    allowed: missingWitnesses.length === 0,
    requiredWitnesses: Object.freeze(requiredWitnesses),
    satisfiedWitnesses: Object.freeze(satisfiedWitnesses),
    missingWitnesses: Object.freeze(missingWitnesses),
  });
}
