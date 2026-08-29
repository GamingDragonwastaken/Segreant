/** Canonical JSON/digest envelopes for immutable economic events. */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../epistemic/serialization.ts';
import { economicEvent, economicEventFromJson, economicEventToJson, type EconomicEvent } from './events.ts';

export interface SerializedEconomicEvent {
  readonly kind: 'economic_event';
  readonly schemaVersion: number;
  readonly id: string;
  readonly body: string;
  readonly digest: string;
}

const ENVELOPE_KEYS = new Set(['kind', 'schemaVersion', 'id', 'body', 'digest']);

function digest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export function serializeEconomicEvent(value: EconomicEvent): SerializedEconomicEvent {
  const item = economicEvent(value);
  const body = canonicalJson(economicEventToJson(item));
  return Object.freeze({ kind: 'economic_event', schemaVersion: item.schemaVersion, id: item.id, body, digest: digest(body) });
}

export function deserializeEconomicEvent(record: SerializedEconomicEvent): EconomicEvent {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('serialized economic event must be an object');
  for (const key of Object.keys(record)) if (!ENVELOPE_KEYS.has(key)) throw new Error(`serialized economic event contains unknown field: ${key}`);
  if (record.kind !== 'economic_event') throw new Error('serialized economic event kind must be economic_event');
  if (!Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1) throw new Error('serialized economic event schemaVersion must be a positive safe integer');
  if (typeof record.id !== 'string' || record.id.trim().length === 0) throw new Error('serialized economic event id must be non-empty');
  if (typeof record.body !== 'string' || record.body.length === 0) throw new Error('serialized economic event body must be non-empty');
  if (typeof record.digest !== 'string' || record.digest !== digest(record.body)) throw new Error('serialized economic event digest verification failed');
  let parsed: unknown;
  try { parsed = JSON.parse(record.body); } catch { throw new Error('serialized economic event body is invalid JSON'); }
  if (canonicalJson(parsed) !== record.body) throw new Error('serialized economic event body is not canonical JSON');
  const item = economicEventFromJson(parsed);
  if (item.id !== record.id || item.schemaVersion !== record.schemaVersion) throw new Error('serialized economic event identity/schemaVersion mismatch');
  return item;
}
