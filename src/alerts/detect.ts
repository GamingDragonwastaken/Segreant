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
import type { AegisConfig } from '../config.ts';
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
  todaySpendUsd: number;
  dailyCapUsd: number | null;
  dailySoftUsd: number | null;
  baselineActiveDaySpends: number[]; // trailing per-active-day spend, excluding today
  blocked24h: number; // count of budget-blocked (429) requests in the last 24h
  estimatedShare: number; // 0..1 share of recent spend priced with estimated rates
  runaway: { tripped: boolean; windowCostUsd: number; windowSec: number } | null;
  realizedValueRate: number | null; // null = uninstrumented (no git / no matured units)
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

export function detectAlerts(inp: AlertInputs): Alert[] {
  const out: Alert[] = [];

  // Budget pressure — critical once the hard cap is reached (requests now blocked).
  if (inp.dailyCapUsd !== null && inp.todaySpendUsd >= inp.dailyCapUsd) {
    out.push({
      id: 'budget-exhausted',
      severity: 'critical',
      title: 'Daily budget reached',
      detail: 'New requests are being blocked until the daily cap resets.',
      metric: `$${fmt(inp.todaySpendUsd)} / $${fmt(inp.dailyCapUsd)}`,
    });
  } else if (inp.dailySoftUsd !== null && inp.todaySpendUsd >= inp.dailySoftUsd) {
    out.push({
      id: 'budget-soft',
      severity: 'warn',
      title: 'Approaching daily cap',
      detail: 'Spend has crossed the soft-warn threshold for today.',
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

  // Spend spike — today is well above the typical active day.
  const base = percentile([...inp.baselineActiveDaySpends].sort((a, b) => a - b), 0.9);
  if (base > 0 && inp.todaySpendUsd >= 0.01 && inp.todaySpendUsd > base * 2) {
    out.push({
      id: 'spend-spike',
      severity: 'warn',
      title: 'Spend spike',
      detail: 'Today is well above your typical active day — worth a look before it compounds.',
      metric: `${(inp.todaySpendUsd / base).toFixed(1)}× your p90 day ($${fmt(base)})`,
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
  if (inp.realizedValueRate !== null && inp.realizedValueRate < 0.3) {
    out.push({
      id: 'value-crater',
      severity: 'warn',
      title: 'Low realized value',
      detail: 'Most recent spend is not turning into kept, verified outcomes. Check the frontier for where it is leaking.',
      metric: `${Math.round(inp.realizedValueRate * 100)}% realized`,
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

/** Gather alert inputs from the store + config and detect. `realizedValueRate` is passed in (git-gated). */
export function computeAlerts(
  store: Store,
  config: AegisConfig,
  opts: { now?: number; realizedValueRate?: number | null } = {},
): Alert[] {
  const now = opts.now ?? Date.now();
  const day = 24 * 60 * 60 * 1000;
  const dayStart = startOfLocalDay(now);

  const todaySpendUsd = store.spendBetween(dayStart, now + 1000);

  // Baseline = prior active days (exclude today), so a spike compares like-for-like.
  const priorSeries = store.series(now - 30 * day, dayStart, day);
  const baselineActiveDaySpends = priorSeries.map((s) => s.costUsd).filter((x) => x > 0);

  const blocked24h = store.healthStats(now - day, now + 1000).blocked;
  const week = store.healthStats(now - 7 * day, now + 1000);
  const estimatedShare = week.totalCostUsd > 0 ? week.estimatedCostUsd / week.totalCostUsd : 0;

  let runaway: AlertInputs['runaway'] = null;
  if (config.budget.runawayMaxUsd !== null) {
    const w = store.spendInWindow(now, config.budget.runawayWindowSec * 1000);
    runaway = {
      tripped: w.costUsd >= config.budget.runawayMaxUsd,
      windowCostUsd: w.costUsd,
      windowSec: config.budget.runawayWindowSec,
    };
  }

  return detectAlerts({
    todaySpendUsd,
    dailyCapUsd: config.budget.dailyUsd,
    dailySoftUsd: config.budget.dailySoftUsd,
    baselineActiveDaySpends,
    blocked24h,
    estimatedShare,
    runaway,
    realizedValueRate: opts.realizedValueRate ?? null,
  });
}
