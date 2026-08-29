/**
 * Billing-to-kernel issuance adapter.
 *
 * The legacy billing tables remain a compatibility/read model with integer
 * microdollars. This adapter is the first product vertical that crosses into
 * the Trusted Epistemic Kernel: every provider line becomes immutable Evidence
 * and a typed billed Claim, while aggregate and reconciliation values retain
 * exact Money objects and explicit evidence limitations.
 */

import { claim, type Claim } from '../epistemic/claim.ts';
import { evidence, type Evidence } from '../epistemic/evidence.ts';
import { claimProfile } from '../epistemic/profile.ts';
import { grain } from '../epistemic/grain.ts';
import { scope } from '../epistemic/scope.ts';
import { instant, interval, type Instant } from '../epistemic/time.ts';
import { addMoney, money, moneyToJson, type EconomicBasis, type Money } from '../economics/money.ts';
import type { ReconciliationRun } from './reconcile.ts';
import type { BillingEvidenceRecord, BillingImportRun } from '../store/billing.ts';

export interface BillingKernelIssuanceInput {
  readonly run: BillingImportRun;
  readonly records: readonly BillingEvidenceRecord[];
}

export interface BillingKernelIssuance {
  readonly recordEvidence: readonly Evidence[];
  readonly recordClaims: readonly Claim[];
  readonly aggregateClaim: Claim;
  readonly total: Money;
}

export type KernelAppendResult = 'inserted' | 'duplicate';

export interface BillingKernelPersistenceResult {
  readonly importId: string;
  readonly total: Money;
  readonly recordEvidence: Readonly<{ inserted: number; duplicate: number }>;
  readonly recordClaims: Readonly<{ inserted: number; duplicate: number }>;
  readonly aggregateClaim: Readonly<{ id: string; result: KernelAppendResult }>;
}

export interface BillingReconciliationClaimInput {
  readonly id: string;
  readonly run: ReconciliationRun;
  /** IDs of the provider and local-capture Evidence records supporting the comparison. */
  readonly evidenceIds: readonly string[];
  readonly issuedAt: Instant;
}

const BILLING_COVERAGE = new Set(['unknown', 'partial', 'complete']);

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function canonicalInstantMs(value: unknown, label: string): Instant {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer epoch-milliseconds timestamp`);
  let result: string;
  try {
    result = new Date(value).toISOString();
  } catch {
    throw new Error(`${label} is outside the supported timestamp range`);
  }
  if (Date.parse(result) !== value) throw new Error(`${label} is outside the supported timestamp range`);
  return result;
}

function canonicalInstantString(value: unknown, label: string): Instant {
  if (typeof value !== 'string') throw new Error(`${label} must be canonical UTC ISO-8601`);
  try {
    return instant(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalMoneyFromMicros(value: unknown, basis: EconomicBasis, label: string): Money {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer microdollar amount`);
  const micros = BigInt(value);
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0');
  return money(`${negative ? '-' : ''}${whole}.${fraction}`, 'USD', basis);
}

function coverage(value: unknown): 'unknown' | 'partial' | 'complete' {
  if (typeof value !== 'string' || !BILLING_COVERAGE.has(value)) throw new Error(`unsupported billing coverage: ${String(value)}`);
  return value as 'unknown' | 'partial' | 'complete';
}

function intervalFor(startMs: number, endMs: number, label: string) {
  const from = canonicalInstantMs(startMs, `${label} start`);
  const to = canonicalInstantMs(endMs, `${label} end`);
  if (Date.parse(from) >= Date.parse(to)) throw new Error(`${label} must have a positive duration`);
  return interval(from, to);
}

function billingScope(run: BillingImportRun, record?: BillingEvidenceRecord) {
  return scope({
    provider: run.provider,
    billingAccountRef: run.billingAccountRef,
    sourceExportId: run.sourceExportId,
    ...(record?.providerProjectRef === null || record?.providerProjectRef === undefined ? {} : { providerProjectRef: record.providerProjectRef }),
    ...(record?.sourceRecordId === undefined ? {} : { sourceRecordId: record.sourceRecordId }),
  });
}

function profile(run: BillingImportRun) {
  return claimProfile({
    epistemic: 'supported',
    integrity: 'verified',
    authenticity: 'self_asserted',
    scope: 'conditional',
    coverage: coverage(run.coverage),
    measurement: 'proxy_unvalidated',
    causality: 'none',
    monetaryBasis: 'billed',
    finality: 'provisional',
    decisionFitness: 'not_assessed',
  });
}

function validateRun(run: BillingImportRun): void {
  if (run.sourceSystem !== 'operator-export' || run.provider !== 'openai') throw new Error('billing kernel adapter supports only OpenAI operator exports');
  if (run.schemaVersion !== 1) throw new Error('billing kernel adapter supports only billing schema version 1');
  if (run.trust !== 'operator_supplied_unverified' || run.rawRetention !== 'digest_only') throw new Error('billing import trust/retention boundary is unsupported');
  nonEmpty(run.importId, 'billing import id');
  nonEmpty(run.sourceExportId, 'billing source export id');
  nonEmpty(run.billingAccountRef, 'billing account reference');
  coverage(run.coverage);
  canonicalInstantMs(run.importedAtMs, 'billing import importedAtMs');
  canonicalInstantMs(run.exportedAtMs, 'billing import exportedAtMs');
  intervalFor(run.periodStartMs, run.periodEndMs, 'billing import period');
}

function validateRecord(run: BillingImportRun, record: BillingEvidenceRecord): void {
  if (record.sourceSystem !== run.sourceSystem || record.provider !== run.provider || record.billingAccountRef !== run.billingAccountRef || record.sourceExportId !== run.sourceExportId) {
    throw new Error(`billing record ${record.recordId} does not belong to import ${run.importId}`);
  }
  if (record.firstImportId !== run.importId || record.currency !== 'USD' || record.costBasis !== 'provider_reported' || record.trust !== 'operator_supplied_unverified') {
    throw new Error(`billing record ${record.recordId} has an unsupported trust or currency boundary`);
  }
  nonEmpty(record.recordId, 'billing record id');
  nonEmpty(record.sourceRecordId, 'billing source record id');
  if (!/^[a-f0-9]{64}$/.test(record.sourceRecordSha256)) throw new Error(`billing record ${record.recordId} has an invalid source digest`);
  canonicalMoneyFromMicros(record.amountMicros, 'billed', `billing record ${record.recordId} amount`);
  canonicalInstantMs(record.observedAtMs, `billing record ${record.recordId} observedAtMs`);
  intervalFor(record.chargePeriodStartMs, record.chargePeriodEndMs, `billing record ${record.recordId} charge period`);
  if (record.chargePeriodStartMs < run.periodStartMs || record.chargePeriodEndMs > run.periodEndMs) {
    throw new Error(`billing record ${record.recordId} charge period falls outside import ${run.importId}`);
  }
}

function buildRecordEvidence(run: BillingImportRun, record: BillingEvidenceRecord): Evidence {
  const amount = canonicalMoneyFromMicros(record.amountMicros, 'billed', `billing record ${record.recordId} amount`);
  const validTime = intervalFor(record.chargePeriodStartMs, record.chargePeriodEndMs, `billing record ${record.recordId} charge period`);
  const recordScope = billingScope(run, record);
  return evidence({
    id: `evidence:billing:${run.importId}:${record.sourceRecordId}`,
    evidenceType: 'billing.provider_charge',
    sourceIdentity: `operator-export:${run.sourceExportId}`,
    sourceClass: 'operator_supplied_provider_export',
    payload: {
      amount: { ...moneyToJson(amount) },
      chargeType: record.chargeType,
      sourceRecordId: record.sourceRecordId,
      sourceRecordSha256: record.sourceRecordSha256,
    },
    scope: recordScope,
    grain: grain(['billing_record']),
    occurredAt: validTime.from,
    validTime,
    observedAt: canonicalInstantMs(record.observedAtMs, `billing record ${record.recordId} observedAtMs`),
    recordedAt: canonicalInstantMs(run.importedAtMs, 'billing import importedAtMs'),
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: {
      status: coverage(run.coverage),
      method: 'operator_export',
      coveredEventTypes: ['billing.provider_charge'],
      coveredScope: billingScope(run),
      coveredTime: intervalFor(run.periodStartMs, run.periodEndMs, 'billing import period'),
    },
    measurementModelRef: null,
    monetaryBasis: 'billed',
    assumptions: ['Provider export was supplied by the operator and was not independently authenticated by Fiscus.'],
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'confidential',
    redaction: 'none',
  });
}

function recordClaim(run: BillingImportRun, record: BillingEvidenceRecord, item: Evidence): Claim {
  const amount = canonicalMoneyFromMicros(record.amountMicros, 'billed', `billing record ${record.recordId} amount`);
  const validTime = intervalFor(record.chargePeriodStartMs, record.chargePeriodEndMs, `billing record ${record.recordId} charge period`);
  return claim({
    id: `claim:billing:billed:${run.importId}:${record.sourceRecordId}`,
    proposition: {
      predicate: 'billing.billed_amount',
      value: { amount: { ...moneyToJson(amount) }, chargeType: record.chargeType, sourceRecordId: record.sourceRecordId },
    },
    subject: `billing-record:${record.sourceRecordId}`,
    scope: billingScope(run, record),
    grain: grain(['billing_record']),
    time: { validTime, asOf: canonicalInstantMs(run.importedAtMs, 'billing import importedAtMs') },
    epistemic: 'supported',
    profile: profile(run),
    measurementModelRef: null,
    evidenceIds: [item.id],
    derivationRule: 'billing.operator_export.record.v1',
    derivationVersion: 1,
    assumptions: ['Provider export authenticity remains operator-supplied and unverified.'],
    uncertainty: { kind: 'qualitative', description: 'Provider line is retained exactly; authenticity and provider scope remain conditional.' },
    causalStatus: 'none',
    monetaryBasis: 'billed',
    finality: 'provisional',
    issuedAt: canonicalInstantMs(run.importedAtMs, 'billing import importedAtMs'),
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
}

/** Issue deterministic kernel Evidence/Claims for one validated billing import. */
export function buildBillingKernelIssuance(input: BillingKernelIssuanceInput): BillingKernelIssuance {
  validateRun(input.run);
  if (!Array.isArray(input.records) || input.records.length === 0) throw new Error('billing kernel issuance requires at least one record');
  const sourceIds = new Set<string>();
  const recordIds = new Set<string>();
  let total = money('0', 'USD', 'billed');
  const recordEvidence: Evidence[] = [];
  const recordClaims: Claim[] = [];
  for (const record of input.records) {
    validateRecord(input.run, record);
    if (sourceIds.has(record.sourceRecordId)) throw new Error(`duplicate billing source record id: ${record.sourceRecordId}`);
    if (recordIds.has(record.recordId)) throw new Error(`duplicate billing record id: ${record.recordId}`);
    sourceIds.add(record.sourceRecordId);
    recordIds.add(record.recordId);
    const item = buildRecordEvidence(input.run, record);
    recordEvidence.push(item);
    recordClaims.push(recordClaim(input.run, record, item));
    total = addMoney(total, canonicalMoneyFromMicros(record.amountMicros, 'billed', `billing record ${record.recordId} amount`));
  }
  const aggregateClaim = claim({
    id: `claim:billing:billed-total:${input.run.importId}`,
    proposition: {
      predicate: 'billing.billed_period_total',
      value: {
        amount: { ...moneyToJson(total) },
        sourceExportId: input.run.sourceExportId,
        recordCount: recordEvidence.length,
      },
    },
    subject: `billing-period:${input.run.sourceExportId}`,
    scope: billingScope(input.run),
    grain: grain(['billing_period']),
    time: {
      validTime: intervalFor(input.run.periodStartMs, input.run.periodEndMs, 'billing import period'),
      asOf: canonicalInstantMs(input.run.importedAtMs, 'billing import importedAtMs'),
    },
    epistemic: 'supported',
    profile: profile(input.run),
    measurementModelRef: null,
    evidenceIds: recordEvidence.map((item) => item.id),
    derivationRule: 'billing.operator_export.period_total.v1',
    derivationVersion: 1,
    assumptions: ['Provider export authenticity remains operator-supplied and unverified.'],
    uncertainty: { kind: 'qualitative', description: 'Exact arithmetic over retained provider lines; scope and authenticity remain conditional.' },
    causalStatus: 'none',
    monetaryBasis: 'billed',
    finality: 'provisional',
    issuedAt: canonicalInstantMs(input.run.importedAtMs, 'billing import importedAtMs'),
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
  return Object.freeze({ recordEvidence: Object.freeze(recordEvidence), recordClaims: Object.freeze(recordClaims), aggregateClaim, total });
}

function fixedMicrosDifference(value: number, leftBasis: string, rightBasis: string) {
  if (!Number.isSafeInteger(value)) throw new Error('reconciliation difference must be a safe integer microdollar amount');
  return Object.freeze({ coefficient: String(value), scale: 6, currency: 'USD' as const, leftBasis, rightBasis });
}

/** Issue a mixed-basis reconciliation Claim without pretending the residual has one basis. */
export function billingReconciliationClaim(input: BillingReconciliationClaimInput): Claim {
  nonEmpty(input.id, 'reconciliation claim id');
  if (input.run.status !== 'reconciled_with_residual' || input.run.currency !== 'USD') throw new Error('reconciliation claim requires a USD residual-bearing run');
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) throw new Error('reconciliation claim requires supporting evidence IDs');
  const issuedAt = canonicalInstantString(input.issuedAt, 'reconciliation claim issuedAt');
  const validTime = intervalFor(input.run.periodStartMs, input.run.periodEndMs, 'reconciliation period');
  const providerReported = canonicalMoneyFromMicros(input.run.providerReportedMicros, 'billed', 'provider reported total');
  const localCaptured = canonicalMoneyFromMicros(input.run.localCapturedMicros, 'estimated', 'local captured total');
  canonicalMoneyFromMicros(input.run.unexplainedVarianceMicros, 'estimated', 'reconciliation residual');
  if (BigInt(input.run.providerReportedMicros) - BigInt(input.run.localCapturedMicros) !== BigInt(input.run.unexplainedVarianceMicros)) {
    throw new Error('reconciliation residual does not conserve provider minus local totals');
  }
  const authenticity = input.run.providerSourceKind === 'provider_api_pull' ? 'provider_authenticated' : 'self_asserted';
  return claim({
    id: input.id,
    proposition: {
      predicate: 'billing.reconciled_with_residual',
      value: {
        providerReported: { ...moneyToJson(providerReported) },
        localCaptured: { ...moneyToJson(localCaptured) },
        unexplainedVariance: fixedMicrosDifference(input.run.unexplainedVarianceMicros, 'billed', 'estimated'),
        snapshotStability: input.run.snapshotStability,
        providerSourceKind: input.run.providerSourceKind,
      },
    },
    subject: `provider-project:${input.run.providerProjectRef}`,
    scope: scope({ provider: 'openai', declaredScopeId: input.run.declaredScopeId, providerProjectRef: input.run.providerProjectRef }),
    grain: grain(['billing_period']),
    time: { validTime, asOf: issuedAt },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported', integrity: 'verified', authenticity, scope: 'conditional', coverage: 'partial', measurement: 'proxy_unvalidated',
      causality: 'none', monetaryBasis: 'mixed', finality: 'provisional', decisionFitness: 'not_assessed',
    }),
    measurementModelRef: null,
    evidenceIds: [...input.evidenceIds],
    derivationRule: 'billing.reconciliation.v1',
    derivationVersion: 1,
    assumptions: [...input.run.conditions],
    uncertainty: { kind: 'qualitative', description: 'Residual compares provider billed basis with local estimated basis; it is not an attributable cause.' },
    causalStatus: 'none',
    monetaryBasis: 'mixed',
    finality: 'provisional',
    issuedAt,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
}
