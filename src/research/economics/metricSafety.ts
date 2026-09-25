export type MetricSafetyClass =
  | 'resource_accounting'
  | 'process_diagnostic'
  | 'outcome_measure'
  | 'causal_effect_estimate'
  | 'incentive_unsafe'
  | 'compensation_prohibited';

export type MetricPurpose =
  | 'resource_accounting'
  | 'diagnostic'
  | 'team_planning'
  | 'individual_performance'
  | 'compensation';

export interface MetricAssessment {
  metric: string;
  purpose: MetricPurpose;
  classes: MetricSafetyClass[];
  allowed: boolean;
  reason: string;
}

const RESOURCE_METRICS = new Set([
  'token_count',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'token_cost',
  'request_count',
  'ai_usage_count',
  'model_spend',
  'full_workflow_cost',
]);

const OUTCOME_METRICS = new Set([
  'realization_rate',
  'realized_outcomes',
  'acceptance_rate',
  'rework_rate',
  'sla_success_rate',
]);

const CAUSAL_METRICS = new Set([
  'incremental_value',
  'causal_return',
  'treatment_effect',
]);

const DIAGNOSTIC_METRICS = new Set([
  'roi_index',
  'opportunity_gap',
  'standardized_spend_ratio',
  'retry_rate',
  'cache_hit_rate',
]);

export function intrinsicMetricClass(metric: string): MetricSafetyClass {
  const normalized = metric.trim().toLowerCase();
  if (RESOURCE_METRICS.has(normalized)) return 'resource_accounting';
  if (OUTCOME_METRICS.has(normalized)) return 'outcome_measure';
  if (CAUSAL_METRICS.has(normalized)) return 'causal_effect_estimate';
  if (DIAGNOSTIC_METRICS.has(normalized)) return 'process_diagnostic';
  return 'process_diagnostic';
}

/**
 * Classify the USE of a metric, not merely its name. In particular, consuming
 * more tokens/cost is an input/resource signal and cannot become a productivity
 * reward target just because an organization asks for a ranking.
 */
export function assessMetricUse(metric: string, purpose: MetricPurpose): MetricAssessment {
  const normalized = metric.trim().toLowerCase();
  if (!normalized) throw new Error('metric name is required');

  const intrinsic = intrinsicMetricClass(normalized);
  const classes: MetricSafetyClass[] = [intrinsic];

  if (purpose === 'individual_performance' && intrinsic === 'resource_accounting') {
    classes.push('incentive_unsafe');
  }
  if (purpose === 'compensation') {
    if (intrinsic === 'resource_accounting') classes.push('incentive_unsafe');
    classes.push('compensation_prohibited');
  }

  const allowed = !classes.includes('incentive_unsafe') && !classes.includes('compensation_prohibited');
  let reason = 'metric is being used within its declared evidence class';
  if (classes.includes('compensation_prohibited')) {
    reason = 'Fiscus does not endorse tying individual compensation to a single instrumented metric';
  } else if (classes.includes('incentive_unsafe')) {
    reason = 'resource consumption is an input/cost signal, not productivity; rewarding it creates token-maxxing incentives';
  } else if (intrinsic === 'resource_accounting') {
    reason = 'resource consumption may be budgeted and diagnosed, but it is not output or productivity';
  }

  return { metric: normalized, purpose, classes, allowed, reason };
}
