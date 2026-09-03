/**
 * Privacy-gating layer over team-server's raw aggregate queries (store.ts).
 * Deliberately pure — no DB, no HTTP — so the suppression/weighting logic is
 * unit-testable on its own, the same "test through a real interface boundary,
 * keep the math free of I/O" instinct as src/value/cohort.ts.
 *
 * Per-developer spend/realization is an identifying axis once `label` is
 * joined back to a person (typically 1:1 with a machine in practice), so it
 * gets the same two-factor gate cohort.ts already established for local
 * per-user value: OPT-IN (disabled by default) AND a k-ANONYMITY floor,
 * distribution only, never a named list. Kept as a parallel implementation
 * rather than an import from cohort.ts — the input here (developer rollup
 * totals) doesn't carry the session-count evidence cohort.ts's reliability
 * shrinkage needs, so force-fitting one signature onto both would obscure
 * more than it'd share (the same reasoning src/team/rollup.ts's header
 * comment gives for not sharing verifyRollup/verifyReceipt).
 *
 * Project-level totals get a lighter, always-on version of the same instinct:
 * a project is only ever shown with real numbers if at least `minCohort`
 * distinct developers contributed to it in the window — otherwise a lone
 * contributor's project total just IS their personal total under another
 * name, the same re-identification risk one level down. Team-wide spend by
 * project is otherwise the core, expected FinOps view
 * (docs/TEAM-TIER-DESIGN.md's own stated target), so unlike the developer
 * breakdown it needs no separate opt-in — only the per-row floor.
 */

import type { ProjectTotals, DeveloperTotals, ObservationWindow } from './store.ts';
import { standardizedScore, type StandardizedScore } from '../../src/team/standardize.ts';

export type ProjectAggregateRow =
  | { project: string; developerCount: number; suppressed: true; reason: string }
  | {
      project: string;
      developerCount: number;
      suppressed: false;
      rollupCount: number;
      totalUnits: number;
      totalCostUsd: number;
      totalSpendOnRealizedUnitsUsd: number;
      totalAcceptanceWeightedSpendUsd: number;
      realizationRate: number | null;
      realizedSpendShare: number | null;
      avgRoiIndex: number | null;
    };

export interface TeamDeveloperDistribution {
  cohortSize: number;
  medianCostUsd: number;
  medianRealizedValueRate: number;
  p25RealizedValueRate: number;
  p75RealizedValueRate: number;
  totalCostUsd: number;
  totalSpendOnRealizedUnitsUsd: number;
}

export interface TeamDeveloperReport {
  enabled: boolean;
  suppressed: boolean;
  reason: string;
  distribution: TeamDeveloperDistribution | null;
}

export interface TeamAggregateConfig {
  /** k-anonymity floor shared by per-project row suppression and the developer-breakdown gate. */
  minCohort: number;
  /** Opt-in: without this, the developer breakdown reports itself disabled (fails closed, like adminToken/oidc). */
  exposeDeveloperBreakdown: boolean;
}

export interface WindowCoverage {
  /** How many DIFFERENT observation windows the summed rollups declared. */
  distinctWindows: number;
  contributingDevelopers: number;
  /** True only when every contributing rollup declared the same window. */
  uniform: boolean;
  earliestFrom: string | null;
  latestTo: string | null;
  shortestWindowDays: number | null;
  longestWindowDays: number | null;
  /** What the totals beside this do, and do not, describe. */
  note: string;
}

function windowDays(window: ObservationWindow): number {
  const span = new Date(window.periodTo).getTime() - new Date(window.periodFrom).getTime();
  return Math.round((span / 86_400_000) * 100) / 100;
}

/**
 * State the coverage of a team total, because the rollups it sums need not
 * cover the same period.
 *
 * THE FIGURE HAD NO PERIOD AT ALL. Each rollup declares its own observation
 * window, chosen by whoever pushed it — `fiscus team push --window D` defaults
 * to 30 and accepts anything — and `aggregateProjects` sums one rollup per
 * developer whatever length each window is. A seven-day machine and a
 * ninety-day machine added up to one `totalCostUsd` and the response said
 * nothing about which period, if any, it described.
 *
 * THE ARGUMENT WAS ALREADY MADE ONE FUNCTION OVER. `parsePeriodFilter` refuses
 * `periodFrom`/`periodTo` outright and states why: filtering a snapshot by an
 * overlapping window "would present its *whole* total as though it belonged to
 * that partial window". That is the same error in the other direction — there
 * the query's window misdescribes the data, here the data's own windows
 * misdescribe each other — and only one of the two was guarded.
 *
 * NEITHER REFUSED NOR REWEIGHTED, DELIBERATELY. Normalising unequal windows to a
 * common period would invent a rate the rollups do not carry, and refusing the
 * sum would delete the core FinOps view over a difference that is often
 * harmless. What is added is the basis: how many distinct windows fed the total,
 * their span, and their shortest and longest length. Recorded at D-102.
 */
export function buildWindowCoverage(windows: ObservationWindow[]): WindowCoverage {
  if (windows.length === 0) {
    return {
      distinctWindows: 0,
      contributingDevelopers: 0,
      // Nothing is not uniform; it is nothing. Reporting `true` here would let a
      // reader take an empty team for an agreeing one.
      uniform: false,
      earliestFrom: null,
      latestTo: null,
      shortestWindowDays: null,
      longestWindowDays: null,
      note: 'no rollups contributed to these totals, so there is no observation window to state',
    };
  }

  const lengths = windows.map(windowDays);
  const shortest = Math.min(...lengths);
  const longest = Math.max(...lengths);
  const earliestFrom = windows.map((w) => w.periodFrom).sort()[0]!;
  const latestTo = windows.map((w) => w.periodTo).sort().at(-1)!;
  const contributingDevelopers = windows.reduce((total, w) => total + w.developerCount, 0);
  const uniform = windows.length === 1;

  const note = uniform
    ? `every contributing rollup declares the same ${shortest}-day window, ${earliestFrom} to ${latestTo}; `
      + 'the totals cover that period'
    : `contributing rollups declare ${windows.length} different observation windows, the shortest ${shortest} `
      + `days and the longest ${longest} days, spanning ${earliestFrom} to ${latestTo}. These totals are a sum `
      + 'across periods of unequal length and do not describe any single window'
      + '; a machine that observed for longer contributes more of it for that reason alone';

  return {
    distinctWindows: windows.length,
    contributingDevelopers,
    uniform,
    earliestFrom,
    latestTo,
    shortestWindowDays: shortest,
    longestWindowDays: longest,
    note,
  };
}

/** Suppresses any project row with fewer than `minCohort` distinct contributing developers. */
export function buildProjectReport(totals: ProjectTotals[], minCohort: number): ProjectAggregateRow[] {
  return totals.map((t) => {
    if (t.developerCount < minCohort) {
      return {
        project: t.project,
        developerCount: t.developerCount,
        suppressed: true,
        reason: `fewer than ${minCohort} distinct developers contributed to this project in the selected window; numbers withheld to avoid identifying a single contributor`,
      };
    }
    return {
      project: t.project,
      developerCount: t.developerCount,
      suppressed: false,
      rollupCount: t.rollupCount,
      totalUnits: t.totalUnits,
      totalCostUsd: t.totalCostUsd,
      totalSpendOnRealizedUnitsUsd: t.totalSpendOnRealizedUnitsUsd,
      totalAcceptanceWeightedSpendUsd: t.totalAcceptanceWeightedSpendUsd,
      realizationRate: t.realizationRate,
      realizedSpendShare: t.realizedSpendShare,
      avgRoiIndex: t.avgRoiIndex,
    };
  });
}

/** Linear-interpolated percentile over an ascending array. Mirrors src/value/cohort.ts's own (private, unexported) quantile helper. */
function quantile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo);
}

/** The org-facing developer distribution — gated by opt-in, then by k-anonymity. Never returns a named list. */
export function buildDeveloperReport(totals: DeveloperTotals[], config: TeamAggregateConfig): TeamDeveloperReport {
  if (!config.exposeDeveloperBreakdown) {
    return {
      enabled: false,
      suppressed: true,
      reason: 'per-developer breakdown is opt-in and disabled on this server (TEAM_SERVER_EXPOSE_DEVELOPER_BREAKDOWN)',
      distribution: null,
    };
  }
  if (totals.length < config.minCohort) {
    return {
      enabled: true,
      suppressed: true,
      reason: `cohort of ${totals.length} is below the k-anonymity floor of ${config.minCohort}; per-developer breakdown withheld`,
      distribution: null,
    };
  }
  const costs = totals.map((t) => t.totalCostUsd).sort((a, b) => a - b);
  // Rate is undefined (not zero) at $0 cost — exclude those rows from the rate
  // distribution rather than fold them in as 0, the same "unknown never
  // penalizes" discipline realization.ts's acceptanceWeightedSpendUsd uses.
  const rates = totals
    .filter((t): t is DeveloperTotals & { realizedSpendShare: number } => t.realizedSpendShare !== null)
    .map((t) => t.realizedSpendShare)
    .sort((a, b) => a - b);
  // The k-anonymity floor must hold for whatever population a statistic is
  // actually computed over — the rate axis is computed over a SMALLER,
  // filtered population than the raw cohort, so it needs its own floor check
  // rather than inheriting the one above.
  if (rates.length < config.minCohort) {
    return {
      enabled: true,
      suppressed: true,
      reason: `rate cohort of ${rates.length} (after excluding $0-cost developers) is below the k-anonymity floor of ${config.minCohort}; per-developer breakdown withheld`,
      distribution: null,
    };
  }
  return {
    enabled: true,
    suppressed: false,
    reason: `distribution over ${totals.length} developers; individuals not identified`,
    distribution: {
      cohortSize: totals.length,
      medianCostUsd: quantile(costs, 0.5),
      medianRealizedValueRate: quantile(rates, 0.5),
      p25RealizedValueRate: quantile(rates, 0.25),
      p75RealizedValueRate: quantile(rates, 0.75),
      totalCostUsd: totals.reduce((s, t) => s + t.totalCostUsd, 0),
      totalSpendOnRealizedUnitsUsd: totals.reduce((s, t) => s + t.totalSpendOnRealizedUnitsUsd, 0),
    },
  };
}

// ---- Task-standardized comparison (Simpson's-paradox defense) ---------------

export interface EntityStrata {
  /** Comparison label — a project, a period, or (behind the developer gate) a developer. */
  label: string;
  strata: Array<{ stratum: string; value: number | null; activity: number }>;
}

export interface StandardizedComparisonRow {
  label: string;
  /** Activity-weighted pooled score — the naive number, kept for the contrast. */
  raw: number | null;
  standardized: StandardizedScore;
}

export interface StandardizedComparison {
  /** The fixed basket every entity is scored on. */
  referenceBasket: Record<string, number>;
  /** Where the basket came from — an operator-pinned input, or the pooled mix (disclosed). */
  basketSource: string;
  rows: StandardizedComparisonRow[];
}

/**
 * Compare entities at a FIXED task mix. Raw pooled scores are reported next to
 * the standardized ones deliberately: when the two rankings disagree, that
 * disagreement IS the Simpson's-paradox warning — the raw ranking was task-mix,
 * not performance. The reference basket should be pinned by the operator
 * ex-ante (weights chosen after seeing the numbers are just another way to game
 * the comparison); absent that, the pooled activity mix across the compared
 * entities is used as a common basket and the provenance is disclosed.
 */
export function buildStandardizedComparison(
  entities: ReadonlyArray<EntityStrata>,
  referenceWeights?: Record<string, number>,
): StandardizedComparison {
  let basket: Record<string, number>;
  let basketSource: string;
  if (referenceWeights && Object.keys(referenceWeights).length > 0) {
    basket = referenceWeights;
    basketSource = 'operator-pinned reference weights (ex-ante)';
  } else {
    basket = {};
    for (const e of entities) {
      for (const s of e.strata) {
        if (s.activity > 0 && s.value !== null) basket[s.stratum] = (basket[s.stratum] ?? 0) + s.activity;
      }
    }
    basketSource = 'pooled activity mix across the compared entities (fallback — pin ex-ante weights for accountability use)';
  }

  const rows: StandardizedComparisonRow[] = entities.map((e) => {
    let act = 0;
    let weighted = 0;
    for (const s of e.strata) {
      if (s.value === null || s.activity <= 0) continue;
      act += s.activity;
      weighted += s.activity * s.value;
    }
    return {
      label: e.label,
      raw: act > 0 ? weighted / act : null,
      standardized: standardizedScore(
        e.strata.map((s) => ({ stratum: s.stratum, value: s.value })),
        basket,
      ),
    };
  });

  return { referenceBasket: basket, basketSource, rows };
}
