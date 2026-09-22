import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scope } from '../src/epistemic/scope.ts';
import { measurementModel, type MeasurementModel } from '../src/measurement/model.ts';
import {
  measurementRegistry,
  assessMeasurementBacking,
  assertMeasurementBacking,
} from '../src/measurement/registry.ts';
import { ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL } from '../src/git/quality.ts';

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

// `measurementModelRef` is free text on Evidence and Claim. Nothing resolved
// it, so naming a model and having one were indistinguishable: a reference to
// a model that does not exist read exactly like a reference to one that does.
test('a reference that resolves to nothing is never treated as backing', () => {
  const registry = measurementRegistry([model()]);
  assert.equal(registry.resolve('no-such-model-anywhere'), null);

  const backing = assessMeasurementBacking(registry, {
    measurementModelRef: 'no-such-model-anywhere',
    requiredConstruct: 'developer_productivity',
    assertedValidation: 'validated',
  });
  assert.equal(backing.admissible, false);
  assert.equal(backing.model, null);
  assert.ok(backing.reasons.some((reason) => /resolves to no registered measurement model/.test(reason)));
});

test('a claim asserting a measurement strength must name a model at all', () => {
  const backing = assessMeasurementBacking(measurementRegistry([model()]), {
    measurementModelRef: null,
    requiredConstruct: 'developer_productivity',
    assertedValidation: 'proxy_validated',
  });
  assert.equal(backing.admissible, false);
  assert.ok(backing.reasons.some((reason) => /names no measurement model/.test(reason)));
});

// The concrete laundering this packet exists to stop. Fiscus's one declared
// measurement model is Git line retention, whose own author wrote
// `artifact_persistence` / `proxy_unvalidated` on it. Cited behind a validated
// productivity figure it must fail on both counts at once: a survival ratio is
// not productivity, and an unvalidated proxy is not a measurement of anything
// but itself.
test('git line retention cannot back a validated developer-productivity claim', () => {
  const registry = measurementRegistry([ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL]);
  const request = {
    measurementModelRef: ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL.id,
    requiredConstruct: 'developer_productivity',
    assertedValidation: 'validated',
  } as const;

  const backing = assessMeasurementBacking(registry, request);
  assert.equal(backing.admissible, false);
  assert.equal(backing.model?.id, ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL.id);
  assert.ok(backing.reasons.some((reason) => /construct mismatch/.test(reason)));
  assert.ok(backing.reasons.some((reason) => /unvalidated proxy/.test(reason)));

  assert.throws(() => assertMeasurementBacking(registry, request), /construct mismatch/);
});

test('the registry refuses two different models sharing one reference', () => {
  assert.throws(
    () => measurementRegistry([model(), model({ targetConstruct: 'artifact_persistence' })]),
    /conflicting measurement models registered under id/,
  );
  assert.doesNotThrow(() => measurementRegistry([model(), model()]));
});

test('the registry refuses a model that never passed through measurementModel', () => {
  assert.throws(
    () => measurementRegistry([{ ...model(), validation: 'unvalidated' } as unknown as MeasurementModel]),
    /invalid measurement validation/,
  );
  assert.throws(
    () => measurementRegistry([{ ...model(), targetConstruct: '  ' } as unknown as MeasurementModel]),
    /target construct must be non-empty/,
  );
});

// Guard rails. A gate that refused every reference would satisfy every test
// above while making the declaration surface useless.

test('a registered validated model backs a claim about the construct it measures', () => {
  const registry = measurementRegistry([model()]);
  const request = {
    measurementModelRef: 'lines-v1',
    requiredConstruct: 'developer_productivity',
    assertedValidation: 'validated',
  } as const;

  const backing = assessMeasurementBacking(registry, request);
  assert.equal(backing.admissible, true);
  assert.deepEqual(backing.reasons, []);
  assert.equal(backing.model?.id, 'lines-v1');
  assert.equal(assertMeasurementBacking(registry, request)?.id, 'lines-v1');
  assert.deepEqual(registry.ids, ['lines-v1']);
});

test('a validated surrogate backs a claim that asserts only a validated surrogate', () => {
  const backing = assessMeasurementBacking(measurementRegistry([model({ validation: 'proxy_validated' })]), {
    measurementModelRef: 'lines-v1',
    requiredConstruct: 'developer_productivity',
    assertedValidation: 'proxy_validated',
  });
  assert.equal(backing.admissible, true);
  assert.deepEqual(backing.reasons, []);
});

// The kernel already permits a null ref when a claim asserts nothing on the
// measurement axis, and every existing `proxy_unvalidated` boundary relies on
// that. Refusing it here would force those boundaries to invent a model to keep
// working, which is the laundering incentive pointed the other way.
test('a proxy_unvalidated claim stays admissible without naming a model', () => {
  const registry = measurementRegistry([]);
  const request = {
    measurementModelRef: null,
    requiredConstruct: 'developer_productivity',
    assertedValidation: 'proxy_unvalidated',
  } as const;

  const backing = assessMeasurementBacking(registry, request);
  assert.equal(backing.admissible, true);
  assert.equal(backing.model, null);
  assert.deepEqual(backing.reasons, []);
  assert.equal(assertMeasurementBacking(registry, request), null);
});

// Naming a model does not stop being checked just because the axis is weak: an
// honest proxy_unvalidated claim may cite the model it used, and citing one
// that measures a different construct is still a mismatch.
test('a proxy_unvalidated claim that does name a model still has that model checked', () => {
  const registry = measurementRegistry([ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL]);

  assert.equal(assessMeasurementBacking(registry, {
    measurementModelRef: ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL.id,
    requiredConstruct: ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL.targetConstruct,
    assertedValidation: 'proxy_unvalidated',
  }).admissible, true);

  const wrongConstruct = assessMeasurementBacking(registry, {
    measurementModelRef: ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL.id,
    requiredConstruct: 'developer_productivity',
    assertedValidation: 'proxy_unvalidated',
  });
  assert.equal(wrongConstruct.admissible, false);
  assert.ok(wrongConstruct.reasons.some((reason) => /construct mismatch/.test(reason)));
});
