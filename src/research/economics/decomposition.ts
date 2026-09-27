export interface ShapleyContribution {
  factor: string;
  contribution: number | null;
}

export interface ShapleyDecomposition {
  identified: boolean;
  baselineValue: number | null;
  targetValue: number | null;
  delta: number | null;
  contributions: ShapleyContribution[];
  residual: number | null;
  missingCoalitions: number;
}

function factorial(n: number): number {
  let value = 1;
  for (let i = 2; i <= n; i += 1) value *= i;
  return value;
}

/**
 * Exact Shapley decomposition for a deliberately small driver set. The model
 * callback may return null for an unidentified counterfactual; that missing
 * evidence propagates rather than being imputed as zero.
 */
export function exactShapleyDecomposition(
  baseline: Readonly<Record<string, number>>,
  target: Readonly<Record<string, number>>,
  evaluate: (drivers: Readonly<Record<string, number>>) => number | null,
  maxFactors = 10,
): ShapleyDecomposition {
  const factors = [...new Set([...Object.keys(baseline), ...Object.keys(target)])].sort();
  if (factors.length > maxFactors) throw new Error(`exact Shapley decomposition limited to ${maxFactors} factors`);
  for (const factor of factors) {
    if (!(factor in baseline) || !(factor in target)) throw new Error(`factor ${factor} must exist in baseline and target`);
    if (!Number.isFinite(baseline[factor]) || !Number.isFinite(target[factor])) throw new Error(`factor ${factor} values must be finite`);
  }

  const n = factors.length;
  const allFactorial = factorial(n);
  const cache = new Map<number, number | null>();
  let missingCoalitions = 0;

  const evaluateMask = (mask: number): number | null => {
    const cached = cache.get(mask);
    if (cached !== undefined || cache.has(mask)) return cached ?? null;
    const point: Record<string, number> = {};
    for (let i = 0; i < n; i += 1) {
      const factor = factors[i]!;
      point[factor] = (mask & (1 << i)) !== 0 ? target[factor]! : baseline[factor]!;
    }
    const value = evaluate(point);
    if (value !== null && !Number.isFinite(value)) throw new Error('Shapley evaluation must return finite number or null');
    if (value === null) missingCoalitions += 1;
    cache.set(mask, value);
    return value;
  };

  const contributions: ShapleyContribution[] = [];
  for (let j = 0; j < n; j += 1) {
    let contribution = 0;
    let identified = true;
    const bit = 1 << j;
    for (let mask = 0; mask < (1 << n); mask += 1) {
      if ((mask & bit) !== 0) continue;
      let subsetSize = 0;
      for (let k = 0; k < n; k += 1) if ((mask & (1 << k)) !== 0) subsetSize += 1;
      const without = evaluateMask(mask);
      const withFactor = evaluateMask(mask | bit);
      if (without === null || withFactor === null) {
        identified = false;
        continue;
      }
      const weight = factorial(subsetSize) * factorial(n - subsetSize - 1) / allFactorial;
      contribution += weight * (withFactor - without);
    }
    contributions.push({ factor: factors[j]!, contribution: identified ? contribution : null });
  }

  const baselineValue = evaluateMask(0);
  const targetValue = evaluateMask((1 << n) - 1);
  const allIdentified = baselineValue !== null && targetValue !== null && contributions.every((item) => item.contribution !== null);
  const delta = baselineValue !== null && targetValue !== null ? targetValue - baselineValue : null;
  const contributionTotal = allIdentified
    ? contributions.reduce((sum, item) => sum + (item.contribution ?? 0), 0)
    : null;

  return {
    identified: allIdentified,
    baselineValue,
    targetValue,
    delta,
    contributions,
    residual: delta !== null && contributionTotal !== null ? delta - contributionTotal : null,
    missingCoalitions,
  };
}

export interface SpendDiagnostic {
  actualCost: number;
  expectedCost: number | null;
  residual: number | null;
  standardizedSpendRatio: number | null;
  label: 'process_diagnostic_not_productivity';
}

export function standardizedSpendDiagnostic(actualCost: number, expectedCost: number | null): SpendDiagnostic {
  if (!Number.isFinite(actualCost) || actualCost < 0) throw new Error('actualCost must be finite and non-negative');
  if (expectedCost !== null && (!Number.isFinite(expectedCost) || expectedCost < 0)) throw new Error('expectedCost must be finite/non-negative or null');
  return {
    actualCost,
    expectedCost,
    residual: expectedCost === null ? null : actualCost - expectedCost,
    standardizedSpendRatio: expectedCost !== null && expectedCost > 0 ? actualCost / expectedCost : null,
    label: 'process_diagnostic_not_productivity',
  };
}

/** Emit a savings/opportunity gap only when the alternative is evidence-feasible. */
export function opportunityGap(actualFullCost: number, counterfactualFeasibleCost: number | null, evidenceSupported: boolean): number | null {
  if (!Number.isFinite(actualFullCost) || actualFullCost < 0) throw new Error('actualFullCost must be finite and non-negative');
  if (counterfactualFeasibleCost !== null && (!Number.isFinite(counterfactualFeasibleCost) || counterfactualFeasibleCost < 0)) {
    throw new Error('counterfactualFeasibleCost must be finite/non-negative or null');
  }
  if (!evidenceSupported || counterfactualFeasibleCost === null) return null;
  return actualFullCost - counterfactualFeasibleCost;
}
