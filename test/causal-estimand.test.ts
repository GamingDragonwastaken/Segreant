/** Canonical randomized ITT estimand registry contract. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESTIMAND_REGISTRY,
  RANDOMIZED_ITT_ESTIMAND_ID,
  getEstimandDefinition,
  isEstimandId,
} from '../src/causal/estimand.ts';

test('registry exposes exactly the canonical randomized ITT definition', () => {
  assert.deepEqual([...ESTIMAND_REGISTRY.keys()], [RANDOMIZED_ITT_ESTIMAND_ID]);
  const definition = getEstimandDefinition(RANDOMIZED_ITT_ESTIMAND_ID);
  assert.ok(definition);
  assert.equal(definition.id, 'randomized_itt');
  assert.equal(definition.design, 'randomized');
  assert.equal(definition.analysis, 'intention_to_treat');
  assert.equal(definition.contrast, 'difference_in_means');
  assert.equal(definition.population, 'registered_eligible_population');
  assert.equal(definition.intervention, 'assigned_arm');
  assert.equal(definition.comparator, 'other_assigned_arm');
  assert.equal(definition.outcome, 'pre_registered_primary_outcome');
  assert.equal(definition.timeHorizon, 'registered_study_window');
  assert.equal(definition.missingData, 'report_missingness_do_not_impute_as_success');
});

test('registry lookup rejects unknown identifiers without widening the canonical slice', () => {
  assert.equal(getEstimandDefinition('observational' as never), undefined);
  assert.equal(isEstimandId(RANDOMIZED_ITT_ESTIMAND_ID), true);
  assert.equal(isEstimandId('observational'), false);
});

test('registry and its definition are deeply immutable', () => {
  const definition = getEstimandDefinition(RANDOMIZED_ITT_ESTIMAND_ID)!;
  assert.ok(Object.isFrozen(ESTIMAND_REGISTRY));
  assert.ok(Object.isFrozen(definition));
  assert.throws(() => {
    (definition as { label: string }).label = 'mutated';
  }, TypeError);
  assert.equal(definition.label, 'Randomized intention-to-treat');
});
