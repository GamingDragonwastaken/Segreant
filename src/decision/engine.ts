/**
 * Conservative decision primitives for bounded utility evidence.
 *
 * These functions deliberately operate on intervals and explicitly declared
 * assumptions.  They can prove strict robust dominance when the evidence
 * warrants it; otherwise they return an undetermined certificate or a result
 * labelled with the rule that selected it.  A rule-selected action is never
 * presented as an objectively best action.
 */

export interface ActionUtilityInterval {
  readonly action: string;
  readonly low: number;
  readonly high: number;
}

export type DecisionCertificateStatus = 'proven_dominant' | 'undetermined';

export interface DominanceComparison {
  readonly action: string;
  readonly lowerBound: number;
  readonly strongestRivalUpperBound: number | null;
  readonly margin: number | null;
}

export interface DecisionCertificate {
  readonly status: DecisionCertificateStatus;
  readonly action: string | null;
  /** Strict lower-bound minus strongest rival upper-bound, when proved. */
  readonly margin: number | null;
  readonly rule: 'strict_interval_dominance';
  readonly reason: 'strict_interval_dominance' | 'intervals_overlap' | 'no_competitor';
  readonly comparisons: readonly DominanceComparison[];
  readonly assumptions: readonly string[];
}

export interface MinimaxRegretResult {
  readonly rule: 'minimax_regret';
  readonly assumption: 'rectangular_interval_uncertainty';
  readonly maxRegretByAction: Readonly<Record<string, number>>;
  /** All minimizers, sorted by action identifier for deterministic output. */
  readonly actions: readonly string[];
  readonly minimaxRegret: number;
  readonly assumptions: readonly string[];
}

export interface PosteriorScenario {
  readonly probability: number;
  /** Expected utility conditional on this mutually exclusive scenario. */
  readonly expectedUtilities: Readonly<Record<string, number>>;
}

export interface ValueOfInformationInput {
  /**
   * Optional compatibility assertion for the prior expectations. The
   * posterior scenario mixture is the sole authority; when supplied, this
   * map must agree with the mixture within the documented tolerance.
   */
  readonly currentExpectedUtilities?: Readonly<Record<string, number>>;
  readonly posteriorScenarios: readonly PosteriorScenario[];
  /** Measurement cost in the same utility units as the expected utilities. */
  readonly measurementCost: number;
}

export interface ValueOfInformationResult {
  readonly rule: 'expected_value_of_perfect_information';
  readonly assumption: 'finite_exhaustive_posterior_scenarios';
  /** Prior expectations derived from the posterior scenario mixture. */
  readonly priorExpectedUtilities: Readonly<Record<string, number>>;
  readonly currentOptimalExpectedUtility: number;
  readonly informedOptimalExpectedUtility: number;
  readonly grossValue: number;
  readonly measurementCost: number;
  readonly netValue: number;
  readonly currentOptimalActions: readonly string[];
  readonly informedOptimalActionsByScenario: readonly (readonly string[])[];
  readonly assumptions: readonly string[];
}

const DOMINANCE_ASSUMPTIONS = Object.freeze([
  'Each utility interval bounds the action utility in every admissible world.',
  'The interval uncertainty set is rectangular for regret calculations.',
  'Strict dominance requires a positive lower-bound margin over every rival upper bound.',
]);

const REGRET_ASSUMPTIONS = Object.freeze([
  'Each utility interval bounds the action utility in every admissible world.',
  'Utilities may vary independently within their intervals (rectangular uncertainty).',
  'Minimax regret is a declared selection rule, not proof of objective optimality.',
]);

const VOI_ASSUMPTIONS = Object.freeze([
  'Posterior scenarios are mutually exclusive and exhaustive.',
  'Scenario probabilities and expected utilities are finite and use one common utility basis.',
  'Prior expected utilities are derived from the scenario mixture; an optional supplied map is only a consistency assertion.',
  'The measurement reveals the scenario before the action is selected (perfect information).',
  'Measurement cost is expressed in the same utility units and is paid once.',
]);

const VOI_CONSISTENCY_TOLERANCE = 1e-9;
const VOI_MAX_SAFE_UTILITY = Number.MAX_SAFE_INTEGER;

function nonEmptyAction(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function validateIntervals(actions: ReadonlyArray<ActionUtilityInterval>): readonly ActionUtilityInterval[] {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('at least one action utility interval is required');
  }

  const seen = new Set<string>();
  return Object.freeze(actions.map((input, index) => {
    if (input === null || typeof input !== 'object') {
      throw new Error(`action utility interval ${index} must be an object`);
    }
    const action = nonEmptyAction(input.action, `action utility interval ${index} action`);
    if (seen.has(action)) throw new Error(`duplicate action: ${action}`);
    seen.add(action);

    const low = finiteNumber(input.low, `${action} low`);
    const high = finiteNumber(input.high, `${action} high`);
    if (low > high) throw new Error(`${action} low must be <= high`);
    return Object.freeze({ action, low, high });
  }));
}

function sortedActionNames(values: Readonly<Record<string, number>>): string[] {
  return Object.keys(values).sort((a, b) => a.localeCompare(b));
}

function maxActions(values: Readonly<Record<string, number>>): { value: number; actions: string[] } {
  const names = sortedActionNames(values);
  if (names.length === 0) throw new Error('expected utility map must contain at least one action');
  let value = values[names[0]!]!;
  for (const action of names.slice(1)) value = Math.max(value, values[action]!);
  return { value, actions: names.filter((action) => values[action] === value) };
}

/**
 * Prove strict robust dominance, if one interval's lower bound clears every
 * rival's upper bound. Overlap is intentionally returned as undetermined.
 */
export function certifyDecision(actions: ReadonlyArray<ActionUtilityInterval>): DecisionCertificate {
  const intervals = validateIntervals(actions);
  const comparisons = intervals.map((candidate) => {
    const rivals = intervals.filter((other) => other.action !== candidate.action);
    const strongestRivalUpperBound = rivals.length === 0
      ? null
      : Math.max(...rivals.map((rival) => rival.high));
    const margin = strongestRivalUpperBound === null
      ? null
      : candidate.low - strongestRivalUpperBound;
    return Object.freeze({
      action: candidate.action,
      lowerBound: candidate.low,
      strongestRivalUpperBound,
      margin,
    });
  });

  // With no rival there is no comparative dominance proposition to prove.
  // Keeping this undetermined avoids turning a one-option problem into an
  // unjustified claim of objective optimality.
  const winner = comparisons
    .filter((comparison) => comparison.margin !== null && comparison.margin > 0)
    .sort((a, b) => {
      const marginOrder = (b.margin ?? 0) - (a.margin ?? 0);
      return marginOrder !== 0 ? marginOrder : a.action.localeCompare(b.action);
    })[0];

  if (winner !== undefined) {
    return Object.freeze({
      status: 'proven_dominant',
      action: winner.action,
      margin: winner.margin,
      rule: 'strict_interval_dominance',
      reason: 'strict_interval_dominance',
      comparisons: Object.freeze(comparisons),
      assumptions: DOMINANCE_ASSUMPTIONS,
    });
  }

  return Object.freeze({
    status: 'undetermined',
    action: null,
    margin: null,
    rule: 'strict_interval_dominance',
    reason: intervals.length === 1 ? 'no_competitor' : 'intervals_overlap',
    comparisons: Object.freeze(comparisons),
    assumptions: DOMINANCE_ASSUMPTIONS,
  });
}

/**
 * Select all actions with the smallest worst-case regret under rectangular
 * interval uncertainty. This is a declared ambiguity rule, not a proof.
 */
export function minimaxRegret(actions: ReadonlyArray<ActionUtilityInterval>): MinimaxRegretResult {
  const intervals = validateIntervals(actions);
  const regrets: Record<string, number> = {};
  for (const candidate of intervals) {
    const rivalUpperBounds = intervals
      .filter((other) => other.action !== candidate.action)
      .map((rival) => rival.high);
    const strongestRivalUpperBound = rivalUpperBounds.length === 0 ? candidate.low : Math.max(...rivalUpperBounds);
    const regret = Math.max(0, strongestRivalUpperBound - candidate.low);
    if (!Number.isFinite(regret)) throw new Error('computed regret must be finite');
    regrets[candidate.action] = regret;
  }

  const regretValues = Object.values(regrets);
  const minimax = Math.min(...regretValues);
  const selected = Object.keys(regrets)
    .filter((action) => regrets[action] === minimax)
    .sort((a, b) => a.localeCompare(b));

  return Object.freeze({
    rule: 'minimax_regret',
    assumption: 'rectangular_interval_uncertainty',
    maxRegretByAction: Object.freeze(regrets),
    actions: Object.freeze(selected),
    minimaxRegret: minimax,
    assumptions: REGRET_ASSUMPTIONS,
  });
}

function validateUtilityMap(input: unknown, label: string): Record<string, number> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const values: Record<string, number> = {};
  for (const action of Object.keys(input)) {
    if (action.trim().length === 0) throw new Error(`${label} contains an empty action`);
    const value = finiteNumber((input as Record<string, unknown>)[action], `${label}.${action}`);
    if (Math.abs(value) > VOI_MAX_SAFE_UTILITY) {
      throw new Error(`${label}.${action} must be within the safe utility range`);
    }
    values[action] = value;
  }
  if (Object.keys(values).length === 0) throw new Error(`${label} must contain at least one action`);
  return values;
}

function assertSameActionSet(expected: readonly string[], actual: readonly string[], label: string): void {
  if (expected.length !== actual.length || expected.some((action, index) => action !== actual[index])) {
    throw new Error(`${label} must use the same action set as currentExpectedUtilities`);
  }
}

function derivePriorExpectedUtilities(
  scenarios: readonly Readonly<{ probability: number; expectedUtilities: Readonly<Record<string, number>> }>[],
  actions: readonly string[],
): Record<string, number> {
  const prior: Record<string, number> = {};
  for (const action of actions) {
    let expected = 0;
    for (const scenario of scenarios) {
      const contribution = scenario.probability * scenario.expectedUtilities[action]!;
      if (!Number.isFinite(contribution)) {
        throw new Error(`computed prior expected utility for ${action} must be finite`);
      }
      expected += contribution;
      if (!Number.isFinite(expected)) {
        throw new Error(`computed prior expected utility for ${action} must be finite`);
      }
    }
    prior[action] = expected;
  }
  return prior;
}

function approximatelyEqual(left: number, right: number): boolean {
  if (Object.is(left, right)) return true;
  const difference = Math.abs(left - right);
  if (!Number.isFinite(difference)) return false;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return difference <= VOI_CONSISTENCY_TOLERANCE * scale;
}

function cleanZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Expected value of perfect information over finite posterior scenarios,
 * minus the declared cost of acquiring that measurement.
 */
export function valueOfInformation(input: ValueOfInformationInput): ValueOfInformationResult {
  const suppliedCurrent = input?.currentExpectedUtilities === undefined
    ? null
    : validateUtilityMap(input.currentExpectedUtilities, 'currentExpectedUtilities');
  if (!Array.isArray(input?.posteriorScenarios) || input.posteriorScenarios.length === 0) {
    throw new Error('posteriorScenarios must contain at least one scenario');
  }
  const measurementCost = finiteNumber(input?.measurementCost, 'measurementCost');
  if (measurementCost < 0) throw new Error('measurementCost must be >= 0');

  let actions = suppliedCurrent === null ? null : sortedActionNames(suppliedCurrent);
  let probabilityTotal = 0;
  const scenarios = input.posteriorScenarios.map((scenario, index) => {
    if (scenario === null || typeof scenario !== 'object') {
      throw new Error(`posterior scenario ${index} must be an object`);
    }
    const probability = finiteNumber(scenario.probability, `posterior scenario ${index} probability`);
    if (probability < 0 || probability > 1) {
      throw new Error(`posterior scenario ${index} probability must be between 0 and 1`);
    }
    probabilityTotal += probability;
    const expectedUtilities = validateUtilityMap(
      scenario.expectedUtilities,
      `posterior scenario ${index} expectedUtilities`,
    );
    const scenarioActions = sortedActionNames(expectedUtilities);
    if (actions === null) actions = scenarioActions;
    else assertSameActionSet(actions, scenarioActions, `posterior scenario ${index} expectedUtilities`);
    const optimal = maxActions(expectedUtilities);
    return Object.freeze({ probability, expectedUtilities, optimal });
  });

  if (!Number.isFinite(probabilityTotal) || Math.abs(probabilityTotal - 1) > VOI_CONSISTENCY_TOLERANCE) {
    throw new Error('probabilities must sum to 1');
  }

  if (actions === null) throw new Error('posteriorScenarios must contain at least one action');
  const priorExpectedUtilities = derivePriorExpectedUtilities(scenarios, actions);
  if (suppliedCurrent !== null) {
    for (const action of actions) {
      if (!approximatelyEqual(suppliedCurrent[action]!, priorExpectedUtilities[action]!)) {
        throw new Error(`currentExpectedUtilities is inconsistent with scenario mixture for action ${action}`);
      }
    }
  }

  const current = suppliedCurrent ?? priorExpectedUtilities;
  const currentOptimal = maxActions(current);
  let informedOptimalExpectedUtility = 0;
  for (const scenario of scenarios) {
    const contribution = scenario.probability * scenario.optimal.value;
    if (!Number.isFinite(contribution)) throw new Error('computed informed expected utility must be finite');
    informedOptimalExpectedUtility += contribution;
    if (!Number.isFinite(informedOptimalExpectedUtility)) {
      throw new Error('computed informed expected utility must be finite');
    }
  }
  const rawGrossValue = informedOptimalExpectedUtility - currentOptimal.value;
  if (!Number.isFinite(rawGrossValue)) throw new Error('computed gross EVPI must be finite');
  const grossTolerance = VOI_CONSISTENCY_TOLERANCE
    * Math.max(1, Math.abs(informedOptimalExpectedUtility), Math.abs(currentOptimal.value));
  if (rawGrossValue < -grossTolerance) throw new Error('gross EVPI must be non-negative');
  const grossValue = cleanZero(rawGrossValue < 0 ? 0 : rawGrossValue);
  const netValue = cleanZero(grossValue - measurementCost);

  return Object.freeze({
    rule: 'expected_value_of_perfect_information',
    assumption: 'finite_exhaustive_posterior_scenarios',
    priorExpectedUtilities: Object.freeze(priorExpectedUtilities),
    currentOptimalExpectedUtility: currentOptimal.value,
    informedOptimalExpectedUtility,
    grossValue,
    measurementCost,
    netValue,
    currentOptimalActions: Object.freeze(currentOptimal.actions),
    informedOptimalActionsByScenario: Object.freeze(
      scenarios.map((scenario) => Object.freeze(scenario.optimal.actions)),
    ),
    assumptions: VOI_ASSUMPTIONS,
  });
}
