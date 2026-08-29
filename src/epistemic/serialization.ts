/**
 * Canonical JSON and digest envelopes for Trusted Epistemic Kernel records.
 *
 * Canonicalization sorts object keys, preserves array order, rejects unsupported
 * values/cycles, and is verified again before deserialization. Record factories
 * run on both sides of the boundary, so a valid digest cannot bypass the
 * Evidence/Claim/Assumption/Derivation invariants.
 */

import { createHash } from 'node:crypto';
import { assumption, type Assumption } from './assumption.ts';
import { claim, type Claim } from './claim.ts';
import { derivation, type Derivation } from './derivation.ts';
import { evidence, type Evidence } from './evidence.ts';

export const SERIALIZED_RECORD_KINDS = ['evidence', 'claim', 'assumption', 'derivation'] as const;
export type SerializedRecordKind = (typeof SERIALIZED_RECORD_KINDS)[number];

export interface SerializedEpistemicRecord {
  readonly kind: SerializedRecordKind;
  readonly schemaVersion: number;
  readonly id: string;
  readonly body: string;
  readonly digest: string;
}

const ENVELOPE_KEYS = new Set(['kind', 'schemaVersion', 'id', 'body', 'digest']);

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function canonicalValue(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return jsonString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON-compatible numbers`);
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error(`${path} must be JSON-compatible`);
  if (seen.has(value)) throw new Error(`${path} must not contain a cycle`);
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item, index) => canonicalValue(item, `${path}[${index}]`, seen)).join(',')}]`;
  } else {
    let prototype: object | null;
    try { prototype = Object.getPrototypeOf(value); } catch { throw new Error(`${path} must be JSON-compatible`); }
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be JSON-compatible`);
    const parts: string[] = [];
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`${path}.${key} is not an allowed JSON field`);
      parts.push(`${jsonString(key)}:${canonicalValue((value as Record<string, unknown>)[key], `${path}.${key}`, seen)}`);
    }
    result = `{${parts.join(',')}}`;
  }
  seen.delete(value);
  return result;
}

/** Return deterministic JSON bytes for a JSON-compatible value. */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value, 'value', new WeakSet<object>());
}

function digest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function envelope(kind: SerializedRecordKind, id: string, schemaVersion: number, body: string): SerializedEpistemicRecord {
  return Object.freeze({ kind, schemaVersion, id, body, digest: digest(body) });
}

export function serializeEvidence(value: Evidence): SerializedEpistemicRecord {
  const item = evidence(value);
  return envelope('evidence', item.id, item.schemaVersion, canonicalJson(item));
}

export function serializeClaim(value: Claim): SerializedEpistemicRecord {
  const item = claim(value);
  return envelope('claim', item.id, item.schemaVersion, canonicalJson(item));
}

export function serializeAssumption(value: Assumption): SerializedEpistemicRecord {
  const item = assumption(value);
  return envelope('assumption', item.id, item.schemaVersion, canonicalJson(item));
}

export function serializeDerivation(value: Derivation): SerializedEpistemicRecord {
  const item = derivation(value);
  return envelope('derivation', item.id, item.version, canonicalJson(item));
}

function decode(record: SerializedEpistemicRecord, expectedKind: SerializedRecordKind): Record<string, unknown> {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('serialized record must be an object');
  for (const key of Object.keys(record)) if (!ENVELOPE_KEYS.has(key)) throw new Error(`serialized record contains unknown field: ${key}`);
  if (record.kind !== expectedKind) throw new Error(`serialized record kind must be ${expectedKind}`);
  if (!Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1) throw new Error('serialized record schemaVersion must be a positive safe integer');
  if (typeof record.id !== 'string' || record.id.trim().length === 0) throw new Error('serialized record id must be non-empty');
  if (typeof record.body !== 'string' || record.body.length === 0) throw new Error('serialized record body must be non-empty');
  if (typeof record.digest !== 'string' || record.digest !== digest(record.body)) throw new Error('serialized record digest verification failed');
  let parsed: unknown;
  try { parsed = JSON.parse(record.body); } catch { throw new Error('serialized record body is invalid JSON'); }
  if (canonicalJson(parsed) !== record.body) throw new Error('serialized record body is not canonical JSON');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('serialized record body must be an object');
  return parsed as Record<string, unknown>;
}

export function deserializeEvidence(record: SerializedEpistemicRecord): Evidence {
  const parsed = decode(record, 'evidence');
  const item = evidence(parsed as unknown as Evidence);
  if (item.id !== record.id || item.schemaVersion !== record.schemaVersion) throw new Error('serialized evidence identity/schemaVersion mismatch');
  return item;
}

export function deserializeClaim(record: SerializedEpistemicRecord): Claim {
  const parsed = decode(record, 'claim');
  const item = claim(parsed as unknown as Claim);
  if (item.id !== record.id || item.schemaVersion !== record.schemaVersion) throw new Error('serialized claim identity/schemaVersion mismatch');
  return item;
}

export function deserializeAssumption(record: SerializedEpistemicRecord): Assumption {
  const parsed = decode(record, 'assumption');
  const item = assumption(parsed as unknown as Assumption);
  if (item.id !== record.id || item.schemaVersion !== record.schemaVersion) throw new Error('serialized assumption identity/schemaVersion mismatch');
  return item;
}

export function deserializeDerivation(record: SerializedEpistemicRecord): Derivation {
  const parsed = decode(record, 'derivation');
  const item = derivation(parsed as unknown as Derivation);
  if (item.id !== record.id || item.version !== record.schemaVersion) throw new Error('serialized derivation identity/version mismatch');
  return item;
}
