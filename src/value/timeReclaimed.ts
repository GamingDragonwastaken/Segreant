/**
 * Time Reclaimed — the calendar-unit showcase over Lift's existing math.
 *
 * Answers "how many work-weeks of manual effort did AI-assisted work deliver,
 * in how many measured hours?" with the same honesty rules liftFromData
 * enforces: only REALIZED units earn credit, priced at their task-type manual
 * baseline (an auditable org input, never a self-reported speedup); ALL
 * measured AI time sits in the denominator, so work that died pulls the
 * number DOWN; the baseline band is the interval; task types with no baseline
 * earn nothing rather than an invented figure. The per-type strata are the
 * "where did AI actually matter" split the headline alone can't show.
 */
import type { Store } from '../store/db.ts';
import { timeWithAiMinutes } from './lift.ts';
import type { RealizationReport } from './realization.ts';
import { economicAttributionFromAttributions, economicAttributionNumber, type EconomicAttribution } from '../economics/attribution.ts';

export const WORK_WEEK_MINUTES = 40 * 60;

export interface TimeReclaimedStratum {
  taskType: string;
  realizedUnits: number;
  diedUnits: number; // matured, not realized — AI time spent, zero credit
  manualMinutes: number; // baseline[taskType] × realizedUnits (0 when unbaselined)
  manualMinutesLow: number;
  manualMinutesHigh: number;
  baselined: boolean;
  costUsd: number; // attributed spend across the stratum's matured units
  /** Exact effective spend coverage for this task stratum, when available. */
  economic?: EconomicAttribution;
}

export interface TimeReclaimedReport {
  strata: TimeReclaimedStratum[]; // sorted by manualMinutes desc
  manualMinutes: number;
  manualMinutesLow: number;
  manualMinutesHigh: number;
  aiMinutes: number; // measured (METR-windowed) — caller supplies
  savedMinutes: number | null; // manual − ai; null when uninstrumented
  savedRange: { low: number; high: number } | null;
  workWeeksSaved: number | null; // saved / (40h × 60min)
  workWeeksRange: { low: number; high: number } | null;
  uncreditedUnits: number; // died + realized-but-unbaselined
  notes: string[];
  /** Exact effective spend coverage, separate from manual-minute estimates. */
  economic?: {
    coverage: 'exact' | 'partial' | 'legacy_unknown';
    total: EconomicAttribution | null;
    realized: EconomicAttribution | null;
  };
}

export function computeTimeReclaimed(
  matureUnits: Array<{ taskType: string; realized: boolean; attributedCostUsd: number; economic?: EconomicAttribution }>,
  aiMinutes: number,
  baseline: Record<string, number>,
  bounds?: { low: Record<string, number>; high: Record<string, number> },
): TimeReclaimedReport {
  const byType = new Map<string, TimeReclaimedStratum>();
  const economicByType = new Map<string, EconomicAttribution[]>();
  let uncreditedUnits = 0;
  for (const u of matureUnits) {
    const b = baseline[u.taskType];
    const baselined = typeof b === 'number' && b > 0;
    const s = byType.get(u.taskType) ?? {
      taskType: u.taskType, realizedUnits: 0, diedUnits: 0,
      manualMinutes: 0, manualMinutesLow: 0, manualMinutesHigh: 0,
      baselined, costUsd: 0,
    };
    s.costUsd += economicAttributionNumber(u.economic, u.attributedCostUsd);
    if (u.economic !== undefined) {
      const values = economicByType.get(u.taskType) ?? [];
      values.push(u.economic);
      economicByType.set(u.taskType, values);
    }
    if (u.realized && baselined) {
      s.realizedUnits += 1;
      s.manualMinutes += b!;
      s.manualMinutesLow += bounds?.low[u.taskType] ?? b!;
      s.manualMinutesHigh += bounds?.high[u.taskType] ?? b!;
    } else if (u.realized) {
      s.realizedUnits += 1;
      uncreditedUnits += 1; // realized but unbaselined — no invented credit
    } else {
      s.diedUnits += 1;
      uncreditedUnits += 1; // died — its AI time stays in the denominator
    }
    byType.set(u.taskType, s);
  }
  const strata = [...byType.values()].sort((a, b2) => b2.manualMinutes - a.manualMinutes);
  const manualMinutes = strata.reduce((t, s) => t + s.manualMinutes, 0);
  const manualMinutesLow = strata.reduce((t, s) => t + s.manualMinutesLow, 0);
  const manualMinutesHigh = strata.reduce((t, s) => t + s.manualMinutesHigh, 0);

  for (const stratum of strata) {
    const values = economicByType.get(stratum.taskType);
    if (values !== undefined && values.length > 0) stratum.economic = economicAttributionFromAttributions(values);
  }
  const exactValues = matureUnits.flatMap((unit) => unit.economic === undefined ? [] : [unit.economic]);
  const realizedValues = matureUnits.flatMap((unit) => unit.realized && unit.economic !== undefined ? [unit.economic] : []);
  const economic = exactValues.length === 0
    ? { coverage: 'legacy_unknown' as const, total: null, realized: null }
    : {
        coverage: exactValues.length === matureUnits.length && economicAttributionFromAttributions(exactValues).complete ? 'exact' as const : 'partial' as const,
        total: economicAttributionFromAttributions(exactValues),
        realized: economicAttributionFromAttributions(realizedValues),
      };

  const instrumented = manualMinutes > 0 && aiMinutes > 0;
  const savedMinutes = instrumented ? manualMinutes - aiMinutes : null;
  const savedRange = instrumented ? { low: manualMinutesLow - aiMinutes, high: manualMinutesHigh - aiMinutes } : null;
  const notes: string[] = [];
  if (uncreditedUnits > 0)
    notes.push(`${uncreditedUnits} matured unit(s) received NO savings credit (died before realizing, or no task baseline) — their AI time still counts against the total.`);
  if (!instrumented)
    notes.push('Uninstrumented: needs realized work with a task baseline AND measured AI time. No claim is invented.');
  else
    notes.push('Baseline-estimated (org-auditable task baselines, not a controlled A/B). The range is the baseline band, propagated.');
  return {
    strata, manualMinutes, manualMinutesLow, manualMinutesHigh, aiMinutes,
    savedMinutes, savedRange,
    workWeeksSaved: savedMinutes === null ? null : savedMinutes / WORK_WEEK_MINUTES,
    workWeeksRange: savedRange === null ? null : { low: savedRange.low / WORK_WEEK_MINUTES, high: savedRange.high / WORK_WEEK_MINUTES },
    uncreditedUnits, notes,
    economic,
  };
}

/**
 * Measures AI minutes over the FULL matured-unit span (died units included —
 * that is the honest denominator), mirroring liftOptionsFromStore but over
 * `mature` instead of `realized`.
 */
export function timeReclaimedFromStore(
  store: Store,
  report: RealizationReport,
  baseline: Record<string, number>,
  bounds?: { low: Record<string, number>; high: Record<string, number> },
): TimeReclaimedReport {
  const mature = report.units.filter((u) => !u.maturing);
  let aiMinutes = 0;
  if (mature.length > 0) {
    const startMs = Math.min(...mature.map((u) => u.windowStartMs));
    const endMs = Math.max(...mature.map((u) => u.windowEndMs));
    const events = store.requestsInRange(startMs, endMs).map((r) => ({ sessionId: r.sessionId ?? 'unknown', tsEpochMs: r.tsEpochMs }));
    aiMinutes = timeWithAiMinutes(events).totalMin;
  }
  return computeTimeReclaimed(
    mature.map((u) => ({ taskType: u.taskType, realized: u.funnel.realized, attributedCostUsd: u.attributedCostUsd, economic: u.economic })),
    aiMinutes, baseline, bounds,
  );
}
