/** Historical, exact foreign-exchange translation events. */

import { instant, intervalContains, type Instant } from '../epistemic/time.ts';
import { economicEvent, economicEventRole, type EconomicEvent } from './events.ts';
import { applyExactRate, exactRate, rateToJson, selectHistoricalRate, type ExactRate, type HistoricalRateBook } from './rate.ts';
import { ECONOMIC_BASES, moneyFromJson, moneyToJson, type EconomicBasis, type Money } from './money.ts';

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

export interface FxTranslationEventFromRateBookInput {
  readonly id: string;
  readonly source: EconomicEvent;
  readonly targetUnit: string;
  readonly rateBook: HistoricalRateBook;
  readonly effectiveAt: Instant;
  readonly rateAsOf?: Instant;
  readonly rounding?: 'none';
  readonly occurredAt?: Instant;
  readonly recordedAt: Instant;
}

const RATE_BOOK_INPUT_KEYS = new Set(['id', 'source', 'targetUnit', 'rateBook', 'effectiveAt', 'rateAsOf', 'rounding', 'occurredAt', 'recordedAt']);

function assertRateBookInput(value: unknown): asserts value is FxTranslationEventFromRateBookInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FX rate-book translation input must be an object');
  for (const key of Object.keys(value)) if (!RATE_BOOK_INPUT_KEYS.has(key)) throw new Error(`FX rate-book translation input contains unknown field: ${key}`);
}

/**
 * Select and apply a historical rate without allowing later rate knowledge to
 * rewrite an earlier translation. The default knowledge boundary is the
 * translation's own recordedAt; callers may choose an earlier explicit as-of
 * boundary but never one after the translation was recorded.
 */
export function fxTranslationEventFromRateBook(input: FxTranslationEventFromRateBookInput): EconomicEvent {
  assertRateBookInput(input);
  const source = economicEvent(input.source);
  if (source.amount === null) throw new Error('FX rate-book translation source must have a monetary amount');
  const targetUnit = nonEmpty(input.targetUnit, 'FX rate-book translation targetUnit');
  if (typeof input.recordedAt !== 'string') throw new Error('FX rate-book translation recordedAt must be canonical UTC ISO-8601');
  const recordedAt = instant(input.recordedAt);
  const rateAsOf = input.rateAsOf === undefined
    ? recordedAt
    : (typeof input.rateAsOf === 'string' ? instant(input.rateAsOf) : (() => { throw new Error('FX rate-book translation rateAsOf must be canonical UTC ISO-8601'); })());
  if (Date.parse(rateAsOf) > Date.parse(recordedAt)) {
    throw new Error('FX rate-book translation rateAsOf cannot be after recordedAt');
  }
  const selected = selectHistoricalRate(input.rateBook, {
    sourceUnit: source.amount.currency,
    targetUnit,
    effectiveAt: input.effectiveAt,
    asOf: rateAsOf,
  });
  return fxTranslationEvent({
    id: input.id,
    source,
    rate: selected.rate,
    rateSource: selected.rateSource,
    effectiveAt: input.effectiveAt,
    ...(input.rounding === undefined ? {} : { rounding: input.rounding }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    recordedAt,
  });
}

export interface EffectiveFxChargeFromRateBookInput {
  readonly source: EconomicEvent;
  readonly effectiveAmount: Money;
  readonly eventIds: readonly string[];
  readonly sourceBases: readonly EconomicBasis[];
  readonly targetUnit: string;
  readonly rateBook: HistoricalRateBook;
  readonly effectiveAt: Instant;
  readonly rateAsOf?: Instant;
}

export interface EffectiveFxChargeProjection {
  readonly sourceEventId: string;
  readonly sourceAmount: Money;
  readonly effectiveAmount: Money;
  readonly translatedAmount: Money;
  readonly eventIds: readonly string[];
  readonly sourceBases: readonly EconomicBasis[];
  readonly rate: ExactRate;
  readonly rateSource: string;
  readonly effectiveAt: Instant;
  readonly rateAsOf: Instant | null;
}

const EFFECTIVE_FX_INPUT_KEYS = new Set(['source', 'effectiveAmount', 'eventIds', 'sourceBases', 'targetUnit', 'rateBook', 'effectiveAt', 'rateAsOf']);

function assertEffectiveFxInput(value: unknown): asserts value is EffectiveFxChargeFromRateBookInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('effective FX projection input must be an object');
  for (const key of Object.keys(value)) if (!EFFECTIVE_FX_INPUT_KEYS.has(key)) throw new Error(`effective FX projection input contains unknown field: ${key}`);
}

function canonicalEffectiveAmount(value: unknown): Money {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof (value as { coefficient?: unknown }).coefficient !== 'bigint') {
    throw new Error('effective FX projection amount must be exact Money');
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\u0000') !== ['basis', 'coefficient', 'currency', 'scale'].join('\u0000')) {
    throw new Error('effective FX projection amount contains unknown or missing Money fields');
  }
  try {
    return moneyFromJson(moneyToJson(value as Money));
  } catch (error) {
    throw new Error(`effective FX projection amount is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    const id = nonEmpty(item, `${label}[${index}]`);
    if (seen.has(id)) throw new Error(`${label} contains duplicate id: ${id}`);
    seen.add(id);
    return id;
  }));
}

function canonicalBases(value: unknown): readonly EconomicBasis[] {
  const values = canonicalIds(value, 'effective FX projection sourceBases');
  for (const basis of values) {
    if (!ECONOMIC_BASES.includes(basis as EconomicBasis)) throw new Error(`effective FX projection sourceBases contains unsupported basis: ${basis}`);
  }
  return values as readonly EconomicBasis[];
}

/**
 * Project a corrected charge into another currency without manufacturing a
 * fake `fx_translated` event. Raw charge/correction history remains separate;
 * this result is an explicitly effective, replay-bound read model.
 */
export function translateEffectiveChargeFromRateBook(input: EffectiveFxChargeFromRateBookInput): EffectiveFxChargeProjection {
  assertEffectiveFxInput(input);
  const source = economicEvent(input.source);
  if (source.amount === null || economicEventRole(source.kind) !== 'charge') {
    throw new Error('effective FX projection source must be a monetary charge');
  }
  const effectiveAmount = canonicalEffectiveAmount(input.effectiveAmount);
  if (effectiveAmount.currency !== source.amount.currency) throw new Error('effective FX projection must preserve the source currency before translation');
  if (effectiveAmount.basis !== 'effective') throw new Error('effective FX projection amount must use the effective basis');
  if (effectiveAmount.coefficient < 0n) throw new Error('effective FX projection amount must be non-negative');
  const eventIds = canonicalIds(input.eventIds, 'effective FX projection eventIds');
  if (eventIds[0] !== source.id) throw new Error('effective FX projection eventIds must begin with the source event');
  const sourceBases = canonicalBases(input.sourceBases);
  if (!sourceBases.includes(source.amount.basis)) throw new Error('effective FX projection sourceBases must include the raw source basis');
  const targetUnit = nonEmpty(input.targetUnit, 'effective FX projection targetUnit');
  if (targetUnit === source.amount.currency) throw new Error('effective FX projection target currency must differ from the source currency');
  const effectiveAt = instant(input.effectiveAt);
  if (Date.parse(effectiveAt) > Date.parse(source.occurredAt)) throw new Error('effective FX projection effectiveAt cannot be after the source occurrence');
  const rateAsOf = input.rateAsOf === undefined ? null : instant(input.rateAsOf);
  if (rateAsOf !== null && Date.parse(rateAsOf) < Date.parse(source.recordedAt)) {
    throw new Error('effective FX projection rateAsOf cannot precede the source recording');
  }
  const selected = selectHistoricalRate(input.rateBook, {
    sourceUnit: source.amount.currency,
    targetUnit,
    effectiveAt,
    ...(rateAsOf === null ? {} : { asOf: rateAsOf }),
  });
  const translatedAmount = applyExactRate(effectiveAmount, selected.rate, 'effective');
  return Object.freeze({
    sourceEventId: source.id,
    sourceAmount: source.amount,
    effectiveAmount,
    translatedAmount,
    eventIds,
    sourceBases,
    rate: selected.rate,
    rateSource: selected.rateSource,
    effectiveAt,
    rateAsOf,
  });
}
