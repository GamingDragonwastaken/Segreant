import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scope } from '../src/epistemic/scope.ts';
import {
  measurementModel,
  assessMeasurementFitness,
  type MeasurementModel,
  type MeasurementValidation,
} from '../src/measurement/model.ts';

function model(overrides: Partial<MeasurementModel> = {}): MeasurementModel {
  return {
    ...measurementModel({
      id: 'lines-v1',
      targetConstruct: 'developer_productivity',
      measurand: 'lines surviving blame',
      observable: 'git blame line identity',
      procedure: 'count added lines still blamed to the source commit',
      scope: scope({ organization: 'acme' }),
      population: 'commits in the declared window',
      validation: 'validated',
      calibration: null,
      uncertainty: { kind: 'none', description: 'exact line count' },
    }),
    ...overrides,
  };
}

// A model reconstituted from a stored row, a payload, or an interface-shaped
// literal never passes through `measurementModel()`, so its validation field is
// whatever the caller put there. The fitness gate used to test only for the
// single literal `proxy_unvalidated`, which meant every OTHER value — a typo, a
// legacy spelling, an absent field — read as "not an unvalidated proxy" and so
// as construct-fit. The strength was decided by the caller populating a field.
test('an unrecognized measurement validation is not construct fitness', () => {
  const typo = assessMeasurementFitness(
    model({ validation: 'unvalidated' as MeasurementValidation }),
    { requiredConstruct: 'developer_productivity' },
  );
  assert.equal(typo.fitForConstructClaim, false);
  assert.ok(typo.reasons.some((reason) => /unrecognized measurement validation/.test(reason)));

  const absent = assessMeasurementFitness(
    model({ validation: undefined as unknown as MeasurementValidation }),
    { requiredConstruct: 'developer_productivity' },
  );
  assert.equal(absent.fitForConstructClaim, false);
  assert.ok(absent.reasons.some((reason) => /unrecognized measurement validation/.test(reason)));
});

// `proxy_validated` and `validated` are distinct rungs of the ladder that
// `mergeClaimProfiles` already orders. A validated surrogate is evidence about
// the surrogate; it is not a direct measurement of the target construct, and a
// caller that intends to assert `validated` must not be told the surrogate
// suffices.
test('a validated proxy cannot back a claim asserting a validated direct measurement', () => {
  const escalated = assessMeasurementFitness(model({ validation: 'proxy_validated' }), {
    requiredConstruct: 'developer_productivity',
    requiredValidation: 'validated',
  });
  assert.equal(escalated.fitForConstructClaim, false);
  assert.ok(escalated.reasons.some((reason) => /measurement strength escalation/.test(reason)));
});

test('the strength a caller intends to assert is checked, never coerced', () => {
  assert.throws(
    () => assessMeasurementFitness(model(), {
      requiredConstruct: 'developer_productivity',
      requiredValidation: 'strong' as MeasurementValidation,
    }),
    /invalid required measurement validation/,
  );
});

// Guard rails. A gate that refused everything would satisfy every test above.

test('a validated surrogate still serves a caller that asserts only a validated surrogate', () => {
  assert.deepEqual(
    assessMeasurementFitness(model({ validation: 'proxy_validated' }), {
      requiredConstruct: 'developer_productivity',
      requiredValidation: 'proxy_validated',
    }),
    { fitForConstructClaim: true, reasons: [] },
  );
});

test('the pre-existing fitness call shape keeps its meaning for a matching validated model', () => {
  assert.deepEqual(
    assessMeasurementFitness(model(), { requiredConstruct: 'developer_productivity' }),
    { fitForConstructClaim: true, reasons: [] },
  );
});
