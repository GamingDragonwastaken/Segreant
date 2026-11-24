/** What an import changed or could not read, in the words the CLI and the dashboard both use. */
import type { ImportSummary } from './importShared.ts';

export interface ImportNote {
  label: string;
  text: string;
  /** Usage is missing from the totals, or differs from what a log says. */
  missing: boolean;
}

const count = (n: number): string => n.toLocaleString('en-US');

export function importNotes(sum: ImportSummary): ImportNote[] {
  const notes: ImportNote[] = [];
  if (sum.unreadFiles) {
    notes.push({ label: 'Not read', missing: true, text: `${count(sum.unreadFiles)} log file(s) could not be read to the end; their remaining usage is not counted. The next import tries again.` });
  }
  const cut = (sum.truncatedFiles ?? 0) + (sum.truncatedLines ?? 0) + (sum.truncatedRows ?? 0);
  if (cut > 0) {
    const parts = [[sum.truncatedFiles, 'file scans'], [sum.truncatedLines, 'lines'], [sum.truncatedRows, 'rows']] as const;
    notes.push({ label: 'Cut short', missing: true, text: `A size limit was reached (${parts.filter(([n]) => n).map(([n, what]) => `${count(n!)} ${what}`).join(', ')}); the usage past it is not counted.` });
  }
  if (sum.completedObservations) {
    notes.push({ label: 'Completed', missing: false, text: `${count(sum.completedObservations)} request(s) recorded earlier from an unfinished log line, or without their service tier, now carry what the log says.` });
  }
  if (sum.retractedObservations) {
    notes.push({ label: 'Corrected', missing: false, text: `${count(sum.retractedObservations)} request(s) an earlier import counted a second time, from a forked session's copy of its parent's log, now count once.` });
  }
  if (sum.closedPeriodObservations) {
    notes.push({ label: 'Closed books', missing: true, text: `${count(sum.closedPeriodObservations)} correction(s) fall in an accounting period you have closed and were not made. Reopen the period, then import again.` });
  }
  if (sum.conflictingObservations) {
    notes.push({ label: 'Conflicts', missing: true, text: `${count(sum.conflictingObservations)} request(s) already recorded with different usage; kept the first record, left these out.` });
  }
  return notes;
}
