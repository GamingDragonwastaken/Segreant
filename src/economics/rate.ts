/** Exact rational rates with explicit source/target units and optional validity. */

import { formatMoneyAmount, money, type EconomicBasis, type Money } from './money.ts';
import { instant, interval, intervalContains, type Instant, type TimeInterval } from '../epistemic/time.ts';

export interface ExactRateInput {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly sourceUnit: string;
  readonly targetUnit: string;
  readonly validTime?: TimeInterval;
}

export interface ExactRate extends ExactRateInput {
  readonly denominator: bigint;
}

export interface ExactRateJson {
  readonly numerator: string;
  readonly denominator: string;
  readonly sourceUnit: string;
  readonly targetUnit: string;
  readonly validTime?: TimeInterval;
}

/** One immutable, bitemporal rate observation used for historical selection. */
export interface HistoricalRateObservationInput {
  readonly id: string;
  readonly rate: ExactRate;
  readonly rateSource: string;
  readonly recordedAt: Instant;
  /** Explicitly identifies the observation this record replaces. */
  readonly supersedes?: string | null;
}

export interface HistoricalRateObservation {
  readonly id: string;
  readonly rate: ExactRate;
  readonly rateSource: string;
  readonly recordedAt: Instant;
  readonly supersedes: string | null;
}

export interface HistoricalRateBook {
  readonly observations: readonly HistoricalRateObservation[];
}

export interface HistoricalRateObservationJson {
  readonly id: string;
  readonly rate: ExactRateJson;
  readonly rateSource: string;
  readonly recordedAt: Instant;
  readonly supersedes: string | null;
}

export interface HistoricalRateBookJson {
  readonly observations: readonly HistoricalRateObservationJson[];
}

export interface HistoricalRateSelectionInput {
  readonly sourceUnit: string;
  readonly targetUnit: string;
  readonly effectiveAt: Instant;
  /** Only observations recorded at or before this boundary are visible. */
  readonly asOf?: Instant;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function canonicalValidTime(value: unknown): TimeInterval {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('rate validTime must be a half-open interval');
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\u0000') !== ['from', 'to'].join('\u0000')) {
    throw new Error('rate validTime contains unknown or missing fields');
  }
  const record = value as { from?: unknown; to?: unknown };
  if (typeof record.from !== 'string' || typeof record.to !== 'string') {
    throw new Error('rate validTime bounds must be canonical timestamps');
  }
  try {
    return interval(record.from, record.to);
  } catch (error) {
    throw new Error(`rate validTime is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const RATE_KEYS_WITHOUT_VALID_TIME = ['denominator', 'numerator', 'sourceUnit', 'targetUnit'];
const RATE_KEYS_WITH_VALID_TIME = [...RATE_KEYS_WITHOUT_VALID_TIME, 'validTime'].sort();

function canonicalHistoricalObservation(value: HistoricalRateObservationInput): HistoricalRateObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('historical rate observation must be an object');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ['id', 'rate', 'rateSource', 'recordedAt', 'supersedes'].sort();
  const expectedKeysWithoutOptionalSupersedes = expectedKeys.filter((key) => key !== 'supersedes');
  if (keys.join('\u0000') !== expectedKeys.join('\u0000') && keys.join('\u0000') !== expectedKeysWithoutOptionalSupersedes.join('\u0000')) {
    throw new Error('historical rate observation contains unknown or missing fields');
  }
  const id = nonEmpty(value.id, 'historical rate observation id');
  const rateValue = value.rate;
  if (rateValue === null || typeof rateValue !== 'object' || Array.isArray(rateValue)) {
    throw new Error(`historical rate observation ${id} rate must be an exact rational rate`);
  }
  const rateKeys = Object.keys(rateValue).sort();
  if (rateKeys.join('\u0000') !== RATE_KEYS_WITH_VALID_TIME.join('\u0000')) {
    throw new Error(`historical rate observation ${id} rate must carry exactly one validity interval`);
  }
  const rawRate = rateValue as ExactRate;
  const rate = exactRate({
    numerator: rawRate.numerator,
    denominator: rawRate.denominator,
    sourceUnit: rawRate.sourceUnit,
    targetUnit: rawRate.targetUnit,
    validTime: rawRate.validTime as TimeInterval,
  });
  if (rate.validTime === undefined) {
    throw new Error(`historical rate observation ${id} requires a validity interval`);
  }
  if (rate.numerator <= 0n) {
    throw new Error(`historical FX rate observation ${id} must be positive`);
  }
  const rateSource = nonEmpty(value.rateSource, `historical rate observation ${id} rateSource`);
  if (typeof value.recordedAt !== 'string') throw new Error(`historical rate observation ${id} recordedAt must be canonical UTC ISO-8601`);
  const recordedAt = instant(value.recordedAt);
  const supersedes = value.supersedes === undefined || value.supersedes === null
    ? null
    : nonEmpty(value.supersedes, `historical rate observation ${id} supersedes`);
  if (supersedes === id) throw new Error(`historical rate observation ${id} cannot supersede itself`);
  return Object.freeze({ id, rate, rateSource, recordedAt, supersedes });
}

/** Canonicalize one persisted historical observation without resolving its edge. */
export function historicalRateObservation(value: HistoricalRateObservationInput): HistoricalRateObservation {
  return canonicalHistoricalObservation(value);
}

function sameValidity(a: TimeInterval, b: TimeInterval): boolean {
  return a.from === b.from && a.to === b.to;
}

/**
 * Canonicalize a finite historical rate set. Supersession is an explicit typed
 * edge, not inferred from insertion order or from which record was observed
 * later. Overlapping independent observations remain visible to the selector,
 * which will refuse to choose between them.
 */
export function historicalRateBook(observations: readonly HistoricalRateObservationInput[]): HistoricalRateBook {
  if (!Array.isArray(observations)) throw new Error('historical rate observations must be an array');
  const canonical = observations.map(historicalRateObservation);
  const byId = new Map<string, HistoricalRateObservation>();
  for (const observation of canonical) {
    if (byId.has(observation.id)) throw new Error(`duplicate historical rate observation: ${observation.id}`);
    byId.set(observation.id, observation);
  }
  const successorByTarget = new Map<string, string>();
  for (const observation of canonical) {
    if (observation.supersedes === null) continue;
    const predecessor = byId.get(observation.supersedes);
    if (predecessor === undefined) {
      throw new Error(`historical rate observation ${observation.id} supersedes an unknown observation ${observation.supersedes}`);
    }
    if (observation.rate.sourceUnit !== predecessor.rate.sourceUnit || observation.rate.targetUnit !== predecessor.rate.targetUnit) {
      throw new Error(`historical rate observation ${observation.id} supersession changes source/target units`);
    }
    if (observation.rate.validTime === undefined || predecessor.rate.validTime === undefined || !sameValidity(observation.rate.validTime, predecessor.rate.validTime)) {
      throw new Error(`historical rate observation ${observation.id} supersession must retain the predecessor validity interval`);
    }
    if (Date.parse(observation.recordedAt) <= Date.parse(predecessor.recordedAt)) {
      throw new Error(`historical rate observation ${observation.id} must be recorded after its superseded observation`);
    }
    const existingSuccessor = successorByTarget.get(predecessor.id);
    if (existingSuccessor !== undefined) {
      throw new Error(`historical rate observation ${predecessor.id} has multiple superseding observations: ${existingSuccessor}, ${observation.id}`);
    }
    successorByTarget.set(predecessor.id, observation.id);
  }
  const sorted = [...canonical].sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({ observations: Object.freeze(sorted) });
}

const HISTORICAL_RATE_JSON_KEYS = ['id', 'rate', 'rateSource', 'recordedAt', 'supersedes'].sort();

function canonicalHistoricalRateJson(value: unknown): HistoricalRateObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('historical rate observation JSON must be an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\u0000') !== HISTORICAL_RATE_JSON_KEYS.join('\u0000')) {
    throw new Error('historical rate observation JSON contains unknown or missing fields');
  }
  const record = value as Record<string, unknown>;
  if (record.rate === null || typeof record.rate !== 'object' || Array.isArray(record.rate)) {
    throw new Error('historical rate observation JSON rate must be an object');
  }
  const rateKeys = Object.keys(record.rate).sort();
  if (rateKeys.join('\u0000') !== RATE_KEYS_WITH_VALID_TIME.join('\u0000')) {
    throw new Error('historical rate observation JSON rate must carry exactly one validity interval');
  }
  let rate: ExactRate;
  try {
    rate = rateFromJson(record.rate as ExactRateJson);
  } catch (error) {
    throw new Error(`historical rate observation JSON rate is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return canonicalHistoricalObservation({
    id: record.id as string,
    rate,
    rateSource: record.rateSource as string,
    recordedAt: record.recordedAt as Instant,
    supersedes: record.supersedes as string | null,
  });
}

export function historicalRateObservationToJson(value: HistoricalRateObservation): HistoricalRateObservationJson {
  const item = canonicalHistoricalObservation(value);
  if (item.rate.validTime === undefined) throw new Error(`historical rate observation ${item.id} requires a validity interval`);
  return Object.freeze({
    id: item.id,
    rate: rateToJson(item.rate),
    rateSource: item.rateSource,
    recordedAt: item.recordedAt,
    supersedes: item.supersedes,
  });
}

export function historicalRateObservationFromJson(value: unknown): HistoricalRateObservation {
  return canonicalHistoricalRateJson(value);
}

export function historicalRateBookToJson(value: HistoricalRateBook): HistoricalRateBookJson {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('historical rate book must be an object');
  const keys = Object.keys(value).sort();
  if (keys.join('\u0000') !== 'observations') throw new Error('historical rate book contains unknown or missing fields');
  const canonical = historicalRateBook(value.observations);
  return Object.freeze({ observations: Object.freeze(canonical.observations.map(historicalRateObservationToJson)) });
}

export function historicalRateBookFromJson(value: unknown): HistoricalRateBook {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('historical rate book JSON must be an object');
  const keys = Object.keys(value).sort();
  if (keys.join('\u0000') !== 'observations') throw new Error('historical rate book JSON contains unknown or missing fields');
  const observations = (value as { observations?: unknown }).observations;
  if (!Array.isArray(observations)) throw new Error('historical rate book JSON observations must be an array');
  return historicalRateBook(observations.map(canonicalHistoricalRateJson));
}

/**
 * Select the one rate justified by modeled validity and an optional recording
 * boundary. A visible explicit supersession chain has one tip; independent
 * overlapping observations are ambiguous and fail closed.
 */
export function selectHistoricalRate(book: HistoricalRateBook, input: HistoricalRateSelectionInput): HistoricalRateObservation {
  if (book === null || typeof book !== 'object' || Array.isArray(book)) throw new Error('historical rate book must be canonical');
  if (Object.keys(book).join('\u0000') !== 'observations') throw new Error('historical rate book contains unknown or missing fields');
  if (!Array.isArray(book.observations)) throw new Error('historical rate book observations must be an array');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('historical rate selection input must be an object');
  const inputKeys = Object.keys(input).sort();
  const expectedInputKeys = ['asOf', 'effectiveAt', 'sourceUnit', 'targetUnit'].sort();
  const expectedInputKeysWithoutOptionalAsOf = expectedInputKeys.filter((key) => key !== 'asOf');
  if (inputKeys.join('\u0000') !== expectedInputKeys.join('\u0000') && inputKeys.join('\u0000') !== expectedInputKeysWithoutOptionalAsOf.join('\u0000')) {
    throw new Error('historical rate selection input contains unknown or missing fields');
  }
  const sourceUnit = nonEmpty(input.sourceUnit, 'historical rate selection sourceUnit');
  const targetUnit = nonEmpty(input.targetUnit, 'historical rate selection targetUnit');
  if (typeof input.effectiveAt !== 'string') throw new Error('historical rate selection effectiveAt must be canonical UTC ISO-8601');
  const effectiveAt = instant(input.effectiveAt);
  const asOf = input.asOf === undefined ? null : (typeof input.asOf === 'string' ? instant(input.asOf) : (() => { throw new Error('historical rate selection asOf must be canonical UTC ISO-8601'); })());
  const canonicalBook = historicalRateBook(book.observations);
  const visible = canonicalBook.observations.filter((observation) => {
    if (observation.rate.sourceUnit !== sourceUnit || observation.rate.targetUnit !== targetUnit) return false;
    if (observation.rate.validTime === undefined || !intervalContains(observation.rate.validTime, effectiveAt)) return false;
    return asOf === null || Date.parse(observation.recordedAt) <= Date.parse(asOf);
  });
  if (visible.length === 0) {
    throw new Error(`no historical FX rate covers ${sourceUnit}->${targetUnit} at ${effectiveAt} as of ${asOf ?? 'latest'}`);
  }
  const visibleIds = new Set(visible.map((observation) => observation.id));
  const tips = visible.filter((observation) => !visible.some((candidate) => candidate.supersedes === observation.id && visibleIds.has(candidate.id)));
  if (tips.length !== 1) {
    throw new Error(`historical FX rate selection is ambiguous for ${sourceUnit}->${targetUnit} at ${effectiveAt}`);
  }
  return tips[0]!;
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }
function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function exactRate(input: ExactRateInput): ExactRate {
  if (input.denominator === 0n) throw new Error('rate denominator must be non-zero');
  const sourceUnit = nonEmpty(input.sourceUnit, 'rate source unit');
  const targetUnit = nonEmpty(input.targetUnit, 'rate target unit');
  const sign = input.denominator < 0n ? -1n : 1n;
  let numerator = input.numerator * sign;
  let denominator = input.denominator * sign;
  const common = gcd(numerator, denominator);
  if (common !== 0n) {
    numerator /= common;
    denominator /= common;
  }
  const validTime = input.validTime === undefined ? undefined : canonicalValidTime(input.validTime);
  return Object.freeze({ numerator, denominator, sourceUnit, targetUnit, ...(validTime === undefined ? {} : { validTime }) });
}

function terminatingDecimal(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) throw new Error('internal denominator must be positive');
  if (numerator === 0n) return '0';
  const negative = numerator < 0n;
  let n = abs(numerator);
  let d = denominator;
  const common = gcd(n, d);
  n /= common;
  d /= common;

  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) { d /= 2n; twos += 1; }
  while (d % 5n === 0n) { d /= 5n; fives += 1; }
  if (d !== 1n) return null;

  const scale = Math.max(twos, fives);
  const scaled = n * (2n ** BigInt(scale - twos)) * (5n ** BigInt(scale - fives));
  const digits = scaled.toString().padStart(scale + 1, '0');
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const split = digits.length - scale;
  return `${negative ? '-' : ''}${digits.slice(0, split)}.${digits.slice(split)}`;
}

/**
 * Exact conversion only. If the rational result has a non-terminating decimal
 * representation, Fiscus refuses to invent a rounding mode or precision. A later
 * quantization API must make that policy explicit.
 */
export function applyExactRate(value: Money, rate: ExactRate, targetBasis: EconomicBasis): Money {
  if (value.currency !== rate.sourceUnit) {
    throw new Error(`rate source unit mismatch: ${rate.sourceUnit} cannot convert ${value.currency}`);
  }
  const sourceScale = 10n ** BigInt(value.scale);
  const numerator = value.coefficient * rate.numerator;
  const denominator = sourceScale * rate.denominator;
  const decimal = terminatingDecimal(numerator, denominator);
  if (decimal === null) throw new Error('non-terminating conversion requires an explicit quantization policy');
  return money(decimal, rate.targetUnit, targetBasis);
}

export function rateToJson(rate: ExactRate): ExactRateJson {
  return Object.freeze({
    numerator: rate.numerator.toString(),
    denominator: rate.denominator.toString(),
    sourceUnit: rate.sourceUnit,
    targetUnit: rate.targetUnit,
    ...(rate.validTime ? { validTime: rate.validTime } : {}),
  });
}

export function rateFromJson(value: ExactRateJson): ExactRate {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value.numerator)) throw new Error('rate numerator must be a canonical integer string');
  if (!/^-?(?:0|[1-9]\d*)$/.test(value.denominator)) throw new Error('rate denominator must be a canonical integer string');
  return exactRate({
    numerator: BigInt(value.numerator),
    denominator: BigInt(value.denominator),
    sourceUnit: value.sourceUnit,
    targetUnit: value.targetUnit,
    ...(value.validTime === undefined ? {} : { validTime: value.validTime }),
  });
}

// Type-level import is intentionally exercised so refactors cannot silently
// change Money formatting assumptions used by rate tests.
void formatMoneyAmount;
