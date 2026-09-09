/**
 * Proactive governance — turning passive measurement into alerts.
 *
 * A spend-governance tool that only blocks (silently) is half a product: the
 * user finds out something went wrong by noticing their agent stalled, or by
 * reading a dashboard they happened to open. This detects the conditions worth
 * surfacing — budget pressure, spend spikes, runaway loops, throttling, value
 * craters, untrustworthy pricing — from data already on the device. No external
 * services, no notifications leaving the machine.
 *
 * `detectAlerts` is pure over precomputed inputs (testable without a store);
 * `computeAlerts` is the store-backed wrapper the CLI and dashboard call.
 */

import type { Store } from '../store/db.ts';
import type { FiscusConfig } from '../config.ts';
import { startOfLocalDay } from '../budget/guard.ts';

export type AlertSeverity = 'critical' | 'warn' | 'info';

export interface Alert {
  id: string; // stable kind id, e.g. 'spend-spike'
  severity: AlertSeverity;
  title: string;
  detail: string;
  metric: string | null; // short quantified evidence, e.g. '3.2× your p90 day'
}

export interface AlertInputs {
  /** Today's spend on the cap-ENFORCEMENT basis (live-only unless capIncludesImported). */
  todaySpendUsd: number;
  /** Today's TOTAL observed spend (live + imported) — the spike alert compares this
   *  against the baseline, which is also total. Defaults to todaySpendUsd. */
  todayTotalSpendUsd?: number;
  /** True when imported spend is excluded from enforcement — cap alerts say so. */
  capExcludesImported?: boolean;
  dailyCapUsd: number | null;
  dailySoftUsd: number | null;
  baselineActiveDaySpends: number[]; // trailing per-active-day spend, excluding today
  /**
   * Whether retention deleted request rows from inside the baseline window
   * (D-182). Optional so a caller constructing inputs by hand keeps working;
   * absent reads as "not known truncated", which is the same convention D-176
   * settled for the spend window and NOT a claim the window is intact.
   *
   * Two sentences depend on it. A baseline retention emptied is dark because
   * the history was DELETED, not because it never accumulated -- and the
   * coverage surface exists precisely to give that reason. A baseline retention
   * merely narrowed is a p90 over the days that survive, which is not "your
   * typical active day" and must not be printed as though it were.
   */
  baselineTruncated?: boolean;
  /** Boundary those rows were deleted before; null is NO PRUNE ON RECORD. */
  baselinePrunedBeforeMs?: number | null;
  blocked24h: number; // count of budget-blocked (429) requests in the last 24h
  estimatedShare: number; // 0..1 share of recent spend priced with estimated rates
  /**
   * Total spend the `estimatedShare` window was computed over. The share arrives
   * already divided, so zero is ambiguous between "none of the spend was
   * estimated" and "there was no spend to price"; coverage needs the
   * denominator to tell those apart. Omitting it leaves the pricing channel
   * reported DARK, which is the conservative direction.
   */
  pricedWindowSpendUsd?: number;
  runaway: { tripped: boolean; windowCostUsd: number; windowSec: number } | null;
  realizedSpendShare: number | null; // share of spend that reached a kept outcome; null = uninstrumented (no git / no matured units)
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warn: 1, info: 2 };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}

function fmt(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

/**
 * WHICH DETECTORS COULD HAVE FIRED (WP-D06, D-141).
 *
 * `detectAlerts` returns an array, and an empty one used to be read as a
 * finding: `fiscus ops` printed a green "all clear". Two different situations
 * produce that empty array. In one, six detectors examined real traffic and none
 * tripped. In the other, the detectors were structurally unable to fire, and the
 * empty array records that nothing was looked at.
 *
 * The default install is the second case, which makes it the common one. Caps
 * are opt-in, so every threshold starts null; a fresh ledger has no prior active
 * day, so the spike baseline is zero and its detector requires `base > 0`; value
 * is uninstrumented until units mature. On that install not one of the six
 * channels can produce an alert, and the operator was shown a green tick.
 *
 * This is `assessCompleteness` one module over: absence is a negative claim only
 * where there is positive evidence the source could have seen the thing. So the
 * surface states coverage, and a dark channel names the setting that would light
 * it rather than merely reporting itself unavailable.
 */
export type AlertChannel =
  | 'budget-cap'
  | 'runaway-loop'
  | 'throttling'
  | 'spend-spike'
  | 'value-crater'
  | 'pricing-trust';

export interface AlertChannelCoverage {
  readonly channel: AlertChannel;
  readonly live: boolean;
  /** Why it could not fire, and what would change that. Null exactly when live. */
  readonly darkBecause: string | null;
}

export interface AlertCoverage {
  readonly channels: readonly AlertChannelCoverage[];
  readonly liveChannels: number;
  /** True only when every channel could have fired. An empty alert list means something only then. */
  readonly complete: boolean;
  /** One sentence a surface prints INSTEAD of a verdict it cannot support. */
  readonly summary: string;
}

export function alertCoverage(inp: AlertInputs): AlertCoverage {
  const capConfigured = inp.dailyCapUsd !== null || inp.dailySoftUsd !== null;
  // A request can only be blocked by something that blocks. A soft threshold
  // warns and does not, so it does not light this channel.
  const blockingConfigured = inp.dailyCapUsd !== null || inp.runaway !== null;
  const baseline = percentile([...inp.baselineActiveDaySpends].sort((a, b) => a - b), 0.9);

  const channels: AlertChannelCoverage[] = [
    {
      channel: 'budget-cap',
      live: capConfigured,
      darkBecause: capConfigured ? null : 'no daily cap or soft threshold is set, so no budget alert can fire',
    },
    {
      channel: 'runaway-loop',
      live: inp.runaway !== null,
      darkBecause: inp.runaway !== null ? null : 'no runaway velocity threshold is set, so no burst can trip it',
    },
    {
      channel: 'throttling',
      live: blockingConfigured,
      darkBecause: blockingConfigured ? null : 'nothing is configured that would block a request, so none can be observed blocked',
    },
    {
      channel: 'spend-spike',
      live: baseline > 0,
      // "yet" is a claim about the operator's history, and it is false on a
      // ledger whose prior days Fiscus deleted on their own retention policy
      // (D-182). This is the surface whose whole job is to give the reason a
      // channel is dark, so giving the wrong one here is worse than anywhere.
      darkBecause: baseline > 0
        ? null
        : inp.baselineTruncated === true
          ? 'the prior active days in this window were deleted by retention, so no baseline survives to compare against'
          : 'no prior active day exists yet, so there is no baseline to exceed',
    },
    {
      channel: 'value-crater',
      live: inp.realizedSpendShare !== null,
      darkBecause: inp.realizedSpendShare !== null ? null : 'realized value is uninstrumented, so no realization share exists to fall',
    },
    {
      channel: 'pricing-trust',
      live: (inp.pricedWindowSpendUsd ?? 0) > 0,
      darkBecause: (inp.pricedWindowSpendUsd ?? 0) > 0
        ? null
        : 'no priced spend in the window, so an estimated share of zero reflects absent spend rather than verified pricing',
    },
  ];

  const liveChannels = channels.filter((channel) => channel.live).length;
  const total = channels.length;
  const summary = liveChannels === total
    ? `${liveChannels} of ${total} alert channels are watching`
    : `${liveChannels} of ${total} alert channels are watching; the rest cannot fire as configured`;

  return Object.freeze({
    channels: Object.freeze(channels),
    liveChannels,
    complete: liveChannels === total,
    summary,
  });
}

export function detectAlerts(inp: AlertInputs): Alert[] {
  const out: Alert[] = [];

  // Budget pressure — critical once the hard cap is reached (requests now blocked).
  const basisNote = inp.capExcludesImported ? ' The cap counts live proxy spend only; imported subscription spend is excluded.' : '';
  if (inp.dailyCapUsd !== null && inp.todaySpendUsd >= inp.dailyCapUsd) {
    out.push({
      id: 'budget-exhausted',
      severity: 'critical',
      title: 'Daily budget reached',
      detail: 'New requests are being blocked until the daily cap resets.' + basisNote,
      metric: `$${fmt(inp.todaySpendUsd)} / $${fmt(inp.dailyCapUsd)}`,
    });
  } else if (inp.dailySoftUsd !== null && inp.todaySpendUsd >= inp.dailySoftUsd) {
    out.push({
      id: 'budget-soft',
      severity: 'warn',
      title: 'Approaching daily cap',
      detail: 'Spend has crossed the soft-warn threshold for today.' + basisNote,
      metric: `$${fmt(inp.todaySpendUsd)} / $${fmt(inp.dailySoftUsd)} soft`,
    });
  }

  // Runaway loop — a burst of spend in a short window.
  if (inp.runaway && inp.runaway.tripped) {
    out.push({
      id: 'runaway',
      severity: 'critical',
      title: 'Runaway velocity',
      detail: `A burst of spend in the last ${inp.runaway.windowSec}s tripped the runaway guard — check for a stuck agent loop.`,
      metric: `$${fmt(inp.runaway.windowCostUsd)} in ${inp.runaway.windowSec}s`,
    });
  }

  // Spend spike — today is well above the typical active day. Compared on TOTAL
  // spend, because the baseline series is total (like-for-like regardless of basis).
  const todayTotal = inp.todayTotalSpendUsd ?? inp.todaySpendUsd;
  const base = percentile([...inp.baselineActiveDaySpends].sort((a, b) => a - b), 0.9);
  if (base > 0 && todayTotal >= 0.01 && todayTotal > base * 2) {
    out.push({
      id: 'spend-spike',
      severity: 'warn',
      title: 'Spend spike',
      // The alert still FIRES on a narrowed baseline, deliberately (D-173's
      // rule, D-182's application): withholding a live overspend signal because
      // a privacy setting shortened its comparison would withdraw the whole
      // claim to repair half of it. What deletion undermines is the baseline's
      // claim to represent a typical month, not the observation that today is
      // far above what survives -- so the alert fires and the comparison says
      // what it was computed over. No direction is asserted: deleting the
      // oldest days can move a p90 either way.
      detail: inp.baselineTruncated === true
        ? `Today is well above the days that survive in this window — but retention deleted part of the comparison period, so this is not a month's typical. Compared against ${inp.baselineActiveDaySpends.length} surviving active day(s).`
        : 'Today is well above your typical active day — worth a look before it compounds.',
      metric: `${(todayTotal / base).toFixed(1)}× your p90 day ($${fmt(base)})`,
    });
  }

  // Throttling — the user's agent is being blocked and may not realize it.
  if (inp.blocked24h > 0) {
    out.push({
      id: 'throttled',
      severity: 'warn',
      title: 'Requests blocked by budget',
      detail: 'Your agent is being throttled. Raise the cap or investigate what is driving the spend.',
      metric: `${inp.blocked24h} blocked in 24h`,
    });
  }

  // Value crater — spend isn't converting into kept outcomes (only when instrumented).
  if (inp.realizedSpendShare !== null && inp.realizedSpendShare < 0.3) {
    out.push({
      id: 'value-crater',
      severity: 'warn',
      title: 'Low realized value',
      detail: 'Most recent spend is not turning into kept, verified outcomes. Check the frontier for where it is leaking.',
      metric: `${Math.round(inp.realizedSpendShare * 100)}% realized`,
    });
  }

  // Data quality — a chunk of spend used estimated (unverified) pricing.
  if (inp.estimatedShare > 0.2) {
    out.push({
      id: 'estimated-pricing',
      severity: 'info',
      title: 'Costs are approximate',
      detail: 'Some spend used estimated pricing (an unrecognized model). Re-verify pricing/models.json before billing-grade use.',
      metric: `${Math.round(inp.estimatedShare * 100)}% of last-7d spend estimated`,
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Gather the inputs once, so alerts and their coverage are read from the same observation. */
function gatherAlertInputs(
  store: Store,
  config: FiscusConfig,
  opts: { now?: number; realizedSpendShare?: number | null },
): AlertInputs {
  const now = opts.now ?? Date.now();
  const day = 24 * 60 * 60 * 1000;
  const dayStart = startOfLocalDay(now);

  // Cap-related alerts must read the same basis the guard ENFORCES on, or the
  // dashboard would warn about a block that will never happen (or miss one that will).
  const liveOnly = !config.budget.capIncludesImported;
  const todaySpendUsd = store.spendBetween(dayStart, now + 1000, liveOnly);

  // Baseline = prior active days (exclude today), so a spike compares like-for-like.
  const baselineStartMs = now - 30 * day;
  const priorSeries = store.series(baselineStartMs, dayStart, day);
  const baselineActiveDaySpends = priorSeries.map((s) => s.costUsd).filter((x) => x > 0);
  // Same predicate as every other window in this sweep: truncated when the
  // window STARTS strictly before a recorded boundary, because `prune` deletes
  // rows strictly older than it. Null is no prune on record (D-170).
  const baselinePrunedBeforeMs = store.retentionFloor().requestsPrunedBeforeMs;
  const baselineTruncated = baselinePrunedBeforeMs !== null && baselineStartMs < baselinePrunedBeforeMs;

  const blocked24h = store.healthStats(now - day, now + 1000).blocked;
  const week = store.healthStats(now - 7 * day, now + 1000);
  const estimatedShare = week.totalCostUsd > 0 ? week.estimatedCostUsd / week.totalCostUsd : 0;
  // Carried alongside the share so coverage can tell an unestimated window from
  // an empty one; the share alone cannot (D-141).
  const pricedWindowSpendUsd = week.totalCostUsd;

  let runaway: AlertInputs['runaway'] = null;
  if (config.budget.runawayMaxUsd !== null) {
    const w = store.spendInWindow(now, config.budget.runawayWindowSec * 1000, liveOnly);
    runaway = {
      tripped: w.costUsd >= config.budget.runawayMaxUsd,
      windowCostUsd: w.costUsd,
      windowSec: config.budget.runawayWindowSec,
    };
  }

  return Object.freeze({
    todaySpendUsd,
    todayTotalSpendUsd: liveOnly ? store.spendBetween(dayStart, now + 1000) : todaySpendUsd,
    capExcludesImported: liveOnly,
    dailyCapUsd: config.budget.dailyUsd,
    dailySoftUsd: config.budget.dailySoftUsd,
    baselineActiveDaySpends,
    baselineTruncated,
    baselinePrunedBeforeMs,
    blocked24h,
    estimatedShare,
    pricedWindowSpendUsd,
    runaway,
    realizedSpendShare: opts.realizedSpendShare ?? null,
  });
}

/** Gather alert inputs from the store + config and detect. `realizedSpendShare` is passed in (git-gated). */
export function computeAlerts(
  store: Store,
  config: FiscusConfig,
  opts: { now?: number; realizedSpendShare?: number | null } = {},
): Alert[] {
  return detectAlerts(gatherAlertInputs(store, config, opts));
}

/** The same inputs `computeAlerts` gathers, read for coverage rather than for alerts. */
export function computeAlertCoverage(
  store: Store,
  config: FiscusConfig,
  opts: { now?: number; realizedSpendShare?: number | null } = {},
): AlertCoverage {
  return alertCoverage(gatherAlertInputs(store, config, opts));
}
