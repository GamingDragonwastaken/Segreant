/** Local, operator-driven billing-evidence file reader. No provider network or credentials. */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { parseBillingImportDocument, type NormalizedBillingImport } from './types.ts';
import type { BillingImportInput } from '../store/db.ts';

export const MAX_BILLING_IMPORT_BYTES = 20 * 1024 * 1024;

export interface BillingImportPreview {
  schemaVersion: number;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  source: {
    system: 'operator-export';
    provider: 'openai';
    exportId: string;
    billingAccountRef: string;
    exportedAtMs: number;
    periodStartMs: number;
    periodEndMs: number;
    coverage: 'complete' | 'partial' | 'unknown';
  };
  recordsSeen: number;
  providerReportedUsdMicros: number;
  byChargeType: Record<string, number>;
  reconciliationStatus: 'not_reconciled';
}

function preview(document: NormalizedBillingImport, fileName: string, fileSha256: string, fileSizeBytes: number): BillingImportPreview {
  const byChargeType: Record<string, number> = {};
  let providerReportedUsdMicros = 0;
  for (const record of document.records) {
    providerReportedUsdMicros += record.amountMicros;
    byChargeType[record.chargeType] = (byChargeType[record.chargeType] ?? 0) + record.amountMicros;
  }
  return {
    schemaVersion: document.schemaVersion,
    fileName,
    fileSha256,
    fileSizeBytes,
    source: {
      system: document.source.system,
      provider: document.source.provider,
      exportId: document.source.exportId,
      billingAccountRef: document.source.billingAccountRef,
      exportedAtMs: document.exportedAtMs,
      periodStartMs: document.periodStartMs,
      periodEndMs: document.periodEndMs,
      coverage: document.source.coverage,
    },
    recordsSeen: document.records.length,
    providerReportedUsdMicros,
    byChargeType,
    reconciliationStatus: 'not_reconciled',
  };
}

/** Read, size-gate, hash, and strictly validate a Fiscus billing-evidence v1 JSON file. */
export function readBillingImportFile(path: string): { input: BillingImportInput; preview: BillingImportPreview } {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('billing import --file must point to a regular local file');
  if (stat.size > MAX_BILLING_IMPORT_BYTES) {
    throw new Error(`billing evidence exceeds the ${MAX_BILLING_IMPORT_BYTES / (1024 * 1024)} MiB v1 import limit`);
  }
  const raw = readFileSync(path);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`billing evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = parseBillingImportDocument(value);
  const fileName = basename(path);
  const fileSha256 = createHash('sha256').update(raw).digest('hex');
  const input: BillingImportInput = { document, fileName, fileSha256, fileSizeBytes: stat.size, format: 'json' };
  return { input, preview: preview(document, fileName, fileSha256, stat.size) };
}
