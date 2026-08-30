/** Exact economic-event adapter for one locally metered request. */

import { instant, type Instant } from '../epistemic/time.ts';
import { economicEvent, type EconomicEvent, type EconomicEventKind } from './events.ts';
import { moneyFromJson, moneyToJson, type Money } from './money.ts';

export interface RequestEconomicEventInput {
  readonly requestId: string;
  readonly sessionId?: string | null;
  readonly tsEpochMs: number;
  readonly provider: string;
  readonly model: string;
  readonly project: string;
  readonly amount: Money;
  readonly via?: 'proxy' | 'import';
  readonly recordedAt?: Instant;
}

const REQUEST_KEYS = new Set(['requestId', 'sessionId', 'tsEpochMs', 'provider', 'model', 'project', 'amount', 'via', 'recordedAt']);

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`${label} contains unsafe field: ${key}`);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requestTime(epochMs: unknown): Instant {
  if (typeof epochMs !== 'number' || !Number.isSafeInteger(epochMs)) throw new Error('request economic tsEpochMs must be a safe integer');
  const value = new Date(epochMs);
  if (!Number.isFinite(value.getTime())) throw new Error('request economic tsEpochMs is outside the supported date range');
  return instant(value.toISOString());
}

function requestKind(basis: Money['basis']): EconomicEventKind {
  switch (basis) {
    case 'list':
    case 'estimated':
      return 'charge_estimated';
    case 'provider_observed':
      return 'provider_charge_observed';
    case 'billed':
      return 'bill_observed';
    default:
      throw new Error(`unsupported request economic basis: ${basis}`);
  }
}

/** Stable event identity for the one exact charge associated with a request. */
export function requestEconomicEventId(requestId: string): string {
  return `economic:request:${nonEmpty(requestId, 'requestId')}:charge`;
}

/**
 * Build a canonical charge event. The caller may provide a recorded-at value
 * for deterministic replay tests; production Store writes use the actual
 * insertion instant. Usage quantities remain in metadata/legacy request rows;
 * this first bridge emits exactly one monetary charge event, avoiding usage +
 * charge double counting until typed quantity events are introduced.
 */
export function requestEconomicEvent(input: RequestEconomicEventInput): EconomicEvent {
  assertObject(input, 'request economic event input');
  for (const key of Object.keys(input)) if (!REQUEST_KEYS.has(key)) throw new Error(`request economic event input contains unknown field: ${key}`);
  const requestId = nonEmpty(input.requestId, 'requestId');
  const sessionId = input.sessionId === undefined || input.sessionId === null ? null : nonEmpty(input.sessionId, 'sessionId');
  const provider = nonEmpty(input.provider, 'provider');
  const model = nonEmpty(input.model, 'model');
  const project = nonEmpty(input.project, 'project');
  if (input.via !== undefined && input.via !== 'proxy' && input.via !== 'import') throw new Error('request economic via must be proxy or import');
  if (input.amount === null || typeof input.amount !== 'object' || Array.isArray(input.amount)) throw new Error('request economic amount must be exact Money');
  const amount = moneyFromJson(moneyToJson(input.amount));
  if (amount.currency !== 'USD') throw new Error('request economic amount currency must be USD');
  const kind = requestKind(amount.basis);
  const occurredAt = requestTime(input.tsEpochMs);
  const recordedAt = input.recordedAt === undefined ? instant(new Date().toISOString()) : instant(input.recordedAt);
  return economicEvent({
    id: requestEconomicEventId(requestId),
    kind,
    subject: `request:${requestId}`,
    occurredAt,
    recordedAt,
    amount,
    sourceEventIds: [],
    reversalOf: null,
    metadata: {
      requestId,
      provider,
      model,
      project,
      ...(sessionId === null ? {} : { sessionId }),
      ...(input.via === undefined ? {} : { via: input.via }),
    },
    schemaVersion: 1,
  });
}
