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

export interface FrontierReport {
  byModel: FrontierCell[];
  byTaskType: FrontierCell[];
  byModelAndTask: FrontierCell[];
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

  return { byModel, byTaskType, byModelAndTask, recommendations: buildRecommendations(mature), lensRedundancy: redundancy };
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
      // A routing decision is a policy change — it deserves a lower-bound check,
      // not a point-estimate coin flip. Compare the two cells' realization rates
      // via their anytime confidence sequences: only when the leader's LOWER
      // bound clears the alternative's UPPER bound is the evidence separated;
      // otherwise the recommendation says so out loud instead of feigning
      // certainty from a handful of units.
      const bestCs = anytimeRateInterval(Math.round(best.realizationRate * best.units), best.units, { level: 0.95 });
      const dearCs = anytimeRateInterval(Math.round(dearest.realizationRate * dearest.units), dearest.units, { level: 0.95 });
      const separated = bestCs.low > dearCs.high;
      const confidence = separated
        ? 'the separation holds at the anytime-valid lower bound — safe to act on'
        : `provisional: the anytime intervals still overlap on ${best.units + dearest.units} units — route a few more tasks before committing`;
      recs.push(
        `For ${tt}: ${best.model} leads (RoI ${best.roiIndex!.toFixed(0)} vs ${dearest.model} ${dearest.roiIndex!.toFixed(0)}) ` +
          `at ${relCost.toFixed(2)}× the per-unit cost — ${relRoi !== null ? `${relRoi}% of the return question is decided here; ` : ''}consider routing ${tt} work to ${best.model} (${confidence}).`,
      );
    }
  }
  if (recs.length === 0) recs.push('Not enough per-context data yet: use ≥2 models on the same task-type to unlock routing recommendations.');
  return recs;
}
