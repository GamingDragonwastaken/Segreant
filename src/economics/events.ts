/**
 * Immutable economic-event vocabulary.
 *
 * Events are facts about an economic ledger, not mutable balances. Monetary
 * amounts retain their exact Money basis; credits and reversals are represented
 * by signed amounts and linked to their source event where applicable. The
 * projection layer is deliberately separate so corrections append history
 * instead of rewriting an earlier observation.
 */

import { immutableJson, type JsonValue } from '../epistemic/evidence.ts';
import { instant, type Instant } from '../epistemic/time.ts';
import { moneyFromJson, moneyToJson, type EconomicBasis, type Money, type MoneyJson } from './money.ts';

export const ECONOMIC_EVENT_KINDS = [
  'usage_observed',
  'charge_estimated',
  'provider_charge_observed',
  'bill_observed',
  'price_asserted',
  'price_corrected',
  'credit_applied',
  'discount_applied',
  'commitment_recognized',
  'tax_recognized',
  'fx_translated',
  'cost_allocated',
  'allocation_reversed',
  'true_up',
  'write_off',
  'close_finalized',
  'close_reopened',
] as const;
export type EconomicEventKind = (typeof ECONOMIC_EVENT_KINDS)[number];

export const ECONOMIC_EVENT_ROLES = [
  'usage',
  'charge',
  'price',
  'adjustment',
  'translation',
  'allocation',
  'control',
] as const;
export type EconomicEventRole = (typeof ECONOMIC_EVENT_ROLES)[number];

const EVENT_ROLE_BY_KIND: Record<EconomicEventKind, EconomicEventRole> = {
  usage_observed: 'usage',
  charge_estimated: 'charge',
  provider_charge_observed: 'charge',
  bill_observed: 'charge',
  price_asserted: 'price',
  price_corrected: 'price',
  credit_applied: 'adjustment',
  discount_applied: 'adjustment',
  commitment_recognized: 'adjustment',
  tax_recognized: 'adjustment',
  fx_translated: 'translation',
  cost_allocated: 'allocation',
  allocation_reversed: 'allocation',
  true_up: 'adjustment',
  write_off: 'adjustment',
  close_finalized: 'control',
  close_reopened: 'control',
};

/** Classify event semantics before a projection combines any amounts. */
export function economicEventRole(kind: EconomicEventKind): EconomicEventRole {
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_ROLE_BY_KIND, kind)) {
    throw new Error(`invalid economic event kind: ${String(kind)}`);
  }
  return EVENT_ROLE_BY_KIND[kind as EconomicEventKind];
}

const MONETARY_EVENT_KINDS = new Set<EconomicEventKind>([
  'usage_observed',
  'charge_estimated',
  'provider_charge_observed',
  'bill_observed',
  'credit_applied',
  'price_corrected',
  'discount_applied',
  'commitment_recognized',
  'tax_recognized',
  'fx_translated',
  'cost_allocated',
  'allocation_reversed',
  'true_up',
  'write_off',
]);

export interface EconomicEventInput {
  readonly id: string;
  readonly kind: EconomicEventKind;
  readonly subject: string;
  readonly occurredAt: Instant;
  readonly recordedAt: Instant;
  readonly amount?: Money | null;
  readonly sourceEventIds?: readonly string[];
  readonly reversalOf?: string | null;
  readonly metadata?: JsonValue | null;
  readonly schemaVersion: number;
}

export interface EconomicEvent {
  readonly id: string;
  readonly kind: EconomicEventKind;
  readonly subject: string;
  readonly occurredAt: Instant;
  readonly recordedAt: Instant;
  readonly amount: Money | null;
  readonly sourceEventIds: readonly string[];
  readonly reversalOf: string | null;
  readonly metadata: JsonValue | null;
  readonly schemaVersion: number;
}

/** JSON-safe canonical form used by the event digest and SQLite ledger. */
export interface EconomicEventJson {
  readonly id: string;
  readonly kind: EconomicEventKind;
  readonly subject: string;
  readonly occurredAt: Instant;
  readonly recordedAt: Instant;
  readonly amount: MoneyJson | null;
  readonly sourceEventIds: readonly string[];
  readonly reversalOf: string | null;
  readonly metadata: JsonValue | null;
  readonly schemaVersion: number;
}

const EVENT_KEYS = new Set([
  'id', 'kind', 'subject', 'occurredAt', 'recordedAt', 'amount', 'sourceEventIds', 'reversalOf', 'metadata', 'schemaVersion',
]);

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function canonicalInstant(value: unknown, label: string): Instant {
  if (typeof value !== 'string') throw new Error(`${label} must be canonical UTC ISO-8601`);
  try {
    return instant(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function eventKind(value: unknown): EconomicEventKind {
  if (typeof value !== 'string' || !ECONOMIC_EVENT_KINDS.includes(value as EconomicEventKind)) throw new Error(`invalid economic event kind: ${String(value)}`);
  return value as EconomicEventKind;
}

function validateEventBasis(kind: EconomicEventKind, amount: Money | null, id: string): void {
  if (amount === null) return;
  const valid = kind === 'charge_estimated'
    ? amount.basis === 'list' || amount.basis === 'estimated'
    : kind === 'provider_charge_observed'
      ? amount.basis === 'provider_observed'
      : kind === 'bill_observed'
        ? amount.basis === 'billed'
        : kind === 'cost_allocated' || kind === 'allocation_reversed'
          ? amount.basis === 'allocated'
          : true;
  if (!valid) throw new Error(`economic event ${id} kind ${kind} requires a compatible economic basis (received ${amount.basis})`);
}

function eventIds(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error('economic event sourceEventIds must be an array');
  const seen = new Set<string>();
  const result = value.map((item, index) => {
    const id = nonEmpty(item, `economic event sourceEventIds[${index}]`);
    if (seen.has(id)) throw new Error(`duplicate economic event sourceEventIds entry: ${id}`);
    seen.add(id);
    return id;
  });
  return Object.freeze(result);
}

function requireJsonFields(value: object, fields: readonly string[], label: string): void {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw new Error(`${label} is missing field: ${field}`);
  }
}

function canonicalAmount(value: unknown, label: string): Money | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || typeof (value as { coefficient?: unknown }).coefficient !== 'bigint') {
    throw new Error(`${label} must be an exact Money value`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\u0000') !== ['basis', 'coefficient', 'currency', 'scale'].join('\u0000')) {
    throw new Error(`${label} contains unknown or missing Money fields`);
  }
  try {
    return moneyFromJson(moneyToJson(value as Money));
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Construct a canonical immutable economic event. */
export function economicEvent(input: EconomicEventInput): EconomicEvent {
  assertKnownKeys(input, EVENT_KEYS, 'economic event');
  const value = input as EconomicEventInput;
  const id = nonEmpty(value.id, 'economic event id');
  const kind = eventKind(value.kind);
  const subject = nonEmpty(value.subject, 'economic event subject');
  const occurredAt = canonicalInstant(value.occurredAt, `economic event ${id} occurredAt`);
  const recordedAt = canonicalInstant(value.recordedAt, `economic event ${id} recordedAt`);
  const amount = canonicalAmount(value.amount, `economic event ${id} amount`);
  if (MONETARY_EVENT_KINDS.has(kind) && amount === null) throw new Error(`economic event ${id} of kind ${kind} requires an amount`);
  validateEventBasis(kind, amount, id);
  const sourceEventIds = eventIds(value.sourceEventIds);
  const reversalOf = value.reversalOf === undefined || value.reversalOf === null ? null : nonEmpty(value.reversalOf, `economic event ${id} reversalOf`);
  if (reversalOf === id) throw new Error(`economic event ${id} cannot reverse itself`);
  if (kind === 'allocation_reversed' && reversalOf === null) throw new Error(`economic event ${id} allocation_reversed requires reversalOf`);
  const metadata = value.metadata === undefined || value.metadata === null ? null : immutableJson(value.metadata, `economic event ${id} metadata`);
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) throw new Error('economic event schemaVersion must be a positive safe integer');
  return Object.freeze({ id, kind, subject, occurredAt, recordedAt, amount, sourceEventIds, reversalOf, metadata, schemaVersion: value.schemaVersion });
}

export function economicEventToJson(value: EconomicEvent): EconomicEventJson {
  const item = economicEvent(value);
  return Object.freeze({
    id: item.id,
    kind: item.kind,
    subject: item.subject,
    occurredAt: item.occurredAt,
    recordedAt: item.recordedAt,
    amount: item.amount === null ? null : { ...moneyToJson(item.amount) },
    sourceEventIds: item.sourceEventIds,
    reversalOf: item.reversalOf,
    metadata: item.metadata,
    schemaVersion: item.schemaVersion,
  });
}

export function economicEventFromJson(value: unknown): EconomicEvent {
  assertKnownKeys(value, EVENT_KEYS, 'economic event JSON');
  requireJsonFields(value as object, [...EVENT_KEYS], 'economic event JSON');
  const input = value as EconomicEventJson;
  if (input.amount !== null && (typeof input.amount !== 'object' || Array.isArray(input.amount))) throw new Error('economic event JSON amount must be a Money object or null');
  const amount = input.amount === null ? null : moneyFromJson(input.amount);
  return economicEvent({
    id: input.id,
    kind: input.kind,
    subject: input.subject,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
    amount,
    sourceEventIds: input.sourceEventIds,
    reversalOf: input.reversalOf,
    metadata: input.metadata,
    schemaVersion: input.schemaVersion,
  });
}

/** Basis of a balance, exported for projection consumers that avoid floats. */
export type EconomicBalanceBasis = EconomicBasis;
