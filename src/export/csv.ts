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

const REQUEST_COLUMNS = [
  'tsIso', 'tsEpochMs', 'provider', 'model', 'project', 'user', 'sessionId',
  'inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'reasoningTokens',
  'costUsd', 'estimated', 'streamed', 'statusCode', 'durationMs', 'requestId',
];

/** The request ledger as CSV — one row per metered request, BI-ready. */
export function requestsToCsv(rows: RequestRow[]): string {
  return toCsv(
    REQUEST_COLUMNS,
    rows.map((r) => [
      new Date(r.tsEpochMs).toISOString(), r.tsEpochMs, r.provider, r.model, r.project, r.user ?? '', r.sessionId ?? '',
      r.inputTokens, r.outputTokens, r.cacheWriteTokens, r.cacheReadTokens, r.reasoningTokens ?? 0,
      r.costUsd, r.estimated ? 1 : 0, r.streamed ? 1 : 0, r.statusCode ?? '', r.durationMs ?? '', r.requestId,
    ]),
  );
}
