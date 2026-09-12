/**
 * Canonical, immutable proof-obligation records for the Trusted Epistemic
 * Kernel.
 *
 * A derivation witness is not a free-form string attached to a claim. It is a
 * separately issued, evidence-grounded node that can be persisted, revoked,
 * replayed and traversed through the epistemic DAG. Inline witness references
 * on a Derivation must match one of these records before the derivation is
 * accepted by the ledger.
 */

import {
  COORDINATE_WITNESS_KINDS,
  DERIVATION_WITNESS_KINDS,
  type ClaimCoordinates,
  type CoordinateWitnessKind,
  type DerivationWitnessKind,
} from './derivation.ts';
import { grain, type Grain } from './grain.ts';
import { MONETARY_BASIS, type MonetaryBasisStatus } from './profile.ts';
import { scope, type Scope } from './scope.ts';
import { EPISTEMIC_STATES, type EpistemicState } from './state.ts';
import { instant, type Instant } from './time.ts';

/**
 * The two bases a `monetary_rebasing` witness declares it moves between.
 *
 * THE MONEY AXIS GETS THE SAME TREATMENT THE COORDINATE AXES ALWAYS HAD.
 * A coordinate witness carries `from`/`to` coordinates and
 * `assessCoordinateDerivation` refuses it unless they are the exact
 * coordinates being moved between. `monetary_rebasing` was added at D-152 with
 * no such field, so the witness that defends `metered usage !=
 * provider-billed cost` named neither side of the move it licensed and
 * `estimated -> billed` was discharged by a witness written about an
 * allocation. `detail` is prose and cannot be checked; this can.
 */
export interface MonetaryBasisChange {
  readonly from: MonetaryBasisStatus;
  readonly to: MonetaryBasisStatus;
}

export interface WitnessInput {
  readonly id: string;
  readonly kind: DerivationWitnessKind;
  /** Required for coordinate witness kinds; forbidden for all others. */
  readonly from?: ClaimCoordinates;
  readonly to?: ClaimCoordinates;
  /** Required for `monetary_rebasing`; forbidden for every other kind. */
  readonly basisChange?: MonetaryBasisChange;
  /** Every canonical witness must retain at least one grounding evidence ID. */
  readonly evidenceIds: readonly string[];
  readonly detail?: string | null;
  /** Availability of the proof to a consumer, not the represented event time. */
  readonly issuedAt: Instant;
  readonly epistemic: EpistemicState;
  readonly schemaVersion: number;
}

export interface Witness {
  readonly id: string;
  readonly kind: DerivationWitnessKind;
  readonly from?: ClaimCoordinates;
  readonly to?: ClaimCoordinates;
  readonly basisChange?: MonetaryBasisChange;
  readonly evidenceIds: readonly string[];
  readonly detail: string | null;
  readonly issuedAt: Instant;
  readonly epistemic: EpistemicState;
  readonly schemaVersion: number;
}

const WITNESS_KEYS = new Set([
  'id', 'kind', 'from', 'to', 'basisChange', 'evidenceIds', 'detail', 'issuedAt', 'epistemic',
  'schemaVersion',
]);
const BASIS_CHANGE_KEYS = new Set(['from', 'to']);
const COORDINATE_KEYS = new Set(['grain', 'scope']);
const GRAIN_KEYS = new Set(['dimensions']);
const SCOPE_KEYS = new Set(['constraints']);

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length === 0) throw new Error(`${label} must contain at least one evidence ID`);
  const seen = new Set<string>();
  const normalized = value.map((item, index) => {
    const id = nonEmpty(item, `${label}[${index}]`);
    if (seen.has(id)) throw new Error(`duplicate ${label} entry: ${id}`);
    seen.add(id);
    return id;
  });
  return Object.freeze(normalized);
}

function canonicalCoordinates(value: unknown, label: string): ClaimCoordinates {
  assertKnownKeys(value, COORDINATE_KEYS, label);
  const input = value as { readonly grain?: unknown; readonly scope?: unknown };
  assertKnownKeys(input.grain, GRAIN_KEYS, `${label}.grain`);
  assertKnownKeys(input.scope, SCOPE_KEYS, `${label}.scope`);

  const dimensions = (input.grain as { readonly dimensions?: unknown }).dimensions;
  if (!Array.isArray(dimensions)) throw new Error(`${label}.grain dimensions must be an array`);
  const canonicalDimensions = dimensions.map((item, index) => nonEmpty(item, `${label}.grain dimension ${index}`));

  const constraints = (input.scope as { readonly constraints?: unknown }).constraints;
  if (!Array.isArray(constraints)) throw new Error(`${label}.scope constraints must be an array`);
  const values: Record<string, string> = {};
  for (let index = 0; index < constraints.length; index += 1) {
    const constraint = constraints[index];
    assertKnownKeys(constraint, new Set(['key', 'value']), `${label}.scope constraint ${index}`);
    const item = constraint as { readonly key?: unknown; readonly value?: unknown };
    const key = nonEmpty(item.key, `${label}.scope key ${index}`);
    const itemValue = nonEmpty(item.value, `${label}.scope value ${index}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate ${label}.scope key: ${key}`);
    values[key] = itemValue;
  }

  const canonicalGrain: Grain = grain(canonicalDimensions);
  const canonicalScope: Scope = scope(values);
  return Object.freeze({ grain: canonicalGrain, scope: canonicalScope });
}

function canonicalInstant(value: unknown, label: string): Instant {
  if (typeof value !== 'string') throw new Error(`${label} must be canonical UTC ISO-8601`);
  try {
    return instant(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalBasisChange(value: unknown, label: string): MonetaryBasisChange {
  assertKnownKeys(value, BASIS_CHANGE_KEYS, label);
  const input = value as { readonly from?: unknown; readonly to?: unknown };
  for (const side of ['from', 'to'] as const) {
    const basis = input[side];
    if (typeof basis !== 'string' || !MONETARY_BASIS.includes(basis as MonetaryBasisStatus)) {
      throw new Error(`${label}.${side} must be a monetary basis: ${String(basis)}`);
    }
  }
  const from = input.from as MonetaryBasisStatus;
  const to = input.to as MonetaryBasisStatus;
  // The same two moves `monetaryRebasing` in derivation.ts leaves free are not
  // re-basings, so a witness declaring one would be a witness to nothing.
  if (from === to) throw new Error(`${label} declares no change: ${from} -> ${to}`);
  if (to === 'none' || to === 'mixed') throw new Error(`${label} declares a weakening, which needs no witness: ${from} -> ${to}`);
  return Object.freeze({ from, to });
}

function witnessKind(value: unknown): DerivationWitnessKind {
  if (typeof value !== 'string' || !DERIVATION_WITNESS_KINDS.includes(value as DerivationWitnessKind)) {
    throw new Error(`invalid witness kind: ${String(value)}`);
  }
  return value as DerivationWitnessKind;
}

/** Construct a canonical, immutable, evidence-grounded witness envelope. */
export function witness(input: WitnessInput): Witness {
  assertKnownKeys(input, WITNESS_KEYS, 'witness');
  const value = input as WitnessInput;
  const id = nonEmpty(value.id, 'witness id');
  const kind = witnessKind(value.kind);
  const coordinateKind = COORDINATE_WITNESS_KINDS.includes(kind as CoordinateWitnessKind);
  const hasFrom = value.from !== undefined;
  const hasTo = value.to !== undefined;
  if (coordinateKind && (!hasFrom || !hasTo)) throw new Error(`coordinate witness ${id} requires from and to coordinates`);
  if (!coordinateKind && (hasFrom || hasTo)) throw new Error(`non-coordinate witness ${id} cannot carry coordinates`);
  const rebasingKind = kind === 'monetary_rebasing';
  const hasBasisChange = value.basisChange !== undefined;
  if (rebasingKind && !hasBasisChange) throw new Error(`monetary_rebasing witness ${id} requires a basisChange naming the bases it moves between`);
  if (!rebasingKind && hasBasisChange) throw new Error(`${kind} witness ${id} cannot carry a basisChange`);

  const evidenceIds = stringList(value.evidenceIds, `witness ${id} evidenceIds`);
  const detail = value.detail === undefined || value.detail === null ? null : nonEmpty(value.detail, `witness ${id} detail`);
  const issuedAt = canonicalInstant(value.issuedAt, `witness ${id} issuedAt`);
  if (typeof value.epistemic !== 'string' || !EPISTEMIC_STATES.includes(value.epistemic)) {
    throw new Error(`invalid witness epistemic state: ${String(value.epistemic)}`);
  }
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw new Error('witness schemaVersion must be a positive safe integer');
  }

  return Object.freeze({
    id,
    kind,
    ...(coordinateKind ? {
      from: canonicalCoordinates(value.from, `witness ${id}.from`),
      to: canonicalCoordinates(value.to, `witness ${id}.to`),
    } : {}),
    ...(rebasingKind ? { basisChange: canonicalBasisChange(value.basisChange, `witness ${id}.basisChange`) } : {}),
    evidenceIds,
    detail,
    issuedAt,
    epistemic: value.epistemic,
    schemaVersion: value.schemaVersion,
  });
}

/** Naming alias for callers that prefer constructor-style factories. */
export const createWitness = witness;
