/**
 * The per-context frontier — "what's best for *you*".
 *
 * RoI is only comparable within like-for-like work, so we slice the matured
 * units by model and by task-type and compute RoI per cell. The output answers
 * the question that turns the metric into a decision: for *this* kind of task,
 * which model returns the most per dollar?
 *
 * Each cell reuses the same RoI composite as the headline, so a cell's number
 * means exactly what the global number means — just scoped to a context.
 */

import type { WorkUnit } from './realization.ts';
import { computeReturnOnIntelligence, lensRedundancy, type LensRedundancy } from './lenses.ts';
import { anytimeRateInterval } from './anytime.ts';

export interface FrontierCell {
  key: string;
  model: string | null;
  taskType: string | null;
  units: number;
  costUsd: number;
  realizedValueUsd: number;
  netRealizedValueUsd: number;
  realizationRate: number;
  acceptance: number | null;
  costPerUnit: number;
  roiIndex: number | null;
  // The impact lens value for this cell (realized fraction weighted by
  // production reach + durability) — kept so the cells double as the sample
  // for the lens-redundancy statistic below.
  impact: number | null;
}

/**
 * A local historical comparison between a more expensive model and a cheaper
 * candidate on the same task type. It is review-only: Fiscus never changes
 * provider routing from this output.
 */
export interface ModelSwitchRecommendation {
  taskType: string;
  incumbentModel: string;
  candidateModel: string;
  incumbentUnits: number;
  candidateUnits: number;
  incumbentRealizationRate: number;
  candidateRealizationRate: number;
  incumbentCostPerUnitUsd: number;
  candidateCostPerUnitUsd: number;
  savingsPerUnitUsd: number;
  /** Savings across the incumbent's observed units at the candidate's historical rate. */
  historicalEquivalentHeadroomUsd: number;
  historicalHeadroomPercent: number;
  /**
   * `evidence_supported` requires the anytime-valid bounds to separate AND the
   * separation to survive one outcome flipping the wrong way on each side.
   * Everything else — overlapping bounds, or a separation that hinges on a single
   * observation — is a `trial`.
   */
  confidence: 'trial' | 'evidence_supported';
  /**
   * How the per-unit costs above were priced. `dominant_model_attributed` means
   * each model was charged only its own spend in the unit's window — a local
   * list-price estimate, never provider-billed cost.
   */
  costBasis: 'dominant_model_attributed';
  /** The dominant-model cost share a unit needed to be priced at all. */
  minimumDominantCostShare: number;
  /** Units dropped because their window was too mixed to price one model. */
  unitsExcludedMixedAttribution: number;
  /** Units dropped because no model attribution was recorded (e.g. legacy snapshots). */
  unitsExcludedUnknownAttribution: number;
  /**
   * Units dropped because their snapshot carries pre-reprice dollars. A model
   * comparison is a price difference; a superseded price on one side would move
   * the headroom for a reason that has nothing to do with the models.
   */
  unitsExcludedStalePricing: number;
  /**
   * Reasons this comparison cannot isolate the model even if the outcome
   * statistics separate. Non-empty always caps `confidence` at `trial`.
   */
  confounders: string[];
  /**
   * Assumptions the method makes and does NOT verify. These do not block a
   * result — they are the known limits of what it can mean, stated rather than
   * left for a reader to discover.
   */
  assumptions: string[];
  /** Median changed lines per unit on each side — the size axis cost-per-unit ignores. */
  candidateMedianUnitLines: number;
  incumbentMedianUnitLines: number;
  /** Confidence level actually used, after splitting 5% across the task types scanned. */
  appliedConfidenceLevel: number;
  /** How many task-type comparisons the level was split across. */
  comparisonsConsidered: number;
  rationale: string;
}

/**
 * What the comparison assumes and cannot check. Fixed text, attached to every
 * recommendation: a reader who sees only a dollar figure and a label would
 * otherwise have no way to know these hold.
 */
const MODEL_SWITCH_ASSUMPTIONS: readonly string[] = [
  'commits are treated as independent trials, but several from one session share a task, a codebase state, and an author — so the intervals are narrower than clustered evidence warrants',
  'costs are summed across pricing bases (local list-price estimates, fallback rates for unrecognized models, tool-reported amounts) without separating them',
  'which model was used was chosen by an operator, not assigned, so easier work may have systematically gone to the cheaper model',
  'a local list-price estimate is not provider-billed cost, and past cost is not a forecast of future cost',
] as const;

export interface FrontierReport {
  byModel: FrontierCell[];
  byTaskType: FrontierCell[];
  byModelAndTask: FrontierCell[];
  modelSwitches: ModelSwitchRecommendation[];
  recommendations: string[];
  // d_eff over the finest cells: how many independent dimensions the lens
  // system actually measures across contexts. Low d_eff = the lenses co-move —
  // a composite silently overweighting one latent factor. Disclosure, never an
  // automatic reweighting. See lenses.ts `lensRedundancy`.
  lensRedundancy: LensRedundancy;
}

function makeCell(key: string, model: string | null, taskType: string | null, units: WorkUnit[]): FrontierCell {
  const realized = units.filter((u) => u.funnel.realized);
  const costUsd = units.reduce((s, u) => s + u.attributedCostUsd, 0);
  const realizedValueUsd = realized.reduce((s, u) => s + u.attributedCostUsd, 0);
  // Net of rework: discount each realized unit's value by its first-pass acceptance
  // (unknown acceptance → full credit), matching the headline's net efficiency so
  // the frontier + allocation rank contexts by the SAME value the Index rewards.
  const netRealizedValueUsd = realized.reduce((s, u) => s + u.attributedCostUsd * (u.acceptance ?? 1), 0);
  const withAcc = units.filter((u) => u.acceptance !== null);
  const acceptance = withAcc.length > 0 ? withAcc.reduce((s, u) => s + (u.acceptance ?? 0), 0) / withAcc.length : null;
  const realizationRate = units.length > 0 ? realized.length / units.length : 0;
  const roi = computeReturnOnIntelligence({
    firstPassAcceptance: acceptance,
    units,
    matured: { realizationRate, totalCostUsd: costUsd, realizedValueUsd, netRealizedValueUsd },
  });
  return {
    key,
    model,
    taskType,
    units: units.length,
    costUsd,
    realizedValueUsd,
    netRealizedValueUsd,
    realizationRate,
    acceptance,
    costPerUnit: units.length > 0 ? costUsd / units.length : 0,
    roiIndex: roi.roiIndex,
    impact: roi.lenses.impact.value,
  };
}

function groupBy<K>(units: WorkUnit[], keyFn: (u: WorkUnit) => K): Map<K, WorkUnit[]> {
  const m = new Map<K, WorkUnit[]>();
  for (const u of units) {
    const k = keyFn(u);
    (m.get(k) ?? m.set(k, []).get(k)!).push(u);
  }
  return m;
}

const byRoiDesc = (a: FrontierCell, b: FrontierCell) => (b.roiIndex ?? -1) - (a.roiIndex ?? -1);

export function computeFrontier(units: WorkUnit[]): FrontierReport {
  const mature = units.filter((u) => !u.maturing);

  const byModel: FrontierCell[] = [];
  for (const [model, us] of groupBy(mature, (u) => u.dominantModel ?? 'unattributed')) {
    byModel.push(makeCell(model, model, null, us));
  }
  byModel.sort(byRoiDesc);

  const byTaskType: FrontierCell[] = [];
  for (const [tt, us] of groupBy(mature, (u) => u.taskType)) {
    byTaskType.push(makeCell(tt, null, tt, us));
  }
  byTaskType.sort((a, b) => b.units - a.units);

  const byModelAndTask: FrontierCell[] = [];
  for (const [tt, tus] of groupBy(mature, (u) => u.taskType)) {
    for (const [model, us] of groupBy(tus, (u) => u.dominantModel ?? 'unattributed')) {
      byModelAndTask.push(makeCell(`${tt} · ${model}`, model, tt, us));
    }
  }
  byModelAndTask.sort(byRoiDesc);

  // Redundancy over the finest slicing (most contexts): per-cell vectors of the
  // three per-context-computable lenses. Lift is window-global, so it cannot
  // vary across cells and is excluded rather than padded.
  const redundancy = lensRedundancy(
    byModelAndTask.map((c) => [c.realizationRate, c.acceptance, c.impact]),
    ['realization', 'acceptance', 'impact'],
  );

  const modelSwitches = buildModelSwitchRecommendations(mature);
  return {
    byModel,
    byTaskType,
    byModelAndTask,
    modelSwitches,
    recommendations: buildModelSwitchStrings(modelSwitches),
    lensRedundancy: redundancy,
  };
}

/**
 * The share of a unit's window spend that must belong to its dominant model
 * before the unit may be used to price that model.
 *
 * This is a disclosed assumption, not a derived constant. A commit's window
 * frequently contains more than one model; booking the whole window to the
 * top spender would charge one model for another's tokens and make the
 * "cheaper model" difference an artifact of the mix rather than of price. At
 * 0.8 a qualifying unit is at most one-fifth other models, so the residual
 * contamination is small relative to the price gaps this surfaces. Units below
 * the bar are not deleted — they are counted and reported as excluded.
 */
const MIN_DOMINANT_COST_SHARE = 0.8;

/**
 * Can this unit's dollars be charged to one model at all? It needs a recorded
 * model attribution, a dominant share above the purity bar, and a price that has
 * not been superseded by a reprice. Used both to count how many task types could
 * produce a comparison (the Bonferroni denominator) and to build the cells, so
 * the correction is split across exactly the comparisons that can happen.
 */
function isPriceable(u: WorkUnit): boolean {
  return (
    !u.costStale &&
    u.dominantModelCostShare !== null &&
    u.dominantModelCostUsd !== null &&
    u.dominantModelCostShare >= MIN_DOMINANT_COST_SHARE
  );
}

/** A model-vs-model cell priced by the model's OWN spend, not the window total. */
interface SwitchCell {
  model: string;
  units: number;
  /** Realized-outcome count — kept as a raw count so the interval math never round-trips through a rate. */
  realized: number;
  /** Sum of the dominant model's own spend across this cell's units. */
  modelCostUsd: number;
  /** Per-unit cost on the model-attributed basis. */
  costPerUnit: number;
  realizationRate: number;
  /** Median changed lines per unit — the size axis cost-per-unit is blind to. */
  medianUnitLines: number;
  /** Observation span of this cell's units, for detecting era-separated samples. */
  firstUnitMs: number;
  lastUnitMs: number;
}

/**
 * Beyond this ratio between the two cells' median unit sizes, "cheaper per unit"
 * is confounded with "did smaller pieces of work" and the comparison cannot
 * separate model price from task size. 2x is a judgement call, disclosed as one.
 */
const MAX_UNIT_SIZE_RATIO = 2;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function makeSwitchCell(model: string, units: WorkUnit[]): SwitchCell {
  const modelCostUsd = units.reduce((s, u) => s + (u.dominantModelCostUsd ?? 0), 0);
  const realized = units.filter((u) => u.funnel.realized).length;
  const times = units.map((u) => u.tsEpochMs);
  return {
    model,
    units: units.length,
    realized,
    modelCostUsd,
    costPerUnit: units.length > 0 ? modelCostUsd / units.length : 0,
    realizationRate: units.length > 0 ? realized / units.length : 0,
    medianUnitLines: median(units.map((u) => u.linesAdded + u.linesDeleted)),
    firstUnitMs: times.length > 0 ? Math.min(...times) : 0,
    lastUnitMs: times.length > 0 ? Math.max(...times) : 0,
  };
}

/**
 * Recommend only a cheaper candidate with an observed realized-outcome rate no
 * lower than the expensive incumbent on the same task type. Three mature units
 * per model is still thin evidence, so an overlapping confidence sequence means
 * "trial", not an instruction to change the default route.
 *
 * Cost here is the model's OWN attributed spend (`dominantModelCostUsd`), never
 * the unit's window total (`attributedCostUsd`). The window total is the right
 * answer to "what did this commit cost" and the wrong answer to "what does this
 * model cost", because a mixed window books every model's dollars to the top
 * spender. Units whose attribution is unknown or too mixed to price a single
 * model are excluded and counted, not quietly folded in.
 */
function buildModelSwitchRecommendations(mature: WorkUnit[]): ModelSwitchRecommendation[] {
  const recs: ModelSwitchRecommendation[] = [];
  const minUnits = 3;
  const taskGroups = [...groupBy(mature, (u) => u.taskType)]
    // `other` is the classifier's catch-all sink (see taskType.ts): a team that
    // does not write conventional-commit subjects funnels nearly everything into
    // it, so "the same task type" would stop meaning anything. Excluded outright,
    // the way `unattributed` is — an unclassified cohort is not a like-work cohort.
    .filter(([taskType]) => taskType !== 'other')
    .sort((a, b) => b[1].length - a[1].length);

  // How many task types could produce a comparison at all. Each one is another
  // chance for a false positive, so the confidence level is split across them
  // (Bonferroni) instead of every cohort independently spending the full 5%.
  const eligibleComparisons = Math.max(
    1,
    taskGroups.filter(([, units]) => {
      const attributable = units.filter(isPriceable);
      const models = new Set(attributable.map((u) => u.dominantModel ?? 'unattributed'));
      models.delete('unattributed');
      return models.size >= 2;
    }).length,
  );
  const familyAlpha = (1 - 0.95) / eligibleComparisons;
  const adjustedLevel = 1 - familyAlpha;

  for (const [taskType, units] of taskGroups) {
    // Partition before pricing so the exclusions can be reported rather than
    // silently shrinking the sample. Stale pricing is checked FIRST so a unit is
    // counted under exactly one reason — a superseded price is why it is out,
    // whatever its attribution share happens to say.
    const stalePricing = units.filter((u) => u.costStale);
    const priced = units.filter((u) => !u.costStale);
    const unknownAttribution = priced.filter((u) => u.dominantModelCostShare === null || u.dominantModelCostUsd === null);
    const mixedAttribution = priced.filter(
      (u) =>
        u.dominantModelCostShare !== null &&
        u.dominantModelCostUsd !== null &&
        u.dominantModelCostShare < MIN_DOMINANT_COST_SHARE,
    );
    const attributable = priced.filter(isPriceable);

    const cells = [...groupBy(attributable, (u) => u.dominantModel ?? 'unattributed')]
      .map(([model, grouped]) => makeSwitchCell(model, grouped))
      .filter((cell) => cell.units >= minUnits && cell.model !== 'unattributed' && cell.costPerUnit > 0);
    if (cells.length < 2) continue;

    const incumbent = [...cells].sort((a, b) => b.costPerUnit - a.costPerUnit)[0]!;
    const candidate = cells
      .filter(
        (cell) =>
          cell.model !== incumbent.model &&
          cell.costPerUnit < incumbent.costPerUnit &&
          cell.realizationRate >= incumbent.realizationRate,
      )
      .sort((a, b) => a.costPerUnit - b.costPerUnit || b.realizationRate - a.realizationRate)[0];
    if (!candidate) continue;

    const candidateCs = anytimeRateInterval(candidate.realized, candidate.units, { level: adjustedLevel });
    const incumbentCs = anytimeRateInterval(incumbent.realized, incumbent.units, { level: adjustedLevel });
    const separates = candidateCs.low > incumbentCs.high;
    /**
     * Separation alone is not enough to call something evidence.
     *
     * A 3-of-3 candidate produces a lower bound of 0.25, which clears the upper
     * bound of a 2-of-40 incumbent — so three commits from one afternoon would be
     * labelled EVIDENCE. The interval math is sound, but the conclusion rests on a
     * single observation, and the surrounding pipeline already weakens the
     * confidence sequence's guarantee (the pair is chosen by searching on the very
     * outcome being tested, the sample slides rather than accumulates, and a past
     * unit's realized verdict can change on re-run).
     *
     * So require the separation to survive one outcome flipping the wrong way on
     * each side: one candidate success becomes a failure, one incumbent failure
     * becomes a success. This is a sensitivity check, not an arbitrary minimum
     * sample — it scales with how close the call already is, and it is what makes
     * the doc-comment intent above ("three mature units is still thin evidence")
     * true in the code rather than only in prose.
     */
    const flippedCandidateLow = anytimeRateInterval(Math.max(0, candidate.realized - 1), candidate.units, { level: adjustedLevel }).low;
    const flippedIncumbentHigh = anytimeRateInterval(Math.min(incumbent.units, incumbent.realized + 1), incumbent.units, { level: adjustedLevel }).high;
    const survivesOneFlip = flippedCandidateLow > flippedIncumbentHigh;

    /**
     * Confounders: reasons this comparison cannot isolate the model, even when
     * the outcome statistics separate cleanly. Each one is named rather than
     * silently absorbed, and any of them caps the result at `trial` — the
     * statistics can only be as good as the comparison underneath them.
     */
    const confounders: string[] = [];
    // Cost-per-unit is blind to unit size, so a model that happened to take the
    // smaller pieces of work looks cheaper for a reason that is not its price.
    const sizeRatio =
      candidate.medianUnitLines > 0 && incumbent.medianUnitLines > 0
        ? Math.max(candidate.medianUnitLines, incumbent.medianUnitLines) /
          Math.min(candidate.medianUnitLines, incumbent.medianUnitLines)
        : 1;
    if (sizeRatio > MAX_UNIT_SIZE_RATIO) {
      confounders.push(
        `unit sizes differ ${sizeRatio.toFixed(1)}x by median changed lines ` +
          `(${Math.round(candidate.medianUnitLines)} vs ${Math.round(incumbent.medianUnitLines)}), ` +
          'so cheaper-per-unit is confounded with smaller work',
      );
    }
    // Non-overlapping observation spans mean the models were used in different
    // periods — different prices, different codebase, different task mix. That
    // is a comparison of eras as much as of models.
    if (candidate.lastUnitMs < incumbent.firstUnitMs || incumbent.lastUnitMs < candidate.firstUnitMs) {
      confounders.push(
        'the two models were observed in non-overlapping periods, so the comparison also spans a change in prices, codebase, and task mix',
      );
    }

    const confidence = separates && survivesOneFlip && confounders.length === 0 ? 'evidence_supported' : 'trial';
    const savingsPerUnitUsd = incumbent.costPerUnit - candidate.costPerUnit;
    const historicalEquivalentHeadroomUsd = savingsPerUnitUsd * incumbent.units;
    // Percent of the incumbent MODEL's own attributed spend — the same basis the
    // headroom dollars were computed on, so the ratio stays internally consistent.
    const historicalHeadroomPercent =
      incumbent.modelCostUsd > 0 ? historicalEquivalentHeadroomUsd / incumbent.modelCostUsd : 0;
    // A trial now arises two different ways, and saying "the intervals overlap"
    // when they in fact separated would be a false rationale.
    const confidenceText =
      confidence === 'evidence_supported'
        ? "the candidate's anytime-valid lower outcome bound exceeds the incumbent's upper bound, and still does if one outcome flips either way"
        : confounders.length > 0
          ? `the comparison is confounded — ${confounders[0]}`
          : separates
            ? `the anytime-valid bounds separate, but the separation does not survive a single flipped outcome across ${candidate.units + incumbent.units} units`
            : `observed outcome is no lower, but the anytime-valid intervals overlap across ${candidate.units + incumbent.units} units`;

    recs.push({
      taskType,
      incumbentModel: incumbent.model!,
      candidateModel: candidate.model!,
      incumbentUnits: incumbent.units,
      candidateUnits: candidate.units,
      incumbentRealizationRate: incumbent.realizationRate,
      candidateRealizationRate: candidate.realizationRate,
      incumbentCostPerUnitUsd: incumbent.costPerUnit,
      candidateCostPerUnitUsd: candidate.costPerUnit,
      savingsPerUnitUsd,
      historicalEquivalentHeadroomUsd,
      historicalHeadroomPercent,
      confidence,
      costBasis: 'dominant_model_attributed',
      minimumDominantCostShare: MIN_DOMINANT_COST_SHARE,
      unitsExcludedMixedAttribution: mixedAttribution.length,
      unitsExcludedUnknownAttribution: unknownAttribution.length,
      unitsExcludedStalePricing: stalePricing.length,
      confounders,
      assumptions: [...MODEL_SWITCH_ASSUMPTIONS],
      candidateMedianUnitLines: candidate.medianUnitLines,
      incumbentMedianUnitLines: incumbent.medianUnitLines,
      appliedConfidenceLevel: adjustedLevel,
      comparisonsConsidered: eligibleComparisons,
      rationale:
        `${candidate.model} costs $${candidate.costPerUnit.toFixed(2)} per ${taskType} unit versus ` +
        `$${incumbent.costPerUnit.toFixed(2)} for ${incumbent.model}, priced from each model's own ` +
        `attributed spend; ${confidenceText}.`,
    });
  }
  return recs;
}

function buildModelSwitchStrings(switches: ModelSwitchRecommendation[]): string[] {
  if (switches.length === 0) {
    return ['No lower-cost same-outcome trial yet: use at least two models on the same task type, with at least three mature units per model.'];
  }
  return switches.map((item) => {
    const confidence =
      item.confidence === 'evidence_supported'
        ? 'evidence-supported comparison'
        : 'review-only trial; continue measuring before changing a default';
    // A confounder is the single most decision-relevant thing about the result —
    // it is why the number may not be about the model at all — so it goes in the
    // one-line summary rather than only in the detail payload.
    const confounded = item.confounders.length > 0 ? `  [confounded: ${item.confounders.join('; ')}]` : '';
    return (
      `For ${item.taskType}: try ${item.candidateModel} before ${item.incumbentModel} - ` +
      `$${item.historicalEquivalentHeadroomUsd.toFixed(2)} historical-equivalent headroom across ` +
      `${item.incumbentUnits} incumbent units (${confidence}).${confounded}`
    );
  });
}
