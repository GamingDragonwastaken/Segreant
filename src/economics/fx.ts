/** Historical, exact foreign-exchange translation events. */

import { instant, intervalContains, type Instant } from '../epistemic/time.ts';
import { economicEvent, type EconomicEvent } from './events.ts';
import { applyExactRate, exactRate, rateToJson, type ExactRate } from './rate.ts';
import { moneyToJson } from './money.ts';

const INPUT_KEYS = new Set(['id', 'source', 'rate', 'rateSource', 'effectiveAt', 'rounding', 'occurredAt', 'recordedAt']);
const RATE_KEYS = ['denominator', 'numerator', 'sourceUnit', 'targetUnit'];

function assertInput(value: unknown): asserts value is FxTranslationEventInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FX translation input must be an object');
  for (const key of Object.keys(value)) if (!INPUT_KEYS.has(key)) throw new Error(`FX translation input contains unknown field: ${key}`);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function canonicalRate(value: unknown): ExactRate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FX translation rate must be an exact rational rate');
  const record = value as { numerator?: unknown; denominator?: unknown; sourceUnit?: unknown; targetUnit?: unknown; validTime?: unknown };
  const keys = Object.keys(value).sort();
  const expectedKeys = record.validTime === undefined ? RATE_KEYS : [...RATE_KEYS, 'validTime'].sort();
  if (keys.join('\u0000') !== expectedKeys.join('\u0000')) throw new Error('FX translation rate contains unknown or missing fields');
  if (typeof record.numerator !== 'bigint' || typeof record.denominator !== 'bigint') throw new Error('FX translation rate numerator and denominator must be bigint values');
  const sourceUnit = nonEmpty(record.sourceUnit, 'FX translation rate sourceUnit');
  const targetUnit = nonEmpty(record.targetUnit, 'FX translation rate targetUnit');
  const rate = exactRate({
    numerator: record.numerator,
    denominator: record.denominator,
    sourceUnit,
    targetUnit,
    ...(record.validTime === undefined ? {} : { validTime: record.validTime as NonNullable<ExactRate['validTime']> }),
  });
  if (rate.numerator <= 0n || rate.denominator <= 0n) throw new Error('FX translation rate must be positive');
  return rate;
}

export interface FxTranslationEventInput {
  readonly id: string;
  readonly source: EconomicEvent;
  readonly rate: ExactRate;
  readonly rateSource: string;
  readonly effectiveAt: Instant;
  readonly rounding?: 'none';
  readonly occurredAt?: Instant;
  readonly recordedAt: Instant;
}

/**
 * Build a historical FX derivative without consulting a current-rate source.
 * The result remains a separate translation event; the source is never
 * rewritten and the source basis is retained on the translated amount.
 */
export function fxTranslationEvent(input: FxTranslationEventInput): EconomicEvent {
  assertInput(input);
  const source = economicEvent(input.source);
  if (source.amount === null) throw new Error('FX translation source must have a monetary amount');
  const rate = canonicalRate(input.rate);
  if (rate.sourceUnit !== source.amount.currency) {
    throw new Error(`FX translation rate source unit ${rate.sourceUnit} does not match ${source.amount.currency}`);
  }
  if (rate.targetUnit === source.amount.currency) throw new Error('FX translation target currency must differ from the source currency');
  const rateSource = nonEmpty(input.rateSource, 'FX translation rateSource');
  const effectiveAt = instant(input.effectiveAt);
  if (rate.validTime !== undefined && !intervalContains(rate.validTime, effectiveAt)) {
    throw new Error('FX translation effectiveAt must fall within the rate validTime interval');
  }
  if (input.rounding !== undefined && input.rounding !== 'none') throw new Error('FX translation rounding must be none until an explicit quantization policy exists');
  if (Date.parse(effectiveAt) > Date.parse(source.occurredAt)) {
    throw new Error('FX translation effectiveAt cannot be after the source occurrence');
  }
  const amount = applyExactRate(source.amount, rate, source.amount.basis);
  const rateJson = rateToJson(rate);
  const translated = economicEvent({
    id: input.id,
    kind: 'fx_translated',
    subject: source.subject,
    occurredAt: input.occurredAt ?? source.occurredAt,
    recordedAt: input.recordedAt,
    amount,
    sourceEventIds: [source.id],
    reversalOf: null,
    metadata: {
      sourceAmount: { ...moneyToJson(source.amount) },
      rate: {
        numerator: rateJson.numerator,
        denominator: rateJson.denominator,
        sourceUnit: rateJson.sourceUnit,
        targetUnit: rateJson.targetUnit,
        ...(rateJson.validTime === undefined ? {} : { validTime: { ...rateJson.validTime } }),
      },
      rateSource,
      effectiveAt,
      convention: 'source-to-target',
      rounding: 'none',
    },
    schemaVersion: 1,
  });
  if (translated.occurredAt !== source.occurredAt) throw new Error('FX translation occurredAt must match its source occurrence');
  if (Date.parse(translated.recordedAt) < Date.parse(source.recordedAt)) {
    throw new Error('FX translation recordedAt cannot precede its source recordedAt');
  }
  return translated;
}
