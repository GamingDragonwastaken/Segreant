export interface SpendScenario {
  costMicros: number;
  /** Relative scenario probability/weight. Omitted means 1. */
  weight?: number;
}

export interface BudgetRiskReport {
  scenarioCount: number;
  expectedMicros: number | null;
  p50Micros: number | null;
  p90Micros: number | null;
  p99Micros: number | null;
  cvar99Micros: number | null;
  breachProbability: number | null;
}

interface WeightedCost { cost: number; weight: number }

function normalizeScenarios(scenarios: readonly SpendScenario[]): WeightedCost[] {
  if (scenarios.length === 0) return [];
  let totalWeight = 0;
  const raw = scenarios.map((scenario, index) => {
    const weight = scenario.weight ?? 1;
    if (!Number.isSafeInteger(scenario.costMicros) || scenario.costMicros < 0) {
      throw new Error(`scenario ${index} costMicros must be a non-negative safe integer`);
    }
    if (!Number.isFinite(weight) || weight <= 0) throw new Error(`scenario ${index} weight must be positive and finite`);
    totalWeight += weight;
    return { cost: scenario.costMicros, weight };
  });
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) throw new Error('scenario weights cannot be normalized');
  return raw
    .map((item) => ({ cost: item.cost, weight: item.weight / totalWeight }))
    .sort((a, b) => a.cost - b.cost);
}

function weightedQuantile(items: readonly WeightedCost[], probability: number): number | null {
  if (items.length === 0) return null;
  if (!(probability >= 0 && probability <= 1)) throw new Error('quantile probability must be in [0,1]');
  let cumulative = 0;
  for (const item of items) {
    cumulative += item.weight;
    if (cumulative + Number.EPSILON >= probability) return item.cost;
  }
  return items.at(-1)?.cost ?? null;
}

/** Exact weighted mean of the worst (1-alpha) probability mass. */
function weightedUpperTailMean(items: readonly WeightedCost[], alpha: number): number | null {
  if (items.length === 0) return null;
  if (!(alpha >= 0 && alpha < 1)) throw new Error('CVaR alpha must be in [0,1)');
  const tailMass = 1 - alpha;
  let remaining = tailMass;
  let weighted = 0;
  for (let index = items.length - 1; index >= 0 && remaining > 1e-15; index -= 1) {
    const item = items[index]!;
    const taken = Math.min(item.weight, remaining);
    weighted += item.cost * taken;
    remaining -= taken;
  }
  const consumed = tailMass - Math.max(0, remaining);
  return consumed > 0 ? weighted / consumed : null;
}

/**
 * Tail-aware budget report for an explicitly supplied scenario distribution.
 * An empty scenario set is unknown, not a zero-cost forecast.
 */
export function summarizeBudgetRisk(
  scenarios: readonly SpendScenario[],
  budgetMicros: number,
): BudgetRiskReport {
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 0) throw new Error('budgetMicros must be a non-negative safe integer');
  const items = normalizeScenarios(scenarios);
  if (items.length === 0) {
    return {
      scenarioCount: 0,
      expectedMicros: null,
      p50Micros: null,
      p90Micros: null,
      p99Micros: null,
      cvar99Micros: null,
      breachProbability: null,
    };
  }

  const expectedMicros = items.reduce((sum, item) => sum + item.cost * item.weight, 0);
  const breachProbability = items
    .filter((item) => item.cost > budgetMicros)
    .reduce((sum, item) => sum + item.weight, 0);

  return {
    scenarioCount: items.length,
    expectedMicros,
    p50Micros: weightedQuantile(items, 0.50),
    p90Micros: weightedQuantile(items, 0.90),
    p99Micros: weightedQuantile(items, 0.99),
    cvar99Micros: weightedUpperTailMean(items, 0.99),
    breachProbability,
  };
}

/**
 * One projected-gradient step for the non-negative scarcity multiplier lambda.
 * This is a primitive for simulation/research; nothing calls it from the live
 * budget guard.
 */
export function updateScarcityDual(
  currentLambda: number,
  observedMicros: number,
  targetMicros: number,
  learningRate = 0.1,
): number {
  for (const [name, value] of Object.entries({ currentLambda, observedMicros, targetMicros, learningRate })) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  }
  if (currentLambda < 0 || observedMicros < 0 || targetMicros <= 0 || learningRate <= 0) {
    throw new Error('lambda/observed must be non-negative; target/learningRate must be positive');
  }
  const violation = (observedMicros - targetMicros) / targetMicros;
  return Math.max(0, currentLambda + learningRate * violation);
}
