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
import {
  CAUSALITY,
  COVERAGE,
  DECISION_FITNESS,
  FINALITY,
  INTEGRITY,
  AUTHENTICITY,
  MEASUREMENT,
} from './profile.ts';
import { EPISTEMIC_STATES } from './state.ts';
import { immutableJson } from './evidence.ts';
import type { Claim, TypedProposition } from './claim.ts';

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

/** Witnesses for non-coordinate claim strengthening. */
export const DERIVATION_WITNESS_KINDS = [
  ...COORDINATE_WITNESS_KINDS,
  'epistemic_resolution',
  'coverage_witness',
  'scope_validation',
  'measurement_validation',
  'causal_identification',
  'monetary_finality',
  'integrity_attestation',
  'authenticity_attestation',
  'decision_fitness',
] as const;
export type DerivationWitnessKind = (typeof DERIVATION_WITNESS_KINDS)[number];

export interface DerivationWitness {
  readonly id: string;
  readonly kind: DerivationWitnessKind;
  /** Required for coordinate witness kinds; ignored for other kinds. */
  readonly from?: ClaimCoordinates;
  readonly to?: ClaimCoordinates;
  readonly evidenceIds?: readonly string[];
  readonly detail?: string | null;
}

export interface DerivationInput {
  readonly id: string;
  readonly inputEvidenceIds?: readonly string[];
  readonly inputClaimIds?: readonly string[];
  readonly transformation: string;
  readonly outputClaimId: string;
  readonly outputProposition: TypedProposition;
  readonly coordinateChange: {
    readonly from: ClaimCoordinates;
    readonly to: ClaimCoordinates;
  };
  readonly witnesses?: readonly DerivationWitness[];
  readonly assumptions?: readonly string[];
  readonly uncertaintyTransformation?: string | null;
  readonly version: number;
  readonly reproducibilityHash: string;
}

export interface Derivation {
  readonly id: string;
  readonly inputEvidenceIds: readonly string[];
  readonly inputClaimIds: readonly string[];
  readonly transformation: string;
  readonly outputClaimId: string;
  readonly outputProposition: TypedProposition;
  readonly coordinateChange: {
    readonly from: ClaimCoordinates;
    readonly to: ClaimCoordinates;
  };
  readonly witnesses: readonly DerivationWitness[];
  readonly assumptions: readonly string[];
  readonly uncertaintyTransformation: string | null;
  readonly version: number;
  readonly reproducibilityHash: string;
}

export interface DerivationLegalityAssessment {
  readonly allowed: boolean;
  readonly requiredWitnesses: readonly DerivationWitnessKind[];
  readonly satisfiedWitnesses: readonly DerivationWitnessKind[];
  readonly missingWitnesses: readonly DerivationWitnessKind[];
}

const DERIVATION_KEYS = new Set([
  'id', 'inputEvidenceIds', 'inputClaimIds', 'transformation', 'outputClaimId', 'outputProposition',
  'coordinateChange', 'witnesses', 'assumptions', 'uncertaintyTransformation', 'version',
  'reproducibilityHash',
]);
const DERIVATION_PROPOSITION_KEYS = new Set(['predicate', 'value']);
const COORDINATE_CHANGE_KEYS = new Set(['from', 'to']);
const DERIVATION_WITNESS_KEYS = new Set(['id', 'kind', 'from', 'to', 'evidenceIds', 'detail']);

const PROFILE_STRENGTH_AXES: ReadonlyArray<{
  readonly key: DerivationWitnessKind;
  readonly source: keyof Claim['profile'];
  readonly order: readonly string[];
}> = [
  { key: 'coverage_witness', source: 'coverage', order: COVERAGE },
  { key: 'scope_validation', source: 'scope', order: ['unknown', 'incomplete', 'conditional', 'established'] },
  { key: 'measurement_validation', source: 'measurement', order: MEASUREMENT },
  { key: 'causal_identification', source: 'causality', order: CAUSALITY },
  { key: 'monetary_finality', source: 'finality', order: FINALITY },
  { key: 'integrity_attestation', source: 'integrity', order: INTEGRITY },
  { key: 'authenticity_attestation', source: 'authenticity', order: AUTHENTICITY },
  { key: 'decision_fitness', source: 'decisionFitness', order: DECISION_FITNESS },
];

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function derivationString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function derivationStringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const ids = new Set<string>();
  const normalized = value.map((item, index) => {
    const id = derivationString(item, `${label}[${index}]`);
    if (ids.has(id)) throw new Error(`duplicate ${label} entry: ${id}`);
    ids.add(id);
    return id;
  });
  return Object.freeze(normalized);
}

function canonicalCoordinates(value: unknown, label: string): ClaimCoordinates {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const grainValue = (value as { grain?: unknown }).grain;
  const scopeValue = (value as { scope?: unknown }).scope;
  if (grainValue === null || typeof grainValue !== 'object' || Array.isArray(grainValue)) throw new Error(`${label}.grain must be an object`);
  if (scopeValue === null || typeof scopeValue !== 'object' || Array.isArray(scopeValue)) throw new Error(`${label}.scope must be an object`);
  const dimensions = (grainValue as { dimensions?: unknown }).dimensions;
  const constraints = (scopeValue as { constraints?: unknown }).constraints;
  if (!Array.isArray(dimensions)) throw new Error(`${label}.grain dimensions must be an array`);
  if (!Array.isArray(constraints)) throw new Error(`${label}.scope constraints must be an array`);
  const canonicalDimensions = dimensions.map((item, index) => derivationString(item, `${label}.grain dimension ${index}`));
  const canonicalScope: Record<string, string> = {};
  for (let index = 0; index < constraints.length; index += 1) {
    const item = constraints[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label}.scope constraint ${index} must be an object`);
    const key = derivationString((item as { key?: unknown }).key, `${label}.scope key ${index}`);
    const itemValue = derivationString((item as { value?: unknown }).value, `${label}.scope value ${index}`);
    if (Object.hasOwn(canonicalScope, key)) throw new Error(`duplicate ${label}.scope key: ${key}`);
    canonicalScope[key] = itemValue;
  }
  // Constructors canonicalize order and reject duplicate dimensions/constraints.
  return Object.freeze({ grain: canonicalGrainCoordinates(canonicalDimensions), scope: canonicalScopeCoordinates(canonicalScope) });
}

// Kept local to make the runtime boundary above explicit without introducing a
// second coordinates module during this first kernel slice.
function canonicalGrainCoordinates(dimensions: string[]): Grain {
  const canonical = [...dimensions].sort();
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index] === canonical[index - 1]) throw new Error(`duplicate grain dimension: ${canonical[index]}`);
  }
  return Object.freeze({ dimensions: Object.freeze(canonical) });
}

function canonicalScopeCoordinates(values: Readonly<Record<string, string>>): Scope {
  const constraints = Object.entries(values)
    .map(([key, value]) => Object.freeze({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return Object.freeze({ constraints: Object.freeze(constraints) });
}

function canonicalWitness(input: unknown, index: number): DerivationWitness {
  assertKnownKeys(input, DERIVATION_WITNESS_KEYS, `derivation witness ${index}`);
  const value = input as DerivationWitness;
  const id = derivationString(value.id, `derivation witness ${index} id`);
  const kind = value.kind;
  if (!DERIVATION_WITNESS_KINDS.includes(kind)) throw new Error(`invalid derivation witness kind: ${String(kind)}`);
  const coordinateKind = COORDINATE_WITNESS_KINDS.includes(kind as CoordinateWitnessKind);
  const hasFrom = value.from !== undefined;
  const hasTo = value.to !== undefined;
  if (coordinateKind && (!hasFrom || !hasTo)) throw new Error(`coordinate witness ${id} requires from and to coordinates`);
  if (!coordinateKind && (hasFrom || hasTo)) throw new Error(`non-coordinate witness ${id} cannot carry coordinates`);
  const evidenceIds = derivationStringList(value.evidenceIds, `derivation witness ${index} evidenceIds`);
  const detail = value.detail === undefined || value.detail === null ? null : derivationString(value.detail, `derivation witness ${index} detail`);
  return Object.freeze({
    id,
    kind,
    ...(coordinateKind ? { from: canonicalCoordinates(value.from, `derivation witness ${index}.from`), to: canonicalCoordinates(value.to, `derivation witness ${index}.to`) } : {}),
    evidenceIds,
    detail,
  });
}

/** Construct an immutable, versioned derivation record. */
export function derivation(input: DerivationInput): Derivation {
  assertKnownKeys(input, DERIVATION_KEYS, 'derivation');
  const value = input as DerivationInput;
  const id = derivationString(value.id, 'derivation id');
  const inputEvidenceIds = derivationStringList(value.inputEvidenceIds, 'inputEvidenceIds');
  const inputClaimIds = derivationStringList(value.inputClaimIds, 'inputClaimIds');
  if (inputEvidenceIds.length === 0 && inputClaimIds.length === 0) throw new Error('derivation requires at least one input evidence or claim');
  const transformation = derivationString(value.transformation, 'transformation');
  const outputClaimId = derivationString(value.outputClaimId, 'outputClaimId');
  assertKnownKeys(value.outputProposition, DERIVATION_PROPOSITION_KEYS, 'outputProposition');
  const outputInput = value.outputProposition as TypedProposition;
  const outputProposition = Object.freeze({
    predicate: derivationString(outputInput.predicate, 'output proposition predicate'),
    value: immutableJson(outputInput.value, 'output proposition value'),
  });
  assertKnownKeys(value.coordinateChange, COORDINATE_CHANGE_KEYS, 'coordinateChange');
  const coordinateChange = Object.freeze({
    from: canonicalCoordinates(value.coordinateChange.from, 'coordinateChange.from'),
    to: canonicalCoordinates(value.coordinateChange.to, 'coordinateChange.to'),
  });
  if (value.witnesses !== undefined && !Array.isArray(value.witnesses)) throw new Error('witnesses must be an array');
  const witnessIds = new Set<string>();
  const witnesses = (value.witnesses ?? []).map((item, index) => {
    const normalized = canonicalWitness(item, index);
    if (witnessIds.has(normalized.id)) throw new Error(`duplicate witness id: ${normalized.id}`);
    witnessIds.add(normalized.id);
    return normalized;
  });
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('derivation version must be a positive safe integer');
  const uncertaintyTransformation = value.uncertaintyTransformation === undefined || value.uncertaintyTransformation === null
    ? null
    : derivationString(value.uncertaintyTransformation, 'uncertaintyTransformation');
  return Object.freeze({
    id,
    inputEvidenceIds,
    inputClaimIds,
    transformation,
    outputClaimId,
    outputProposition,
    coordinateChange,
    witnesses: Object.freeze(witnesses),
    assumptions: derivationStringList(value.assumptions, 'assumption'),
    uncertaintyTransformation,
    version: value.version,
    reproducibilityHash: derivationString(value.reproducibilityHash, 'reproducibilityHash'),
  });
}

function sameProposition(a: TypedProposition, b: TypedProposition): boolean {
  return a.predicate === b.predicate && JSON.stringify(a.value) === JSON.stringify(b.value);
}

function hasWitness(witnesses: ReadonlyArray<DerivationWitness>, kind: DerivationWitnessKind): boolean {
  return witnesses.some((witness) => witness.kind === kind);
}

function stronger<T extends string>(source: T, output: T, order: readonly T[]): boolean {
  return order.indexOf(output) > order.indexOf(source);
}

function coordinateWitnesses(witnesses: ReadonlyArray<DerivationWitness>): CoordinateWitness[] {
  return witnesses
    .filter((witness): witness is DerivationWitness & { from: ClaimCoordinates; to: ClaimCoordinates } =>
      COORDINATE_WITNESS_KINDS.includes(witness.kind as CoordinateWitnessKind)
      && witness.from !== undefined && witness.to !== undefined,
    )
    .map((witness) => ({ id: witness.id, kind: witness.kind as CoordinateWitnessKind, from: witness.from, to: witness.to }));
}

/**
 * Check whether a derivation may legally produce `output` from `source`.
 * Binding mismatches throw because they indicate a malformed derivation record;
 * semantic strengthening returns a structured refusal so callers can explain
 * exactly which witness is missing.
 */
export function assessDerivationLegality(
  source: Claim,
  output: Claim,
  item: Derivation,
): DerivationLegalityAssessment {
  if (!item.inputClaimIds.includes(source.id)) throw new Error(`derivation input claim does not include ${source.id}`);
  if (item.outputClaimId !== output.id) throw new Error(`derivation output claim does not match ${output.id}`);
  if (!sameProposition(item.outputProposition, output.proposition)) throw new Error('derivation output proposition does not match output claim');
  if (!matchesClaimCoordinates(item.coordinateChange.from, source) || !matchesClaimCoordinates(item.coordinateChange.to, output)) {
    throw new Error('derivation coordinate change does not match input/output claims');
  }

  const coordinate = assessCoordinateDerivation(
    { grain: source.grain, scope: source.scope },
    { grain: output.grain, scope: output.scope },
    coordinateWitnesses(item.witnesses),
  );
  const required: DerivationWitnessKind[] = [...coordinate.requiredWitnesses];

  if (source.epistemic !== output.epistemic) required.push('epistemic_resolution');
  for (const axis of PROFILE_STRENGTH_AXES) {
    const sourceValue = source.profile[axis.source];
    const outputValue = output.profile[axis.source];
    if (stronger(sourceValue, outputValue, axis.order)) required.push(axis.key);
  }
  const uniqueRequired = [...new Set(required)];
  const satisfied = uniqueRequired.filter((kind) => {
    if (COORDINATE_WITNESS_KINDS.includes(kind as CoordinateWitnessKind)) {
      return coordinate.satisfiedWitnesses.includes(kind as CoordinateWitnessKind);
    }
    return hasWitness(item.witnesses, kind);
  });
  const missing = uniqueRequired.filter((kind) => !satisfied.includes(kind));
  return Object.freeze({
    allowed: missing.length === 0,
    requiredWitnesses: Object.freeze(uniqueRequired),
    satisfiedWitnesses: Object.freeze(satisfied),
    missingWitnesses: Object.freeze(missing),
  });
}

function matchesClaimCoordinates(a: ClaimCoordinates, b: Claim): boolean {
  return sameGrain(a.grain, b.grain) && sameScope(a.scope, b.scope);
}
