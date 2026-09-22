/**
 * An expired surrogate bridge read as a current one, and the field that would
 * have said otherwise was never looked at.
 *
 * THE COUNTEREXAMPLE, MEASURED AGAINST THE COMMITTED TREE. Both
 * `MeasurementModelInput` and `SurrogateBridgeInput` declare an optional
 * `validTime`. `measurementModel()` copies it onto the frozen model,
 * `surrogateBridge()` carries it through a spread — and `grep validTime` finds
 * no other occurrence in the whole module. Nothing reads it. So a bridge whose
 * declared validity window closed in 2020 resolves today, passes every check,
 * and licenses exactly the same rung as one declared valid now. The field is a
 * comment with a type.
 *
 * It is also unvalidated: an interval whose `to` precedes its `from` was
 * accepted at construction, so a bridge could declare a window that cannot
 * contain any instant at all and still be registered.
 *
 * WHY A MISSING `asOf` WITHHOLDS RATHER THAN IGNORES. A bridge that declares a
 * window and is then asked "does this hold?" with no instant supplied has been
 * asked a question it cannot answer. The permissive reading — treat the absent
 * time as "now, presumably fine" — is how the field came to be decorative in
 * the first place, and it is the same absence-as-result move this repository
 * refuses everywhere else. So a TIME-BOUNDED citation with no `asOf` ceilings at
 * `proxy_unvalidated` and says why.
 *
 * A bridge or model that declares NO `validTime` is unbounded in time BY
 * DECLARATION, which is a different claim from one whose window is unknown.
 * Those are unaffected with or without `asOf`, which is why nothing existing
 * churns: `causalQualitySurrogateBridge` declares no window.
 *
 * Recorded at D-159.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scope } from '../src/epistemic/scope.ts';
import { measurementModel, type MeasurementModel } from '../src/measurement/model.ts';
import { measurementRegistry } from '../src/measurement/registry.ts';
import {
  assessBridgedMeasurementBacking,
  surrogateBridge,
  surrogateBridgeRegistry,
  type SurrogateBridge,
  type SurrogateBridgeInput,
} from '../src/measurement/surrogate.ts';

const WINDOW = { from: '2026-01-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' };
const INSIDE = '2026-03-01T00:00:00.000Z';
const AFTER = '2026-09-08T00:00:00.000Z';

function surrogateModel(overrides: Partial<MeasurementModel> = {}): MeasurementModel {
  return {
    ...measurementModel({
      id: 'acceptance-rate-v1',
      targetConstruct: 'code_quality',
      measurand: 'share of AI-authored diffs accepted by a reviewer',
      observable: 'reviewer acceptance events',
      procedure: 'accepted diffs divided by submitted diffs in the study window',
      scope: scope({ ledger: 'fiscus-causal' }),
      population: 'decisions in the declared causal study',
      validation: 'proxy_validated',
      calibration: null,
      uncertainty: { kind: 'none', description: 'exact event counts' },
    }),
    ...overrides,
  };
}

function referenceModel(overrides: Partial<MeasurementModel> = {}): MeasurementModel {
  return {
    ...measurementModel({
      id: 'defect-audit-v1',
      targetConstruct: 'code_quality',
      measurand: 'defects found by blind expert audit per thousand lines',
      observable: 'audit findings',
      procedure: 'two independent auditors, blind to authorship, adjudicated',
      scope: scope({ ledger: 'fiscus-causal' }),
      population: 'a sampled subset of the declared causal study',
      validation: 'validated',
      calibration: 'inter-rater agreement recorded per audit round',
      uncertainty: { kind: 'bounded', description: 'audit sampling', bound: 'the audited subset only' },
    }),
    ...overrides,
  };
}

function bridge(overrides: Partial<SurrogateBridgeInput> = {}): SurrogateBridge {
  return surrogateBridge({
    id: 'acceptance-rate-stands-for-quality-v1',
    surrogateModelRef: 'acceptance-rate-v1',
    targetConstruct: 'code_quality',
    surrogateConstruct: 'reviewer_acceptance',
    direction: 'increases_with_target',
    basis: {
      kind: 'empirical_association',
      argument: 'acceptance rate tracked audited defect density across the sampled subset',
      referenceMeasurementRef: 'defect-audit-v1',
      sample: '412 adjudicated diffs, 2026-Q1, two auditors',
    },
    failureModes: [
      'reviewers who know a diff is AI-authored accept differently',
      'acceptance saturates once diffs are small enough to skim',
    ],
    status: 'supported',
    contest: null,
    ...overrides,
  });
}

function ask(bridges: readonly SurrogateBridge[], models: readonly MeasurementModel[], asOf?: string) {
  return assessBridgedMeasurementBacking(
    measurementRegistry(models),
    surrogateBridgeRegistry(bridges),
    {
      measurementModelRef: 'acceptance-rate-v1',
      surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
      requiredConstruct: 'code_quality',
      assertedValidation: 'proxy_validated',
      ...(asOf === undefined ? {} : { asOf }),
    },
  );
}

test('the unwindowed case is unchanged, and this pins that nothing churns', () => {
  // The control. Neither the model nor the bridge declares a window, so both
  // are unbounded in time by declaration and the answer must be what it was
  // before any of this existed — with an `asOf` and without one.
  for (const asOf of [undefined, AFTER]) {
    const backing = ask([bridge()], [surrogateModel(), referenceModel()], asOf);
    assert.equal(backing.earnedValidation, 'proxy_validated', `asOf=${String(asOf)}`);
    assert.deepEqual(backing.reasons, []);
  }
});

test('a bridge whose window has closed cannot license its ceiling', () => {
  // THE COUNTEREXAMPLE. Before this, the window was carried and never read, so
  // this returned `proxy_validated` with no reasons at all.
  const backing = ask([bridge({ validTime: WINDOW })], [surrogateModel(), referenceModel()], AFTER);

  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.equal(backing.degraded, true);
  assert.ok(
    backing.reasons.some((reason) => reason.includes(AFTER) && /valid/i.test(reason)),
    `a reason must name the instant the bridge does not cover; got ${JSON.stringify(backing.reasons)}`,
  );
});

test('a bridge asked inside its own window is not penalised for having one', () => {
  // A declared window is a stronger record than no window, so it must not cost
  // the honest caller anything.
  const backing = ask([bridge({ validTime: WINDOW })], [surrogateModel(), referenceModel()], INSIDE);
  assert.equal(backing.earnedValidation, 'proxy_validated');
  assert.deepEqual(backing.reasons, []);
});

test('a time-bounded bridge asked with no instant withholds rather than assuming now', () => {
  // The load-bearing one. Treating a missing `asOf` as "presumably fine" is
  // exactly how the field became decorative; the honest answer to a question
  // that was not asked is to withhold the rung that depends on it.
  const backing = ask([bridge({ validTime: WINDOW })], [surrogateModel(), referenceModel()]);

  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.ok(
    backing.reasons.some((reason) => /no .*(instant|as-of|asOf)/i.test(reason)),
    `a reason must say the citation named no instant; got ${JSON.stringify(backing.reasons)}`,
  );
});

test('the measurement model carries its own window, and it is read too', () => {
  // The bridge is not the only side that can expire. A model whose calibration
  // window has closed is not made current by a bridge that is still open.
  const expired = surrogateModel({ validTime: WINDOW });
  const backing = ask([bridge()], [expired, referenceModel()], AFTER);

  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.ok(
    backing.reasons.some((reason) => reason.includes('acceptance-rate-v1') && /valid/i.test(reason)),
    `a reason must name the expired model; got ${JSON.stringify(backing.reasons)}`,
  );
});

test('an empirical reference measurement that has expired cannot validate anything', () => {
  // The subtlest of the three. `bridgeSupport` already refuses a reference that
  // is not itself `validated`; a reference whose validity window has closed is
  // the same failure with a clock on it.
  const backing = ask(
    [bridge()],
    [surrogateModel(), referenceModel({ validTime: WINDOW })],
    AFTER,
  );

  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.ok(
    backing.reasons.some((reason) => reason.includes('defect-audit-v1') && /valid/i.test(reason)),
    `a reason must name the expired reference; got ${JSON.stringify(backing.reasons)}`,
  );
});

test('a window that can contain no instant is refused at declaration', () => {
  // It was accepted. A bridge could declare a window ending before it began and
  // be registered, which is not a narrow window but an incoherent one.
  assert.throws(
    () => bridge({ validTime: { from: WINDOW.to, to: WINDOW.from } }),
    /interval start must be before end/,
  );
  // `measurementModel()` directly, not through the `surrogateModel` helper: that
  // helper spreads its overrides AFTER the constructor, so asserting through it
  // would test the spread and not the validation.
  assert.throws(
    () => measurementModel({
      id: 'windowed-v1',
      targetConstruct: 'code_quality',
      measurand: 'anything',
      observable: 'anything',
      procedure: 'anything',
      scope: scope({ ledger: 'fiscus-causal' }),
      population: 'anything',
      validation: 'proxy_unvalidated',
      calibration: null,
      uncertainty: { kind: 'none', description: 'exact' },
      validTime: { from: WINDOW.to, to: WINDOW.from },
    }),
    /interval start must be before end/,
  );
});
