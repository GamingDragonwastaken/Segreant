/** Spreadsheet-safe export for immutable provider-billing evidence. */

import { formatUsdMicros } from '../billing/types.ts';
import type { BillingEvidenceRecord } from '../store/db.ts';

function cell(value: unknown, text = false): string {
  if (value === null || value === undefined) return '';
  let rendered = String(value);
  // Imported identifiers/descriptions are operator-supplied text. Prefix the
  // four spreadsheet formula starters so opening a CSV cannot evaluate them.
  if (text && /^[=+\-@]/.test(rendered)) rendered = `'${rendered}`;
  return /[",\n\r]/.test(rendered) ? `"${rendered.replace(/"/g, '""')}"` : rendered;
}

const COLUMNS = [
  'sourceSystem', 'billingAccountRef', 'sourceRecordId', 'sourceRecordSha256', 'firstImportId', 'sourceExportId',
  'provider', 'providerProjectRef', 'service', 'sku', 'model', 'region', 'observedAt', 'chargePeriodStart',
  'chargePeriodEnd', 'chargeType', 'currency', 'amountUsd', 'amountMicros', 'usageUnit', 'usageQuantity',
  'costBasis', 'trust',
];

/** This export is separate from request-ledger CSV and never adds provider totals to metered estimates. */
export function billingEvidenceToCsv(rows: BillingEvidenceRecord[]): string {
  const lines = [COLUMNS.map((column) => cell(column)).join(',')];
  for (const row of rows) {
    lines.push([
      row.sourceSystem, row.billingAccountRef, row.sourceRecordId, row.sourceRecordSha256, row.firstImportId,
      row.sourceExportId, row.provider, row.providerProjectRef, row.service, row.sku, row.model, row.region,
      new Date(row.observedAtMs).toISOString(), new Date(row.chargePeriodStartMs).toISOString(),
      new Date(row.chargePeriodEndMs).toISOString(), row.chargeType, row.currency, formatUsdMicros(row.amountMicros),
      row.amountMicros, row.usageUnit, row.usageQuantity, row.costBasis, row.trust,
    ].map((value, index) => cell(value, ![12, 13, 14, 17, 18].includes(index))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
