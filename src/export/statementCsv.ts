/**
 * The monthly statement as a spreadsheet.
 *
 * Built from the same payload the Statement page renders, so the file and the
 * screen cannot disagree. The four claims stay four sections: each row names
 * its claim, its basis and its own dates, and there is no total row, because
 * metered usage, provider-billed cost, allocated cost and realized value are
 * different questions and adding them answers none of them.
 */

import { toCsv } from './csv.ts';
import type { StatementPayload, StatementBilledRun } from '../dashboard/shared-types.ts';

export const STATEMENT_CSV_COLUMNS = [
  'claim', 'item', 'amountUsd', 'amountMicros', 'requests', 'basis',
  'periodStartUtc', 'periodEndUtc', 'coversMonth', 'recordedAtUtc', 'runId', 'note',
] as const;

const iso = (ms: number): string => new Date(ms).toISOString();
const microsUsd = (micros: number): string => {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  return `${sign}${Math.trunc(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, '0')}`;
};

function billedSource(kind: string | null | undefined): string {
  if (kind === 'operator_supplied_export') return 'provider figure from an export the operator supplied';
  if (kind === 'provider_api_pull') return 'provider figure read from the provider';
  return 'provider figure, source not recorded';
}

function billedNote(r: StatementBilledRun): string {
  const notes: string[] = [];
  if (r.snapshotStability === 'changed_across_observations') notes.push('conflicted: the provider reported different figures for the same days');
  else if (r.snapshotStability === null) notes.push('snapshot stability not recorded');
  if (r.offPathBound === 'none_local_estimate_exceeds_provider') notes.push('local estimate exceeds the provider total, so the remainder bounds nothing');
  else if (r.offPathBound === 'unknown_local_total_truncated_by_retention') notes.push('retention deleted local rows, so the remainder bounds nothing');
  else if (r.offPathBound === null) notes.push('remainder bound not recorded');
  if (!r.coversWholeMonth) notes.push('figures are for this run\'s own period, not prorated to the month');
  return notes.join('; ');
}

/** One calendar month, four claims, never summed. */
export function statementToCsv(s: StatementPayload): string {
  const month = [iso(s.period.startMs), iso(s.period.endMs)];
  const rows: unknown[][] = [];
  rows.push(['statement', s.period.label, '', '', '', s.demo ? 'sample data, not measured' : 'local ledger',
    ...month, '', s.generatedAt, '',
    'Four separate claims. Do not add the sections together. The month runs from local midnight; times are shown in UTC.' + (s.period.complete ? '' : ' Month in progress: figures so far.')]);

  const m = s.metered;
  const exact = m.basis.exactShare === null ? '' : `; ${Math.round(m.basis.exactShare * 100)}% at each model's own list rate`;
  const basis = `local estimate: ${m.basis.headlineLabel.toLowerCase()}${exact}`;
  const retention = m.retention.truncated ? `retention deleted ${m.retention.rowsRemoved} row(s) in this period; covers what survived` : '';
  rows.push(['metered', 'total', m.costUsd.toFixed(6), '', m.requests, basis, ...month, 'yes', '', '', retention]);
  for (const p of m.byProject) rows.push(['metered', `project: ${p.label}`, p.costUsd.toFixed(6), '', p.requests, 'local estimate', ...month, 'yes', '', '', '']);
  for (const x of m.byModel) rows.push(['metered', `model: ${x.provider ? `${x.provider}/` : ''}${x.label}`, x.costUsd.toFixed(6), '', x.requests, 'local estimate', ...month, 'yes', '', '', '']);

  const b = s.billed;
  if (b.runs.length === 0) {
    rows.push(['billed', 'not established', '', '', '', '', ...month, 'no', '', '',
      b.scanComplete ? 'no comparison with a provider bill covers this month' : 'none among the most recent comparisons; an older one may exist']);
  }
  for (const r of b.runs) {
    const own = [iso(r.periodStartMs), iso(r.periodEndMs), r.coversWholeMonth ? 'yes' : 'no', iso(r.computedAtMs), r.reconciliationRunId];
    const project = r.providerProjectRef ? ` (${r.providerProjectRef})` : '';
    const note = billedNote(r);
    rows.push(['billed', `provider reported${project}`, microsUsd(r.providerReportedMicros), r.providerReportedMicros, '', billedSource(r.providerSourceKind), ...own, note]);
    rows.push(['billed', `measured locally for comparison${project}`, microsUsd(r.localCapturedMicros), r.localCapturedMicros, '', 'local estimate, same scope and days', ...own, note]);
    rows.push(['billed', `not explained${project}`, microsUsd(r.unexplainedVarianceMicros), r.unexplainedVarianceMicros, '', 'provider reported minus measured', ...own, note]);
  }

  const a = s.allocated;
  const names = new Map(a.costCentres.map((c) => [c.costCentreId, c.name]));
  if (a.runs.length === 0) {
    rows.push(['allocated', 'not established', '', '', '', '', ...month, 'no', '', '',
      a.scanComplete ? 'no recorded split covers this month' : 'none among the most recent splits; an older one may exist']);
  }
  for (const r of a.runs) {
    const own = [iso(r.periodStartMs), iso(r.periodEndMs), r.coversWholeMonth ? 'yes' : 'no', iso(r.computedAtMs), r.allocationRunId];
    const note = r.coversWholeMonth ? '' : 'figures are for this run\'s own period, not prorated to the month';
    for (const c of r.byCostCentre) {
      rows.push(['allocated', `cost centre: ${names.get(c.costCentreId) ?? c.costCentreId}`, microsUsd(c.allocatedMicros), c.allocatedMicros, c.requestCount, 'showback split of the local estimate', ...own, note]);
    }
    if (r.unallocatedMicros !== 0) rows.push(['allocated', 'not allocated', microsUsd(r.unallocatedMicros), r.unallocatedMicros, '', 'showback split of the local estimate', ...own, note]);
  }

  rows.push(['realized', 'not computed per month', '', '', '', '', ...month, 'no', '', '', s.realized.reason]);
  rows.push(['close', s.close.status, '', '', '', 'economic period close', ...month, '', '', s.close.activeFinalizationId ?? '', '']);
  return toCsv([...STATEMENT_CSV_COLUMNS], rows);
}
