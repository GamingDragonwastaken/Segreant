/**
 * Bounded WP-E01 registry for canonical causal estimands.
 *
 * This slice names the randomized ITT estimand used by the existing causal
 * protocol. It is a descriptive registry primitive, not a replacement for
 * protocol validation or the estimator.
 */

export const RANDOMIZED_ITT_ESTIMAND_ID = 'randomized_itt' as const;

export interface EstimandDefinition {
  readonly id: typeof RANDOMIZED_ITT_ESTIMAND_ID;
  readonly label: 'Randomized intention-to-treat';
  readonly design: 'randomized';
  readonly analysis: 'intention_to_treat';
  readonly contrast: 'difference_in_means';
  readonly population: 'registered_eligible_population';
  readonly intervention: 'assigned_arm';
  readonly comparator: 'other_assigned_arm';
  readonly outcome: 'pre_registered_primary_outcome';
  readonly timeHorizon: 'registered_study_window';
  readonly missingData: 'report_missingness_do_not_impute_as_success';
}

const RANDOMIZED_ITT: EstimandDefinition = Object.freeze({
  id: RANDOMIZED_ITT_ESTIMAND_ID,
  label: 'Randomized intention-to-treat',
  design: 'randomized',
  analysis: 'intention_to_treat',
  contrast: 'difference_in_means',
  population: 'registered_eligible_population',
  intervention: 'assigned_arm',
  comparator: 'other_assigned_arm',
  outcome: 'pre_registered_primary_outcome',
  timeHorizon: 'registered_study_window',
  missingData: 'report_missingness_do_not_impute_as_success',
});

const definitions = new Map<string, EstimandDefinition>([
  [RANDOMIZED_ITT_ESTIMAND_ID, RANDOMIZED_ITT],
]);

/** Read-only canonical definitions; mutation APIs are intentionally absent. */
export const ESTIMAND_REGISTRY: ReadonlyMap<string, EstimandDefinition> = Object.freeze({
  get: (key: string) => definitions.get(key),
  has: (key: string) => definitions.has(key),
  keys: () => definitions.keys(),
  values: () => definitions.values(),
  entries: () => definitions.entries(),
  forEach: (callback: (value: EstimandDefinition, key: string, map: ReadonlyMap<string, EstimandDefinition>) => void) => {
    definitions.forEach((value, key) => callback(value, key, ESTIMAND_REGISTRY));
  },
  get size() { return definitions.size; },
  [Symbol.iterator]: () => definitions[Symbol.iterator](),
});

export function isEstimandId(value: string): value is typeof RANDOMIZED_ITT_ESTIMAND_ID {
  return value === RANDOMIZED_ITT_ESTIMAND_ID;
}

export function getEstimandDefinition(id: string): EstimandDefinition | undefined {
  return definitions.get(id);
}
