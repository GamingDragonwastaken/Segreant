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

function predecessorNextAmount(source: EconomicEvent): Money {
  const metadata = source.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('price correction predecessor metadata must contain typed previousAmount and nextAmount');
  }
  const keys = Object.keys(metadata).sort();
  if (keys.join('\u0000') !== ['correction', 'nextAmount', 'previousAmount'].join('\u0000')) {
    throw new Error('price correction predecessor metadata must contain exactly correction, previousAmount, and nextAmount');
  }
  const record = metadata as { correction?: unknown; previousAmount?: unknown; nextAmount?: unknown };
  if (record.correction !== 'reprice') throw new Error('price correction predecessor metadata correction must be reprice');
  let previousAmount: Money;
  let nextAmount: Money;
  try {
    previousAmount = moneyFromJson(record.previousAmount as Parameters<typeof moneyFromJson>[0]);
    nextAmount = moneyFromJson(record.nextAmount as Parameters<typeof moneyFromJson>[0]);
  } catch (error) {
    throw new Error(`price correction predecessor metadata has invalid typed amounts: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (source.amount === null) throw new Error('price correction predecessor must have a monetary delta');
  if (previousAmount.currency !== source.amount.currency || previousAmount.basis !== source.amount.basis || nextAmount.currency !== source.amount.currency || nextAmount.basis !== source.amount.basis) {
    throw new Error('price correction predecessor metadata must use its delta currency and basis');
  }
  if (nextAmount.coefficient < 0n || compareMoney(subtractMoney(nextAmount, previousAmount), source.amount) !== 0) {
    throw new Error('price correction predecessor metadata does not reproduce its delta');
  }
  return nextAmount;
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
  let predecessorAmount: Money;
  if (source.kind === 'charge_estimated') {
    if (source.amount === null) throw new Error('price correction source must have a monetary amount');
    if (source.amount.basis !== 'list' && source.amount.basis !== 'estimated') {
      throw new Error(`price correction source must be a local charge_estimated event (received ${source.kind})`);
    }
    predecessorAmount = source.amount;
  } else if (source.kind === 'price_corrected') {
    predecessorAmount = predecessorNextAmount(source);
  } else {
    throw new Error(`price correction source must be a local charge_estimated or prior price_corrected event (received ${source.kind})`);
  }
  if (predecessorAmount.coefficient < 0n) throw new Error('price correction predecessor amount must be non-negative');
  if (compareMoney(previousAmount, predecessorAmount) !== 0) {
    throw new Error('price correction previousAmount must equal the predecessor next amount');
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
