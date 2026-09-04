/**
 * Billing evidence, provider scope, and reconciliation.
 *
 * Split out of db.ts. `Store` still owns the public method names; these are the
 * implementations behind them, operating on the shared `DatabaseSync` handle.
 *
 * Everything here is on the PROVIDER side of the distinction the product is
 * built on: a provider-billed cost is not a metered one. Nothing in this module
 * creates or changes a request row, and nothing in it adds a provider figure to
 * a local one — the two have different scopes, and merging them would be the
 * exact collapse the ledger exists to prevent.
 */

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { runScript } from './schema.ts';
import {
  BILLING_IMPORTER_VERSION,
  usdMicros,
  type BillingChargeType,
  type BillingCoverage,
  type NormalizedBillingImport,
} from '../billing/types.ts';
import {
  newOpenAiScopeDeclaration,
  normalizeOpenAiUpstream,
  type ProviderScopeDeclaration,
} from '../billing/scope.ts';
import type { OpenAiCostObservation, OpenAiCostsFailureCode } from '../billing/openaiCosts.ts';
import { buildOpenAiCostsCaptureCoverage, type OpenAiCostsCaptureCoverage } from '../billing/openaiCostsCoverage.ts';
import {
  billingMappingKey,
  evaluateBillingMapping,
  newBillingRecordMapping,
  type BillingMappingCoverage,
  type BillingRecordMapping,
  type ImportedBillingRecordIdentity,
  type ProviderScopeAuthority,
} from '../billing/mapping.ts';
import {
  reconcileOpenAiCosts as computeOpenAiReconciliation,
  type ProviderSourceKind,
  type ReconciliationCoverage,
  type ReconciliationResult,
  type ReconciliationRun,
} from '../billing/reconcile.ts';
import type { RequestRow } from './db.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How the billing domain reads request rows: alias-canonical, exactly as the ledger totals them. */
export type RequestsInRange = (startMs: number, endMs: number) => RequestRow[];

/** File-level provenance supplied with a validated, local billing-evidence import. */
export interface BillingImportInput {
  document: NormalizedBillingImport;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  format: 'json';
}

export interface BillingImportRun {
  importId: string;
  importedAtMs: number;
  format: 'json';
  schemaVersion: number;
  importerVersion: string;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  sourceSystem: 'operator-export';
  sourceExportId: string;
  provider: 'openai';
  billingAccountRef: string;
  exportedAtMs: number;
  periodStartMs: number;
  periodEndMs: number;
  coverage: BillingCoverage;
  trust: 'operator_supplied_unverified';
  rawRetention: 'digest_only';
  recordsSeen: number;
  recordsInserted: number;
  recordsDuplicate: number;
}

/** One immutable provider-declared charge line. It is never a request-ledger row. */
export interface BillingEvidenceRecord {
  recordId: string;
  sourceSystem: 'operator-export';
  billingAccountRef: string;
  sourceRecordId: string;
  sourceRecordSha256: string;
  firstImportId: string;
  sourceExportId: string;
  provider: 'openai';
  providerProjectRef: string | null;
  service: string;
  sku: string;
  model: string | null;
  region: string | null;
  observedAtMs: number;
  chargePeriodStartMs: number;
  chargePeriodEndMs: number;
  chargeType: BillingChargeType;
  currency: 'USD';
  amountMicros: number;
  usageUnit: string | null;
  usageQuantity: string | null;
  costBasis: 'provider_reported';
  trust: 'operator_supplied_unverified';
}

export interface BillingRecordMappingDeclarationInput {
  /** The immutable billing_evidence_records.record_id, not a fuzzy selector. */
  recordId: string;
  targetProject: string;
  targetAccountRef: string;
  declaredAtMs?: number;
}

export interface BillingRecordMappingDeclarationResult {
  mapping: BillingRecordMapping;
  created: boolean;
}

export interface BillingImportResult {
  run: BillingImportRun;
  duplicateFile: boolean;
}

export interface BillingSummary {
  importCount: number;
  recordCount: number;
  providerReportedUsdMicros: number;
  lastImportedAtMs: number | null;
  reconciliationStatus: 'not_reconciled';
}

/**
 * An immutable record of one direct, read-only OpenAI Costs API attempt. This
 * collection is intentionally separate from both operator file imports and the
 * request ledger. A successful later pull can restate or change a provider day;
 * it is retained as a new observation rather than an overwrite or a sum.
 */
export interface OpenAiCostsObservationRun {
  observationRunId: string;
  declaredScopeId: string;
  providerProjectRef: string;
  periodStartMs: number;
  periodEndMs: number;
  fetchedAtMs: number;
  paginationComplete: boolean;
  pageCount: number;
  pageDigestChainSha256: string | null;
  resultState: 'succeeded' | 'failed';
  failureCode: OpenAiCostsFailureCode | null;
  providerFinality: 'undocumented';
  trust: 'provider_observation_unreconciled';
  rawRetention: 'digest_only';
  observationsStored: number;
  /**
   * How these figures reached Fiscus. `legacy_unknown` on rows recorded before
   * the distinction existed — never backfilled to `provider_api_pull` merely
   * because that happened to be the only writer at the time.
   */
  sourceKind: ProviderSourceKind;
}

/** A retained provider daily grouping from exactly one completed observation run. */
export interface OpenAiCostsObservationLine extends OpenAiCostObservation {
  observationId: string;
  observationRunId: string;
  declaredScopeId: string;
  fetchedAtMs: number;
}

export interface OpenAiCostsObservationInput {
  declaredScopeId: string;
  providerProjectRef: string;
  periodStartMs: number;
  periodEndMs: number;
  fetchedAtMs: number;
  paginationComplete: boolean;
  pageCount: number;
  pageDigestChainSha256: string | null;
  resultState: 'succeeded' | 'failed';
  failureCode: OpenAiCostsFailureCode | null;
  observations: OpenAiCostObservation[];
  /** Defaults to the direct API pull — the only writer that existed before this. */
  sourceKind?: ProviderSourceKind;
}

export interface OpenAiCostsObservationStatus {
  latestRun: OpenAiCostsObservationRun | null;
  latestCompleteRun: OpenAiCostsObservationRun | null;
  reconciliationStatus: 'not_reconciled';
}

/** What an adoption would observe, and what it deliberately would not. */
export type OpenAiCostsAdoptionPlan =
  | {
      adoptable: true;
      importId: string;
      declaredScopeId: string;
      providerProjectRef: string;
      periodStartMs: number;
      periodEndMs: number;
      fileSha256: string;
      /** The operator's own coverage claim on the import. Never verified here. */
      declaredCoverage: string;
      observations: OpenAiCostObservation[];
      matchedRecordCount: number;
      matchedMicros: number;
      /**
       * Lines this adoption will NOT observe, with their money. Account-level
       * credits carry no project reference and cannot be attributed to one, so
       * they are excluded — and reported, because a silently dropped credit
       * would show up later as a residual that never existed.
       */
      excluded: { otherOrNoProjectRecordCount: number; otherOrNoProjectMicros: number };
    }
  | {
      adoptable: false;
      refusal:
        | 'no_such_import'
        | 'import_is_not_openai'
        | 'import_owns_no_records'
        | 'no_records_for_declared_project'
        | 'records_are_not_single_currency_usd'
        | 'records_are_not_whole_utc_days';
      detail: string;
    };

/**
 * A microdollar integer as the plain decimal string the observation grain
 * stores. Never a float round-trip: the ledger is exact integers and the
 * provider grain is an exact decimal, so the conversion between them must not
 * introduce a representation error a reconciliation would then report as a
 * residual.
 */
function microsToDecimal(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  return `${sign}${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, '0')}`;
}

function scopeDeclarationFromRecord(row: Record<string, unknown>): ProviderScopeDeclaration {
  return {
    declarationId: String(row.declarationId),
    provider: 'openai',
    billingAccountRef: String(row.billingAccountRef),
    providerProjectRef: typeof row.providerProjectRef === 'string' ? row.providerProjectRef : null,
    upstreamFingerprint: String(row.upstreamFingerprint),
    upstreamDisplay: String(row.upstreamDisplay),
    declaredAtMs: Number(row.declaredAtMs),
    trust: 'operator_declared_unverified',
  };
}

function billingRunFromRecord(row: Record<string, unknown>): BillingImportRun {
  return {
    importId: String(row.importId),
    importedAtMs: Number(row.importedAtMs),
    format: 'json',
    schemaVersion: Number(row.schemaVersion),
    importerVersion: String(row.importerVersion),
    fileName: String(row.fileName),
    fileSha256: String(row.fileSha256),
    fileSizeBytes: Number(row.fileSizeBytes),
    sourceSystem: 'operator-export',
    sourceExportId: String(row.sourceExportId),
    provider: 'openai',
    billingAccountRef: String(row.billingAccountRef),
    exportedAtMs: Number(row.exportedAtMs),
    periodStartMs: Number(row.periodStartMs),
    periodEndMs: Number(row.periodEndMs),
    coverage: String(row.coverage) as BillingCoverage,
    trust: 'operator_supplied_unverified',
    rawRetention: 'digest_only',
    recordsSeen: Number(row.recordsSeen),
    recordsInserted: Number(row.recordsInserted),
    recordsDuplicate: Number(row.recordsDuplicate),
  };
}

function billingRecordFromRecord(row: Record<string, unknown>): BillingEvidenceRecord {
  return {
    recordId: String(row.recordId),
    sourceSystem: 'operator-export',
    billingAccountRef: String(row.billingAccountRef),
    sourceRecordId: String(row.sourceRecordId),
    sourceRecordSha256: String(row.sourceRecordSha256),
    firstImportId: String(row.firstImportId),
    sourceExportId: String(row.sourceExportId),
    provider: 'openai',
    providerProjectRef: typeof row.providerProjectRef === 'string' ? row.providerProjectRef : null,
    service: String(row.service),
    sku: String(row.sku),
    model: typeof row.model === 'string' ? row.model : null,
    region: typeof row.region === 'string' ? row.region : null,
    observedAtMs: Number(row.observedAtMs),
    chargePeriodStartMs: Number(row.chargePeriodStartMs),
    chargePeriodEndMs: Number(row.chargePeriodEndMs),
    chargeType: String(row.chargeType) as BillingChargeType,
    currency: 'USD',
    amountMicros: Number(row.amountMicros),
    usageUnit: typeof row.usageUnit === 'string' ? row.usageUnit : null,
    usageQuantity: typeof row.usageQuantity === 'string' ? row.usageQuantity : null,
    costBasis: 'provider_reported',
    trust: 'operator_supplied_unverified',
  };
}

function openAiCostsRunFromRecord(row: Record<string, unknown>): OpenAiCostsObservationRun {
  return {
    observationRunId: String(row.observationRunId),
    declaredScopeId: String(row.declaredScopeId),
    providerProjectRef: String(row.providerProjectRef),
    periodStartMs: Number(row.periodStartMs),
    periodEndMs: Number(row.periodEndMs),
    fetchedAtMs: Number(row.fetchedAtMs),
    paginationComplete: Boolean(row.paginationComplete),
    pageCount: Number(row.pageCount),
    pageDigestChainSha256: typeof row.pageDigestChainSha256 === 'string' ? row.pageDigestChainSha256 : null,
    resultState: String(row.resultState) as OpenAiCostsObservationRun['resultState'],
    failureCode: typeof row.failureCode === 'string' ? row.failureCode as OpenAiCostsFailureCode : null,
    providerFinality: 'undocumented',
    trust: 'provider_observation_unreconciled',
    rawRetention: 'digest_only',
    observationsStored: Number(row.observationsStored),
    // Anything not one of the two known writers stays unknown rather than being
    // coerced into the one that happens to be more flattering.
    sourceKind: row.sourceKind === 'provider_api_pull' || row.sourceKind === 'operator_supplied_export'
      ? row.sourceKind
      : 'legacy_unknown',
  };
}

function openAiCostsLineFromRecord(row: Record<string, unknown>): OpenAiCostsObservationLine {
  return {
    observationId: String(row.observationId),
    observationRunId: String(row.observationRunId),
    declaredScopeId: String(row.declaredScopeId),
    fetchedAtMs: Number(row.fetchedAtMs),
    providerProjectRef: String(row.providerProjectRef),
    bucketStartMs: Number(row.bucketStartMs),
    bucketEndMs: Number(row.bucketEndMs),
    lineItem: String(row.lineItem),
    currency: String(row.currency),
    amountDecimal: String(row.amountDecimal),
  };
}

/**
 * Write one validated provider-cost export as immutable evidence. This never
 * creates or changes request rows: local metering and provider reports have
 * different scopes and cannot be silently added together.
 */
export function applyBillingImport(
  db: DatabaseSync,
  input: BillingImportInput,
  importedAtMs: number,
): BillingImportResult {
  if (!/^[a-f0-9]{64}$/.test(input.fileSha256)) throw new Error('billing fileSha256 must be a lowercase SHA-256 digest');
  if (!Number.isSafeInteger(input.fileSizeBytes) || input.fileSizeBytes < 0) throw new Error('billing file size is invalid');
  const d = input.document;
  const priorFile = db.prepare(
    `SELECT import_id AS importId, imported_at_ms AS importedAtMs, format, schema_version AS schemaVersion,
              importer_version AS importerVersion, file_name AS fileName, file_sha256 AS fileSha256,
              file_size_bytes AS fileSizeBytes, source_system AS sourceSystem, source_export_id AS sourceExportId,
              provider, billing_account_ref AS billingAccountRef, exported_at_ms AS exportedAtMs,
              period_start_ms AS periodStartMs, period_end_ms AS periodEndMs, coverage, trust, raw_retention AS rawRetention,
              records_seen AS recordsSeen, records_inserted AS recordsInserted, records_duplicate AS recordsDuplicate
       FROM billing_import_runs WHERE file_sha256 = ?`,
  ).get(input.fileSha256) as Record<string, unknown> | undefined;
  if (priorFile) return { run: billingRunFromRecord(priorFile), duplicateFile: true };

  const existing = db.prepare(
    `SELECT source_record_sha256 AS sourceRecordSha256
       FROM billing_evidence_records
       WHERE source_system = ? AND provider = ? AND billing_account_ref = ? AND source_record_id = ?`,
  );
  let recordsDuplicate = 0;
  const recordsToInsert = [] as typeof d.records;
  for (const record of d.records) {
    const row = existing.get(d.source.system, d.source.provider, d.source.billingAccountRef, record.sourceRecordId) as
      | { sourceRecordSha256: string }
      | undefined;
    if (!row) {
      recordsToInsert.push(record);
    } else if (row.sourceRecordSha256 === record.sourceRecordSha256) {
      recordsDuplicate++;
    } else {
      throw new Error(
        `billing source-record conflict for ${record.sourceRecordId}: the same provider/account record id has different content`,
      );
    }
  }

  const run: BillingImportRun = {
    importId: randomUUID(),
    importedAtMs,
    format: input.format,
    schemaVersion: d.schemaVersion,
    importerVersion: BILLING_IMPORTER_VERSION,
    fileName: input.fileName,
    fileSha256: input.fileSha256,
    fileSizeBytes: input.fileSizeBytes,
    sourceSystem: d.source.system,
    sourceExportId: d.source.exportId,
    provider: d.source.provider,
    billingAccountRef: d.source.billingAccountRef,
    exportedAtMs: d.exportedAtMs,
    periodStartMs: d.periodStartMs,
    periodEndMs: d.periodEndMs,
    coverage: d.source.coverage,
    trust: 'operator_supplied_unverified',
    rawRetention: 'digest_only',
    recordsSeen: d.records.length,
    recordsInserted: recordsToInsert.length,
    recordsDuplicate,
  };
  const writeRun = db.prepare(
    `INSERT INTO billing_import_runs (
         import_id, imported_at_ms, format, schema_version, importer_version, file_name, file_sha256, file_size_bytes,
         source_system, source_export_id, provider, billing_account_ref, exported_at_ms, period_start_ms, period_end_ms,
         coverage, trust, raw_retention, records_seen, records_inserted, records_duplicate
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const writeRecord = db.prepare(
    `INSERT INTO billing_evidence_records (
         record_id, source_system, billing_account_ref, source_record_id, source_record_sha256, first_import_id,
         source_export_id, provider, provider_project_ref, service, sku, model, region, observed_at_ms,
         charge_period_start_ms, charge_period_end_ms, charge_type, currency, amount_micros, usage_unit,
         usage_quantity, cost_basis, trust
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  runScript(db, 'BEGIN');
  try {
    writeRun.run(
      run.importId, run.importedAtMs, run.format, run.schemaVersion, run.importerVersion, run.fileName, run.fileSha256,
      run.fileSizeBytes, run.sourceSystem, run.sourceExportId, run.provider, run.billingAccountRef, run.exportedAtMs,
      run.periodStartMs, run.periodEndMs, run.coverage, run.trust, run.rawRetention, run.recordsSeen,
      run.recordsInserted, run.recordsDuplicate,
    );
    for (const record of recordsToInsert) {
      writeRecord.run(
        randomUUID(), d.source.system, d.source.billingAccountRef, record.sourceRecordId, record.sourceRecordSha256,
        run.importId, d.source.exportId, d.source.provider, record.providerProjectRef, record.service, record.sku,
        record.model, record.region, record.observedAtMs, record.chargePeriodStartMs, record.chargePeriodEndMs,
        record.chargeType, record.currency, record.amountMicros, record.usageUnit, record.usageQuantity,
        'provider_reported', 'operator_supplied_unverified',
      );
    }
    runScript(db, 'COMMIT');
  } catch (error) {
    runScript(db, 'ROLLBACK');
    throw error;
  }
  return { run, duplicateFile: false };
}

/** Newest first, including empty/replay-only evidence runs for auditability. */
export function billingImportRuns(db: DatabaseSync, limit: number): BillingImportRun[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db.prepare(
    `SELECT import_id AS importId, imported_at_ms AS importedAtMs, format, schema_version AS schemaVersion,
              importer_version AS importerVersion, file_name AS fileName, file_sha256 AS fileSha256,
              file_size_bytes AS fileSizeBytes, source_system AS sourceSystem, source_export_id AS sourceExportId,
              provider, billing_account_ref AS billingAccountRef, exported_at_ms AS exportedAtMs,
              period_start_ms AS periodStartMs, period_end_ms AS periodEndMs, coverage, trust, raw_retention AS rawRetention,
              records_seen AS recordsSeen, records_inserted AS recordsInserted, records_duplicate AS recordsDuplicate
       FROM billing_import_runs ORDER BY imported_at_ms DESC, import_id DESC LIMIT ?`,
  ).all(safeLimit) as Array<Record<string, unknown>>;
  return rows.map(billingRunFromRecord);
}

/** Immutable provider-declared lines, deliberately separate from requestsInRange(). */
export function billingEvidenceRecords(db: DatabaseSync): BillingEvidenceRecord[] {
  const rows = db.prepare(
    `SELECT record_id AS recordId, source_system AS sourceSystem, billing_account_ref AS billingAccountRef,
              source_record_id AS sourceRecordId, source_record_sha256 AS sourceRecordSha256,
              first_import_id AS firstImportId, source_export_id AS sourceExportId, provider,
              provider_project_ref AS providerProjectRef, service, sku, model, region, observed_at_ms AS observedAtMs,
              charge_period_start_ms AS chargePeriodStartMs, charge_period_end_ms AS chargePeriodEndMs,
              charge_type AS chargeType, currency, amount_micros AS amountMicros, usage_unit AS usageUnit,
              usage_quantity AS usageQuantity, cost_basis AS costBasis, trust
       FROM billing_evidence_records
       ORDER BY charge_period_start_ms ASC, source_record_id ASC`,
  ).all() as Array<Record<string, unknown>>;
  return rows.map(billingRecordFromRecord);
}

function mappingFromRecord(row: Record<string, unknown>): BillingRecordMapping {
  return {
    mappingId: String(row.mappingId),
    mappingKey: String(row.mappingKey),
    mappingVersion: Number(row.mappingVersion),
    schemaVersion: Number(row.schemaVersion) as 1,
    sourceSystem: 'operator-export',
    provider: 'openai',
    billingAccountRef: String(row.billingAccountRef),
    sourceRecordId: String(row.sourceRecordId),
    sourceRecordSha256: String(row.sourceRecordSha256),
    firstImportId: String(row.firstImportId),
    targetProject: String(row.targetProject),
    targetAccountRef: String(row.targetAccountRef),
    declaredAtMs: Number(row.declaredAtMs),
    trust: 'operator_declared_unverified',
  };
}

const MAPPING_SELECT = `
  SELECT mapping_id AS mappingId, mapping_key AS mappingKey, mapping_version AS mappingVersion,
         schema_version AS schemaVersion, source_system AS sourceSystem, provider,
         billing_account_ref AS billingAccountRef, source_record_id AS sourceRecordId,
         source_record_sha256 AS sourceRecordSha256, first_import_id AS firstImportId,
         target_project AS targetProject, target_account_ref AS targetAccountRef,
         declared_at_ms AS declaredAtMs, trust
    FROM billing_record_mapping_versions`;

/** Every mapping version, oldest first per source record for audit/replay. */
export function billingRecordMappings(db: DatabaseSync, recordId?: string): BillingRecordMapping[] {
  let rows: Array<Record<string, unknown>>;
  if (recordId !== undefined) {
    const source = db.prepare(
      `SELECT source_system AS sourceSystem, provider, billing_account_ref AS billingAccountRef,
              source_record_id AS sourceRecordId
         FROM billing_evidence_records WHERE record_id = ?`,
    ).get(recordId) as Record<string, unknown> | undefined;
    if (!source) return [];
    const mappingKey = billingMappingKey({
      sourceSystem: 'operator-export',
      provider: 'openai',
      billingAccountRef: String(source.billingAccountRef),
      sourceRecordId: String(source.sourceRecordId),
    });
    rows = db.prepare(`${MAPPING_SELECT} WHERE mapping_key = ? ORDER BY mapping_key ASC, mapping_version ASC`).all(mappingKey) as Array<Record<string, unknown>>;
  } else {
    rows = db.prepare(`${MAPPING_SELECT} ORDER BY mapping_key ASC, mapping_version ASC`).all() as Array<Record<string, unknown>>;
  }
  return rows.map(mappingFromRecord);
}

/**
 * Declare one exact imported record's local accounting/project destination.
 *
 * The source row is looked up first and its stored hash/import anchor is copied
 * into the mapping. This makes a caller unable to map a guessed or subsequently
 * changed record. Remapping is an append-only new version; the old decision is
 * never updated or deleted.
 */
export function declareBillingRecordMapping(
  db: DatabaseSync,
  input: BillingRecordMappingDeclarationInput,
): BillingRecordMappingDeclarationResult {
  if (typeof input.recordId !== 'string' || !input.recordId.trim()) throw new Error('recordId is required');
  const source = db.prepare(
    `SELECT record_id AS recordId, source_system AS sourceSystem, provider,
            billing_account_ref AS billingAccountRef, source_record_id AS sourceRecordId,
            source_record_sha256 AS sourceRecordSha256, first_import_id AS firstImportId
       FROM billing_evidence_records WHERE record_id = ?`,
  ).get(input.recordId) as Record<string, unknown> | undefined;
  if (!source) throw new Error(`no imported billing evidence record exists for recordId ${input.recordId}`);
  if (source.sourceSystem !== 'operator-export' || source.provider !== 'openai') {
    throw new Error('only OpenAI operator-export records can receive a billing mapping');
  }
  const identity = {
    sourceSystem: 'operator-export' as const,
    provider: 'openai' as const,
    billingAccountRef: String(source.billingAccountRef),
    sourceRecordId: String(source.sourceRecordId),
  };
  const mappingKey = billingMappingKey(identity);
  const previous = db.prepare(
    `${MAPPING_SELECT} WHERE mapping_key = ? ORDER BY mapping_version DESC LIMIT 1`,
  ).get(mappingKey) as Record<string, unknown> | undefined;
  const previousMapping = previous ? mappingFromRecord(previous) : null;
  if (previousMapping
      && previousMapping.sourceRecordSha256 === String(source.sourceRecordSha256)
      && previousMapping.firstImportId === String(source.firstImportId)
      && previousMapping.targetProject === input.targetProject
      && previousMapping.targetAccountRef === input.targetAccountRef) {
    return { mapping: previousMapping, created: false };
  }
  const declaredAtMs = input.declaredAtMs ?? Date.now();
  if (previousMapping && declaredAtMs <= previousMapping.declaredAtMs) {
    throw new Error('declaredAtMs must be later than the prior mapping version for this source record');
  }
  const mapping = newBillingRecordMapping({
    sourceSystem: identity.sourceSystem,
    provider: identity.provider,
    billingAccountRef: identity.billingAccountRef,
    sourceRecordId: identity.sourceRecordId,
    sourceRecordSha256: String(source.sourceRecordSha256),
    firstImportId: String(source.firstImportId),
    targetProject: input.targetProject,
    targetAccountRef: input.targetAccountRef,
    mappingVersion: previousMapping ? previousMapping.mappingVersion + 1 : 1,
    declaredAtMs,
  });
  runScript(db, 'BEGIN IMMEDIATE');
  try {
    // Re-check the version under the writer lock. Another handle may have
    // authored a version between the read above and this transaction.
    const locked = db.prepare(
      `${MAPPING_SELECT} WHERE mapping_key = ? ORDER BY mapping_version DESC LIMIT 1`,
    ).get(mappingKey) as Record<string, unknown> | undefined;
    const lockedMapping = locked ? mappingFromRecord(locked) : null;
    if (lockedMapping && lockedMapping.mappingVersion >= mapping.mappingVersion) {
      runScript(db, 'ROLLBACK');
      if (lockedMapping.sourceRecordSha256 === mapping.sourceRecordSha256
          && lockedMapping.firstImportId === mapping.firstImportId
          && lockedMapping.targetProject === mapping.targetProject
          && lockedMapping.targetAccountRef === mapping.targetAccountRef) {
        return { mapping: lockedMapping, created: false };
      }
      throw new Error('mapping version advanced concurrently; retry with a fresh declaration');
    }
    db.prepare(
      `INSERT INTO billing_record_mapping_versions (
         mapping_id, mapping_key, mapping_version, schema_version, source_system, provider,
         billing_account_ref, source_record_id, source_record_sha256, first_import_id,
         target_project, target_account_ref, declared_at_ms, trust
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      mapping.mappingId, mapping.mappingKey, mapping.mappingVersion, mapping.schemaVersion,
      mapping.sourceSystem, mapping.provider, mapping.billingAccountRef, mapping.sourceRecordId,
      mapping.sourceRecordSha256, mapping.firstImportId, mapping.targetProject, mapping.targetAccountRef,
      mapping.declaredAtMs, mapping.trust,
    );
    runScript(db, 'COMMIT');
  } catch (error) {
    try { runScript(db, 'ROLLBACK'); } catch { /* preserve the insertion error */ }
    throw error;
  }
  return { mapping, created: true };
}

/**
 * Evaluate imported provider evidence against all retained mapping versions.
 * No request rows are touched and no result is eligible for budgets, ROI, or
 * model routing while provider scope remains unverified.
 */
export function billingMappingCoverage(
  db: DatabaseSync,
  options: { importId?: string; asOfMs?: number; providerScopeAuthority?: ProviderScopeAuthority } = {},
): BillingMappingCoverage {
  const records = billingEvidenceRecords(db).filter((record) => options.importId === undefined || record.firstImportId === options.importId);
  const identities: ImportedBillingRecordIdentity[] = records.map((record) => ({
    recordId: record.recordId,
    sourceSystem: record.sourceSystem,
    provider: record.provider,
    billingAccountRef: record.billingAccountRef,
    sourceRecordId: record.sourceRecordId,
    sourceRecordSha256: record.sourceRecordSha256,
    firstImportId: record.firstImportId,
    amountMicros: record.amountMicros,
  }));
  return evaluateBillingMapping({
    records: identities,
    mappings: billingRecordMappings(db),
    asOfMs: options.asOfMs,
    providerScopeAuthority: options.providerScopeAuthority,
  });
}

/** Provider-declared USD total only. It is not a reconciliation or a request-ledger total. */
export function billingSummary(db: DatabaseSync): BillingSummary {
  const imports = db.prepare(
    `SELECT COUNT(*) AS importCount, MAX(imported_at_ms) AS lastImportedAtMs FROM billing_import_runs`,
  ).get() as { importCount: number; lastImportedAtMs: number | null };
  const records = db.prepare(
    `SELECT COUNT(*) AS recordCount, COALESCE(SUM(amount_micros), 0) AS providerReportedUsdMicros
       FROM billing_evidence_records`,
  ).get() as { recordCount: number; providerReportedUsdMicros: number };
  return {
    importCount: Number(imports.importCount),
    recordCount: Number(records.recordCount),
    providerReportedUsdMicros: Number(records.providerReportedUsdMicros),
    lastImportedAtMs: imports.lastImportedAtMs === null ? null : Number(imports.lastImportedAtMs),
    reconciliationStatus: 'not_reconciled',
  };
}

/**
 * Retain one direct OpenAI Costs API attempt. Failed and partial attempts are
 * audit rows only: they store no usable provider observations. Successful
 * attempts retain their own snapshot lines, even when a later pull changes a
 * daily provider line. Nothing here mutates or contributes to request spend.
 */
export function recordOpenAiCostsObservation(
  db: DatabaseSync,
  input: OpenAiCostsObservationInput,
): OpenAiCostsObservationRun {
  const text = (value: string, label: string, pattern: RegExp): void => {
    if (!pattern.test(value)) throw new Error(`OpenAI Costs ${label} is invalid`);
  };
  text(input.declaredScopeId, 'declared scope id', /^[A-Za-z0-9_-]{8,200}$/);
  text(input.providerProjectRef, 'project reference', /^proj_[A-Za-z0-9_-]+$/);
  if (!Number.isSafeInteger(input.periodStartMs) || !Number.isSafeInteger(input.periodEndMs)
    || input.periodEndMs <= input.periodStartMs || (input.periodEndMs - input.periodStartMs) % 86_400_000 !== 0) {
    throw new Error('OpenAI Costs observation range must be whole UTC days');
  }
  if (!Number.isSafeInteger(input.fetchedAtMs) || input.fetchedAtMs < 0) throw new Error('OpenAI Costs fetched time is invalid');
  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 0 || input.pageCount > 64) {
    throw new Error('OpenAI Costs page count is invalid');
  }
  if (input.pageDigestChainSha256 !== null) text(input.pageDigestChainSha256, 'page digest chain', /^[a-f0-9]{64}$/);
  const succeeded = input.resultState === 'succeeded';
  if (succeeded !== input.paginationComplete) throw new Error('OpenAI Costs success state must match complete pagination');
  if (succeeded && (input.failureCode !== null || input.pageCount < 1 || input.pageDigestChainSha256 === null)) {
    throw new Error('OpenAI Costs successful observation is incomplete');
  }
  if (!succeeded && (input.failureCode === null || input.observations.length !== 0)) {
    throw new Error('OpenAI Costs failed observation cannot expose provider lines');
  }
  const run: OpenAiCostsObservationRun = {
    observationRunId: randomUUID(),
    declaredScopeId: input.declaredScopeId,
    providerProjectRef: input.providerProjectRef,
    periodStartMs: input.periodStartMs,
    periodEndMs: input.periodEndMs,
    fetchedAtMs: input.fetchedAtMs,
    paginationComplete: input.paginationComplete,
    pageCount: input.pageCount,
    pageDigestChainSha256: input.pageDigestChainSha256,
    resultState: input.resultState,
    failureCode: input.failureCode,
    providerFinality: 'undocumented',
    trust: 'provider_observation_unreconciled',
    rawRetention: 'digest_only',
    observationsStored: input.observations.length,
    sourceKind: input.sourceKind ?? 'provider_api_pull',
  };
  const seen = new Set<string>();
  for (const observation of input.observations) {
    if (observation.providerProjectRef !== run.providerProjectRef) throw new Error('OpenAI Costs observation project does not match its declared scope');
    if (!Number.isSafeInteger(observation.bucketStartMs) || !Number.isSafeInteger(observation.bucketEndMs)
      || observation.bucketEndMs - observation.bucketStartMs !== 86_400_000
      || observation.bucketStartMs < run.periodStartMs || observation.bucketEndMs > run.periodEndMs) {
      throw new Error('OpenAI Costs observation bucket is invalid');
    }
    text(observation.lineItem, 'line item', /^[^\u0000-\u001F\u007F]{1,500}$/);
    text(observation.currency, 'currency', /^[A-Z]{3}$/);
    text(observation.amountDecimal, 'amount decimal', /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
    const key = `${observation.bucketStartMs}\u0000${observation.bucketEndMs}\u0000${observation.lineItem}\u0000${observation.currency}`;
    if (seen.has(key)) throw new Error('OpenAI Costs observation has duplicate daily line grouping');
    seen.add(key);
  }
  const writeRun = db.prepare(
    `INSERT INTO openai_cost_observation_runs (
         observation_run_id, declared_scope_id, provider_project_ref, period_start_ms, period_end_ms, fetched_at_ms,
         pagination_complete, page_count, page_digest_chain_sha256, result_state, failure_code, provider_finality,
         trust, raw_retention, observations_stored, source_kind
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const writeLine = db.prepare(
    `INSERT INTO openai_cost_observation_lines (
         observation_id, observation_run_id, declared_scope_id, provider_project_ref, fetched_at_ms,
         bucket_start_ms, bucket_end_ms, line_item, currency, amount_decimal
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  runScript(db, 'BEGIN');
  try {
    writeRun.run(
      run.observationRunId, run.declaredScopeId, run.providerProjectRef, run.periodStartMs, run.periodEndMs,
      run.fetchedAtMs, run.paginationComplete ? 1 : 0, run.pageCount, run.pageDigestChainSha256, run.resultState,
      run.failureCode, run.providerFinality, run.trust, run.rawRetention, run.observationsStored,
      run.sourceKind,
    );
    for (const observation of input.observations) {
      writeLine.run(
        randomUUID(), run.observationRunId, run.declaredScopeId, run.providerProjectRef, run.fetchedAtMs,
        observation.bucketStartMs, observation.bucketEndMs, observation.lineItem, observation.currency,
        observation.amountDecimal,
      );
    }
    runScript(db, 'COMMIT');
  } catch (error) {
    runScript(db, 'ROLLBACK');
    throw error;
  }
  return run;
}

/**
 * Plan the adoption of an already-imported operator export as a Costs
 * observation, so a reconciliation can run WITHOUT an Admin credential.
 *
 * This exists because the credential was the wrong thing to be blocked on.
 * A read-only Costs pull is the better evidence and stays the recommended
 * path, but an account owner who can export a report should not be unable to
 * reconcile merely because minting an Admin key needs a different permission
 * than reading a bill. What changes is the EVIDENCE CLASS, not the
 * arithmetic: the resulting run is stamped `operator_supplied_export` and
 * carries a fifth permanent condition saying nothing in it was obtained from
 * the provider by Fiscus.
 *
 * Read-only: this computes a plan and writes nothing. Everything it cannot
 * adopt is REPORTED with its amount rather than dropped — an adoption that
 * quietly discarded an account-level credit would understate the provider
 * side and turn a missing line into a fake residual.
 */
export function planOpenAiCostsAdoption(
  db: DatabaseSync,
  input: { importId: string; declaredScopeId: string; providerProjectRef: string },
): OpenAiCostsAdoptionPlan {
  const run = billingImportRuns(db, 500).find((r) => r.importId === input.importId);
  if (!run) return { adoptable: false, refusal: 'no_such_import', detail: `no billing import ${input.importId}` };
  if (run.provider !== 'openai') {
    return { adoptable: false, refusal: 'import_is_not_openai', detail: `import ${input.importId} is for ${run.provider}` };
  }

  const all = billingEvidenceRecords(db).filter((r) => r.firstImportId === input.importId);
  if (all.length === 0) {
    // Every row was a replay of an earlier import, so this import id owns
    // none of them. Adopting it would silently observe nothing.
    return { adoptable: false, refusal: 'import_owns_no_records', detail: `import ${input.importId} inserted no new charge lines` };
  }

  const matched = all.filter((r) => r.providerProjectRef === input.providerProjectRef);
  const excludedOtherProject = all.filter((r) => r.providerProjectRef !== input.providerProjectRef);
  if (matched.length === 0) {
    return {
      adoptable: false,
      refusal: 'no_records_for_declared_project',
      detail: `no charge line in ${input.importId} carries providerProjectRef ${input.providerProjectRef}`,
    };
  }

  const currencies = [...new Set(matched.map((r) => r.currency))].sort();
  if (currencies.length > 1 || currencies[0] !== 'USD') {
    return {
      adoptable: false,
      refusal: 'records_are_not_single_currency_usd',
      detail: `the matched lines report ${currencies.join(', ')}; no rate is applied here`,
    };
  }
  const nonDaily = matched.filter((r) => r.chargePeriodEndMs - r.chargePeriodStartMs !== DAY_MS
    || r.chargePeriodStartMs % DAY_MS !== 0);
  if (nonDaily.length > 0) {
    return {
      adoptable: false,
      refusal: 'records_are_not_whole_utc_days',
      detail: `${nonDaily.length} matched line(s) do not cover exactly one UTC day; the provider bucket grain is the only grain that joins`,
    };
  }

  const byKey = new Map<string, { bucketStartMs: number; lineItem: string; micros: number }>();
  for (const record of matched) {
    const lineItem = record.sku || record.service || 'unspecified';
    const key = `${record.chargePeriodStartMs}\u0000${lineItem}`;
    const entry = byKey.get(key) ?? { bucketStartMs: record.chargePeriodStartMs, lineItem, micros: 0 };
    entry.micros += record.amountMicros;
    byKey.set(key, entry);
  }
  const observations: OpenAiCostObservation[] = [...byKey.values()]
    .sort((a, b) => (a.bucketStartMs - b.bucketStartMs) || a.lineItem.localeCompare(b.lineItem))
    .map((entry) => ({
      providerProjectRef: input.providerProjectRef,
      bucketStartMs: entry.bucketStartMs,
      bucketEndMs: entry.bucketStartMs + DAY_MS,
      lineItem: entry.lineItem,
      currency: 'USD',
      amountDecimal: microsToDecimal(entry.micros),
    }));

  const days = observations.map((o) => o.bucketStartMs);
  return {
    adoptable: true,
    importId: input.importId,
    declaredScopeId: input.declaredScopeId,
    providerProjectRef: input.providerProjectRef,
    periodStartMs: Math.min(...days),
    periodEndMs: Math.max(...days) + DAY_MS,
    fileSha256: run.fileSha256,
    // An operator declaration even when it says `complete`. Carried onto the
    // plan so a partial export cannot become a silent under-report of the
    // provider side, which would read as off-path spend that never happened.
    declaredCoverage: run.coverage,
    observations,
    matchedRecordCount: matched.length,
    matchedMicros: matched.reduce((sum, r) => sum + r.amountMicros, 0),
    excluded: {
      otherOrNoProjectRecordCount: excludedOtherProject.length,
      otherOrNoProjectMicros: excludedOtherProject.reduce((sum, r) => sum + r.amountMicros, 0),
    },
  };
}

/** Record an adoption plan as an observation. Refuses anything not adoptable. */
export function adoptOpenAiCostsFromImport(
  db: DatabaseSync,
  plan: OpenAiCostsAdoptionPlan,
  adoptedAtMs: number,
): OpenAiCostsObservationRun {
  if (!plan.adoptable) throw new Error(`refusing to adopt: ${plan.refusal} — ${plan.detail}`);
  return recordOpenAiCostsObservation(db, {
    declaredScopeId: plan.declaredScopeId,
    providerProjectRef: plan.providerProjectRef,
    periodStartMs: plan.periodStartMs,
    periodEndMs: plan.periodEndMs,
    fetchedAtMs: adoptedAtMs,
    paginationComplete: true,
    // One "page": the operator's file. Its SHA-256 is genuinely the digest of
    // the only artifact that produced these lines, so the field keeps its
    // meaning rather than being repurposed.
    pageCount: 1,
    pageDigestChainSha256: plan.fileSha256,
    resultState: 'succeeded',
    failureCode: null,
    observations: plan.observations,
    sourceKind: 'operator_supplied_export',
  });
}

/**
 * What the local side of a reconciliation would actually contain, split by
 * why each row does or does not qualify.
 *
 * Built after hitting the failure on a real machine: a ledger can hold
 * hundreds of dollars of genuine OpenAI spend and still reconcile to a local
 * side of ZERO, because every row arrived by native import rather than
 * through the proxy. Reconciliation counts only proxy traffic carrying the
 * declaration, and it has to — an imported row records the model and the cost
 * but nothing that ties it to the declared provider project, so counting it
 * would be inventing the very attribution the layer refuses to invent.
 *
 * Surfacing this BEFORE the credential step is the whole point. Discovering
 * it afterwards means someone minted an Admin key for nothing.
 */
export function openAiReconciliationCoverage(
  db: DatabaseSync,
  declaredScopeId: string | null,
): ReconciliationCoverage | null {
  const row = db.prepare(
    `SELECT
         COALESCE(SUM(CASE WHEN via = 'proxy' AND scope_capture_status = 'declared_unverified'
                            AND provider_scope_declaration_id = ? THEN cost_usd END), 0) AS onUsd,
         COALESCE(SUM(CASE WHEN via = 'proxy' AND scope_capture_status = 'declared_unverified'
                            AND provider_scope_declaration_id = ? THEN 1 END), 0) AS onReq,
         COALESCE(SUM(CASE WHEN via = 'import' THEN cost_usd END), 0) AS importedUsd,
         COALESCE(SUM(CASE WHEN via = 'import' THEN 1 END), 0) AS importedReq,
         COALESCE(SUM(CASE WHEN via = 'proxy' AND NOT (scope_capture_status = 'declared_unverified'
                            AND provider_scope_declaration_id = ?) THEN cost_usd END), 0) AS offUsd,
         COALESCE(SUM(CASE WHEN via = 'proxy' AND NOT (scope_capture_status = 'declared_unverified'
                            AND provider_scope_declaration_id = ?) THEN 1 END), 0) AS offReq,
         COUNT(*) AS total
       FROM requests WHERE provider = 'openai'`,
  ).get(declaredScopeId, declaredScopeId, declaredScopeId, declaredScopeId) as Record<string, unknown>;
  if (Number(row.total) === 0) return null;
  return {
    onDeclaredRouteUsd: Number(row.onUsd),
    onDeclaredRouteRequests: Number(row.onReq),
    importedUsd: Number(row.importedUsd),
    importedRequests: Number(row.importedReq),
    proxyOffScopeUsd: Number(row.offUsd),
    proxyOffScopeRequests: Number(row.offReq),
  };
}

/** Newest first; includes failed pulls so a finance owner can see freshness failures. */
export function openAiCostsObservationRuns(db: DatabaseSync, limit: number): OpenAiCostsObservationRun[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db.prepare(
    `SELECT observation_run_id AS observationRunId, declared_scope_id AS declaredScopeId,
              provider_project_ref AS providerProjectRef, period_start_ms AS periodStartMs, period_end_ms AS periodEndMs,
              fetched_at_ms AS fetchedAtMs, pagination_complete AS paginationComplete, page_count AS pageCount,
              page_digest_chain_sha256 AS pageDigestChainSha256, result_state AS resultState, failure_code AS failureCode,
              provider_finality AS providerFinality, trust, raw_retention AS rawRetention,
              observations_stored AS observationsStored, source_kind AS sourceKind
         FROM openai_cost_observation_runs
        ORDER BY fetched_at_ms DESC, observation_run_id DESC LIMIT ?`,
  ).all(safeLimit) as Array<Record<string, unknown>>;
  return rows.map(openAiCostsRunFromRecord);
}

/** Latest fully paginated successful snapshot only; failed runs never become a projection. */
export function latestCompleteOpenAiCostsObservation(
  db: DatabaseSync,
): { run: OpenAiCostsObservationRun; observations: OpenAiCostsObservationLine[] } | null {
  const row = db.prepare(
    `SELECT observation_run_id AS observationRunId, declared_scope_id AS declaredScopeId,
              provider_project_ref AS providerProjectRef, period_start_ms AS periodStartMs, period_end_ms AS periodEndMs,
              fetched_at_ms AS fetchedAtMs, pagination_complete AS paginationComplete, page_count AS pageCount,
              page_digest_chain_sha256 AS pageDigestChainSha256, result_state AS resultState, failure_code AS failureCode,
              provider_finality AS providerFinality, trust, raw_retention AS rawRetention,
              observations_stored AS observationsStored, source_kind AS sourceKind
         FROM openai_cost_observation_runs
        WHERE result_state = 'succeeded' AND pagination_complete = 1
        ORDER BY fetched_at_ms DESC, observation_run_id DESC LIMIT 1`,
  ).get() as Record<string, unknown> | undefined;
  if (!row) return null;
  const run = openAiCostsRunFromRecord(row);
  const observations = db.prepare(
    `SELECT observation_id AS observationId, observation_run_id AS observationRunId, declared_scope_id AS declaredScopeId,
              provider_project_ref AS providerProjectRef, fetched_at_ms AS fetchedAtMs, bucket_start_ms AS bucketStartMs,
              bucket_end_ms AS bucketEndMs, line_item AS lineItem, currency, amount_decimal AS amountDecimal
         FROM openai_cost_observation_lines
        WHERE observation_run_id = ?
        ORDER BY bucket_start_ms ASC, line_item ASC, currency ASC`,
  ).all(run.observationRunId) as Array<Record<string, unknown>>;
  return { run, observations: observations.map(openAiCostsLineFromRecord) };
}

/** Read one retained OpenAI Costs observation run and its immutable lines. */
export function openAiCostsObservationById(
  db: DatabaseSync,
  observationRunId: string,
): { run: OpenAiCostsObservationRun; observations: OpenAiCostsObservationLine[] } | null {
  if (typeof observationRunId !== 'string' || observationRunId.trim().length === 0) throw new Error('OpenAI Costs observation run id is required');
  const row = db.prepare(
    `SELECT observation_run_id AS observationRunId, declared_scope_id AS declaredScopeId,
             provider_project_ref AS providerProjectRef, period_start_ms AS periodStartMs, period_end_ms AS periodEndMs,
             fetched_at_ms AS fetchedAtMs, pagination_complete AS paginationComplete, page_count AS pageCount,
             page_digest_chain_sha256 AS pageDigestChainSha256, result_state AS resultState, failure_code AS failureCode,
             provider_finality AS providerFinality, trust, raw_retention AS rawRetention,
             observations_stored AS observationsStored, source_kind AS sourceKind
        FROM openai_cost_observation_runs WHERE observation_run_id = ?`,
  ).get(observationRunId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const run = openAiCostsRunFromRecord(row);
  const observations = db.prepare(
    `SELECT observation_id AS observationId, observation_run_id AS observationRunId, declared_scope_id AS declaredScopeId,
            provider_project_ref AS providerProjectRef, fetched_at_ms AS fetchedAtMs, bucket_start_ms AS bucketStartMs,
            bucket_end_ms AS bucketEndMs, line_item AS lineItem, currency, amount_decimal AS amountDecimal
       FROM openai_cost_observation_lines WHERE observation_run_id = ?
      ORDER BY bucket_start_ms ASC, line_item ASC, currency ASC`,
  ).all(observationRunId) as Array<Record<string, unknown>>;
  return { run, observations: observations.map(openAiCostsLineFromRecord) };
}

/** Status has no financial total by design, so independent snapshots cannot be double counted. */
export function openAiCostsObservationStatus(db: DatabaseSync): OpenAiCostsObservationStatus {
  const latest = openAiCostsObservationRuns(db, 1)[0] ?? null;
  const latestComplete = latestCompleteOpenAiCostsObservation(db)?.run ?? null;
  return { latestRun: latest, latestCompleteRun: latestComplete, reconciliationStatus: 'not_reconciled' };
}

/**
 * Read-only local capture coverage for the newest complete Costs snapshot.
 * It deliberately returns no provider total and no variance: a local route
 * declaration does not prove provider-account ownership or off-path coverage.
 */
export function openAiCostsCaptureCoverage(
  db: DatabaseSync,
  requestsInRange: RequestsInRange,
): OpenAiCostsCaptureCoverage | null {
  const latest = latestCompleteOpenAiCostsObservation(db);
  if (!latest) return null;
  return buildOpenAiCostsCaptureCoverage({
    run: latest.run,
    observations: latest.observations,
    requests: requestsInRange(latest.run.periodStartMs, latest.run.periodEndMs),
  });
}

/**
 * Per-day provider totals from the newest COMPLETE observation of this period
 * that is not the one being reconciled — the evidence behind
 * `snapshotStability`. Returns null when no independent observation exists,
 * which is honestly different from "two observations agreed".
 *
 * Matched on the exact period and scope: a snapshot of a different range is
 * not an independent observation of this one, and comparing them would
 * manufacture instability out of a boundary difference.
 */
export function priorOpenAiCostsDayTotals(
  db: DatabaseSync,
  exceptRunId: string,
  scopeId: string,
  periodStartMs: number,
  periodEndMs: number,
): Map<number, number> | null {
  const row = db.prepare(
    `SELECT observation_run_id AS observationRunId
         FROM openai_cost_observation_runs
        WHERE result_state = 'succeeded' AND pagination_complete = 1
          AND observation_run_id <> ? AND declared_scope_id = ?
          AND period_start_ms = ? AND period_end_ms = ?
        ORDER BY fetched_at_ms DESC, observation_run_id DESC LIMIT 1`,
  ).get(exceptRunId, scopeId, periodStartMs, periodEndMs) as Record<string, unknown> | undefined;
  if (!row) return null;
  const lines = db.prepare(
    `SELECT bucket_start_ms AS bucketStartMs, amount_decimal AS amountDecimal
         FROM openai_cost_observation_lines WHERE observation_run_id = ?`,
  ).all(String(row.observationRunId)) as Array<Record<string, unknown>>;
  const totals = new Map<number, number>();
  for (const line of lines) {
    const day = Number(line.bucketStartMs);
    totals.set(day, (totals.get(day) ?? 0) + usdMicros(String(line.amountDecimal), 'provider amount'));
  }
  return totals;
}

/**
 * Compare the newest complete provider snapshot with the local ledger.
 *
 * Read-only: computing a reconciliation does not record one. `saveReconciliationRun`
 * is a separate, explicit step, so an operator can look at a variance before
 * it becomes part of the durable record.
 */
export function reconcileOpenAiCosts(
  db: DatabaseSync,
  requestsInRange: RequestsInRange,
  opts: { materialityUsd?: number; now?: number },
  exactRequestsInRange: RequestsInRange = requestsInRange,
): ReconciliationResult | null {
  const latest = latestCompleteOpenAiCostsObservation(db);
  if (!latest) return null;
  return computeOpenAiReconciliation({
    run: latest.run,
    observations: latest.observations,
    requests: exactRequestsInRange(latest.run.periodStartMs, latest.run.periodEndMs),
    priorDayTotals: priorOpenAiCostsDayTotals(
      db,
      latest.run.observationRunId,
      latest.run.declaredScopeId,
      latest.run.periodStartMs,
      latest.run.periodEndMs,
    ),
    materialityUsd: opts.materialityUsd,
    now: opts.now,
  });
}

/** Persist a computed reconciliation as an immutable derived record. */
export function saveReconciliationRun(db: DatabaseSync, result: ReconciliationRun, computedAtMs: number): string {
  const id = randomUUID();
  db
    .prepare(
      `INSERT INTO reconciliation_runs (
            reconciliation_run_id, observation_run_id, declared_scope_id, provider_project_ref,
            period_start_ms, period_end_ms, computed_at_ms, currency, materiality_usd,
            provider_reported_micros, local_captured_micros, unexplained_variance_micros,
            snapshot_stability, trust, result_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      result.observationRunId,
      result.declaredScopeId,
      result.providerProjectRef,
      result.periodStartMs,
      result.periodEndMs,
      computedAtMs,
      result.currency,
      result.materialityUsd,
      result.providerReportedMicros,
      result.localCapturedMicros,
      result.unexplainedVarianceMicros,
      result.snapshotStability,
      result.trust,
      JSON.stringify(result),
    );
  return id;
}

/** Recorded reconciliation runs, newest first. */
export function reconciliationRuns(
  db: DatabaseSync,
  limit: number,
): Array<{ reconciliationRunId: string; computedAtMs: number; result: ReconciliationRun }> {
  const rows = db
    .prepare(
      `SELECT reconciliation_run_id AS reconciliationRunId, computed_at_ms AS computedAtMs, result_json AS resultJson
           FROM reconciliation_runs ORDER BY computed_at_ms DESC, reconciliation_run_id DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    reconciliationRunId: String(row.reconciliationRunId),
    computedAtMs: Number(row.computedAtMs),
    result: JSON.parse(String(row.resultJson)) as ReconciliationRun,
  }));
}

/**
 * Create (or recover) an immutable local OpenAI route declaration and make it
 * active for future matching proxy rows. This is intentionally local operator
 * provenance, never a provider credential/account verification.
 */
export function setOpenAiScope(
  db: DatabaseSync,
  input: {
    billingAccountRef: string;
    providerProjectRef?: string | null;
    upstreamBase: string;
    declaredAtMs?: number;
    activatedAtMs?: number;
  },
): ProviderScopeDeclaration {
  const declaration = newOpenAiScopeDeclaration(input);
  const select = db.prepare(
    `SELECT declaration_id AS declarationId, billing_account_ref AS billingAccountRef,
              provider_project_ref AS providerProjectRef, upstream_fingerprint AS upstreamFingerprint,
              upstream_display AS upstreamDisplay, declared_at_ms AS declaredAtMs
         FROM provider_scope_declarations
        WHERE provider = 'openai' AND billing_account_ref = ?
          AND provider_project_ref IS ? AND upstream_fingerprint = ?`,
  );
  runScript(db, 'BEGIN');
  try {
    let record = select.get(
      declaration.billingAccountRef,
      declaration.providerProjectRef,
      declaration.upstreamFingerprint,
    ) as Record<string, unknown> | undefined;
    // SQLite's UNIQUE treats NULL values as distinct. Look up first so the
    // optional provider project cannot create duplicate declarations on each
    // idempotent `scope set` invocation.
    if (!record) {
      db.prepare(
        `INSERT INTO provider_scope_declarations (
             declaration_id, provider, billing_account_ref, provider_project_ref, upstream_fingerprint,
             upstream_display, declared_at_ms, trust
           ) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        declaration.declarationId, declaration.provider, declaration.billingAccountRef, declaration.providerProjectRef,
        declaration.upstreamFingerprint, declaration.upstreamDisplay, declaration.declaredAtMs, declaration.trust,
      );
      record = select.get(
        declaration.billingAccountRef,
        declaration.providerProjectRef,
        declaration.upstreamFingerprint,
      ) as Record<string, unknown> | undefined;
    }
    if (!record) throw new Error('could not persist the local OpenAI scope declaration');
    const persisted = scopeDeclarationFromRecord(record);
    db.prepare(
      `INSERT INTO active_provider_scope_routes (provider, declaration_id, upstream_fingerprint, activated_at_ms)
         VALUES ('openai',?,?,?)
         ON CONFLICT(provider) DO UPDATE SET declaration_id=excluded.declaration_id,
           upstream_fingerprint=excluded.upstream_fingerprint, activated_at_ms=excluded.activated_at_ms`,
    ).run(persisted.declarationId, persisted.upstreamFingerprint, input.activatedAtMs ?? Date.now());
    runScript(db, 'COMMIT');
    return persisted;
  } catch (error) {
    runScript(db, 'ROLLBACK');
    throw error;
  }
}

/** Stop attaching the local scope to future OpenAI-proxy rows. Historical rows are immutable. */
export function clearOpenAiScope(db: DatabaseSync): boolean {
  const info = db.prepare(`DELETE FROM active_provider_scope_routes WHERE provider = 'openai'`).run();
  return Number(info.changes ?? 0) > 0;
}

/** Active local declaration, if one exists. It still has unverified trust. */
export function activeOpenAiScope(db: DatabaseSync): ProviderScopeDeclaration | null {
  const row = db.prepare(
    `SELECT d.declaration_id AS declarationId, d.billing_account_ref AS billingAccountRef,
              d.provider_project_ref AS providerProjectRef, d.upstream_fingerprint AS upstreamFingerprint,
              d.upstream_display AS upstreamDisplay, d.declared_at_ms AS declaredAtMs
         FROM active_provider_scope_routes a
         JOIN provider_scope_declarations d ON d.declaration_id = a.declaration_id
        WHERE a.provider = 'openai'`,
  ).get() as Record<string, unknown> | undefined;
  return row ? scopeDeclarationFromRecord(row) : null;
}

/** Snapshot only when a request's resolved OpenAI endpoint exactly matches the active declaration. */
export function matchingOpenAiScope(db: DatabaseSync, upstreamBase: string): ProviderScopeDeclaration | null {
  let fingerprint: string;
  try {
    fingerprint = normalizeOpenAiUpstream(upstreamBase).fingerprint;
  } catch {
    return null;
  }
  const active = activeOpenAiScope(db);
  return active?.upstreamFingerprint === fingerprint ? active : null;
}
