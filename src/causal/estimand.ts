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
  readonly treatment: 'assigned_arm';
  readonly control: 'other_assigned_arm';
  /** Legacy aliases retained for callers that still use the earlier vocabulary. */
  readonly intervention: 'assigned_arm';
  readonly comparator: 'other_assigned_arm';
  readonly treatmentVersions: 'registered_execution_plan_digest';
  readonly outcome: 'pre_registered_primary_outcome';
  readonly outcomeConstruct: 'pre_registered_primary_outcome';
  readonly measurementModel: 'registered_quality_measurement_model';
  readonly timeHorizon: 'registered_study_window';
  readonly assignmentMechanism: 'blocked_randomized_equal_allocation';
  readonly target: 'randomized_itt';
  readonly interferenceAssumptions: 'no_interference_assumed_not_tested';
  readonly missingData: 'report_missingness_do_not_impute_as_success';
  readonly missingnessAssumptions: 'report_missingness_do_not_impute_as_success';
  readonly transportTarget: 'none_beyond_registered_eligible_population';
  readonly identificationAssumptions: 'randomized_assignment_validity_and_consistent_assignment';
  readonly estimatorVersion: 'bounded_difference_hoeffding_v1';
}

const RANDOMIZED_ITT: EstimandDefinition = Object.freeze({
  id: RANDOMIZED_ITT_ESTIMAND_ID,
  label: 'Randomized intention-to-treat',
  design: 'randomized',
  analysis: 'intention_to_treat',
  contrast: 'difference_in_means',
  population: 'registered_eligible_population',
  treatment: 'assigned_arm',
  control: 'other_assigned_arm',
  intervention: 'assigned_arm',
  comparator: 'other_assigned_arm',
  treatmentVersions: 'registered_execution_plan_digest',
  outcome: 'pre_registered_primary_outcome',
  outcomeConstruct: 'pre_registered_primary_outcome',
  measurementModel: 'registered_quality_measurement_model',
  timeHorizon: 'registered_study_window',
  assignmentMechanism: 'blocked_randomized_equal_allocation',
  target: 'randomized_itt',
  interferenceAssumptions: 'no_interference_assumed_not_tested',
  missingData: 'report_missingness_do_not_impute_as_success',
  missingnessAssumptions: 'report_missingness_do_not_impute_as_success',
  transportTarget: 'none_beyond_registered_eligible_population',
  identificationAssumptions: 'randomized_assignment_validity_and_consistent_assignment',
  estimatorVersion: 'bounded_difference_hoeffding_v1',
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

/**
 * Resolve the retained protocol vocabulary to a canonical registry entry.
 * Unknown analysis labels stay unresolved; this helper never creates IDs.
 */
export function resolveEstimandDefinition(analysis: unknown): EstimandDefinition | undefined {
  if (analysis !== 'intention_to_treat') return undefined;
  return getEstimandDefinition(RANDOMIZED_ITT_ESTIMAND_ID);
}
