/**
 * What the causal study's quality metric is allowed to say about quality.
 *
 * ISSUANCE CLASS: none. Nothing here issues a Claim. This module declares the
 * measurement model and the surrogate bridge that `epistemic.ts` cites, and
 * computes the rung they earn.
 *
 * WHAT WAS WRONG. `epistemic.ts` issued both causal claims with a hard-coded
 * `measurement: 'proxy_validated'` and a `measurementModelRef` synthesized from
 * the metric id and the protocol hash. The reference resolved to nothing — no
 * `MeasurementModel` with that id existed anywhere — so a reader who tried to
 * check what had been validated found no record of a validation to check. The
 * rung was also constant across all four quality evidence classes the protocol
 * admits, which differ from one another in exactly the respect the axis is
 * about.
 *
 * WHY THE RUNG IS WRONG AND NOT MERELY UNBACKED. `bridgeCeiling` licenses
 * `proxy_validated` only from an `empirical_association` — the surrogate
 * compared against an independent measurement of the target. What a causal
 * protocol supplies is pre-registration, and pre-registration rules out
 * choosing the metric after seeing the data without ruling the metric IN.
 * Nothing in this repository records an empirical association between any
 * quality metric and the quality construct, so nothing here reaches that rung.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not assign a stronger rung
 * to a stronger evidence class. `deterministic`, `independent_operational`,
 * `structured_human` and `operator_attested` differ in how the observed VALUE
 * was produced, which is a question about integrity and about independence from
 * the assigned arm. Construct validity is a different question, and none of the
 * four answers it. Inventing a ladder across them would be exactly the
 * inflation this module exists to stop, so the class is recorded in the model's
 * procedure — where it can be asked about — and moves nothing.
 */

import { scope } from '../epistemic/scope.ts';
import {
  measurementModel,
  type MeasurementModel,
} from '../measurement/model.ts';
import { measurementRegistry, type MeasurementRegistry } from '../measurement/registry.ts';
import {
  assessBridgedMeasurementBacking,
  surrogateBridge,
  surrogateBridgeRegistry,
  type BridgedMeasurementBacking,
  type SurrogateBridge,
  type SurrogateBridgeRegistry,
} from '../measurement/surrogate.ts';

/**
 * The construct the causal claim is about, named once so the model, the bridge
 * and the request cannot drift apart.
 */
export const CAUSAL_QUALITY_CONSTRUCT = 'causal:construct:output_quality';

/**
 * The rung `epistemic.ts` used to assert unconditionally. It is kept as the
 * ASSERTED value in the backing request rather than deleted, so the record says
 * "this was claimed and not earned" instead of quietly claiming less.
 */
const ASSERTED_VALIDATION = 'proxy_validated';

/**
 * Everything this module needs from a committed protocol, declared structurally
 * so both protocol versions satisfy it. Version 2 adds a `collectionMethodId`
 * and a wider evidence-class union; neither changes the answer, and depending
 * on the union here would tie this file to a version it does not care about.
 */
export interface CausalQualityMeasurementSource {
  readonly studyId: string;
  readonly protocolHash: string;
  readonly qualityOutcome: {
    readonly metricId: string;
    readonly evidenceClass: string;
    readonly bounds: { readonly low: number; readonly high: number };
    readonly nonInferiorityMargin: number;
  };
}

/**
 * Pinned to the protocol hash, which was already true of the string this
 * replaces and was already right: a model reference that survives a change to
 * the protocol names something that no longer exists.
 */
export function causalQualityMeasurementModelRef(protocol: CausalQualityMeasurementSource): string {
  return `causal:quality-metric:${protocol.qualityOutcome.metricId}@${protocol.protocolHash}`;
}

export function causalQualitySurrogateBridgeRef(protocol: CausalQualityMeasurementSource): string {
  return `causal:quality-bridge:${protocol.qualityOutcome.metricId}@${protocol.protocolHash}`;
}

function studyScope(protocol: CausalQualityMeasurementSource) {
  return scope({
    ledger: 'fiscus-causal',
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
  });
}

export function causalQualityMeasurementModel(protocol: CausalQualityMeasurementSource): MeasurementModel {
  const quality = protocol.qualityOutcome;
  return measurementModel({
    id: causalQualityMeasurementModelRef(protocol),
    targetConstruct: CAUSAL_QUALITY_CONSTRUCT,
    measurand: `pre-registered quality metric ${quality.metricId}`,
    observable: `observed value of ${quality.metricId} per completed unit, bounded to [${quality.bounds.low}, ${quality.bounds.high}]`,
    procedure: `collected under evidence class ${quality.evidenceClass}, with the metric, its bounds and its evidence class fixed by protocol ${protocol.protocolHash} before collection`,
    scope: studyScope(protocol),
    population: `completed units of causal study ${protocol.studyId}`,
    // Not a placeholder. No procedure in this repository compares this metric
    // against an independent measurement of the construct, so the strongest
    // honest declaration its own author can make is that it is an unvalidated
    // proxy — and `assessBridgedMeasurementBacking` can only lower this.
    validation: 'proxy_unvalidated',
    calibration: null,
    uncertainty: {
      kind: 'bounded',
      description: 'Values are constrained to the pre-registered finite range and no error model for the metric itself is fitted.',
      bound: `[${quality.bounds.low}, ${quality.bounds.high}]`,
    },
  });
}

export function causalQualitySurrogateBridge(protocol: CausalQualityMeasurementSource): SurrogateBridge {
  const quality = protocol.qualityOutcome;
  return surrogateBridge({
    id: causalQualitySurrogateBridgeRef(protocol),
    surrogateModelRef: causalQualityMeasurementModelRef(protocol),
    targetConstruct: CAUSAL_QUALITY_CONSTRUCT,
    surrogateConstruct: `pre-registered quality metric ${quality.metricId}`,
    // The non-inferiority test is one-sided in this direction: the protocol's
    // margin says the candidate arm's quality may be no LOWER than the control
    // arm's by more than the margin, which only reads as a quality statement if
    // a higher metric value means more of the construct.
    direction: 'increases_with_target',
    basis: {
      kind: 'preregistered',
      argument: `The metric, its bounds, its evidence class and a non-inferiority margin of ${quality.nonInferiorityMargin} were fixed before collection, so the metric cannot have been chosen to fit the observed data. No comparison against an independent measurement of the construct has been performed.`,
      registrationRef: protocol.protocolHash,
    },
    failureModes: [
      'The metric can be raised without the construct improving, whenever an arm can act on the metric directly.',
      `Differences are censored at the pre-registered bounds [${quality.bounds.low}, ${quality.bounds.high}], so an arm at a bound can differ in the construct without differing in the metric.`,
      `The observed value is produced under evidence class ${quality.evidenceClass}; where that class is not independent of the assigned arm, the metric tracks the observer as well as the construct.`,
    ],
    status: 'supported',
    contest: null,
  });
}

export interface CausalQualityRegistries {
  readonly models: MeasurementRegistry;
  readonly bridges: SurrogateBridgeRegistry;
}

/**
 * Reconstructible from the protocol and nothing else, which is what lets a
 * reader of a stored claim resolve the reference it carries without a service.
 */
export function causalQualityRegistries(protocol: CausalQualityMeasurementSource): CausalQualityRegistries {
  return Object.freeze({
    models: measurementRegistry([causalQualityMeasurementModel(protocol)]),
    bridges: surrogateBridgeRegistry([causalQualitySurrogateBridge(protocol)]),
  });
}

/**
 * The rung the citation earns, with the reasons it is not the rung that was
 * asserted.
 *
 * `assessBridgedMeasurementBacking` rather than the asserting form, and the
 * distinction matters: `admissible` there means "there was nothing at all to
 * say", so a pre-registered bridge used honestly at its own ceiling still
 * reports `admissible: false`. The refusing form would refuse this caller for
 * being right. What is wanted here is the ceiling, not a refusal — the causal
 * claim is still issuable, at the rung its evidence supports.
 */
export function causalQualityMeasurementBacking(
  protocol: CausalQualityMeasurementSource,
): BridgedMeasurementBacking {
  const { models, bridges } = causalQualityRegistries(protocol);
  return assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: causalQualityMeasurementModelRef(protocol),
    surrogateBridgeRef: causalQualitySurrogateBridgeRef(protocol),
    requiredConstruct: CAUSAL_QUALITY_CONSTRUCT,
    assertedValidation: ASSERTED_VALIDATION,
  });
}
