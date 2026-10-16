/**
 * How a reconciliation is said: what its residual bounds, and which days it
 * covers. One copy, shared by the Close page and the reconcile drawer, so a
 * comparison reads the same wherever it is previewed or recorded.
 */

import type { BillingPayload } from './api.ts';
import { date } from './fmt.ts';

/**
 * What the recorded residual actually bounds, from the run's own `offPathBound`.
 *
 * Absent means a run written before the field existed. That is not a licence to
 * assume the favourable branch: it says the condition was never recorded, which
 * is the whole reason the field exists.
 */
export type ResidualBound = NonNullable<
  NonNullable<NonNullable<BillingPayload['reconciliation']>['runs']>[number]['result']['offPathBound']
>;

/**
 * A `Record` rather than an if-chain, keyed by the wire's own union.
 *
 * That is the gate: adding a state to `offPathBound` in `shared-types.ts`
 * without a rendering here fails the BROWSER typecheck. With an if-chain the
 * new state fell through to the "older than the check" sentence below, which
 * would have said a fresh run predates a field it carries — an unrecognised
 * value rendered as an absent one, which is the defect class this screen keeps
 * finding.
 */
export const RESIDUAL_BOUND_WORDS: Readonly<Record<ResidualBound, { precise: string; plain: string }>> = {
  none_local_estimate_exceeds_provider: {
    precise: 'residual bounds nothing — the local estimate exceeds the provider total, so no upper bound on off-path spend survives',
    plain: 'This remainder cannot tell you how much went outside Segreant: our own estimate already came out higher than the provider’s bill.',
  },
  upper_bound_conditional: {
    precise: 'residual is an upper bound on off-path spend while the local estimate does not exceed true on-path billed cost',
    plain: 'At most this much could have gone outside Segreant — assuming our own pricing did not overshoot what you were really charged.',
  },
  unknown_local_total_truncated_by_retention: {
    precise: 'residual bounds nothing — retention deleted request rows from inside this period, so the local total is a known undercount by an unknown amount',
    plain: 'This remainder cannot tell you how much went outside Segreant: some of your own metered requests in this period were deleted by your retention setting, so part of the difference is traffic we did see.',
  },
};

/** Whether the run's own bound state is bad news rather than a caveat. */
export function residualBoundIsError(bound: string | undefined): boolean {
  return bound === 'none_local_estimate_exceeds_provider'
    || bound === 'unknown_local_total_truncated_by_retention';
}

export function residualBoundWords(bound: string | undefined, precise: boolean): string {
  const words = bound === undefined ? undefined : RESIDUAL_BOUND_WORDS[bound as ResidualBound];
  if (words === undefined) {
    return precise
      ? 'this run predates the recorded bound condition, so what the residual bounds is not established'
      : 'This run is older than the check that explains the remainder, so there is nothing to show for it.'
  }
  return precise ? words.precise : words.plain;
}

/**
 * The rounding a comparison applied to our side, or null when it changed
 * nothing. Runs recorded before the rule rounded nothing: they refused instead.
 */
export function quantizationWords(q: { daysRounded: number } | null | undefined, precise: boolean): string | null {
  if (!q || q.daysRounded === 0) return null;
  const days = `${q.daysRounded} day total${q.daysRounded === 1 ? '' : 's'}`;
  return precise
    ? `local exact amounts summed per UTC day; ${days} rounded half to even to the microdollar (each within $0.0000005)`
    : `Our measurement had amounts smaller than a millionth of a dollar. Each day was added up exactly, then ${days} rounded to the nearest millionth.`;
}

/** The days a provider period covers; it ends at an exclusive UTC midnight. */
export function dayRange(startMs: number | undefined, endMs: number | undefined): string {
  if (startMs === undefined || endMs === undefined) return '—';
  // Provider periods end at an exclusive midnight; show the last day included.
  return `${date(startMs, 'UTC')} – ${date(endMs - 1, 'UTC')} UTC`;
}
