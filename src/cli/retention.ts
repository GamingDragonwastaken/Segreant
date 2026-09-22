/**
 * One sentence, in one place, for a window that reaches behind what retention
 * deleted.
 *
 * `fiscus prune` deletes request rows on the operator's own retention policy.
 * After D-170 the boundary is recorded; after D-171 the window surfaces read
 * it. The wording lives here rather than at each call site so that three
 * commands cannot end up describing the same fact three ways -- and so that the
 * SILENT case is written once too: with no boundary on record there is nothing
 * to say, and saying something anyway would turn an unknown into a claim.
 */

import type { WindowRetentionCoverage } from '../store/db.ts';

/**
 * The disclosure for a truncated window, or null when there is nothing to
 * disclose.
 *
 * Null covers both honest silences: a window entirely inside the retained
 * period, and a ledger with no prune on record at all. They are different
 * states -- the caller has `prunedBeforeMs` if it needs to tell them apart --
 * but neither licenses a sentence about deleted data.
 */
export function retentionNotice(coverage: WindowRetentionCoverage): string | null {
  if (!coverage.truncated || coverage.prunedBeforeMs === null) return null;
  const boundary = new Date(coverage.prunedBeforeMs).toISOString();
  const rows = coverage.rowsRemoved === 1 ? '1 row' : `${coverage.rowsRemoved} rows`;
  return `This window starts before ${boundary}, and ${rows} older than that were deleted by retention. `
    + 'Totals below cover what survived, not everything that was metered.';
}
