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
import { computeReturnOnIntelligence } from './lenses.ts';

export interface FrontierCell {
  key: string;
  model: string | null;
  taskType: string | null;
  units: number;
  costUsd: number;
  realizedValueUsd: number;
  realizationRate: number;
  acceptance: number | null;
  costPerUnit: number;
  roiIndex: number | null;
}

export interface FrontierReport {
  byModel: FrontierCell[];
  byTaskType: FrontierCell[];
  byModelAndTask: FrontierCell[];
  recommendations: string[];
}

function makeCell(key: string, model: string | null, taskType: string | null, units: WorkUnit[]): FrontierCell {
  const realized = units.filter((u) => u.funnel.realized);
  const costUsd = units.reduce((s, u) => s + u.attributedCostUsd, 0);
  const realizedValueUsd = realized.reduce((s, u) => s + u.attributedCostUsd, 0);
  const withAcc = units.filter((u) => u.acceptance !== null);
  const acceptance = withAcc.length > 0 ? withAcc.reduce((s, u) => s + (u.acceptance ?? 0), 0) / withAcc.length : null;
  const realizationRate = units.length > 0 ? realized.length / units.length : 0;
  const roiIndex = computeReturnOnIntelligence({
    firstPassAcceptance: acceptance,
    units,
    matured: { realizationRate, totalCostUsd: costUsd, realizedValueUsd },
  }).roiIndex;
  return {
    key,
    model,
    taskType,
    units: units.length,
    costUsd,
    realizedValueUsd,
    realizationRate,
    acceptance,
    costPerUnit: units.length > 0 ? costUsd / units.length : 0,
    roiIndex,
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

  return { byModel, byTaskType, byModelAndTask, recommendations: buildRecommendations(mature) };
}

/**
 * For each task-type where at least two models were used (with enough units to
 * be more than noise), recommend the model that returned the most per dollar and
 * name the trade-off against the most expensive alternative.
 */
function buildRecommendations(mature: WorkUnit[]): string[] {
  const recs: string[] = [];
  const minUnits = 2;
  const taskGroups = [...groupBy(mature, (u) => u.taskType)].sort((a, b) => b[1].length - a[1].length);

  for (const [tt, tus] of taskGroups) {
    const cells = [...groupBy(tus, (u) => u.dominantModel ?? 'unattributed')]
      .map(([model, us]) => makeCell(`${tt} · ${model}`, model, tt, us))
      .filter((c) => c.units >= minUnits && c.model !== 'unattributed' && c.roiIndex !== null);
    if (cells.length < 2) continue;

    cells.sort(byRoiDesc);
    const best = cells[0]!;
    const dearest = [...cells].sort((a, b) => b.costPerUnit - a.costPerUnit)[0]!;
    if (best.model === dearest.model) {
      recs.push(`For ${tt}: ${best.model} both leads RoI (${best.roiIndex!.toFixed(0)}) and costs the most — paying for the best here is justified.`);
    } else {
      const relRoi = dearest.roiIndex && best.roiIndex ? Math.round((best.roiIndex / Math.max(1, dearest.roiIndex)) * 100) : null;
      const relCost = dearest.costPerUnit > 0 ? best.costPerUnit / dearest.costPerUnit : 0;
      recs.push(
        `For ${tt}: ${best.model} leads (RoI ${best.roiIndex!.toFixed(0)} vs ${dearest.model} ${dearest.roiIndex!.toFixed(0)}) ` +
          `at ${relCost.toFixed(2)}× the per-unit cost — ${relRoi !== null ? `${relRoi}% of the return question is decided here; ` : ''}consider routing ${tt} work to ${best.model}.`,
      );
    }
  }
  if (recs.length === 0) recs.push('Not enough per-context data yet: use ≥2 models on the same task-type to unlock routing recommendations.');
  return recs;
}
