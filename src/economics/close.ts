/** Canonical period-close metadata and projection-digest helpers. */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../epistemic/serialization.ts';
import { instant, type Instant } from '../epistemic/time.ts';
import { moneyToJson, type Money } from './money.ts';

export const CLOSE_SCHEMA_VERSION = 1 as const;

export interface EconomicPeriod {
  readonly startMs: number;
  readonly endMs: number;
  readonly start: Instant;
  readonly end: Instant;
  readonly subject: string;
}

export interface CloseFinalizationMetadata {
  readonly closeSchemaVersion: typeof CLOSE_SCHEMA_VERSION;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly projectionDigest: string;
  readonly eventCount: number;
}

export interface CloseReopenMetadata {
  readonly closeSchemaVersion: typeof CLOSE_SCHEMA_VERSION;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly closeEventId: string;
  readonly reason: string;
}

export interface CloseInvalidationMetadata {
  readonly closeSchemaVersion: typeof CLOSE_SCHEMA_VERSION;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly closeEventId: string;
  readonly reason: string;
}

export interface CloseProjectionBalance {
  readonly role: string;
  readonly currency: string;
  readonly basis: string;
  readonly amount: Money;
  readonly eventIds: readonly string[];
}

function safeEpoch(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('economic period ' + label + ' must be a safe integer timestamp');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('economic period ' + label + ' is outside the supported date range');
  return value;
}

/** Normalize a half-open UTC period and derive its stable subject identity. */
export function canonicalPeriod(startMs: unknown, endMs: unknown): EconomicPeriod {
  const start = safeEpoch(startMs, 'startMs');
  const end = safeEpoch(endMs, 'endMs');
  if (start >= end) throw new Error('economic period must be a non-empty half-open interval');
  const startIso = instant(new Date(start).toISOString());
  const endIso = instant(new Date(end).toISOString());
  return Object.freeze({
    startMs: start,
    endMs: end,
    start: startIso,
    end: endIso,
    subject: periodSubject(start, end),
  });
}

export function periodSubject(startMs: number, endMs: number): string {
  return 'economic-period:' + startMs + ':' + endMs;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(label + ' contains unknown or missing fields');
  }
  return record;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(label + ' must be a lowercase SHA-256 digest');
  return value;
}

function closeVersion(value: unknown, label: string): void {
  if (value !== CLOSE_SCHEMA_VERSION) throw new Error(label + ' must use close schema version ' + CLOSE_SCHEMA_VERSION);
}

/** Validate and normalize finalization metadata from an untrusted event. */
export function closeFinalizationMetadata(value: unknown): CloseFinalizationMetadata {
  const record = exactKeys(value, ['closeSchemaVersion', 'periodStartMs', 'periodEndMs', 'projectionDigest', 'eventCount'], 'close finalization metadata');
  closeVersion(record['closeSchemaVersion'], 'close finalization metadata closeSchemaVersion');
  const period = canonicalPeriod(record['periodStartMs'], record['periodEndMs']);
  if (typeof record['eventCount'] !== 'number' || !Number.isSafeInteger(record['eventCount']) || record['eventCount'] < 0) {
    throw new Error('close finalization metadata eventCount must be a non-negative safe integer');
  }
  return Object.freeze({
    closeSchemaVersion: CLOSE_SCHEMA_VERSION,
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    projectionDigest: digest(record['projectionDigest'], 'close finalization metadata projectionDigest'),
    eventCount: record['eventCount'],
  });
}

/** Validate and normalize reopen metadata from an untrusted event. */
export function closeReopenMetadata(value: unknown): CloseReopenMetadata {
  const record = exactKeys(value, ['closeSchemaVersion', 'periodStartMs', 'periodEndMs', 'closeEventId', 'reason'], 'close reopen metadata');
  closeVersion(record['closeSchemaVersion'], 'close reopen metadata closeSchemaVersion');
  const period = canonicalPeriod(record['periodStartMs'], record['periodEndMs']);
  if (typeof record['closeEventId'] !== 'string' || record['closeEventId'].trim().length === 0) {
    throw new Error('close reopen metadata closeEventId must be non-empty');
  }
  if (typeof record['reason'] !== 'string' || record['reason'].trim().length === 0) {
    throw new Error('close reopen metadata reason must be non-empty');
  }
  return Object.freeze({
    closeSchemaVersion: CLOSE_SCHEMA_VERSION,
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    closeEventId: record['closeEventId'],
    reason: record['reason'],
  });
}

/** Validate and normalize an append-only close-invalidation record. */
export function closeInvalidationMetadata(value: unknown): CloseInvalidationMetadata {
  const record = exactKeys(value, ['closeSchemaVersion', 'periodStartMs', 'periodEndMs', 'closeEventId', 'reason'], 'close invalidation metadata');
  closeVersion(record['closeSchemaVersion'], 'close invalidation metadata closeSchemaVersion');
  const period = canonicalPeriod(record['periodStartMs'], record['periodEndMs']);
  if (typeof record['closeEventId'] !== 'string' || record['closeEventId'].trim().length === 0) {
    throw new Error('close invalidation metadata closeEventId must be non-empty');
  }
  if (typeof record['reason'] !== 'string' || record['reason'].trim().length === 0) {
    throw new Error('close invalidation metadata reason must be non-empty');
  }
  return Object.freeze({
    closeSchemaVersion: CLOSE_SCHEMA_VERSION,
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    closeEventId: record['closeEventId'],
    reason: record['reason'],
  });
}

export function isCloseKind(kind: string): boolean {
  return kind === 'close_finalized' || kind === 'close_reopened' || kind === 'close_invalidated';
}

/** Hash the exact in-period event set and basis-separated projection. */
export function closeProjectionDigest(
  period: Pick<EconomicPeriod, 'startMs' | 'endMs'>,
  eventIds: readonly string[],
  balances: readonly CloseProjectionBalance[],
): string {
  const body = canonicalJson({
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    eventIds: [...eventIds].sort(),
    balances: [...balances]
      .map((balance) => ({
        role: balance.role,
        currency: balance.currency,
        basis: balance.basis,
        amount: moneyToJson(balance.amount),
        eventIds: [...balance.eventIds].sort(),
      }))
      .sort((a, b) => {
        const left = a.role + '\u0000' + a.currency + '\u0000' + a.basis;
        const right = b.role + '\u0000' + b.currency + '\u0000' + b.basis;
        return left.localeCompare(right);
      }),
  });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
