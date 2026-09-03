/**
 * Canonical immutable Claim envelope for the Trusted Epistemic Kernel.
 *
 * A claim is an issued proposition, not a receipt or a free-form assertion. It
 * retains its evidence dependencies, derivation identity, coordinates,
 * uncertainty, and independent profile axes so downstream consumers cannot
 * collapse integrity, authenticity, coverage, measurement, causality, or
 * monetary meaning into one `trusted`/`established` bit.
 */

import {
  CAUSALITY,
  claimProfile,
  type CausalityStatus,
  type ClaimProfile,
  type ClaimProfileInput,
} from './profile.ts';
import { EPISTEMIC_STATES, type EpistemicState } from './state.ts';
import { grain, type Grain } from './grain.ts';
import { scope, type Scope } from './scope.ts';
import { instant, interval, type Instant, type TimeInterval } from './time.ts';
import {
  immutableJson,
  type JsonValue,
  type RevocationMetadata,
  type RevocationMetadataInput,
} from './evidence.ts';

export const UNCERTAINTY_KINDS = ['interval', 'identified_set', 'distribution', 'qualitative'] as const;
export type UncertaintyKind = (typeof UNCERTAINTY_KINDS)[number];

export interface TypedPropositionInput {
  readonly predicate: string;
  readonly value: JsonValue;
}

export interface TypedProposition {
  readonly predicate: string;
  readonly value: JsonValue;
}

/**
 * Opt-in contract for propositions whose meaning includes an absence claim.
 * Completeness witnesses are explicit IDs so an issuer cannot turn an empty
 * observation into a negative conclusion by omission.
 */
export interface NegativeClaimInput {
  readonly eventType: string;
  readonly completenessWitnessIds: readonly string[];
}

export interface NegativeClaim extends NegativeClaimInput {
  readonly eventType: string;
  readonly completenessWitnessIds: readonly string[];
}

export interface ClaimTimeInput {
  readonly validTime?: TimeInterval | null;
  readonly asOf?: Instant | null;
}

export interface ClaimTime {
  readonly validTime: TimeInterval | null;
  readonly asOf: Instant | null;
}

export interface UncertaintyInput {
  readonly kind: UncertaintyKind;
  readonly lower?: number | null;
  readonly upper?: number | null;
  readonly values?: readonly number[];
  readonly description?: string | null;
}

export interface Uncertainty {
  readonly kind: UncertaintyKind;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly values: readonly number[];
  readonly description: string | null;
}

export interface ClaimInput {
  readonly id: string;
  readonly proposition: TypedPropositionInput;
  /** Present only for negative propositions; positive claims remain unchanged. */
  readonly negativeClaim?: NegativeClaimInput | null;
  readonly subject: string;
  readonly scope: Scope;
  readonly grain: Grain;
  readonly time: ClaimTimeInput;
  readonly epistemic: EpistemicState;
  readonly profile: ClaimProfileInput;
  readonly measurementModelRef?: string | null;
  readonly evidenceIds: readonly string[];
  readonly derivationRule: string;
  readonly derivationVersion: number;
  readonly assumptions?: readonly string[];
  /** First-class assumption node IDs; free-form `assumptions` remains legacy/display text. */
  readonly assumptionIds?: readonly string[];
  readonly uncertainty?: UncertaintyInput | null;
  readonly causalStatus: CausalityStatus;
  /** Optional stored aliases; when supplied they must match profile exactly. */
  readonly monetaryBasis?: ClaimProfile['monetaryBasis'];
  readonly finality?: ClaimProfile['finality'];
  readonly issuedAt: Instant;
  readonly supersedes?: readonly string[];
  readonly supersededBy?: string | null;
  readonly revocation?: RevocationMetadataInput | null;
  readonly decisionCertificateIds?: readonly string[];
  readonly schemaVersion: number;
}

export interface Claim {
  readonly id: string;
  readonly proposition: TypedProposition;
  readonly negativeClaim?: NegativeClaim;
  readonly subject: string;
  readonly scope: Scope;
  readonly grain: Grain;
  readonly time: ClaimTime;
  readonly epistemic: EpistemicState;
  readonly profile: ClaimProfile;
  readonly measurementModelRef: string | null;
  readonly evidenceIds: readonly string[];
  readonly derivationRule: string;
  readonly derivationVersion: number;
  readonly assumptions: readonly string[];
  readonly assumptionIds: readonly string[];
  readonly uncertainty: Uncertainty | null;
  readonly causalStatus: CausalityStatus;
  /** Aliases are copied from profile and are never independently mutable. */
  readonly monetaryBasis: ClaimProfile['monetaryBasis'];
  readonly finality: ClaimProfile['finality'];
  readonly issuedAt: Instant;
  readonly supersedes: readonly string[];
  readonly supersededBy: string | null;
  readonly revocation: RevocationMetadata | null;
  readonly decisionCertificateIds: readonly string[];
  readonly schemaVersion: number;
}

const CLAIM_KEYS = new Set([
  'id', 'proposition', 'negativeClaim', 'subject', 'scope', 'grain', 'time', 'epistemic', 'profile',
  'measurementModelRef', 'evidenceIds', 'derivationRule', 'derivationVersion', 'assumptions',
  'uncertainty', 'causalStatus', 'issuedAt', 'supersedes', 'supersededBy', 'revocation', 'assumptionIds',
  'decisionCertificateIds', 'schemaVersion', 'monetaryBasis', 'finality',
]);
const PROPOSITION_KEYS = new Set(['predicate', 'value']);
const TIME_KEYS = new Set(['validTime', 'asOf']);
const UNCERTAINTY_KEYS = new Set(['kind', 'lower', 'upper', 'values', 'description']);
const REVOCATION_KEYS = new Set(['eventId', 'effectiveAt', 'reason']);
const PROFILE_KEYS = new Set([
  'epistemic', 'integrity', 'authenticity', 'scope', 'coverage', 'measurement', 'causality',
  'monetaryBasis', 'finality', 'decisionFitness',
]);

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return nonEmpty(value, label);
}

function member<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value as T[number])) {
    throw new Error(`invalid ${label}: ${String(value)}`);
  }
  return value as T[number];
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function stringList(value: unknown, label: string, required = false): readonly string[] {
  if (value === undefined) {
    if (required) throw new Error(`${label} must contain at least one entry`);
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  const normalized = value.map((item, index) => {
    const itemValue = nonEmpty(item, `${label}[${index}]`);
    if (seen.has(itemValue)) throw new Error(`duplicate ${label} entry: ${itemValue}`);
    seen.add(itemValue);
    return itemValue;
  });
  if (required && normalized.length === 0) throw new Error(`${label} must contain at least one entry`);
  return Object.freeze(normalized);
}

function negativeClaim(value: unknown): NegativeClaim | undefined {
  if (value === undefined || value === null) return undefined;
  assertKnownKeys(value, new Set(['eventType', 'completenessWitnessIds']), 'negativeClaim');
  const input = value as NegativeClaimInput;
  return Object.freeze({
    eventType: nonEmpty(input.eventType, 'negativeClaim eventType'),
    completenessWitnessIds: stringList(input.completenessWitnessIds, 'negativeClaim completenessWitnessIds', true),
  });
}

function canonicalScope(value: unknown): Scope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('scope must be an object');
  const constraints = (value as { constraints?: unknown }).constraints;
  if (!Array.isArray(constraints)) throw new Error('scope constraints must be an array');
  const pairs: Record<string, string> = {};
  for (let index = 0; index < constraints.length; index += 1) {
    const item = constraints[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`scope constraint ${index} must be an object`);
    const key = nonEmpty((item as { key?: unknown }).key, `scope constraint ${index} key`);
    const itemValue = nonEmpty((item as { value?: unknown }).value, `scope constraint ${index} value`);
    if (Object.hasOwn(pairs, key)) throw new Error(`duplicate scope key: ${key}`);
    pairs[key] = itemValue;
  }
  return scope(pairs);
}

function canonicalGrain(value: unknown): Grain {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('grain must be an object');
  const dimensions = (value as { dimensions?: unknown }).dimensions;
  if (!Array.isArray(dimensions)) throw new Error('grain dimensions must be an array');
  if (!dimensions.every((dimension) => typeof dimension === 'string')) throw new Error('grain dimensions must be non-empty');
  return grain(dimensions);
}

function canonicalInstant(value: unknown, label: string): Instant | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be canonical UTC ISO-8601`);
  try {
    return instant(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalInterval(value: unknown, label: string): TimeInterval | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a time interval`);
  try {
    return interval((value as { from?: unknown }).from as string, (value as { to?: unknown }).to as string);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function uncertainty(input: unknown): Uncertainty | null {
  if (input === undefined || input === null) return null;
  assertKnownKeys(input, UNCERTAINTY_KEYS, 'uncertainty');
  const value = input as UncertaintyInput;
  const kind = member(value.kind, UNCERTAINTY_KINDS, 'uncertainty kind');
  const lower = value.lower === undefined || value.lower === null ? null : finite(value.lower, 'uncertainty lower');
  const upper = value.upper === undefined || value.upper === null ? null : finite(value.upper, 'uncertainty upper');
  if ((lower === null) !== (upper === null)) throw new Error('uncertainty lower and upper must be supplied together');
  if (lower !== null && upper !== null && lower > upper) throw new Error('uncertainty lower must be <= upper');
  if (value.values !== undefined && !Array.isArray(value.values)) throw new Error('uncertainty values must be an array');
  const values = value.values === undefined ? [] : value.values.map((item, index) => finite(item, `uncertainty values[${index}]`));
  if (kind === 'identified_set' && values.length === 0 && lower === null) {
    throw new Error('identified_set uncertainty requires values or bounds');
  }
  const description = optionalText(value.description, 'uncertainty description');
  return Object.freeze({ kind, lower, upper, values: Object.freeze(values), description });
}

function revocationMetadata(input: unknown): RevocationMetadata | null {
  if (input === undefined || input === null) return null;
  assertKnownKeys(input, REVOCATION_KEYS, 'revocation');
  const value = input as RevocationMetadataInput;
  const eventId = nonEmpty(value.eventId, 'revocation eventId');
  const effectiveAt = canonicalInstant(value.effectiveAt, 'revocation effectiveAt');
  if (effectiveAt === null) throw new Error('revocation effectiveAt must be provided');
  const reason = nonEmpty(value.reason, 'revocation reason');
  return Object.freeze({ eventId, effectiveAt, reason });
}

/** Construct a canonical immutable claim. */
export function claim(input: ClaimInput): Claim {
  assertKnownKeys(input, CLAIM_KEYS, 'claim');
  const value = input as ClaimInput;
  const id = nonEmpty(value.id, 'claim id');

  assertKnownKeys(value.proposition, PROPOSITION_KEYS, 'proposition');
  const propositionInput = value.proposition as TypedPropositionInput;
  const proposition = Object.freeze({
    predicate: nonEmpty(propositionInput.predicate, 'proposition predicate'),
    value: immutableJson(propositionInput.value, 'proposition value'),
  });
  const subject = nonEmpty(value.subject, 'claim subject');
  const normalizedNegativeClaim = negativeClaim(value.negativeClaim);
  const normalizedScope = canonicalScope(value.scope);
  const normalizedGrain = canonicalGrain(value.grain);

  assertKnownKeys(value.time, TIME_KEYS, 'claim time');
  const time: ClaimTime = Object.freeze({
    validTime: canonicalInterval(value.time.validTime, 'claim validTime'),
    asOf: canonicalInstant(value.time.asOf, 'claim asOf'),
  });
  if (time.validTime === null && time.asOf === null) throw new Error('claim time requires validTime or asOf');

  assertKnownKeys(value.profile, PROFILE_KEYS, 'claim profile');
  const normalizedProfile = claimProfile(value.profile);
  const epistemic = member(value.epistemic, EPISTEMIC_STATES, 'epistemic state');
  if (epistemic !== normalizedProfile.epistemic) throw new Error('claim epistemic must match profile.epistemic');
  const causalStatus = member(value.causalStatus, CAUSALITY, 'causal status');
  if (causalStatus !== normalizedProfile.causality) throw new Error('claim causalStatus must match profile.causality');
  if (value.monetaryBasis !== undefined && value.monetaryBasis !== normalizedProfile.monetaryBasis) {
    throw new Error('claim monetaryBasis must match profile.monetaryBasis');
  }
  if (value.finality !== undefined && value.finality !== normalizedProfile.finality) {
    throw new Error('claim finality must match profile.finality');
  }

  const measurementModelRef = optionalText(value.measurementModelRef, 'measurementModelRef');
  if (normalizedProfile.measurement !== 'proxy_unvalidated' && measurementModelRef === null) {
    throw new Error('measurementModelRef is required when profile.measurement is validated');
  }

  const evidenceIds = stringList(value.evidenceIds, 'evidenceIds', true);
  const derivationRule = nonEmpty(value.derivationRule, 'derivationRule');
  if (!Number.isSafeInteger(value.derivationVersion) || value.derivationVersion < 1) {
    throw new Error('derivationVersion must be a positive safe integer');
  }
  const issuedAt = canonicalInstant(value.issuedAt, 'claim issuedAt');
  if (issuedAt === null) throw new Error('claim issuedAt must be provided');
  const supersedes = stringList(value.supersedes, 'supersedes');
  const supersededBy = optionalText(value.supersededBy, 'supersededBy');
  const assumptionIds = stringList(value.assumptionIds, 'assumptionIds');
  const decisionCertificateIds = stringList(value.decisionCertificateIds, 'decisionCertificateIds');
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw new Error('schemaVersion must be a positive safe integer');
  }

  return Object.freeze({
    id,
    proposition,
    ...(normalizedNegativeClaim === undefined ? {} : { negativeClaim: normalizedNegativeClaim }),
    subject,
    scope: normalizedScope,
    grain: normalizedGrain,
    time,
    epistemic,
    profile: normalizedProfile,
    measurementModelRef,
    evidenceIds,
    derivationRule,
    derivationVersion: value.derivationVersion,
    assumptions: stringList(value.assumptions, 'assumption'),
    assumptionIds,
    uncertainty: uncertainty(value.uncertainty),
    causalStatus,
    monetaryBasis: normalizedProfile.monetaryBasis,
    finality: normalizedProfile.finality,
    issuedAt,
    supersedes,
    supersededBy,
    revocation: revocationMetadata(value.revocation),
    decisionCertificateIds,
    schemaVersion: value.schemaVersion,
  });
}

/** Naming alias for constructor-style callers. */
export const createClaim = claim;
