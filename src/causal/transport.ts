/**
 * Explicit cross-study transport and pooling boundary (WP-E05).
 *
 * Causal transport is not a stringly-typed exception to the ordinary
 * derivation rules. This module requires a source/target coordinate declaration,
 * target evidence, and named consistency/exchangeability/positivity assumptions.
 * It also provides a conservative pooling check: studies with different
 * population, treatment, measurement, or time coordinates do not silently pool.
 */

export const CAUSAL_TRANSPORT_TYPE = 'segreant.causal-transport' as const;
export const CAUSAL_TRANSPORT_VERSION = 1 as const;

type Digest = `sha256:${string}`;
type Identifier = string;

export interface CausalTransportDeclaration {
  readonly type: typeof CAUSAL_TRANSPORT_TYPE;
  readonly version: typeof CAUSAL_TRANSPORT_VERSION;
  readonly bridgeId: Identifier;
  readonly sourceProtocolHash: Digest;
  readonly targetProtocolHash: Digest;
  readonly sourcePopulationId: Identifier;
  readonly targetPopulationId: Identifier;
  readonly sourceTreatmentIdentity: Digest;
  readonly targetTreatmentIdentity: Digest;
  readonly sourceMeasurementModelId: Identifier;
  readonly targetMeasurementModelId: Identifier;
  readonly sourceTimeHorizonId: Identifier;
  readonly targetTimeHorizonId: Identifier;
  readonly targetEvidence: { readonly evidenceId: Identifier; readonly digest: Digest } | null;
  readonly assumptions: {
    readonly consistency: boolean;
    readonly exchangeability: boolean;
    readonly positivity: boolean;
  };
}

export interface CausalTransportAssessment {
  readonly type: typeof CAUSAL_TRANSPORT_TYPE;
  readonly version: typeof CAUSAL_TRANSPORT_VERSION;
  readonly bridgeId: Identifier;
  readonly sourceProtocolHash: Digest;
  readonly targetProtocolHash: Digest;
  readonly sourcePopulationId: Identifier;
  readonly targetPopulationId: Identifier;
  readonly targetEvidence: CausalTransportDeclaration['targetEvidence'];
  readonly changedCoordinates: readonly ('population' | 'treatment' | 'measurement_model' | 'time_horizon')[];
  readonly status: 'supported_for_review' | 'withheld';
  readonly reasons: readonly string[];
  readonly nonClaims: readonly string[];
}

export interface CausalStudyDescriptor {
  readonly studyId: Identifier;
  readonly protocolHash: Digest;
  readonly populationId: Identifier;
  readonly treatmentIdentity: Digest;
  readonly measurementModelId: Identifier;
  readonly timeHorizonId: Identifier;
}

export interface CausalPoolingAssessment {
  readonly status: 'poolable' | 'refused';
  readonly studyIds: readonly Identifier[];
  readonly poolKey: string | null;
  readonly reasons: readonly string[];
  readonly nonClaims: readonly string[];
}

export class CausalTransportValidationError extends Error {
  readonly code = 'CAUSAL_TRANSPORT_INVALID';

  constructor(message: string) {
    super(`CAUSAL_TRANSPORT_INVALID: ${message}`);
    this.name = 'CausalTransportValidationError';
  }
}

function fail(message: string): never {
  throw new CausalTransportValidationError(message);
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(`${label} must be a bounded identifier`);
}

function digest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
}

function validateBridge(value: CausalTransportDeclaration): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('transport declaration must be an object');
  if (value.type !== CAUSAL_TRANSPORT_TYPE || value.version !== CAUSAL_TRANSPORT_VERSION) fail('transport type or version is unsupported');
  identifier(value.bridgeId, 'bridgeId');
  digest(value.sourceProtocolHash, 'sourceProtocolHash');
  digest(value.targetProtocolHash, 'targetProtocolHash');
  if (value.sourceProtocolHash === value.targetProtocolHash) fail('sourceProtocolHash and targetProtocolHash must be distinct');
  identifier(value.sourcePopulationId, 'sourcePopulationId');
  identifier(value.targetPopulationId, 'targetPopulationId');
  digest(value.sourceTreatmentIdentity, 'sourceTreatmentIdentity');
  digest(value.targetTreatmentIdentity, 'targetTreatmentIdentity');
  identifier(value.sourceMeasurementModelId, 'sourceMeasurementModelId');
  identifier(value.targetMeasurementModelId, 'targetMeasurementModelId');
  identifier(value.sourceTimeHorizonId, 'sourceTimeHorizonId');
  identifier(value.targetTimeHorizonId, 'targetTimeHorizonId');
  if (value.targetEvidence !== null) {
    identifier(value.targetEvidence.evidenceId, 'targetEvidence.evidenceId');
    digest(value.targetEvidence.digest, 'targetEvidence.digest');
  }
  if (value.assumptions === null || typeof value.assumptions !== 'object' || Array.isArray(value.assumptions)
      || typeof value.assumptions.consistency !== 'boolean'
      || typeof value.assumptions.exchangeability !== 'boolean'
      || typeof value.assumptions.positivity !== 'boolean') {
    fail('assumptions must declare boolean consistency, exchangeability, and positivity');
  }
}

function changedCoordinates(value: CausalTransportDeclaration): CausalTransportAssessment['changedCoordinates'] {
  const changed: CausalTransportAssessment['changedCoordinates'][number][] = [];
  if (value.sourcePopulationId !== value.targetPopulationId) changed.push('population');
  if (value.sourceTreatmentIdentity !== value.targetTreatmentIdentity) changed.push('treatment');
  if (value.sourceMeasurementModelId !== value.targetMeasurementModelId) changed.push('measurement_model');
  if (value.sourceTimeHorizonId !== value.targetTimeHorizonId) changed.push('time_horizon');
  return Object.freeze(changed);
}

export function assessTransportBridge(value: CausalTransportDeclaration): CausalTransportAssessment {
  validateBridge(value);
  const reasons: string[] = [];
  if (value.targetEvidence === null) reasons.push('target evidence is required to support a transport declaration');
  if (!value.assumptions.consistency) reasons.push('consistency is not declared');
  if (!value.assumptions.exchangeability) reasons.push('exchangeability is not declared');
  if (!value.assumptions.positivity) reasons.push('positivity is not declared');
  return Object.freeze({
    type: CAUSAL_TRANSPORT_TYPE,
    version: CAUSAL_TRANSPORT_VERSION,
    bridgeId: value.bridgeId,
    sourceProtocolHash: value.sourceProtocolHash,
    targetProtocolHash: value.targetProtocolHash,
    sourcePopulationId: value.sourcePopulationId,
    targetPopulationId: value.targetPopulationId,
    targetEvidence: value.targetEvidence === null ? null : Object.freeze({ ...value.targetEvidence }),
    changedCoordinates: changedCoordinates(value),
    status: reasons.length === 0 ? 'supported_for_review' : 'withheld',
    reasons: Object.freeze(reasons),
    nonClaims: Object.freeze([
      'A transport declaration is not evidence that the target population is exchangeable with the source.',
      'This is not a transported causal effect, a business-value claim, or permission to pool incompatible studies.',
      'Target evidence is retained by identity and digest; its substantive validity is not established here.',
    ]),
  });
}

function validateStudy(value: CausalStudyDescriptor, index: number): void {
  identifier(value.studyId, `studies[${index}].studyId`);
  digest(value.protocolHash, `studies[${index}].protocolHash`);
  identifier(value.populationId, `studies[${index}].populationId`);
  digest(value.treatmentIdentity, `studies[${index}].treatmentIdentity`);
  identifier(value.measurementModelId, `studies[${index}].measurementModelId`);
  identifier(value.timeHorizonId, `studies[${index}].timeHorizonId`);
}

export function assessStudyPooling(studies: readonly CausalStudyDescriptor[]): CausalPoolingAssessment {
  if (!Array.isArray(studies) || studies.length < 2) fail('at least two studies are required to assess pooling');
  studies.forEach(validateStudy);
  const first = studies[0]!;
  const reasons: string[] = [];
  for (const study of studies.slice(1)) {
    if (study.populationId !== first.populationId) reasons.push(`study ${study.studyId} has a different population coordinate`);
    if (study.treatmentIdentity !== first.treatmentIdentity) reasons.push(`study ${study.studyId} has a different treatment identity`);
    if (study.measurementModelId !== first.measurementModelId) reasons.push(`study ${study.studyId} has a different measurement model`);
    if (study.timeHorizonId !== first.timeHorizonId) reasons.push(`study ${study.studyId} has a different time horizon`);
  }
  const poolKey = reasons.length === 0
    ? [first.populationId, first.treatmentIdentity, first.measurementModelId, first.timeHorizonId].join('|')
    : null;
  return Object.freeze({
    status: reasons.length === 0 ? 'poolable' : 'refused',
    studyIds: Object.freeze(studies.map((study) => study.studyId)),
    poolKey,
    reasons: Object.freeze(reasons),
    nonClaims: Object.freeze([
      'Poolable coordinates do not prove exchangeability, independence, or a common data-generating process.',
      'Refusal prevents silent cross-study pooling; it does not establish that the studies are substantively incompatible for every future bridge.',
    ]),
  });
}

