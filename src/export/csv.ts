/**
 * Data export — getting the metered numbers out for finance/BI.
 *
 * A governance tool whose data is trapped inside it isn't usable by the people
 * who own the budget. This serializes the request ledger to CSV (spreadsheet-
 * native) or leaves it as JSON. Pure string building, no dependencies.
 */

import type { RequestRow } from '../store/db.ts';

/** RFC-4180-ish cell: quote when it contains a comma, quote, or newline; double internal quotes. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}

// `project` is the label recorded at metering time; `projectCanonical` is what it
// rolls up into once aliases are applied — the same grouping the dashboard totals
// by. Both ship, because summing the raw column would disagree with the product's
// own per-project figures as soon as an alias existed, and shipping only the
// canonical would drop the recorded evidence.
const REQUEST_COLUMNS = [
  'tsIso', 'tsEpochMs', 'provider', 'model', 'project', 'projectCanonical', 'attributionBasis', 'user', 'source', 'sessionId',
  'inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'reasoningTokens',
  'costUsd', 'estimated', 'costBasis', 'rateCardSha256', 'rateCardSourceKind',
  'rateMatchKind', 'rateMatchProvider', 'rateMatchModel', 'streamed', 'statusCode', 'durationMs',
  'scopeCaptureStatus', 'providerScopeDeclarationId', 'requestId',
];

/** The request ledger as CSV — one row per metered request, BI-ready. */
export function requestsToCsv(rows: RequestRow[]): string {
  return toCsv(
    REQUEST_COLUMNS,
    rows.map((r) => [
      new Date(r.tsEpochMs).toISOString(), r.tsEpochMs, r.provider, r.model, r.project,
      r.projectCanonical ?? r.project, r.attributionBasis ?? 'legacy_unknown', r.user ?? '', r.source ?? '', r.sessionId ?? '',
      r.inputTokens, r.outputTokens, r.cacheWriteTokens, r.cacheReadTokens, r.reasoningTokens ?? 0,
      r.costUsd, r.estimated ? 1 : 0, r.pricing?.costBasis ?? 'legacy_unknown', r.pricing?.rateCardSha256 ?? '',
      r.pricing?.rateCardSourceKind ?? 'legacy_unknown', r.pricing?.rateMatchKind ?? 'legacy_unknown',
      r.pricing?.rateMatchProvider ?? '', r.pricing?.rateMatchModel ?? '', r.streamed ? 1 : 0,
      r.statusCode ?? '', r.durationMs ?? '', r.scopeCaptureStatus ?? 'legacy_unknown', r.providerScopeDeclarationId ?? '', r.requestId,
    ]),
  );
}
