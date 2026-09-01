/**
 * Value-aware budget SCENARIOS — a heuristic advisor, not an optimizer.
 *
 * The original budget caps are blunt dollar ceilings. This proposes a better-
 * fitting one from two things measurement gives us:
 *   1. What you actually spend (so the cap fits observed usage, not a guess).
 *   2. What share of that spend reached a realized outcome (so a low rate
 *      tightens the cap and surfaces projected waste — and the frontier says
 *      where an operator might look to reallocate).
 *
 * WHAT THIS IS NOT (AII-026). It is not an optimization: no objective is stated,
 * no constraint set is solved, and no alternative cap is evaluated against one.
 * The headroom multiplier and the realized-rate tightening are disclosed
 * heuristics chosen for plausibility, not derived from a utility model. The
 * realized-value RATE it consumes is a lifecycle share of attributed spend, not
 * evidence that the spend caused the outcome, so "projected waste" is a
 * scenario under that share continuing — not a forecast and not a saving.
 *
 * A cap that materially changes behaviour is a decision, and decisions belong to
 * `src/decision/engine.ts` and the assurance chain above it. Until a proposal
 * carries a DecisionCertificate, this output stays advisory: it is rendered for
 * review, and `canApply` gates whether an operator may even act on it.
 *
 * Pure function over precomputed inputs, so it is testable without a store.
 */

import type { FrontierCell } from '../value/frontier.ts';

export interface BudgetInputs {
  dailySpends: number[]; // recent per-day spend totals (USD)
  realizedSpendShare: number | null; // share of attributed SPEND that reached a kept outcome (0..1) — not a value rate
  frontier?: FrontierCell[]; // byModelAndTask cells, for reallocation hints
}

export interface Reallocation {
  context: string;
  action: 'grow' | 'trim';
  roiIndex: number | null;
  costUsd: number;
  reason: string;
}

export interface BudgetRecommendation {
  /** Whether this is a cold-start, thin-history, usage-only, or value-informed review. */
  status: 'cold_start' | 'insufficient_history' | 'usage_only' | 'review_ready';
  /** A cap may be applied only when the active-day minimum is met. */
  canApply: boolean;
  minActiveDays: number;
  basisDays: number;
  observed: { medianDaily: number; p90Daily: number; maxDaily: number; avgDaily: number };
  recommendedDailyUsd: number | null; // null = not enough spend history to recommend a cap
  recommendedSoftUsd: number | null;
  realizedSpendShare: number | null;
  projectedMonthlyWasteUsd: number | null;
  rationale: string[];
  reallocations: Reallocation[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}

/** Round a cap up to a tidy value so it reads as a deliberate budget. */
function roundUp(n: number): number {
  if (n <= 0) return 0;
  if (n < 10) return Math.ceil(n);
  if (n < 100) return Math.ceil(n / 5) * 5;
  return Math.ceil(n / 10) * 10;
}

export function recommendBudget(
  inp: BudgetInputs,
  opts: { headroom?: number; minActiveDays?: number } = {},
): BudgetRecommendation {
  // Base the recommendation on days with real metered spend — empty or zero-cost
  // days (e.g. only blocked requests) must not drag a daily cap toward zero.
  const spends = inp.dailySpends.filter((x) => x > 0);
  const headroom = opts.headroom ?? 1.2;
  const minActiveDays = opts.minActiveDays ?? 7;
  const rvr = inp.realizedSpendShare;

  // Cold start: nothing real to base a cap on. Say so instead of recommending $0.
  if (spends.length === 0) {
    return {
      status: 'cold_start',
      canApply: false,
      minActiveDays,
      basisDays: 0,
      observed: { medianDaily: 0, p90Daily: 0, maxDaily: 0, avgDaily: 0 },
      recommendedDailyUsd: null,
      recommendedSoftUsd: null,
      realizedSpendShare: rvr,
      projectedMonthlyWasteUsd: null,
      rationale: ['Not enough spend history yet — keep metering. A value-aware cap appears once there are a few active days of real usage.'],
      reallocations: [],
    };
  }

  if (spends.length < minActiveDays) {
    return {
      status: 'insufficient_history',
      canApply: false,
      minActiveDays,
      basisDays: spends.length,
      observed: { medianDaily: 0, p90Daily: 0, maxDaily: 0, avgDaily: 0 },
      recommendedDailyUsd: null,
      recommendedSoftUsd: null,
      realizedSpendShare: rvr,
      projectedMonthlyWasteUsd: null,
      rationale: [
        `Only ${spends.length} active day${spends.length === 1 ? '' : 's'} of real spend observed; keep metering until at least ${minActiveDays} active days exist before applying a cap.`,
      ],
      reallocations: [],
    };
  }

  const sorted = [...spends].sort((a, b) => a - b);
  const medianDaily = percentile(sorted, 0.5);
  const p90Daily = percentile(sorted, 0.9);
  const maxDaily = sorted[sorted.length - 1]!;
  const avgDaily = spends.reduce((a, b) => a + b, 0) / spends.length;
  const rationale: string[] = [];

  let dailyTarget = p90Daily * headroom;
  if (rvr !== null && rvr < 0.5) {
    // Low realized value → don't fund the waste; cap nearer the median.
    dailyTarget = Math.max(medianDaily * 1.3, p90Daily * 0.9);
    rationale.push(
      `Realized-value rate is low (${Math.round(rvr * 100)}%), so the cap is set tighter than usage would suggest — funding spend that isn't returning value is the thing to stop.`,
    );
  } else {
    rationale.push(
      `Daily cap ≈ p90 of the last ${spends.length} days (${fmt(p90Daily)}) × ${headroom} headroom, so ordinary days pass and only true outliers are caught.`,
    );
  }
  const recommendedDailyUsd = roundUp(dailyTarget);
  const recommendedSoftUsd = roundUp(recommendedDailyUsd * 0.8);

  let projectedMonthlyWasteUsd: number | null = null;
  if (rvr !== null) {
    projectedMonthlyWasteUsd = (1 - rvr) * avgDaily * 30;
    rationale.push(
      `At the current realized-value rate, ≈ ${fmt(projectedMonthlyWasteUsd)}/mo of spend is not turning into kept outcomes — the budget to actually attack.`,
    );
  } else {
    rationale.push('Realized-value rate is uninstrumented; wire outcomes (git/`report`) to turn this into a value-based budget rather than a usage-based one.');
  }

  const reallocations: Reallocation[] = [];
  // Do not convert raw frontier ranking into an action. Generic model×task cells
  // can represent unlike work, and a two-unit threshold is not allocation-grade
  // evidence. Comparable model guidance is emitted only by the within-task,
  // review-only frontier trial contract instead.
  const cells: FrontierCell[] = [];
  if (cells.length >= 2) {
    const byRoi = [...cells].sort((a, b) => (a.roiIndex ?? 0) - (b.roiIndex ?? 0));
    const worst = byRoi[0]!;
    const best = byRoi[byRoi.length - 1]!;
    reallocations.push({
      context: worst.key,
      action: 'trim',
      roiIndex: worst.roiIndex,
      costUsd: worst.costUsd,
      reason: `Lowest RoI (${worst.roiIndex!.toFixed(0)}) at ${fmt(worst.costUsd)} — spend here returns the least.`,
    });
    if (best.key !== worst.key) {
      reallocations.push({
        context: best.key,
        action: 'grow',
        roiIndex: best.roiIndex,
        costUsd: best.costUsd,
        reason: `Highest RoI (${best.roiIndex!.toFixed(0)}) — the safe place to lean spend in.`,
      });
    }
  }

  return {
    status: rvr === null ? 'usage_only' : 'review_ready',
    canApply: true,
    minActiveDays,
    basisDays: spends.length,
    observed: { medianDaily, p90Daily, maxDaily, avgDaily },
    recommendedDailyUsd,
    recommendedSoftUsd,
    realizedSpendShare: rvr,
    projectedMonthlyWasteUsd,
    rationale,
    reallocations,
  };
}

function fmt(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}
