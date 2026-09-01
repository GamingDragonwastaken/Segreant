/**
 * Value-aware allocation — the forward-looking half of budget governance.
 *
 * `recommendBudget` (recommend.ts) sets a spend CEILING. This answers the next
 * question, the one that turns Fiscus from a meter into a manager: given what
 * each context actually RETURNS (its RoI and realized-value rate), how should the
 * SAME budget be split across contexts — and what does moving a dollar from a
 * low-return context to a high-return one project to gain?
 *
 * Pure over precomputed cells (the model×task frontier today; project/team next),
 * so it is testable without a store and reusable across allocation dimensions.
 *
 * Honesty: every projection assumes each context's realized-value rate HOLDS at
 * the margin — a planning estimate under "RoI persists", never a guarantee. The
 * assumptions travel with the output so every surface shows them.
 */

export interface AllocationCell {
  key: string;
  costUsd: number;
  roiIndex: number | null; // null = unscored: held at status quo, never re-weighted
  spendOnRealizedUnitsUsd: number;
}

export interface AllocationItem {
  key: string;
  currentUsd: number;
  recommendedUsd: number;
  deltaUsd: number; // recommended − current (negative = trim, positive = grow)
  currentShare: number;
  recommendedShare: number;
  roiIndex: number | null;
}

export interface AllocationMove {
  fromKey: string;
  toKey: string;
  amountUsd: number;
  /** Explicit name for the raw arithmetic; never a forecast or realized value. */
  rawRateScenarioGainUsd: number;
  projectedValueGainUsd: number; // amount × (rvr_to − rvr_from)
  rationale: string;
}

export interface AllocationPlan {
  /** Generic contexts may be incomparable; this output is never an action recommendation. */
  evidenceClass: 'exploratory_raw';
  totalUsd: number;
  items: AllocationItem[];
  moves: AllocationMove[];
  /** Same arithmetic as legacy projectedValueGainUsd, with an honest semantic name. */
  rawRateScenarioGainUsd: number;
  projectedValueGainUsd: number;
  assumptions: string[];
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const rvrOf = (c: AllocationCell) => (c.costUsd > 0 ? clamp01(c.spendOnRealizedUnitsUsd / c.costUsd) : 0);

function fmt(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
}

/**
 * Re-weight the same total budget toward higher-RoI contexts.
 *
 *   weight_i      = currentUsd_i × max(roiIndex_i, roiFloor)
 *   recommended_i = scoredTotal × weight_i / Σ weight   (then tilted from current)
 *
 * `roiFloor` keeps a zero-RoI context from being zeroed outright — it shrinks, it
 * does not vanish. `tilt` ∈ [0,1] scales how far to move from the status quo
 * (1 = full value-weighting, 0 = no change), a knob for reallocation aggressiveness.
 * Unscored cells (no RoI yet) keep their current dollars and are carved out of the
 * re-weighting, so the total is always conserved.
 */
export function recommendAllocation(
  cells: AllocationCell[],
  opts: { roiFloor?: number; tilt?: number } = {},
): AllocationPlan {
  const roiFloor = opts.roiFloor ?? 10;
  const tilt = clamp01(opts.tilt ?? 1);
  const totalUsd = cells.reduce((s, c) => s + c.costUsd, 0);

  const scored = cells.filter((c) => c.roiIndex !== null && c.costUsd > 0);
  const scoredTotal = scored.reduce((s, c) => s + c.costUsd, 0);
  const weightSum = scored.reduce((s, c) => s + c.costUsd * Math.max(c.roiIndex as number, roiFloor), 0);

  const items: AllocationItem[] = cells.map((c) => {
    let recommendedUsd = c.costUsd;
    if (c.roiIndex !== null && c.costUsd > 0 && weightSum > 0) {
      const raw = (scoredTotal * (c.costUsd * Math.max(c.roiIndex, roiFloor))) / weightSum;
      recommendedUsd = c.costUsd + tilt * (raw - c.costUsd);
    }
    return {
      key: c.key,
      currentUsd: c.costUsd,
      recommendedUsd,
      deltaUsd: recommendedUsd - c.costUsd,
      currentShare: totalUsd > 0 ? c.costUsd / totalUsd : 0,
      recommendedShare: totalUsd > 0 ? recommendedUsd / totalUsd : 0,
      roiIndex: c.roiIndex,
    };
  });

  // Express the deltas as concrete transfers — biggest trim → biggest grow — and
  // project the realized-value change at each context's current rate.
  const rvr = new Map(cells.map((c) => [c.key, rvrOf(c)]));
  const trims = items
    .filter((i) => i.deltaUsd < -1e-9)
    .map((i) => ({ key: i.key, amt: -i.deltaUsd }))
    .sort((a, b) => b.amt - a.amt);
  const grows = items
    .filter((i) => i.deltaUsd > 1e-9)
    .map((i) => ({ key: i.key, amt: i.deltaUsd }))
    .sort((a, b) => b.amt - a.amt);

  const moves: AllocationMove[] = [];
  let ti = 0;
  let gi = 0;
  while (ti < trims.length && gi < grows.length) {
    const t = trims[ti]!;
    const g = grows[gi]!;
    const amount = Math.min(t.amt, g.amt);
    if (amount > 0.005) {
      const gain = amount * ((rvr.get(g.key) ?? 0) - (rvr.get(t.key) ?? 0));
      moves.push({
        fromKey: t.key,
        toKey: g.key,
        amountUsd: amount,
        rawRateScenarioGainUsd: gain,
        projectedValueGainUsd: gain,
        rationale: `Move ${fmt(amount)} from "${t.key}" to "${g.key}" → ≈ ${fmt(gain)} more realized value at current rates.`,
      });
    }
    t.amt -= amount;
    g.amt -= amount;
    if (t.amt <= 1e-9) ti++;
    if (g.amt <= 1e-9) gi++;
  }

  const projectedValueGainUsd = moves.reduce((s, m) => s + m.projectedValueGainUsd, 0);
  const assumptions = [
    'Same total budget, re-weighted toward higher-RoI contexts (budget ∝ spend × RoI, floored so nothing is zeroed outright).',
    'Projected gains assume each context’s realized-value rate holds at the margin — a planning estimate under "RoI persists", not a guarantee. Re-measure after reallocating.',
  ];

  assumptions.unshift(
    'EXPLORATORY RAW SCENARIO ONLY: generic model/task or project cells can be unlike work and are not actionable allocation evidence.',
    'This arithmetic does not establish causal uplift, comparable marginal returns, or a recommendation to change routing, budget, or spend.',
  );

  return { evidenceClass: 'exploratory_raw', totalUsd, items, moves, rawRateScenarioGainUsd: projectedValueGainUsd, projectedValueGainUsd, assumptions };
}
