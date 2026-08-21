/**
 * The value report — one composition of the value primitives, for every surface.
 *
 * The primitives in this directory are already deep and already shared:
 * `loadRealization`, `resolveBaselineMinutesForRepo`, `liftOptionsFromStore`,
 * `moneyInputsFromStore`, `computeReturnOnIntelligence`, `goodhartStreams`,
 * `timeReclaimedFromStore`, `computeFrontier`, `computeUsageRoI`,
 * `computeCohort`, `recommendBudget`. What was NOT shared was the SEQUENCE that
 * assembles them into a report — the dashboard's `/api/value` and the CLI's
 * `roi` / `saved` / `usage` / `budget-advisor` commands each sequenced the same
 * primitives independently, and five comments in the dashboard source asserted
 * by hand that they matched ("Money inputs mirror the CLI exactly", "same
 * computation as the CLI so the two surfaces can't disagree", "priced exactly
 * like the CLI"). A hand-maintained invariant across two files is not an
 * invariant; it is a defect waiting for the next edit. This module IS that
 * invariant.
 *
 * THE ONE DISTINCTION THIS FILE MUST NOT COLLAPSE. Two different quantities are
 * both spelled `realizedValueUsd`, and they are different claims:
 *
 *   realization.matured.realizedValueUsd   attributed SPEND on units that
 *                                          realized — a COST that landed well.
 *   roi.returnRatio.realizedValueUsd       manual-equivalent VALUE produced —
 *                                          what the work would have cost done
 *                                          by hand, net of rework.
 *
 * They come from different evidence and answer different questions. Neither is
 * ever renamed into the other, and neither is ever computed from the other.
 *
 * Ordering matters and is load-bearing:
 *   1. realization  — the spine; everything downstream is a lens on it.
 *   2. baseline     — resolved per repo (config override > this project's own
 *                     pre-AI git history shrunk toward a cited population prior
 *                     > the prior alone). Demo mode skips git entirely: the
 *                     seeded snapshots are not this checkout's real history.
 *   3. lift         — the counterfactual; its provenance travels with it.
 *   4. money        — priced from the SAME baseline the lens used, so the
 *                     dollar and the index can never disagree.
 *   5. RoI, drift, time reclaimed, frontier — all read (1)–(4), never the store
 *                     directly, so no surface can re-derive an input its own way.
 */

import type { Store } from '../store/db.ts';
import { isDemo, DEFAULT_CONFIG, type FiscusConfig } from '../config.ts';
import { demoLiftOptions } from '../demo/seed.ts';
import { projectName } from '../git/correlate.ts';
import {
  loadRealization,
  liftOptionsFromStore,
  moneyInputsFromStore,
  projectValueBreakdown,
  type LoadedRealization,
  type ProjectValue,
} from './realization.ts';
import { resolveBaselineMinutesForRepo, type ResolvedBaseline } from './liftBaseline.ts';
import { boundedLift } from './lift.ts';
import { computeReturnOnIntelligence, type RoIOptions, type RoIResult } from './lenses.ts';
import { goodhartStreams, type DriftReport, type NamedDriftReport } from './drift.ts';
import { instrumentationPriority, type InstrumentationPriority } from './voi.ts';
import { timeReclaimedFromStore, type TimeReclaimedReport } from './timeReclaimed.ts';
import { computeFrontier, type FrontierReport } from './frontier.ts';
import { computeUsageRoI, type UsageReport } from './usage.ts';
import { computeCohort, type CohortReport } from './cohort.ts';
import { recommendBudget, type BudgetRecommendation } from '../budget/recommend.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The demo's illustrative money inputs — clearly labeled wherever they surface. */
const DEMO_LABOR_RATE_PER_HOUR = 120;
const DEMO_OUTCOME_BASELINE_MINUTES: Record<string, number> = { used: 10, resolved: 30, published: 90 };

/** The default spend/usage window, in days, for the surfaces that do not pass one. */
const DEFAULT_SPEND_WINDOW_DAYS = 30;

export interface ValueSpineOptions {
  /**
   * The repository this report is about. Required, because the spine resolves a
   * PROJECT baseline against it — a value report with no project to name has no
   * baseline to resolve, and inventing one is exactly the collapse this repo's
   * provenance rules exist to prevent. Callers already have one: the CLI's
   * `flags.repo ?? process.cwd()`, the dashboard's `safeRepo(?repo=)`.
   */
  repo: string;
  /** Maturity window for realization, in days. */
  windowDays?: number;
  /** Commits scanned on the live-git path. */
  limit?: number;
  /** Whether the computed snapshot is written back to the store. */
  persist?: boolean;
  /**
   * Labor rate override (the CLI's `--labor-rate`). `undefined` means "use
   * config"; an explicit `null` means "no rate", same as config's own null.
   */
  laborRatePerHour?: number | null;
  /** An externally measured TSF (the CLI's `--tsf`) — the gold-standard Lift source. */
  tsfUpperBound?: number | null;
  /** γ ∈ [0,1] for the Index certainty-equivalent (the CLI's `--risk`). */
  riskAversion?: number;
  /**
   * Whether Lift's SOURCE is disclosed on the result — `liftHow` on the lens,
   * and the demo's synthetic-TSF note in `roi.notes`.
   *
   * This is a disclosure switch, never a computation switch: the Index, the
   * interval, the money number and every lens VALUE are identical either way.
   * It exists because the CLI has always disclosed the Lift source while
   * `/api/value` has not, and that payload is a published contract read by the
   * browser app. Extracting the shared sequence must not silently change one
   * surface's strings. Default is the disclosing behaviour.
   */
  discloseLiftSource?: boolean;
}

/**
 * Everything anchored on a realization report: the spine plus every lens that
 * reads it. Null-free by construction — callers get a spine or they get `null`,
 * which is the honest "nothing matured to report" answer, never zeros.
 */
export interface ValueSpine {
  /** Which source answered — live git, or persisted snapshots. */
  loaded: LoadedRealization;
  /** The project the baseline was resolved for ('demo' in demo mode). */
  project: string;
  /** Where each task-type's manual-minutes baseline came from, and its band. */
  baseline: ResolvedBaseline;
  /**
   * The Lift options threaded into every RoI computed from this spine — the
   * headline and the per-project breakdown alike, so a project's index and the
   * headline index are never scored against different counterfactuals.
   */
  liftOptions: RoIOptions;
  /** Lift/baseline provenance, already unshifted onto `roi.notes`. */
  liftNotes: string[];
  roi: RoIResult;
  /** The realization stream's Goodhart alarm — back-compat name for `driftStreams[realization]`. */
  drift: DriftReport | null;
  /** All gaming-sensitive streams; each carries its own typical reading. */
  driftStreams: NamedDriftReport[];
  /** Which measurement to buy next, ranked by unmeasured exposure. */
  voi: InstrumentationPriority[];
  reclaimed: TimeReclaimedReport;
  frontier: FrontierReport;
}

/**
 * The realization-anchored composition: load the report, resolve this project's
 * baseline, source Lift, price the money inputs from that same baseline, then
 * score RoI, drift, time reclaimed and the frontier off the result.
 *
 * Returns `null` when nothing has matured anywhere — no git repo and no stored
 * snapshots. Callers report that state; they never substitute zeros for it.
 */
export async function valueSpine(
  store: Store,
  config: FiscusConfig,
  opts: ValueSpineOptions,
): Promise<ValueSpine | null> {
  const windowDays = opts.windowDays ?? 14;
  const loaded = await loadRealization(store, opts.repo, {
    limit: opts.limit ?? 40,
    windowDays,
    persist: opts.persist ?? false,
  });
  if (!loaded) return null;
  const report = loaded.report;
  const disclose = opts.discloseLiftSource ?? true;

  // The manual-minutes-per-task-type input, resolved from three sources in
  // priority order (never silent about which one won, per-task-type):
  //   1. an explicit user override in config — always respected
  //   2. THIS project's own pre-AI-tracking git history, shrunk toward #3
  //   3. a cited, refreshable METR-anchored population prior
  // Demo mode skips git entirely (the seeded snapshots aren't this checkout's
  // real history) and uses the population prior + config as-is.
  const demo = isDemo();
  const project = demo ? 'demo' : await projectName(opts.repo);
  const baseline: ResolvedBaseline = demo
    ? {
        minutes: config.lift.baselineMinutes,
        minutesLow: config.lift.baselineMinutes,
        minutesHigh: config.lift.baselineMinutes,
        basis: {},
        notes: [],
      }
    : await resolveBaselineMinutesForRepo(
        store,
        opts.repo,
        project,
        config.lift.baselineMinutes,
        DEFAULT_CONFIG.lift.baselineMinutes,
      );

  // Lift source, in priority order — self-report is NEVER accepted:
  //   1. an externally measured TSF (transcript judge / RCT) — gold standard
  //   2. demo mode: a labeled synthetic TSF, so the interval shows in the demo
  //   3. real data: measured "time with AI" × resolved task baselines (the
  //      default real path; uninstrumented if there's no measured time or no
  //      baselined realized work)
  let liftOptions: RoIOptions;
  let liftNotes: string[];
  if (opts.tsfUpperBound !== undefined && opts.tsfUpperBound !== null) {
    const e = boundedLift({ tsfUpperBound: opts.tsfUpperBound });
    liftOptions = { lift: e.lensScore, liftRange: { low: e.lensLow, high: e.lensHigh } };
    if (disclose) liftOptions.liftHow = 'externally measured TSF (transcript judge / A-B)';
    liftNotes = e.notes;
  } else if (demo) {
    liftOptions = { ...demoLiftOptions() };
    liftNotes = [];
    if (disclose) {
      liftOptions.liftHow = 'labeled synthetic TSF (demo stand-in for a real A-B)';
      liftNotes = ['Demo: Lift uses a synthetic TSF stand-in for a real transcript-judge / A-B measurement.'];
    }
  } else {
    const dl = liftOptionsFromStore(store, report, baseline.minutes, {
      low: baseline.minutesLow,
      high: baseline.minutesHigh,
    });
    liftOptions = { lift: dl.lift, liftRange: dl.liftRange };
    if (disclose) {
      liftOptions.liftHow = 'measured time-with-AI × resolved task baselines (estimate, not a controlled A/B)';
    }
    liftNotes = [...dl.notes, ...baseline.notes];
  }

  // Labor rate prices both the effort tax and the money number's denominator.
  // Falls back to config; in the demo we assume an illustrative rate so the
  // dollar return is visible (clearly labeled), since the demo has no real org
  // rate. Threaded ONLY into the headline RoI — never into `liftOptions` — so
  // the per-project breakdown is not handed a global numerator.
  let laborRate = opts.laborRatePerHour !== undefined ? opts.laborRatePerHour : config.lift.laborRatePerHour;
  if (laborRate === null && demo) laborRate = DEMO_LABOR_RATE_PER_HOUR;

  // The money number's inputs, measured from the same data — and the same
  // baseline — the lenses use, so the value and the index cannot disagree.
  const money = moneyInputsFromStore(store, report, baseline.minutes, laborRate);

  const roi = computeReturnOnIntelligence(report, {
    ...liftOptions,
    laborRatePerHour: laborRate,
    grossRealizedValueUsd: money.grossRealizedValueUsd,
    supervisionMinutes: money.supervisionMinutes,
    riskAversion: opts.riskAversion ?? 0,
  });
  roi.notes.unshift(...liftNotes);

  // Goodhart drift alarm (docs §11): is a rate being BENT? Anytime-valid
  // e-processes over mature units in time order — realization, acceptance, and
  // hard-gate coverage (each stream needs ≥10 observed points; silent below
  // that, honestly). The PATTERN across streams is the tell: acceptance rising
  // while realization stagnates = proposal inflation; hard-gate unknowns rising
  // while the headline holds = coverage suppression.
  const matureOrdered = report.units.filter((u) => !u.maturing).sort((a, b) => a.tsEpochMs - b.tsEpochMs);
  const driftStreams = goodhartStreams(matureOrdered.map((u) => u.funnel));
  // Back-compat: `drift` stays the realization stream's report, as before.
  const drift = driftStreams.find((s) => s.stream === 'realization')?.report ?? null;

  // VoI (docs §12): which measurement to buy next — the un-instrumented lens
  // whose measurement would move the Index most, at a disclosed mid reference.
  const voi = instrumentationPriority(roi);

  // Time Reclaimed — the calendar-unit headline, off the SAME resolved baseline
  // as the Lift lens above, so the two numbers never disagree.
  const reclaimed = timeReclaimedFromStore(store, report, baseline.minutes, {
    low: baseline.minutesLow,
    high: baseline.minutesHigh,
  });

  return {
    loaded,
    project,
    baseline,
    liftOptions,
    liftNotes,
    roi,
    drift,
    driftStreams,
    voi,
    reclaimed,
    frontier: computeFrontier(report.units),
  };
}

/**
 * Return on Intelligence for usage WITHOUT code signals (chat, research,
 * drafting). Money inputs are the org's disclosed outcome baselines + labor
 * rate; the demo assumes illustrative values (clearly labeled at every surface
 * that renders them) so the dollar face is visible there at all.
 */
export function usageValue(
  store: Store,
  config: FiscusConfig,
  opts: { windowDays?: number; nowMs?: number } = {},
): UsageReport {
  const now = opts.nowMs ?? Date.now();
  const days = opts.windowDays ?? DEFAULT_SPEND_WINDOW_DAYS;
  let laborRatePerHour = config.lift.laborRatePerHour;
  let outcomeBaselineMinutes = config.lift.outcomeBaselineMinutes;
  if (isDemo()) {
    if (laborRatePerHour === null) laborRatePerHour = DEMO_LABOR_RATE_PER_HOUR;
    if (Object.keys(outcomeBaselineMinutes).length === 0) outcomeBaselineMinutes = DEMO_OUTCOME_BASELINE_MINUTES;
  }
  return computeUsageRoI(store, {
    startMs: now - days * DAY_MS,
    endMs: now + 1000,
    money: { outcomeBaselineMinutes, laborRatePerHour },
  });
}

/** The frontier cells `recommendBudget` reads — named so callers need not restate it. */
type BudgetInputsFrontier = Parameters<typeof recommendBudget>[0]['frontier'];

/** The advisor's output, plus the basis disclosures that make it actionable. */
export type BudgetAdvice = BudgetRecommendation & {
  /** Which spend the cap would actually govern — `live_proxy` or `all_observed`. */
  spendBasis: 'live_proxy' | 'all_observed';
  /** The observation window behind `observed`, in days. */
  windowDays: number;
};

/**
 * A cap recommendation, on the same spend basis the `--apply` action will
 * govern. Imported usage is observed-only by default, so it is excluded from
 * the basis unless the user explicitly opted into total-observed-spend
 * enforcement — a cap fitted to spend it cannot enforce is a lie.
 */
export function budgetAdvice(
  store: Store,
  config: FiscusConfig,
  opts: {
    windowDays?: number;
    nowMs?: number;
    realizedValueRate?: number | null;
    frontier?: BudgetInputsFrontier;
  } = {},
): BudgetAdvice {
  const now = opts.nowMs ?? Date.now();
  const days = opts.windowDays ?? DEFAULT_SPEND_WINDOW_DAYS;
  const liveOnly = !config.budget.capIncludesImported;
  const series = store.series(now - days * DAY_MS, now + 1000, DAY_MS, liveOnly);
  return {
    ...recommendBudget({
      dailySpends: series.map((s) => s.costUsd),
      realizedValueRate: opts.realizedValueRate ?? null,
      frontier: opts.frontier ?? [],
    }),
    spendBasis: liveOnly ? 'live_proxy' : 'all_observed',
    windowDays: days,
  };
}

export interface ValueReportOptions extends ValueSpineOptions {
  /** Fixes "now" across every window in the report, so the parts agree. */
  nowMs?: number;
  /** The spend/usage/cohort window, in days. */
  spendWindowDays?: number;
}

/**
 * The whole value report: the realization spine, plus the surfaces that do not
 * depend on a repo at all (usage without code signals, the per-user cohort
 * distribution, and the budget advice fitted to observed spend).
 *
 * `spine` is null when nothing has matured — every lens hanging off it is then
 * absent rather than zero, because "not computed" and "computed as zero" are
 * different claims and the caller must be able to tell them apart.
 */
export interface ValueReport {
  /** Fixed once, shared by every window in the report. */
  generatedAtMs: number;
  demo: boolean;
  repo: string | undefined;
  /** Null when nothing matured — no repo attached and no stored snapshots. */
  spine: ValueSpine | null;
  /** Per-project value, scored against the SAME Lift options as the headline. */
  projects: ProjectValue[] | null;
  usage: UsageReport;
  team: CohortReport;
  budget: BudgetAdvice;
}

/**
 * Compose the entire value report once. Every surface that reports value reads
 * this, so a change to the sequence changes every surface together — which is
 * the only way the dashboard and the CLI can be relied on to agree.
 */
export async function valueReport(
  store: Store,
  config: FiscusConfig,
  opts: ValueReportOptions,
): Promise<ValueReport> {
  const now = opts.nowMs ?? Date.now();
  const spendWindowDays = opts.spendWindowDays ?? DEFAULT_SPEND_WINDOW_DAYS;

  const usage = usageValue(store, config, { windowDays: spendWindowDays, nowMs: now });

  // Per-user VALUE — distribution only, gated by opt-in + k-anonymity. When
  // disabled/suppressed this carries no per-user data (suppressed:true), so a
  // caller can render the guardrail state without ever seeing names.
  const team = computeCohort(store, {
    startMs: now - spendWindowDays * DAY_MS,
    endMs: now + 1000,
    enabled: config.perUser.enabled,
    minCohort: config.perUser.minCohort,
  });

  const spine = await valueSpine(store, config, opts);

  // Per-project value is descriptive. Cross-project allocation is not
  // comparable/reliable enough to recommend from raw RoI alone.
  const projects = spine
    ? projectValueBreakdown(store, { windowDays: opts.windowDays, roiOptions: spine.liftOptions })
    : null;

  const budget = budgetAdvice(store, config, {
    windowDays: spendWindowDays,
    nowMs: now,
    realizedValueRate: spine?.loaded.report.matured.realizedValueRate ?? null,
    frontier: spine?.frontier.byModelAndTask ?? [],
  });

  return { generatedAtMs: now, demo: isDemo(), repo: opts.repo, spine, projects, usage, team, budget };
}
