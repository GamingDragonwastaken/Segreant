/**
 * Explicit mapping of imported provider charge lines to a local project and
 * account.
 *
 * A provider export normally has a provider account/project identity, while a
 * Fiscus ledger has a local accounting/project identity. Those are different
 * namespaces. This module permits an operator to declare an exact mapping for
 * one immutable imported record, but it never infers a mapping from a model,
 * date, amount, or provider project name. A mapping is therefore useful for a
 * review and an eventual reconciliation workflow without quietly turning an
 * operator assertion into provider verification.
 */

import { createHash, randomUUID } from 'node:crypto';

export const BILLING_MAPPING_SCHEMA_VERSION = 1;

export type BillingMappingTrust = 'operator_declared_unverified';
export type ProviderScopeAuthority = 'operator_declared_unverified' | 'provider_verified';

export type ImportedRecordMappingStatus =
  | 'mapped_operator_declared'
  | 'unmapped'
  | 'stale_mapping'
  | 'ambiguous_mapping';

export type BillingMappingCoverageStatus = 'no_records' | 'unmapped' | 'partially_mapped' | 'fully_mapped';

export type BillingMappingReconciliationStatus =
  | 'blocked_no_records'
  | 'blocked_incomplete_mapping'
  | 'blocked_provider_scope_not_authoritative'
  | 'eligible_for_authoritative_reconciliation';

export const BILLING_MAPPING_EXCLUDED_FROM = [
  'budget_enforcement',
  'roi',
  'model_recommendations',
] as const;

export type BillingMappingExcludedConsumer = typeof BILLING_MAPPING_EXCLUDED_FROM[number];

/** The smallest record surface needed to evaluate a mapping. */
export interface ImportedBillingRecordIdentity {
  recordId: string;
  sourceSystem: 'operator-export';
  provider: 'openai';
  billingAccountRef: string;
  sourceRecordId: string;
  sourceRecordSha256: string;
  firstImportId: string;
  amountMicros: number;
}

/** One append-only operator declaration for exactly one imported record. */
export interface BillingRecordMapping {
  mappingId: string;
  mappingKey: string;
  mappingVersion: number;
  schemaVersion: typeof BILLING_MAPPING_SCHEMA_VERSION;
  sourceSystem: 'operator-export';
  provider: 'openai';
  billingAccountRef: string;
  sourceRecordId: string;
  sourceRecordSha256: string;
  firstImportId: string;
  targetProject: string;
  targetAccountRef: string;
  declaredAtMs: number;
  trust: BillingMappingTrust;
}

export interface NewBillingRecordMappingInput {
  sourceSystem: 'operator-export';
  provider: 'openai';
  billingAccountRef: string;
  sourceRecordId: string;
  sourceRecordSha256: string;
  firstImportId: string;
  targetProject: string;
  targetAccountRef: string;
  mappingVersion: number;
  mappingId?: string;
  declaredAtMs?: number;
}

export interface BillingRecordMappingResult {
  recordId: string;
  sourceRecordId: string;
  amountMicros: number;
  status: ImportedRecordMappingStatus;
  mapping: BillingRecordMapping | null;
  targetProject: string | null;
  targetAccountRef: string | null;
  detail: string;
}

export interface BillingMappingTargetSummary {
  targetProject: string;
  targetAccountRef: string;
  recordCount: number;
  amountMicros: number;
}

export interface BillingMappingCoverage {
  schemaVersion: typeof BILLING_MAPPING_SCHEMA_VERSION;
  coverageStatus: BillingMappingCoverageStatus;
  reconciliationStatus: BillingMappingReconciliationStatus;
  reconciliationDetail: string;
  providerScopeAuthority: ProviderScopeAuthority;
  mappingTrust: BillingMappingTrust;
  totalRecordCount: number;
  mappedRecordCount: number;
  unmappedRecordCount: number;
  staleMappingRecordCount: number;
  ambiguousMappingRecordCount: number;
  totalMicros: number;
  mappedMicros: number;
  residualMicros: number;
  byStatus: Record<ImportedRecordMappingStatus, { recordCount: number; amountMicros: number }>;
  targets: BillingMappingTargetSummary[];
  records: BillingRecordMappingResult[];
  excludedFrom: readonly BillingMappingExcludedConsumer[];
}

const CONTROL = /[\u0000-\u001F\u007F]/;
const MAX_TEXT = 256;
const SHA256 = /^[a-f0-9]{64}$/;

function text(value: string, label: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > max || CONTROL.test(value)) {
    throw new Error(`${label} must be a non-empty, trimmed single-line string of at most ${max} characters`);
  }
  return value;
}

function digest(value: string, label: string): string {
  const checked = text(value, label, 64);
  if (!SHA256.test(checked)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return checked;
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer epoch-millisecond timestamp`);
  return value;
}

function version(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('mappingVersion must be a positive safe integer');
  return value;
}

/**
 * Stable, credential-free identity for one provider charge-line namespace.
 * Length-prefixing prevents delimiter ambiguity and makes no assumption about
 * the provider's source-record-id grammar.
 */
export function billingMappingKey(input: Pick<NewBillingRecordMappingInput, 'sourceSystem' | 'provider' | 'billingAccountRef' | 'sourceRecordId'>): string {
  const fields = [
    text(input.sourceSystem, 'sourceSystem'),
    text(input.provider, 'provider'),
    text(input.billingAccountRef, 'billingAccountRef'),
    text(input.sourceRecordId, 'sourceRecordId'),
  ];
  const canonical = fields.map((field) => `${field.length}:${field}`).join('');
  return createHash('sha256').update(`fiscus-billing-record-mapping-key-v${BILLING_MAPPING_SCHEMA_VERSION}\n${canonical}`, 'utf8').digest('hex');
}

/** Create and validate a mapping row without reading or writing a database. */
export function newBillingRecordMapping(input: NewBillingRecordMappingInput): BillingRecordMapping {
  if (input.sourceSystem !== 'operator-export') throw new Error('mapping sourceSystem must be operator-export');
  if (input.provider !== 'openai') throw new Error('mapping provider must be openai');
  const billingAccountRef = text(input.billingAccountRef, 'billingAccountRef');
  const sourceRecordId = text(input.sourceRecordId, 'sourceRecordId');
  const sourceRecordSha256 = digest(input.sourceRecordSha256, 'sourceRecordSha256');
  const firstImportId = text(input.firstImportId, 'firstImportId');
  const targetProject = text(input.targetProject, 'targetProject');
  const targetAccountRef = text(input.targetAccountRef, 'targetAccountRef');
  const mappingVersion = version(input.mappingVersion);
  const declaredAtMs = timestamp(input.declaredAtMs ?? Date.now(), 'declaredAtMs');
  const mappingId = text(input.mappingId ?? randomUUID(), 'mappingId', 128);
  const mappingKey = billingMappingKey({
    sourceSystem: input.sourceSystem,
    provider: input.provider,
    billingAccountRef,
    sourceRecordId,
  });
  return {
    mappingId,
    mappingKey,
    mappingVersion,
    schemaVersion: BILLING_MAPPING_SCHEMA_VERSION,
    sourceSystem: input.sourceSystem,
    provider: input.provider,
    billingAccountRef,
    sourceRecordId,
    sourceRecordSha256,
    firstImportId,
    targetProject,
    targetAccountRef,
    declaredAtMs,
    trust: 'operator_declared_unverified',
  };
}

function sumSafe(values: readonly number[], label: string): number {
  let total = 0n;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} contains a non-safe integer amount`);
    total += BigInt(value);
    if (total > max || total < -max) throw new Error(`${label} is outside the supported fixed-point range`);
  }
  return Number(total);
}

function sameMapping(left: BillingRecordMapping, right: BillingRecordMapping): boolean {
  return left.mappingKey === right.mappingKey
    && left.mappingVersion === right.mappingVersion
    && left.sourceRecordSha256 === right.sourceRecordSha256
    && left.firstImportId === right.firstImportId
    && left.targetProject === right.targetProject
    && left.targetAccountRef === right.targetAccountRef
    && left.trust === right.trust;
}

function asOfMapping(
  record: ImportedBillingRecordIdentity,
  mappings: readonly BillingRecordMapping[],
  asOfMs: number,
): { mapping: BillingRecordMapping | null; status: ImportedRecordMappingStatus; detail: string } {
  const key = billingMappingKey(record);
  const candidates = mappings
    .filter((mapping) => mapping.mappingKey === key && mapping.declaredAtMs <= asOfMs)
    .sort((left, right) => right.mappingVersion - left.mappingVersion);
  if (candidates.length === 0) {
    return { mapping: null, status: 'unmapped', detail: 'no exact operator mapping exists for this immutable provider record' };
  }
  const latestVersion = candidates[0]!.mappingVersion;
  const sameVersion = candidates.filter((mapping) => mapping.mappingVersion === latestVersion);
  if (sameVersion.length !== 1) {
    return { mapping: null, status: 'ambiguous_mapping', detail: 'multiple declarations exist for the same record and version; no target was selected' };
  }
  const mapping = sameVersion[0]!;
  if (mapping.sourceRecordSha256 !== record.sourceRecordSha256 || mapping.firstImportId !== record.firstImportId) {
    return { mapping, status: 'stale_mapping', detail: 'the declaration digest/import anchor does not match the imported record' };
  }
  return { mapping, status: 'mapped_operator_declared', detail: 'exact source-record digest matched an operator declaration' };
}

/**
 * Evaluate every imported record without guessing. `providerScopeAuthority` is
 * deliberately explicit: current Fiscus route declarations are operator
 * assertions, so the default result is always excluded from money-consuming
 * controls even when every row has a local target.
 */
export function evaluateBillingMapping(input: {
  records: readonly ImportedBillingRecordIdentity[];
  mappings: readonly BillingRecordMapping[];
  asOfMs?: number;
  providerScopeAuthority?: ProviderScopeAuthority;
}): BillingMappingCoverage {
  const asOfMs = timestamp(input.asOfMs ?? Date.now(), 'asOfMs');
  const authority = input.providerScopeAuthority ?? 'operator_declared_unverified';
  const records: BillingRecordMappingResult[] = [];
  const byStatus: BillingMappingCoverage['byStatus'] = {
    mapped_operator_declared: { recordCount: 0, amountMicros: 0 },
    unmapped: { recordCount: 0, amountMicros: 0 },
    stale_mapping: { recordCount: 0, amountMicros: 0 },
    ambiguous_mapping: { recordCount: 0, amountMicros: 0 },
  };
  const targetMap = new Map<string, BillingMappingTargetSummary>();

  for (const record of input.records) {
    if (!Number.isSafeInteger(record.amountMicros)) throw new Error(`billing record ${record.recordId} has an unsafe amount`);
    const resolved = asOfMapping(record, input.mappings, asOfMs);
    const item: BillingRecordMappingResult = {
      recordId: record.recordId,
      sourceRecordId: record.sourceRecordId,
      amountMicros: record.amountMicros,
      status: resolved.status,
      mapping: resolved.mapping,
      targetProject: resolved.status === 'mapped_operator_declared' ? resolved.mapping!.targetProject : null,
      targetAccountRef: resolved.status === 'mapped_operator_declared' ? resolved.mapping!.targetAccountRef : null,
      detail: resolved.detail,
    };
    records.push(item);
    byStatus[item.status].recordCount++;
    byStatus[item.status].amountMicros = sumSafe(
      [byStatus[item.status].amountMicros, item.amountMicros],
      `billing mapping ${item.status} total`,
    );
    if (item.status === 'mapped_operator_declared') {
      const key = `${item.targetAccountRef}\u0000${item.targetProject}`;
      const target = targetMap.get(key) ?? {
        targetProject: item.targetProject!,
        targetAccountRef: item.targetAccountRef!,
        recordCount: 0,
        amountMicros: 0,
      };
      target.recordCount++;
      target.amountMicros = sumSafe([target.amountMicros, item.amountMicros], 'billing mapping target total');
      targetMap.set(key, target);
    }
  }

  const totalRecordCount = records.length;
  const mappedRecordCount = byStatus.mapped_operator_declared.recordCount;
  const coverageStatus: BillingMappingCoverageStatus = totalRecordCount === 0
    ? 'no_records'
    : mappedRecordCount === 0
      ? 'unmapped'
      : mappedRecordCount === totalRecordCount
        ? 'fully_mapped'
        : 'partially_mapped';
  const reconciliationStatus: BillingMappingReconciliationStatus = totalRecordCount === 0
    ? 'blocked_no_records'
    : mappedRecordCount !== totalRecordCount
      ? 'blocked_incomplete_mapping'
      : authority !== 'provider_verified'
        ? 'blocked_provider_scope_not_authoritative'
        : 'eligible_for_authoritative_reconciliation';
  const reconciliationDetail = reconciliationStatus === 'blocked_no_records'
    ? 'no imported provider records exist to map'
    : reconciliationStatus === 'blocked_incomplete_mapping'
      ? 'unmapped, stale, or ambiguous records remain as residuals; Fiscus refuses to force-fit them'
      : reconciliationStatus === 'blocked_provider_scope_not_authoritative'
        ? 'all rows have exact operator mappings, but provider/account scope remains operator-declared and unverified'
        : 'every imported record has an exact mapping and the caller supplied provider-verified scope authority';
  const totalMicros = sumSafe(records.map((record) => record.amountMicros), 'billing mapping total');
  const mappedMicros = byStatus.mapped_operator_declared.amountMicros;
  return {
    schemaVersion: BILLING_MAPPING_SCHEMA_VERSION,
    coverageStatus,
    reconciliationStatus,
    reconciliationDetail,
    providerScopeAuthority: authority,
    mappingTrust: 'operator_declared_unverified',
    totalRecordCount,
    mappedRecordCount,
    unmappedRecordCount: byStatus.unmapped.recordCount,
    staleMappingRecordCount: byStatus.stale_mapping.recordCount,
    ambiguousMappingRecordCount: byStatus.ambiguous_mapping.recordCount,
    totalMicros,
    mappedMicros,
    residualMicros: sumSafe([totalMicros, -mappedMicros], 'billing mapping residual'),
    byStatus,
    targets: [...targetMap.values()].sort((left, right) => `${left.targetAccountRef}\u0000${left.targetProject}`.localeCompare(`${right.targetAccountRef}\u0000${right.targetProject}`)),
    records,
    // A verified provider scope is a future connector boundary. Until that
    // boundary exists, mapped imported dollars are explicitly barred from all
    // money-consuming controls. Do not make a caller infer this from a status.
    excludedFrom: reconciliationStatus === 'eligible_for_authoritative_reconciliation'
      ? []
      : BILLING_MAPPING_EXCLUDED_FROM,
  };
}

/** Test/helper predicate for idempotent persistence and callers with a cached row. */
export function billingMappingsEquivalent(left: BillingRecordMapping, right: BillingRecordMapping): boolean {
  return sameMapping(left, right);
}
