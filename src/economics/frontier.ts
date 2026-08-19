export type FrontierDimension = 'quality' | 'cost' | 'latency' | 'risk' | 'value';

export interface EvidencePlan {
  planKey: string;
  /** Conservative lower bound; higher is better. */
  qualityLower: number | null;
  /** Conservative upper bound in integer microdollars; lower is better. */
  costUpperMicros: number | null;
  /** Conservative upper bound; lower is better. */
  latencyUpperMs: number | null;
  /** Conservative upper bound, normally [0,1]; lower is better. */
  riskUpper: number | null;
  /** Conservative lower bound in microdollars; higher is better. */
  valueLowerMicros: number | null;
  policyAllowed: boolean;
  notes?: string[];
}

export interface FrontierConstraints {
  minQuality?: number;
  maxCostMicros?: number;
  maxLatencyMs?: number;
  maxRisk?: number;
  /** Explicitly choose which dimensions define dominance. If omitted, a
   * dimension becomes relevant when at least one plan has evidence for it or a
   * hard constraint references it. */
  dimensions?: readonly FrontierDimension[];
}

export interface FrontierResult {
  activeDimensions: FrontierDimension[];
  feasible: EvidencePlan[];
  frontier: EvidencePlan[];
  excluded: Array<{ plan: EvidencePlan; reasons: string[] }>;
  unresolvedDimensions: Record<string, FrontierDimension[]>;
}

function valueFor(plan: EvidencePlan, dimension: FrontierDimension): number | null {
  switch (dimension) {
    case 'quality': return plan.qualityLower;
    case 'cost': return plan.costUpperMicros;
    case 'latency': return plan.latencyUpperMs;
    case 'risk': return plan.riskUpper;
    case 'value': return plan.valueLowerMicros;
  }
}

function lowerIsBetter(dimension: FrontierDimension): boolean {
  return dimension === 'cost' || dimension === 'latency' || dimension === 'risk';
}

export function frontierExclusionReasons(plan: EvidencePlan, constraints: FrontierConstraints): string[] {
  const reasons: string[] = [];
  if (!plan.policyAllowed) reasons.push('policy disallows this plan');

  if (constraints.minQuality !== undefined) {
    if (plan.qualityLower === null) reasons.push('quality lower bound is unknown');
    else if (plan.qualityLower < constraints.minQuality) reasons.push('quality lower bound does not clear the floor');
  }
  if (constraints.maxCostMicros !== undefined) {
    if (plan.costUpperMicros === null) reasons.push('cost upper bound is unknown');
    else if (plan.costUpperMicros > constraints.maxCostMicros) reasons.push('cost upper bound exceeds the cap');
  }
  if (constraints.maxLatencyMs !== undefined) {
    if (plan.latencyUpperMs === null) reasons.push('latency upper bound is unknown');
    else if (plan.latencyUpperMs > constraints.maxLatencyMs) reasons.push('latency upper bound exceeds the SLA');
  }
  if (constraints.maxRisk !== undefined) {
    if (plan.riskUpper === null) reasons.push('risk upper bound is unknown');
    else if (plan.riskUpper > constraints.maxRisk) reasons.push('risk upper bound exceeds tolerance');
  }
  return reasons;
}

function inferActiveDimensions(plans: readonly EvidencePlan[], constraints: FrontierConstraints): FrontierDimension[] {
  if (constraints.dimensions) return [...new Set(constraints.dimensions)];
  const active: FrontierDimension[] = [];
  const constrained = new Set<FrontierDimension>();
  if (constraints.minQuality !== undefined) constrained.add('quality');
  if (constraints.maxCostMicros !== undefined) constrained.add('cost');
  if (constraints.maxLatencyMs !== undefined) constrained.add('latency');
  if (constraints.maxRisk !== undefined) constrained.add('risk');
  for (const dimension of ['quality', 'cost', 'latency', 'risk', 'value'] as const) {
    if (constrained.has(dimension) || plans.some((plan) => valueFor(plan, dimension) !== null)) active.push(dimension);
  }
  return active;
}

/**
 * Conservative dominance proof. Unknown on either side blocks a dominance
 * claim for that active dimension; absence of evidence never becomes equality.
 */
export function evidenceDominates(
  challenger: EvidencePlan,
  incumbent: EvidencePlan,
  activeDimensions: readonly FrontierDimension[],
): boolean {
  if (activeDimensions.length === 0) return false;
  let strictlyBetter = false;
  for (const dimension of activeDimensions) {
    const a = valueFor(challenger, dimension);
    const b = valueFor(incumbent, dimension);
    if (a === null || b === null) return false;
    if (lowerIsBetter(dimension)) {
      if (a > b) return false;
      if (a < b) strictlyBetter = true;
    } else {
      if (a < b) return false;
      if (a > b) strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

export function evidenceConstrainedFrontier(
  plans: readonly EvidencePlan[],
  constraints: FrontierConstraints = {},
): FrontierResult {
  const seen = new Set<string>();
  for (const plan of plans) {
    if (!plan.planKey.trim()) throw new Error('every frontier plan requires planKey');
    if (seen.has(plan.planKey)) throw new Error(`duplicate planKey: ${plan.planKey}`);
    seen.add(plan.planKey);
  }

  const activeDimensions = inferActiveDimensions(plans, constraints);
  const feasible: EvidencePlan[] = [];
  const excluded: FrontierResult['excluded'] = [];
  const unresolvedDimensions: Record<string, FrontierDimension[]> = {};

  for (const plan of plans) {
    const reasons = frontierExclusionReasons(plan, constraints);
    unresolvedDimensions[plan.planKey] = activeDimensions.filter((dimension) => valueFor(plan, dimension) === null);
    if (reasons.length > 0) excluded.push({ plan, reasons });
    else feasible.push(plan);
  }

  const frontier = feasible.filter((incumbent) =>
    !feasible.some((challenger) =>
      challenger.planKey !== incumbent.planKey && evidenceDominates(challenger, incumbent, activeDimensions),
    ),
  );

  return { activeDimensions, feasible, frontier, excluded, unresolvedDimensions };
}
