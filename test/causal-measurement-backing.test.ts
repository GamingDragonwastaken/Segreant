/**
 * The causal claims said their quality metric was a VALIDATED proxy, and the
 * only thing behind that was that the protocol had named the metric in advance.
 *
 * THE COUNTEREXAMPLE, MEASURED AGAINST THE COMMITTED TREE. `src/causal/epistemic.ts`
 * issues two claims — `causal.arm_difference` and `causal.effect` — and both
 * carried a hard-coded `measurement: 'proxy_validated'`:
 *
 *   claim:causal:arm_difference:study-model  proxy_validated
 *   claim:causal:effect:study-model          proxy_validated
 *   measurementModelRef  causal:quality-metric:verified_quality@d96fa6e4...
 *
 * That reference resolved to nothing. It was a string synthesized from the
 * metric id and the protocol hash, and no `MeasurementModel` existed anywhere
 * with that id, so a reader who tried to check what had been validated found no
 * record of a validation to check. The rung was also a constant: the same
 * `proxy_validated` for all four quality evidence classes the protocol admits,
 * which differ from one another in exactly the respect the axis is about.
 *
 * WHY `proxy_validated` IS THE WRONG RUNG HERE, not merely an unbacked one.
 * D-149 built `surrogateBridge` to make this decidable, and its answer is
 * unambiguous: `bridgeCeiling` returns `proxy_validated` only for an
 * `empirical_association` basis — the surrogate compared against an independent
 * measurement of the target. What this protocol supplies is pre-registration,
 * whose own basis docblock says it "rules out choosing the metric after seeing
 * the data; it does not rule in the metric." A pre-registered bridge ceilings
 * at `proxy_unvalidated`. Nothing in this repository records an empirical
 * association between any quality metric and the quality construct, so nothing
 * here reaches the rung the code was asserting.
 *
 * This is D-149's rule applied to the repository's own strongest surrogate
 * claims, which is what that packet was written for and what it did not do.
 *
 * Recorded at D-153.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCausalStudyKernelIssuance } from '../src/causal/epistemic.ts';
import {
  CAUSAL_QUALITY_CONSTRUCT,
  causalQualityMeasurementBacking,
  causalQualityMeasurementModel,
  causalQualityMeasurementModelRef,
  causalQualityRegistries,
  causalQualitySurrogateBridge,
  causalQualitySurrogateBridgeRef,
} from '../src/causal/measurement.ts';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import { bridgeCeiling } from '../src/measurement/surrogate.ts';
import { repeatedCostQualityData } from './support/causalStudyFixture.ts';
import type { CausalStudyData } from '../src/causal/types.ts';

const ISSUED_AT_MS = 1_700_100_000_000;

function supportedStudy(): CausalStudyData {
  return repeatedCostQualityData(0.95, 0.8);
}

function issue(data: CausalStudyData): ReturnType<typeof buildCausalStudyKernelIssuance> {
  return buildCausalStudyKernelIssuance(data, estimateCausalStudy(data), ISSUED_AT_MS);
}

test('the issued causal claims carry the rung the declared bridge earns, not a constant', () => {
  const data = supportedStudy();
  const issuance = issue(data);
  const earned = causalQualityMeasurementBacking(data.protocol).earnedValidation;

  assert.equal(earned, 'proxy_unvalidated', 'a pre-registered bridge cannot license proxy_validated');
  assert.equal(issuance.armDifference.profile.measurement, earned);
  assert.equal(issuance.effect?.profile.measurement, earned);
});

test('the measurement model reference on the issued claims actually resolves', () => {
  // The load-bearing one. The old reference was a synthesized string that
  // resolved to nothing, so `proxy_validated` named a validation that no record
  // described — the absence of a measurement model reported as the presence of
  // a validated one.
  const data = supportedStudy();
  const issuance = issue(data);
  const { models } = causalQualityRegistries(data.protocol);

  const ref = issuance.armDifference.measurementModelRef;
  assert.equal(ref, causalQualityMeasurementModelRef(data.protocol));
  assert.notEqual(ref, null);
  const model = models.resolve(ref!);
  assert.notEqual(model, null, 'the reference the claim carries must resolve in the registry it names');
  assert.equal(model?.targetConstruct, CAUSAL_QUALITY_CONSTRUCT);
});

test('the bridge is pre-registered, and that is exactly why the rung is what it is', () => {
  const protocol = supportedStudy().protocol;
  const bridge = causalQualitySurrogateBridge(protocol);

  assert.equal(bridge.basis.kind, 'preregistered');
  assert.equal(bridge.surrogateModelRef, causalQualityMeasurementModelRef(protocol));
  assert.equal(bridge.targetConstruct, CAUSAL_QUALITY_CONSTRUCT);
  assert.equal(bridgeCeiling(bridge), 'proxy_unvalidated');
  assert.ok(
    bridge.failureModes.length > 0,
    'a bridge with no named failure mode has not been examined',
  );
});

test('the model and bridge are pinned to the protocol hash, so they cannot outlive it', () => {
  // The reference was already hash-pinned before this change and the reason
  // given was right: a model reference that survives a change to the protocol
  // names something that no longer exists. That property is kept.
  const a = supportedStudy().protocol;
  const b = { ...a, protocolHash: 'f'.repeat(64) };

  assert.notEqual(causalQualityMeasurementModelRef(a), causalQualityMeasurementModelRef(b));
  assert.notEqual(causalQualitySurrogateBridgeRef(a), causalQualitySurrogateBridgeRef(b));
  assert.equal(causalQualityMeasurementModel(b).id, causalQualityMeasurementModelRef(b));
});

test('the backing says what it degraded and why, rather than silently withholding', () => {
  const backing = causalQualityMeasurementBacking(supportedStudy().protocol);

  assert.equal(backing.degraded, true, 'the module asserted proxy_validated; it does not earn it');
  assert.ok(
    backing.reasons.some((reason) => reason.includes('preregistered')),
    `a reason must name the pre-registration ceiling; got ${JSON.stringify(backing.reasons)}`,
  );
  assert.equal(backing.bridge?.id, causalQualitySurrogateBridgeRef(supportedStudy().protocol));
});

test('the quality evidence class reaches the record instead of being discarded', () => {
  // Four evidence classes are admitted and they differ in whether the observed
  // value was produced independently of the arm. That does not move the
  // measurement rung — construct validity is not precision, and none of the
  // four checks the metric against the construct — but a record that drops the
  // distinction entirely cannot be asked about it later.
  const protocol = supportedStudy().protocol;
  const model = causalQualityMeasurementModel(protocol);

  assert.ok(
    model.procedure.includes(protocol.qualityOutcome.evidenceClass),
    `the model procedure must name the evidence class; got ${model.procedure}`,
  );
  assert.equal(model.validation, 'proxy_unvalidated');
});
