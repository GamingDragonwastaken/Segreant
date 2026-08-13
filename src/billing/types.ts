/**
 * Provider billing evidence v1.
 *
 * These types deliberately describe provider-declared aggregate charge lines,
 * not individual proxy requests. A matching request id is not part of the
 * provider contract, so importing a record never changes request pricing,
 * budget enforcement, or outcome attribution.
 */

import { createHash } from 'node:crypto';

export const BILLING_SCHEMA_VERSION = 1;
export const BILLING_IMPORTER_VERSION = '1.0.0';

export type BillingCoverage = 'complete' | 'partial' | 'unknown';
export type BillingChargeType = 'usage' | 'credit' | 'discount' | 'tax' | 'adjustment' | 'commitment' | 'other';

export interface BillingEvidenceSource {
  system: 'operator-export';
  provider: 'openai';
  exportId: string;
  /** A non-secret operator label, never an API key or organization name. */
  billingAccountRef: string;
  exportedAt: string;
  periodStart: string;
  periodEnd: string;
  coverage: BillingCoverage;
}

export interface BillingEvidenceRecordInput {
  sourceRecordId: string;
  observedAt: string;
  chargePeriodStart: string;
  chargePeriodEnd: string;
  service: string;
  sku: string;
  model: string | null;
  region: string | null;
  providerProjectRef: string | null;
  chargeType: BillingChargeType;
  currency: 'USD';
  /** Decimal text rather than a JSON number so cents never pass through binary float. */
  amount: string;
  usageUnit: string | null;
  usageQuantity: string | null;
}

export interface BillingImportDocument {
  schemaVersion: typeof BILLING_SCHEMA_VERSION;
  source: BillingEvidenceSource;
  records: BillingEvidenceRecordInput[];
}

/** A parsed record with invariant timestamps and a fixed-point USD amount. */
export interface NormalizedBillingEvidenceRecord {
  sourceRecordId: string;
  sourceRecordSha256: string;
  observedAtMs: number;
  chargePeriodStartMs: number;
  chargePeriodEndMs: number;
  service: string;
  sku: string;
  model: string | null;
  region: string | null;
  providerProjectRef: string | null;
  chargeType: BillingChargeType;
  currency: 'USD';
  amountMicros: number;
  usageUnit: string | null;
  usageQuantity: string | null;
}

export interface NormalizedBillingImport {
  schemaVersion: typeof BILLING_SCHEMA_VERSION;
  source: BillingEvidenceSource;
  exportedAtMs: number;
  periodStartMs: number;
  periodEndMs: number;
  records: NormalizedBillingEvidenceRecord[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly these fields: ${expected.join(', ')}`);
  }
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > max || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty, trimmed string of at most ${max} characters`);
  }
  return value;
}

function nullableText(value: unknown, label: string, max = 256): string | null {
  return value === null ? null : text(value, label, max);
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function utcTimestampMs(value: unknown, label: string): number {
  const raw = text(value, label, 40);
  if (!UTC_TIMESTAMP.test(raw)) throw new Error(`${label} must be an ISO-8601 UTC timestamp ending in Z`);
  const ms = Date.parse(raw);
  if (!Number.isSafeInteger(ms)) throw new Error(`${label} is not a valid timestamp`);
  return ms;
}

/** Parse a decimal USD amount into signed integer microdollars, never a float. */
export function usdMicros(value: unknown, label = 'amount'): number {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`${label} must be a base-10 decimal string with at most six fractional digits`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const micros = BigInt(whole!) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  const signed = negative ? -micros : micros;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (signed > max || signed < -max) throw new Error(`${label} is outside the supported fixed-point range`);
  return Number(signed);
}

export function formatUsdMicros(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / 1_000_000);
  const fraction = String(absolute % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function chargeType(value: unknown): BillingChargeType {
  const allowed: BillingChargeType[] = ['usage', 'credit', 'discount', 'tax', 'adjustment', 'commitment', 'other'];
  if (typeof value !== 'string' || !allowed.includes(value as BillingChargeType)) {
    throw new Error(`chargeType must be one of: ${allowed.join(', ')}`);
  }
  return value as BillingChargeType;
}

function coverage(value: unknown): BillingCoverage {
  const allowed: BillingCoverage[] = ['complete', 'partial', 'unknown'];
  if (typeof value !== 'string' || !allowed.includes(value as BillingCoverage)) {
    throw new Error(`source.coverage must be one of: ${allowed.join(', ')}`);
  }
  return value as BillingCoverage;
}

function recordHash(record: Omit<NormalizedBillingEvidenceRecord, 'sourceRecordSha256'>): string {
  // The object literal fixes key order, making this a portable hash for exactly
  // the normalized allowlisted record rather than the user's raw file layout.
  return createHash('sha256').update(JSON.stringify({
    sourceRecordId: record.sourceRecordId,
    observedAtMs: record.observedAtMs,
    chargePeriodStartMs: record.chargePeriodStartMs,
    chargePeriodEndMs: record.chargePeriodEndMs,
    service: record.service,
    sku: record.sku,
    model: record.model,
    region: record.region,
    providerProjectRef: record.providerProjectRef,
    chargeType: record.chargeType,
    currency: record.currency,
    amountMicros: record.amountMicros,
    usageUnit: record.usageUnit,
    usageQuantity: record.usageQuantity,
  }), 'utf8').digest('hex');
}

function parseRecord(value: unknown, index: number, sourceStartMs: number, sourceEndMs: number): NormalizedBillingEvidenceRecord {
  const label = `records[${index}]`;
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, [
    'sourceRecordId', 'observedAt', 'chargePeriodStart', 'chargePeriodEnd', 'service', 'sku', 'model', 'region',
    'providerProjectRef', 'chargeType', 'currency', 'amount', 'usageUnit', 'usageQuantity',
  ], label);
  if (value.currency !== 'USD') throw new Error(`${label}.currency must be USD in billing evidence v1`);
  const chargePeriodStartMs = utcTimestampMs(value.chargePeriodStart, `${label}.chargePeriodStart`);
  const chargePeriodEndMs = utcTimestampMs(value.chargePeriodEnd, `${label}.chargePeriodEnd`);
  if (chargePeriodStartMs >= chargePeriodEndMs) throw new Error(`${label} charge period must have a positive duration`);
  if (chargePeriodStartMs < sourceStartMs || chargePeriodEndMs > sourceEndMs) {
    throw new Error(`${label} charge period must be within source.periodStart and source.periodEnd`);
  }
  const base = {
    sourceRecordId: text(value.sourceRecordId, `${label}.sourceRecordId`),
    observedAtMs: utcTimestampMs(value.observedAt, `${label}.observedAt`),
    chargePeriodStartMs,
    chargePeriodEndMs,
    service: text(value.service, `${label}.service`),
    sku: text(value.sku, `${label}.sku`),
    model: nullableText(value.model, `${label}.model`),
    region: nullableText(value.region, `${label}.region`),
    providerProjectRef: nullableText(value.providerProjectRef, `${label}.providerProjectRef`),
    chargeType: chargeType(value.chargeType),
    currency: 'USD' as const,
    amountMicros: usdMicros(value.amount, `${label}.amount`),
    usageUnit: nullableText(value.usageUnit, `${label}.usageUnit`),
    usageQuantity: nullableText(value.usageQuantity, `${label}.usageQuantity`),
  };
  return { ...base, sourceRecordSha256: recordHash(base) };
}

/** Strictly validate the operator-supplied normal form; raw provider files are deliberately not guessed at. */
export function parseBillingImportDocument(value: unknown): NormalizedBillingImport {
  if (!isObject(value)) throw new Error('billing evidence must be a JSON object');
  exactKeys(value, ['schemaVersion', 'source', 'records'], 'billing evidence');
  if (value.schemaVersion !== BILLING_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${BILLING_SCHEMA_VERSION}`);
  }
  if (!isObject(value.source)) throw new Error('source must be an object');
  exactKeys(value.source, ['system', 'provider', 'exportId', 'billingAccountRef', 'exportedAt', 'periodStart', 'periodEnd', 'coverage'], 'source');
  if (value.source.system !== 'operator-export') throw new Error('source.system must be operator-export in billing evidence v1');
  if (value.source.provider !== 'openai') throw new Error('source.provider must be openai in billing evidence v1');
  const periodStartMs = utcTimestampMs(value.source.periodStart, 'source.periodStart');
  const periodEndMs = utcTimestampMs(value.source.periodEnd, 'source.periodEnd');
  if (periodStartMs >= periodEndMs) throw new Error('source period must have a positive duration');
  const source: BillingEvidenceSource = {
    system: 'operator-export',
    provider: 'openai',
    exportId: text(value.source.exportId, 'source.exportId'),
    billingAccountRef: text(value.source.billingAccountRef, 'source.billingAccountRef'),
    exportedAt: text(value.source.exportedAt, 'source.exportedAt', 40),
    periodStart: text(value.source.periodStart, 'source.periodStart', 40),
    periodEnd: text(value.source.periodEnd, 'source.periodEnd', 40),
    coverage: coverage(value.source.coverage),
  };
  const exportedAtMs = utcTimestampMs(source.exportedAt, 'source.exportedAt');
  if (!Array.isArray(value.records) || value.records.length === 0) throw new Error('records must be a non-empty array');
  if (value.records.length > 100_000) throw new Error('records exceeds the billing evidence v1 limit (100000)');
  const ids = new Set<string>();
  let totalMicros = 0n;
  const records = value.records.map((record, index) => {
    const parsed = parseRecord(record, index, periodStartMs, periodEndMs);
    if (ids.has(parsed.sourceRecordId)) throw new Error(`duplicate sourceRecordId in document: ${parsed.sourceRecordId}`);
    ids.add(parsed.sourceRecordId);
    totalMicros += BigInt(parsed.amountMicros);
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (totalMicros > max || totalMicros < -max) throw new Error('billing evidence total is outside the supported fixed-point range');
    return parsed;
  });
  return { schemaVersion: BILLING_SCHEMA_VERSION, source, exportedAtMs, periodStartMs, periodEndMs, records };
}
