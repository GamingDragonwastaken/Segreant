/** Constructors for additive, typed economic corrections. */

import { economicEvent, type EconomicEvent } from './events.ts';
import { compareMoney, moneyFromJson, moneyToJson, subtractMoney, type Money } from './money.ts';
import { type Instant } from '../epistemic/time.ts';

const INPUT_KEYS = new Set(['id', 'source', 'previousAmount', 'nextAmount', 'recordedAt', 'occurredAt']);
const MONEY_KEYS = ['basis', 'coefficient', 'currency', 'scale'];

function assertInput(value: unknown): asserts value is PriceCorrectionEventInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('price correction input must be an object');
  for (const key of Object.keys(value)) if (!INPUT_KEYS.has(key)) throw new Error(`price correction input contains unknown field: ${key}`);
}

function canonicalMoney(value: unknown, label: string): Money {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof (value as { coefficient?: unknown }).coefficient !== 'bigint') {
    throw new Error(`${label} must be an exact Money value`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\u0000') !== MONEY_KEYS.join('\u0000')) throw new Error(`${label} contains unknown or missing Money fields`);
  try {
    return moneyFromJson(moneyToJson(value as Money));
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface PriceCorrectionEventInput {
  readonly id: string;
  readonly source: EconomicEvent;
  readonly previousAmount: Money;
  readonly nextAmount: Money;
  readonly recordedAt: Instant;
  readonly occurredAt?: Instant;
}

/**
 * Build an additive price correction for a previously recorded charge.
 *
 * The original charge remains immutable.  The correction is the exact signed
 * delta between the replacement amount and the amount that was previously
 * asserted, while typed metadata preserves both sides of that calculation.
 */
export function priceCorrectionEvent(input: PriceCorrectionEventInput): EconomicEvent {
  assertInput(input);
  const source = economicEvent(input.source);
  const previousAmount = canonicalMoney(input.previousAmount, 'price correction previousAmount');
  const nextAmount = canonicalMoney(input.nextAmount, 'price correction nextAmount');
  if (source.kind !== 'charge_estimated' || (source.amount !== null && source.amount.basis !== 'list' && source.amount.basis !== 'estimated')) {
    throw new Error(`price correction source must be a local charge_estimated event (received ${source.kind})`);
  }
  if (source.amount === null) throw new Error('price correction source must have a monetary amount');
  if (source.amount.coefficient < 0n) throw new Error('price correction source amount must be non-negative');
  if (compareMoney(previousAmount, source.amount) !== 0) {
    throw new Error('price correction previousAmount must equal the source amount');
  }
  if (previousAmount.currency !== nextAmount.currency || previousAmount.basis !== nextAmount.basis) {
    throw new Error('price correction previousAmount and nextAmount must use the same currency and basis');
  }
  if (nextAmount.coefficient < 0n) throw new Error('price correction nextAmount must be non-negative');
  const delta = subtractMoney(nextAmount, previousAmount);
  const correction = economicEvent({
    id: input.id,
    kind: 'price_corrected',
    subject: source.subject,
    occurredAt: input.occurredAt ?? source.occurredAt,
    recordedAt: input.recordedAt,
    amount: delta,
    sourceEventIds: [source.id],
    reversalOf: null,
    metadata: {
      correction: 'reprice',
      previousAmount: { ...moneyToJson(previousAmount) },
      nextAmount: { ...moneyToJson(nextAmount) },
    },
    schemaVersion: 1,
  });
  if (Date.parse(correction.recordedAt) < Date.parse(source.recordedAt)) {
    throw new Error('price correction recordedAt cannot precede its source recordedAt');
  }
  return correction;
}
