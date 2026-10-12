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

function sizeLimitError(): Error {
  return new Error(`billing evidence exceeds the ${MAX_BILLING_IMPORT_BYTES / (1024 * 1024)} MiB v1 import limit`);
}

/** Read, size-gate, hash, and strictly validate a Segreant billing-evidence v1 JSON file. */
export function readBillingImportFile(path: string): { input: BillingImportInput; preview: BillingImportPreview } {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('billing import --file must point to a regular local file');
  // Refuse before reading: a multi-gigabyte file must never be pulled into memory.
  if (stat.size > MAX_BILLING_IMPORT_BYTES) throw sizeLimitError();
  return parseBillingImportText(readFileSync(path), basename(path));
}

/**
 * The validation readBillingImportFile applies, over bytes already in hand. The
 * dashboard import route calls this directly; the CLI reaches it through
 * readBillingImportFile, so the two surfaces give the same preview for the same bytes.
 */
export function parseBillingImportText(raw: Buffer, fileName: string): { input: BillingImportInput; preview: BillingImportPreview } {
  if (raw.byteLength > MAX_BILLING_IMPORT_BYTES) throw sizeLimitError();
  let value: unknown;
  try {
    // A UTF-8 byte-order mark is not JSON, and Windows tools write one by
    // default, so an export saved from Notepad was refused as "not valid JSON".
    // It is skipped for parsing only: the digest below is over the file's own
    // bytes, mark included, so the same file still has one identity.
    const text = raw.toString('utf8');
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch (error) {
    throw new Error(`billing evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = parseBillingImportDocument(value);
  const fileSha256 = createHash('sha256').update(raw).digest('hex');
  const fileSizeBytes = raw.byteLength;
  const input: BillingImportInput = { document, fileName, fileSha256, fileSizeBytes, format: 'json' };
  return { input, preview: preview(document, fileName, fileSha256, fileSizeBytes) };
}
