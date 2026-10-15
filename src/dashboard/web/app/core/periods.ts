/**
 * Allocation periods in local time, as the ISO strings the server parses. One
 * copy, shared by the Allocate page and the run drawer, so both mean the same
 * days by "last month" and both treat a chosen last day as included.
 */

/** A `yyyy-mm-dd` date input as the local midnight it names, in ISO form. */
export function localMidnightIso(day: string): string {
  return new Date(`${day}T00:00:00`).toISOString();
}

/** The local midnight after a `yyyy-mm-dd` day: the exclusive end of an inclusive range. */
export function dayAfterIso(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** Month boundaries in local time, as ISO strings the server parses. */
export function monthRange(offset: number): { from: string; to: string; label: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = offset === 0 ? now : new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) + (offset === 0 ? ' so far' : ''),
  };
}

/** Why spend stayed unallocated, in plain words. */
export const REASON_WORDS: Record<string, string> = {
  no_matching_rule: 'no rule claimed it',
  no_driver_for_proportional_pool: 'a shared pool with nothing directly allocated to split it by',
  target_cost_centre_archived: 'its cost centre was archived',
};
