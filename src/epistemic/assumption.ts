/**
 * First-class assumption node for the Trusted Epistemic Kernel.
 *
 * An assumption is an explicitly scoped proposition that a derivation depends
 * on. It is not a confidence score and it is never silently folded into a
 * claim's evidence. Corrections/revocations are represented as new events or
 * successor assumptions; this envelope remains immutable once issued.
 */

import { EPISTEMIC_STATES, type EpistemicState } from './state.ts';
import { grain, type Grain } from './grain.ts';
import { scope, type Scope } from './scope.ts';
import { instant, interval, type Instant, type TimeInterval } from './time.ts';

export interface AssumptionInput {
  readonly id: string;
  readonly statement: string;
  readonly scope: Scope;
  readonly grain: Grain;
  readonly validTime?: TimeInterval | null;
  readonly asOf?: Instant | null;
  readonly epistemic: EpistemicState;
  readonly evidenceIds?: readonly string[];
  readonly issuedAt: Instant;
  readonly supersedes?: readonly string[];
  readonly supersededBy?: string | null;
  readonly schemaVersion: number;
}

export interface Assumption {
  readonly id: string;
  readonly statement: string;
  readonly scope: Scope;
  readonly grain: Grain;
  readonly validTime: TimeInterval | null;
  readonly asOf: Instant | null;
  readonly epistemic: EpistemicState;
  readonly evidenceIds: readonly string[];
  readonly issuedAt: Instant;
  readonly supersedes: readonly string[];
  readonly supersededBy: string | null;
  readonly schemaVersion: number;
}

const ASSUMPTION_KEYS = new Set([
  'id', 'statement', 'scope', 'grain', 'validTime', 'asOf', 'epistemic', 'evidenceIds',
  'issuedAt', 'supersedes', 'supersededBy', 'schemaVersion',
]);

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function member<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value as T[number])) throw new Error(`invalid ${label}: ${String(value)}`);
  return value as T[number];
}

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  const output = value.map((item, index) => {
    const id = nonEmpty(item, `${label}[${index}]`);
    if (seen.has(id)) throw new Error(`duplicate ${label} entry: ${id}`);
    seen.add(id);
    return id;
  });
  return Object.freeze(output);
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

/** Construct an immutable, scoped and versioned assumption. */
export function assumption(input: AssumptionInput): Assumption {
  assertKnownKeys(input, ASSUMPTION_KEYS, 'assumption');
  const value = input as AssumptionInput;
  const id = nonEmpty(value.id, 'assumption id');
  const statement = nonEmpty(value.statement, 'assumption statement');
  const issuedAt = canonicalInstant(value.issuedAt, 'assumption issuedAt');
  if (issuedAt === null) throw new Error('assumption issuedAt must be provided');
  const supersedes = stringList(value.supersedes, 'supersedes');
  const supersededBy = value.supersededBy === undefined || value.supersededBy === null ? null : nonEmpty(value.supersededBy, 'supersededBy');
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) throw new Error('schemaVersion must be a positive safe integer');
  return Object.freeze({
    id,
    statement,
    scope: canonicalScope(value.scope),
    grain: canonicalGrain(value.grain),
    validTime: canonicalInterval(value.validTime, 'assumption validTime'),
    asOf: canonicalInstant(value.asOf, 'assumption asOf'),
    epistemic: member(value.epistemic, EPISTEMIC_STATES, 'assumption epistemic state'),
    evidenceIds: stringList(value.evidenceIds, 'evidenceIds'),
    issuedAt,
    supersedes,
    supersededBy,
    schemaVersion: value.schemaVersion,
  });
}

/** Naming alias for constructor-style callers. */
export const createAssumption = assumption;
