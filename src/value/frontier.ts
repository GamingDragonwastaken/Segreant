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
  /** A trial preserves the observed rate but its anytime-valid intervals still overlap. */
  confidence: 'trial' | 'evidence_supported';
  rationale: string;
}

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
 * Recommend only a cheaper candidate with an observed realized-outcome rate no
 * lower than the expensive incumbent on the same task type. Three mature units
 * per model is still thin evidence, so an overlapping confidence sequence means
 * "trial", not an instruction to change the default route.
 */
function buildModelSwitchRecommendations(mature: WorkUnit[]): ModelSwitchRecommendation[] {
  const recs: ModelSwitchRecommendation[] = [];
  const minUnits = 3;
  const taskGroups = [...groupBy(mature, (u) => u.taskType)].sort((a, b) => b[1].length - a[1].length);

  for (const [taskType, units] of taskGroups) {
    const cells = [...groupBy(units, (u) => u.dominantModel ?? 'unattributed')]
      .map(([model, grouped]) => makeCell(`${taskType} · ${model}`, model, taskType, grouped))
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

    const candidateCs = anytimeRateInterval(Math.round(candidate.realizationRate * candidate.units), candidate.units, { level: 0.95 });
    const incumbentCs = anytimeRateInterval(Math.round(incumbent.realizationRate * incumbent.units), incumbent.units, { level: 0.95 });
    const confidence = candidateCs.low > incumbentCs.high ? 'evidence_supported' : 'trial';
    const savingsPerUnitUsd = incumbent.costPerUnit - candidate.costPerUnit;
    const historicalEquivalentHeadroomUsd = savingsPerUnitUsd * incumbent.units;
    const historicalHeadroomPercent = incumbent.costUsd > 0 ? historicalEquivalentHeadroomUsd / incumbent.costUsd : 0;
    const confidenceText =
      confidence === 'evidence_supported'
        ? "the candidate's anytime-valid lower outcome bound exceeds the incumbent's upper bound"
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
      rationale:
        `${candidate.model} costs $${candidate.costPerUnit.toFixed(2)} per ${taskType} unit versus ` +
        `$${incumbent.costPerUnit.toFixed(2)} for ${incumbent.model}; ${confidenceText}.`,
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
    return (
      `For ${item.taskType}: try ${item.candidateModel} before ${item.incumbentModel} - ` +
      `$${item.historicalEquivalentHeadroomUsd.toFixed(2)} historical-equivalent headroom across ` +
      `${item.incumbentUnits} incumbent units (${confidence}).`
    );
  });
}
