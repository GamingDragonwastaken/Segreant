/**
 * The single design/estimator authority for the causal subsystem.
 *
 * The protocol registry answers what was assigned and what estimand is named;
 * this registry answers which executable estimator is allowed to consume that
 * design. Keeping the two identities explicit prevents a retained v1
 * inspector, the deferred v2 evidence root, and the standalone sequential
 * rate lane from becoming three silently interchangeable causal systems.
 */

import { resolveEstimandDefinition } from './estimand.ts';
import { verifyCommittedCausalProtocol } from './protocol.ts';
import type { AnyCommittedCausalStudyProtocol } from './types.ts';

export interface DesignEstimatorDefinition {
  readonly id: string;
  readonly version: 1;
  readonly protocolType: string;
  readonly protocolVersion: number;
  readonly status: 'retained_analysis' | 'deferred' | 'archived' | 'noncausal';
  readonly estimandId: 'randomized_itt' | null;
  readonly assignment: string;
  readonly estimator: string | null;
  readonly limitation: string;
}

export const DESIGN_ESTIMATOR_REGISTRY: readonly DesignEstimatorDefinition[] = Object.freeze([
  Object.freeze({
    id: 'blocked_equal_itt_hoeffding_v1', version: 1,
    protocolType: 'segreant.causal-study', protocolVersion: 1,
    status: 'retained_analysis', estimandId: 'randomized_itt',
    assignment: 'blocked_randomized_equal_allocation',
    estimator: 'blocked_stratified_assigned_arm_difference_hoeffding_bonferroni',
    limitation: 'Retained v1 analysis only; ITT is block-aware and does not identify per-protocol, CACE, or LATE effects.',
  }),
  Object.freeze({
    id: 'blocked_equal_itt_v2_deferred', version: 1,
    protocolType: 'segreant.causal-study', protocolVersion: 2,
    status: 'deferred', estimandId: null,
    assignment: 'blocked_randomized_equal_allocation', estimator: null,
    limitation: 'V2 qualification is structural only; analysis projection and causal issuance remain deferred. No v1 evidence-root translation is allowed.',
  }),
  Object.freeze({
    id: 'paired_return_v1', version: 1,
    protocolType: 'segreant.paired-causal-return', protocolVersion: 1,
    status: 'archived', estimandId: null,
    assignment: 'segreant_local_csprng_per_pair', estimator: 'paired_bounded_return',
    limitation: 'Archived research-only operator-attested method; no migration to canonical causal evidence or issuance.',
  }),
  Object.freeze({
    id: 'sequential_bernoulli_v1', version: 1,
    protocolType: 'segreant.sequential-inference', protocolVersion: 1,
    status: 'noncausal', estimandId: null,
    assignment: 'fixed', estimator: 'anytime_bernoulli_rate',
    limitation: 'Standalone accumulated Bernoulli-rate inference, not an assigned-arm causal contrast or causal issuance path.',
  }),
]);

export function getDesignEstimatorDefinition(id: unknown): DesignEstimatorDefinition | undefined {
  return DESIGN_ESTIMATOR_REGISTRY.find((definition) => definition.id === id);
}

/** Resolve only the executable retained causal estimator; deferred/archived lanes stay unresolved. */
export function resolveCausalDesignEstimator(
  protocol: AnyCommittedCausalStudyProtocol,
): DesignEstimatorDefinition | undefined {
  if (verifyCommittedCausalProtocol(protocol).length !== 0) return undefined;
  const definition = DESIGN_ESTIMATOR_REGISTRY.find((entry) =>
    entry.protocolType === protocol.type
      && entry.protocolVersion === protocol.version
      && entry.status === 'retained_analysis',
  );
  if (!definition || protocol.allocation.method !== definition.assignment
      || resolveEstimandDefinition(protocol.analysis.estimand)?.id !== definition.estimandId) {
    return undefined;
  }
  return definition;
}
