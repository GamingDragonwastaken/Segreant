/**
 * One recorded allocation run as a spreadsheet a budget owner can hand on.
 *
 * Built from the run exactly as it was recorded, never recomputed: a fresh
 * computation under today's rules could disagree with the split someone
 * already reviewed. Every money row is a part of the run's total, so the
 * amount column adds up to the total to the microdollar and summing it is
 * safe. The total itself is stated in the first row's note rather than given
 * a row of its own, which would double any column sum.
 *
 * This is showback: a split of Segreant's own cost estimate. It is not a
 * provider bill and is never added to metered or billed figures.
 */

import { toCsv } from './csv.ts';
import type { AllocationRunResult } from '../alloc/apply.ts';

export const ALLOCATION_CSV_COLUMNS = [
  'section', 'costCentre', 'costCentreId', 'ruleId', 'ruleVersion', 'method', 'shareOfRule',
  'amountUsd', 'amountMicros', 'requests', 'basis', 'periodStartUtc', 'periodEndUtc',
  'runId', 'recordedAtUtc', 'note',
] as const;

const BASIS = 'showback split of the local estimate';

const REASONS: Record<string, string> = {
  no_matching_rule: 'no rule claimed it',
  no_driver_for_proportional_pool: 'a shared pool with nothing directly allocated to split it by',
  target_cost_centre_archived: 'its cost centre was archived',
};

const METHODS: Record<string, string> = {
  direct: 'all to one centre',
  fixed_split: 'fixed shares',
  proportional_to_direct: 'in proportion to direct spend',
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** Exact decimal dollars from integer microdollars, with no float in between. */
export function microsToUsd(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  return `${sign}${Math.trunc(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, '0')}`;
}

export interface AllocationCsvRun {
  allocationRunId: string;
  computedAtMs: number;
  result: AllocationRunResult;
}

export function allocationRunToCsv(run: AllocationCsvRun, nameOf: (costCentreId: string) => string, demo: boolean): string {
  const r = run.result;
  const own = [iso(r.periodStartMs), iso(r.periodEndMs), run.allocationRunId, iso(run.computedAtMs)];
  const notes = [
    `Total estimated spend in the period: $${microsToUsd(r.totalMicros)}. The rows below add up to it exactly.`,
    'Showback: a split of Segreant\'s own cost estimate, not a provider bill. Do not add it to metered or billed figures.',
  ];
  if (demo) notes.push('Sample data, not measured.');
  if (r.retention === undefined) notes.push('Recorded before retention was tracked: whether rows were deleted from this period is unknown.');
  else if (r.retention.truncated) notes.push('Retention deleted request rows from inside this period; the split covers what survived, so the unallocated part may be understated.');
  if (!r.conserves) notes.push('This run did not conserve: allocated plus unallocated differs from the total. Do not rely on it.');

  const rows: unknown[][] = [];
  rows.push(['run', '', '', '', '', '', '', '', '', '', BASIS, ...own, notes.join(' ')]);
  for (const line of r.lines) {
    rows.push(['allocated', nameOf(line.costCentreId), line.costCentreId, line.ruleId, line.ruleVersion,
      METHODS[line.method] ?? line.method, (line.ratioParts / 1_000_000).toFixed(6),
      microsToUsd(line.allocatedMicros), line.allocatedMicros, line.requestCount,
      `${BASIS}; underlying cost basis ${line.sourceBasis}`, ...own, '']);
  }
  for (const u of r.unallocated) {
    const top = u.topProjects.length > 0
      ? `mostly ${u.topProjects.map((p) => `${p.project} ($${microsToUsd(p.micros)})`).join(', ')}`
      : '';
    rows.push(['unallocated', '', '', '', '', '', '', microsToUsd(u.micros), u.micros, u.requestCount,
      `${BASIS}; underlying cost basis ${u.sourceBasis}`, ...own,
      [`not allocated: ${REASONS[u.reason] ?? u.reason.replace(/_/g, ' ')}`, top].filter(Boolean).join('; ')]);
  }
  return toCsv([...ALLOCATION_CSV_COLUMNS], rows);
}
