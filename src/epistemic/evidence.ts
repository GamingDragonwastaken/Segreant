/**
 * Canonical immutable Evidence envelope for the Trusted Epistemic Kernel.
 *
 * Evidence describes what a source supplied, where and at what grain it
 * applies, when it was observed/recorded, and which independent assurance axes
 * are (or are not) established. It is deliberately not a claim: an envelope
 * never contains a universal `trusted`/`established` boolean and cannot mint
 * stronger truth merely by being signed or well formed.
 */

import {
  AUTHENTICITY,
  INTEGRITY,
  type AuthenticityStatus,
  type IntegrityStatus,
} from './profile.ts';
import { grain, type Grain } from './grain.ts';
import { scope, type Scope } from './scope.ts';
import { instant, interval, type Instant, type TimeInterval } from './time.ts';
import { ECONOMIC_BASES, type EconomicBasis } from '../economics/money.ts';

export const COMPLETENESS_STATUSES = ['unknown', 'partial', 'complete'] as const;
export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number];

export const SENSITIVITY_CLASSES = ['public', 'internal', 'confidential', 'restricted'] as const;
export type SensitivityClass = (typeof SENSITIVITY_CLASSES)[number];

export const REDACTION_CLASSES = ['none', 'partial', 'full'] as const;
export type RedactionClass = (typeof REDACTION_CLASSES)[number];

export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export interface CompletenessProfileInput {
  readonly status: CompletenessStatus;
  readonly method?: string | null;
  readonly coveredEventTypes?: readonly string[];
  readonly coveredScope?: Scope | null;
  readonly coveredTime?: TimeInterval | null;
}

export interface CompletenessProfile {
  readonly status: CompletenessStatus;
  readonly method: string | null;
  readonly coveredEventTypes: readonly string[];
  readonly coveredScope: Scope | null;
  readonly coveredTime: TimeInterval | null;
}

export interface RevocationMetadataInput {
  readonly eventId: string;
  readonly effectiveAt: Instant;
  readonly reason: string;
}

export type RevocationMetadata = Readonly<RevocationMetadataInput>;

export interface EvidenceInput {
  readonly id: string;
  readonly evidenceType: string;
  readonly sourceIdentity: string;
  readonly sourceClass: string;
  readonly payload?: JsonValue;
  readonly payloadHash?: string;
  readonly reference?: string;
  readonly scope: Scope;
  readonly grain: Grain;
  readonly occurredAt?: Instant | null;
  readonly validTime?: TimeInterval | null;
  readonly observedAt?: Instant | null;
  readonly recordedAt?: Instant | null;
  readonly assertedAt?: Instant | null;
  readonly finalizedAt?: Instant | null;
  readonly integrity: IntegrityStatus;
  readonly authenticity: AuthenticityStatus;
  readonly completeness: CompletenessProfileInput;
  readonly measurementModelRef?: string | null;
  readonly monetaryBasis?: EconomicBasis | null;
  readonly assumptions?: readonly string[];
  readonly supersedes?: readonly string[];
  readonly supersededBy?: string | null;
  readonly revocation?: RevocationMetadataInput | null;
  readonly schemaVersion: number;
  readonly sensitivity: SensitivityClass;
  readonly redaction: RedactionClass;
}

export interface Evidence {
  readonly id: string;
  readonly evidenceType: string;
  readonly sourceIdentity: string;
  readonly sourceClass: string;
  readonly payload?: JsonValue;
  readonly payloadHash?: string;
  readonly reference?: string;
  readonly scope: Scope;
  readonly grain: Grain;
  readonly occurredAt: Instant | null;
  readonly validTime: TimeInterval | null;
  readonly observedAt: Instant | null;
  readonly recordedAt: Instant | null;
  readonly assertedAt: Instant | null;
  readonly finalizedAt: Instant | null;
  readonly integrity: IntegrityStatus;
  readonly authenticity: AuthenticityStatus;
  readonly completeness: CompletenessProfile;
  readonly measurementModelRef: string | null;
  readonly monetaryBasis: EconomicBasis | null;
  readonly assumptions: readonly string[];
  readonly supersedes: readonly string[];
  readonly supersededBy: string | null;
  readonly revocation: RevocationMetadata | null;
  readonly schemaVersion: number;
  readonly sensitivity: SensitivityClass;
  readonly redaction: RedactionClass;
}

const EVIDENCE_KEYS = new Set([
  'id', 'evidenceType', 'sourceIdentity', 'sourceClass', 'payload', 'payloadHash', 'reference',
  'scope', 'grain', 'occurredAt', 'validTime', 'observedAt', 'recordedAt', 'assertedAt',
  'finalizedAt', 'integrity', 'authenticity', 'completeness', 'measurementModelRef',
  'monetaryBasis', 'assumptions', 'supersedes', 'supersededBy', 'revocation', 'schemaVersion',
  'sensitivity', 'redaction',
]);

const COMPLETENESS_KEYS = new Set(['status', 'method', 'coveredEventTypes', 'coveredScope', 'coveredTime']);
const REVOCATION_KEYS = new Set(['eventId', 'effectiveAt', 'reason']);

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

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function cloneJson(value: unknown, label: string, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON-compatible numbers`);
    return value;
  }
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`);
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
  seen.add(value);

  let result: JsonValue;
  if (Array.isArray(value)) {
    result = Object.freeze(value.map((item, index) => cloneJson(item, `${label}[${index}]`, seen)));
  } else {
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      throw new Error(`${label} must be JSON-compatible`);
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must be JSON-compatible`);
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error(`${label}.${key} is not an allowed JSON field`);
      }
      output[key] = cloneJson((value as Record<string, unknown>)[key], `${label}.${key}`, seen);
    }
    result = Object.freeze(output);
  }
  seen.delete(value);
  return result;
}

function canonicalScope(value: unknown): Scope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('scope must be an object');
  const constraints = (value as { constraints?: unknown }).constraints;
  if (!Array.isArray(constraints)) throw new Error('scope constraints must be an array');
  const pairs: Record<string, string> = {};
  for (let index = 0; index < constraints.length; index += 1) {
    const constraint = constraints[index];
    if (constraint === null || typeof constraint !== 'object' || Array.isArray(constraint)) {
      throw new Error(`scope constraint ${index} must be an object`);
    }
    const key = nonEmpty((constraint as { key?: unknown }).key, `scope constraint ${index} key`);
    const itemValue = nonEmpty((constraint as { value?: unknown }).value, `scope constraint ${index} value`);
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
  if (typeof value !== 'string') throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  try {
    return instant(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${detail}`);
  }
}

function canonicalInterval(value: unknown, label: string): TimeInterval | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a time interval`);
  try {
    return interval(
      (value as { from?: unknown }).from as string,
      (value as { to?: unknown }).to as string,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${detail}`);
  }
}

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  const normalized = value.map((item, index) => {
    const itemValue = nonEmpty(item, `${label}[${index}]`);
    if (seen.has(itemValue)) throw new Error(`duplicate ${label} entry: ${itemValue}`);
    seen.add(itemValue);
    return itemValue;
  });
  return Object.freeze(normalized);
}

function completenessProfile(input: unknown): CompletenessProfile {
  assertKnownKeys(input, COMPLETENESS_KEYS, 'completeness');
  const value = input as CompletenessProfileInput;
  const status = member(value.status, COMPLETENESS_STATUSES, 'completeness status');
  const method = optionalText(value.method, 'completeness method');
  const coveredEventTypes = stringList(value.coveredEventTypes, 'covered event type');
  const coveredScope = value.coveredScope === undefined || value.coveredScope === null ? null : canonicalScope(value.coveredScope);
  const coveredTime = canonicalInterval(value.coveredTime, 'completeness coveredTime');
  return Object.freeze({ status, method, coveredEventTypes, coveredScope, coveredTime });
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

/** Construct a canonical, deeply immutable evidence envelope. */
export function evidence(input: EvidenceInput): Evidence {
  assertKnownKeys(input, EVIDENCE_KEYS, 'evidence');
  const value = input as EvidenceInput;
  const id = nonEmpty(value.id, 'evidence id');
  const evidenceType = nonEmpty(value.evidenceType, 'evidence type');
  const sourceIdentity = nonEmpty(value.sourceIdentity, 'evidence source identity');
  const sourceClass = nonEmpty(value.sourceClass, 'evidence source class');
  const payloadHash = optionalText(value.payloadHash, 'evidence payloadHash');
  const reference = optionalText(value.reference, 'evidence reference');
  const hasPayload = value.payload !== undefined;
  if (!hasPayload && payloadHash === null && reference === null) {
    throw new Error('evidence requires payload, payloadHash, or reference');
  }
  const payload = hasPayload ? cloneJson(value.payload, 'evidence payload') : undefined;

  const observedAt = canonicalInstant(value.observedAt, 'evidence observedAt');
  const recordedAt = canonicalInstant(value.recordedAt, 'evidence recordedAt');
  const assertedAt = canonicalInstant(value.assertedAt, 'evidence assertedAt');
  if (observedAt === null && recordedAt === null && assertedAt === null) {
    throw new Error('evidence requires at least one acquisition timestamp (observedAt, recordedAt, or assertedAt)');
  }

  const monetaryBasis = value.monetaryBasis === undefined || value.monetaryBasis === null
    ? null
    : member(value.monetaryBasis, ECONOMIC_BASES, 'monetary basis');
  const measurementModelRef = optionalText(value.measurementModelRef, 'measurementModelRef');
  const supersedes = stringList(value.supersedes, 'supersedes');
  const supersededBy = optionalText(value.supersededBy, 'supersededBy');
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw new Error('schemaVersion must be a positive safe integer');
  }

  const normalized: Evidence = {
    id,
    evidenceType,
    sourceIdentity,
    sourceClass,
    ...(payload === undefined ? {} : { payload }),
    ...(payloadHash === null ? {} : { payloadHash }),
    ...(reference === null ? {} : { reference }),
    scope: canonicalScope(value.scope),
    grain: canonicalGrain(value.grain),
    occurredAt: canonicalInstant(value.occurredAt, 'evidence occurredAt'),
    validTime: canonicalInterval(value.validTime, 'evidence validTime'),
    observedAt,
    recordedAt,
    assertedAt,
    finalizedAt: canonicalInstant(value.finalizedAt, 'evidence finalizedAt'),
    integrity: member(value.integrity, INTEGRITY, 'integrity'),
    authenticity: member(value.authenticity, AUTHENTICITY, 'authenticity'),
    completeness: completenessProfile(value.completeness),
    measurementModelRef,
    monetaryBasis,
    assumptions: stringList(value.assumptions, 'assumption'),
    supersedes,
    supersededBy,
    revocation: revocationMetadata(value.revocation),
    schemaVersion: value.schemaVersion,
    sensitivity: member(value.sensitivity, SENSITIVITY_CLASSES, 'sensitivity'),
    redaction: member(value.redaction, REDACTION_CLASSES, 'redaction'),
  };
  return Object.freeze(normalized);
}

/** Naming alias for callers that prefer constructor-style factories. */
export const createEvidence = evidence;
