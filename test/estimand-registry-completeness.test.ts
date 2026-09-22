import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEstimandDefinition, RANDOMIZED_ITT_ESTIMAND_ID } from '../src/causal/estimand.ts';

test('the canonical randomized ITT definition names every causal-semantic dimension', () => {
  const definition = getEstimandDefinition(RANDOMIZED_ITT_ESTIMAND_ID) as unknown as Record<string, unknown>;
  for (const key of [
    'population',
    'treatment',
    'control',
    'treatmentVersions',
    'outcomeConstruct',
    'measurementModel',
    'timeHorizon',
    'assignmentMechanism',
    'target',
    'interferenceAssumptions',
    'missingnessAssumptions',
    'transportTarget',
    'identificationAssumptions',
    'estimatorVersion',
  ]) {
    assert.equal(typeof definition[key], 'string', 'estimand registry must declare ' + key);
  }
});
