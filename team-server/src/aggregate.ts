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

import type { ProjectTotals, DeveloperTotals } from './store.ts';
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
      totalRealizedValueUsd: number;
      totalNetRealizedValueUsd: number;
      realizationRate: number | null;
      realizedValueRate: number | null;
      avgRoiIndex: number | null;
    };

export interface TeamDeveloperDistribution {
  cohortSize: number;
  medianCostUsd: number;
  medianRealizedValueRate: number;
  p25RealizedValueRate: number;
  p75RealizedValueRate: number;
  totalCostUsd: number;
  totalRealizedValueUsd: number;
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
      totalRealizedValueUsd: t.totalRealizedValueUsd,
      totalNetRealizedValueUsd: t.totalNetRealizedValueUsd,
      realizationRate: t.realizationRate,
      realizedValueRate: t.realizedValueRate,
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
  // penalizes" discipline realization.ts's netRealizedValueUsd uses.
  const rates = totals
    .filter((t): t is DeveloperTotals & { realizedValueRate: number } => t.realizedValueRate !== null)
    .map((t) => t.realizedValueRate)
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
      totalRealizedValueUsd: totals.reduce((s, t) => s + t.totalRealizedValueUsd, 0),
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
