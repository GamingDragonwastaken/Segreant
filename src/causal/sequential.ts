/**
 * Explicit sequential-inference control for bounded Bernoulli outcomes.
 *
 * This is deliberately narrower than a generic sequential-analysis framework:
 * the supported validity domain is accumulated, independent Bernoulli data with
 * one pre-registered endpoint and an anytime-valid confidence sequence.  A
 * sliding window, cluster dependence, post-hoc model choice, or adaptive
 * assignment is not silently treated as equivalent evidence; it is refused at
 * the protocol boundary until a method that justifies it is registered.
 */

import { createHash } from 'node:crypto';
import { ANYTIME_VALIDITY_DOMAIN, anytimeRateInterval, type AnytimeInterval } from '../value/anytime.ts';

export const SEQUENTIAL_INFERENCE_TYPE = 'fiscus.sequential-inference' as const;
export const SEQUENTIAL_INFERENCE_VERSION = 1 as const;

const ID_RE = /^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export interface SequentialLook {
  lookId: string;
  sampleSize: number;
}

export interface SequentialAssumptions {
  sampling: 'independent_bernoulli';
  outcome: 'fixed_binary_definition';
  cluster: 'no_clustering';
  assignment: 'fixed';
  selection: 'no_post_selection';
}

export interface SequentialProtocolDraft {
  type: typeof SEQUENTIAL_INFERENCE_TYPE;
  version: typeof SEQUENTIAL_INFERENCE_VERSION;
  protocolId: string;
  createdAtMs: number;
  estimand: 'bernoulli_rate';
  outcome: { definitionDigest: string };
  data: { mode: 'accumulated'; observationUnit: 'independent' };
  errorControl: { method: 'anytime_confidence_sequence'; confidenceLevel: number };
  /** Looks are registered before outcomes are analyzed. They are not inferred from data. */
  looks: SequentialLook[];
  stopping: { kind: 'registered_look_schedule'; allowEarlyStop: boolean };
  multiplicity: { method: 'single_endpoint'; familySize: number };
  assumptions: SequentialAssumptions;
  /** No adaptive or selected analysis may be smuggled into this lane. */
  adaptation: { assignment: 'none'; outcome: 'none'; modelSelection: 'none' };
  provenance: { sourceId: string; sourceDigest: string };
}

export interface CommittedSequentialProtocol extends SequentialProtocolDraft {
  lifecycle: 'committed';
  committedAtMs: number;
  protocolHash: string;
}

export interface SequentialObservation {
  observationId: string;
  sequence: number;
  outcome: 0 | 1;
  observedAtMs: number;
  sourceDigest: string;
}

export interface SequentialStop {
  lookId: string;
  reason: 'planned_completion' | 'pre_registered_early_stop';
  observedAtMs: number;
}

export interface SequentialAnalysisRequest {
  asOfMs: number;
  stop: SequentialStop;
}

export interface SequentialValidityDomain {
  data: 'accumulated' | 'unknown';
  sampling: 'independent_bernoulli' | 'unknown';
  cluster: 'none' | 'unknown';
  assignment: 'fixed' | 'unknown';
  selection: 'none' | 'unknown';
  errorControl: 'anytime_confidence_sequence' | 'unknown';
}

export interface SequentialValidity {
  status: 'valid' | 'not_established';
  domain: SequentialValidityDomain;
  confidenceLevel: number | null;
  assumptions: SequentialAssumptions | null;
  limitations: string[];
}

export interface SequentialLookResult {
  lookId: string;
  sampleSize: number;
  successes: number;
  interval: AnytimeInterval;
  registered: true;
}

export interface SequentialInferenceResult {
  type: typeof SEQUENTIAL_INFERENCE_TYPE;
  version: typeof SEQUENTIAL_INFERENCE_VERSION;
  ok: boolean;
  errors: string[];
  protocolHash: string | null;
  observationDigest: string | null;
  resultHash: string | null;
  stopping: {
    registeredLookId: string | null;
    reason: SequentialStop['reason'] | null;
  };
  validity: SequentialValidity;
  looks: SequentialLookResult[];
  interval: AnytimeInterval | null;
  provenance: {
    protocolHash: string | null;
    observationDigest: string | null;
    observationSourceDigests: string[];
    stopDigest: string | null;
    asOfMs: number | null;
    lookIds: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return safeInteger(value) && value > 0;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  errors: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(label + ' must be an object');
    return false;
  }
  let ownKeys: string[];
  try {
    let safe = true;
    const symbols = Reflect.ownKeys(value).filter((key) => typeof key !== 'string');
    if (symbols.length > 0) {
      errors.push(label + ' has unsupported symbol fields');
      safe = false;
    }
    ownKeys = Object.keys(value);
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
        errors.push(label + ' contains an unsupported accessor or hidden field: ' + key);
        safe = false;
      }
    }
    if (!safe) return false;
  } catch {
    errors.push(label + ' must be a plain object');
    return false;
  }
  for (const key of keys) if (!ownKeys.includes(key)) errors.push(label + ' is missing required field: ' + key);
  for (const key of ownKeys) if (!keys.includes(key)) errors.push(label + ' has unsupported field: ' + key);
  return true;
}

/** Canonical JSON for digest material; undefined and executable values fail closed. */
export function canonicalSequentialJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalSequentialJson).join(',') + ']';
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('cannot canonicalize accessor field');
      return JSON.stringify(key) + ':' + canonicalSequentialJson(descriptor.value);
    }).join(',') + '}';
  }
  throw new Error('cannot canonicalize unsupported value');
}

function sha256(value: string | Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
  }
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalSequentialJson(value)) as T;
}

const UNKNOWN_DOMAIN: SequentialValidityDomain = {
  data: 'unknown',
  sampling: 'unknown',
  cluster: 'unknown',
  assignment: 'unknown',
  selection: 'unknown',
  errorControl: 'unknown',
};

function invalidValidity(): SequentialValidity {
  return {
    status: 'not_established',
    domain: { ...UNKNOWN_DOMAIN },
    confidenceLevel: null,
    assumptions: null,
    limitations: [
      'No sequential estimate was produced because the registered protocol, look, stopping, or provenance boundary did not validate.',
      'The anytime-valid confidence sequence is only valid for accumulated independent Bernoulli observations under the registered outcome definition.',
    ],
  };
}

function errorResult(errors: string[], protocolHash: string | null = null): SequentialInferenceResult {
  return {
    type: SEQUENTIAL_INFERENCE_TYPE,
    version: SEQUENTIAL_INFERENCE_VERSION,
    ok: false,
    errors,
    protocolHash,
    observationDigest: null,
    resultHash: null,
    stopping: { registeredLookId: null, reason: null },
    validity: invalidValidity(),
    looks: [],
    interval: null,
    provenance: {
      protocolHash,
      observationDigest: null,
      observationSourceDigests: [],
      stopDigest: null,
      asOfMs: null,
      lookIds: [],
    },
  };
}

function validateAssumptions(value: unknown, errors: string[]): value is SequentialAssumptions {
  if (!exactRecord(value, ['sampling', 'outcome', 'cluster', 'assignment', 'selection'], 'protocol.assumptions', errors)) return false;
  if (value.sampling !== 'independent_bernoulli') errors.push('protocol.assumptions.sampling must be independent_bernoulli');
  if (value.outcome !== 'fixed_binary_definition') errors.push('protocol.assumptions.outcome must be fixed_binary_definition');
  if (value.cluster !== 'no_clustering') errors.push('protocol.assumptions.cluster must be no_clustering');
  if (value.assignment !== 'fixed') errors.push('protocol.assumptions.assignment must be fixed');
  if (value.selection !== 'no_post_selection') errors.push('protocol.assumptions.selection must be no_post_selection');
  return true;
}

/** Return all protocol errors; unknown adaptation is never coerced to a supported value. */
export function validateSequentialProtocol(value: unknown): string[] {
  const errors: string[] = [];
  if (!exactRecord(value, [
    'type', 'version', 'protocolId', 'createdAtMs', 'estimand', 'outcome', 'data',
    'errorControl', 'looks', 'stopping', 'multiplicity', 'assumptions', 'adaptation', 'provenance',
  ], 'protocol', errors)) return errors;

  if (value.type !== SEQUENTIAL_INFERENCE_TYPE || value.version !== SEQUENTIAL_INFERENCE_VERSION) {
    errors.push('protocol has an unsupported type or version');
  }
  if (!identifier(value.protocolId)) errors.push('protocol.protocolId must be a namespaced identifier');
  if (!positiveSafeInteger(value.createdAtMs)) errors.push('protocol.createdAtMs must be a positive safe integer');
  if (value.estimand !== 'bernoulli_rate') errors.push('protocol.estimand must be bernoulli_rate');

  if (!exactRecord(value.outcome, ['definitionDigest'], 'protocol.outcome', errors) || !digest(value.outcome.definitionDigest)) {
    errors.push('protocol.outcome.definitionDigest must be a sha256 digest');
  }
  if (!exactRecord(value.data, ['mode', 'observationUnit'], 'protocol.data', errors) ||
      value.data.mode !== 'accumulated' || value.data.observationUnit !== 'independent') {
    errors.push('protocol.data must declare accumulated independent observations; sliding data is unsupported');
  }
  if (!exactRecord(value.errorControl, ['method', 'confidenceLevel'], 'protocol.errorControl', errors) ||
      value.errorControl.method !== 'anytime_confidence_sequence' ||
      !finite(value.errorControl.confidenceLevel) || value.errorControl.confidenceLevel <= 0 || value.errorControl.confidenceLevel >= 1) {
    errors.push('protocol.errorControl must declare an anytime_confidence_sequence with confidenceLevel in (0,1)');
  }

  if (!Array.isArray(value.looks) || value.looks.length === 0) {
    errors.push('protocol.looks must contain at least one explicit registered look');
  } else {
    const seenIds = new Set<string>();
    let previousSampleSize = 0;
    for (const [index, look] of value.looks.entries()) {
      if (!exactRecord(look, ['lookId', 'sampleSize'], `protocol.looks[${index}]`, errors)) continue;
      if (!identifier(look.lookId)) errors.push(`protocol.looks[${index}].lookId must be a namespaced identifier`);
      if (typeof look.lookId === 'string' && seenIds.has(look.lookId)) errors.push('protocol.looks contains duplicate lookId values');
      if (typeof look.lookId === 'string') seenIds.add(look.lookId);
      if (!positiveSafeInteger(look.sampleSize)) errors.push(`protocol.looks[${index}].sampleSize must be a positive safe integer`);
      else if (look.sampleSize <= previousSampleSize) errors.push('protocol.looks sampleSize values must be strictly increasing');
      if (positiveSafeInteger(look.sampleSize)) previousSampleSize = look.sampleSize;
    }
  }
  if (!exactRecord(value.stopping, ['kind', 'allowEarlyStop'], 'protocol.stopping', errors) ||
      value.stopping.kind !== 'registered_look_schedule' || typeof value.stopping.allowEarlyStop !== 'boolean') {
    errors.push('protocol.stopping must declare a registered_look_schedule and an explicit allowEarlyStop flag');
  }
  if (!exactRecord(value.multiplicity, ['method', 'familySize'], 'protocol.multiplicity', errors) ||
      value.multiplicity.method !== 'single_endpoint' || value.multiplicity.familySize !== 1) {
    errors.push('protocol.multiplicity must declare one registered endpoint; unregistered model selection is unsupported');
  }
  validateAssumptions(value.assumptions, errors);
  if (!exactRecord(value.adaptation, ['assignment', 'outcome', 'modelSelection'], 'protocol.adaptation', errors) ||
      value.adaptation.assignment !== 'none' || value.adaptation.outcome !== 'none' || value.adaptation.modelSelection !== 'none') {
    errors.push('protocol.adaptation must declare none for assignment, outcome, and modelSelection');
  }
  if (!exactRecord(value.provenance, ['sourceId', 'sourceDigest'], 'protocol.provenance', errors) ||
      !identifier(value.provenance.sourceId) || !digest(value.provenance.sourceDigest)) {
    errors.push('protocol.provenance must carry a namespaced sourceId and sha256 sourceDigest');
  }
  return errors;
}

/** Hash only the registered protocol material; lifecycle/commit metadata is not analysis material. */
export function sequentialProtocolHash(value: SequentialProtocolDraft): string {
  const errors = validateSequentialProtocol(value);
  if (errors.length > 0) throw new Error('cannot hash sequential protocol: ' + errors.join('; '));
  return sha256(canonicalSequentialJson(value));
}

/** Commit a validated protocol and freeze every nested provenance field. */
export function commitSequentialProtocol(
  draft: SequentialProtocolDraft,
  committedAtMs: number,
): CommittedSequentialProtocol {
  const errors = validateSequentialProtocol(draft);
  if (errors.length > 0) throw new Error('cannot commit sequential protocol: ' + errors.join('; '));
  if (!positiveSafeInteger(committedAtMs) || committedAtMs < draft.createdAtMs) {
    throw new Error('cannot commit sequential protocol: committedAtMs must be a positive safe integer at or after createdAtMs');
  }
  const material = clone(draft);
  const committed = {
    ...material,
    lifecycle: 'committed' as const,
    committedAtMs,
    protocolHash: sequentialProtocolHash(material),
  };
  return freezeDeep(committed);
}

/** Re-read a committed protocol boundary before any result can be produced. */
export function verifyCommittedSequentialProtocol(value: unknown): string[] {
  const errors: string[] = [];
  if (!exactRecord(value, [
    'type', 'version', 'protocolId', 'createdAtMs', 'estimand', 'outcome', 'data',
    'errorControl', 'looks', 'stopping', 'multiplicity', 'assumptions', 'adaptation', 'provenance',
    'lifecycle', 'committedAtMs', 'protocolHash',
  ], 'committed protocol', errors)) return errors;
  const material: SequentialProtocolDraft = {
    type: value.type as SequentialProtocolDraft['type'],
    version: value.version as SequentialProtocolDraft['version'],
    protocolId: value.protocolId as string,
    createdAtMs: value.createdAtMs as number,
    estimand: value.estimand as SequentialProtocolDraft['estimand'],
    outcome: value.outcome as SequentialProtocolDraft['outcome'],
    data: value.data as SequentialProtocolDraft['data'],
    errorControl: value.errorControl as SequentialProtocolDraft['errorControl'],
    looks: value.looks as SequentialLook[],
    stopping: value.stopping as SequentialProtocolDraft['stopping'],
    multiplicity: value.multiplicity as SequentialProtocolDraft['multiplicity'],
    assumptions: value.assumptions as SequentialAssumptions,
    adaptation: value.adaptation as SequentialProtocolDraft['adaptation'],
    provenance: value.provenance as SequentialProtocolDraft['provenance'],
  };
  errors.push(...validateSequentialProtocol(material));
  if (value.lifecycle !== 'committed') errors.push('committed protocol.lifecycle must be committed');
  if (!positiveSafeInteger(value.committedAtMs) || value.committedAtMs < material.createdAtMs) {
    errors.push('committed protocol.committedAtMs must be at or after createdAtMs');
  }
  if (!digest(value.protocolHash)) errors.push('committed protocol.protocolHash must be a sha256 digest');
  if (errors.length === 0 && sequentialProtocolHash(material) !== value.protocolHash) {
    errors.push('committed protocol hash does not match its immutable material');
  }
  return errors;
}

function validateObservationList(value: unknown): { observations: SequentialObservation[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(value) || value.length === 0) return { observations: [], errors: ['observations must be a non-empty array'] };
  const observations: SequentialObservation[] = [];
  const ids = new Set<string>();
  let previousObservedAt = 0;
  for (const [index, raw] of value.entries()) {
    if (!exactRecord(raw, ['observationId', 'sequence', 'outcome', 'observedAtMs', 'sourceDigest'], `observations[${index}]`, errors)) continue;
    if (!identifier(raw.observationId)) errors.push(`observations[${index}].observationId must be a namespaced identifier`);
    if (typeof raw.observationId === 'string' && ids.has(raw.observationId)) errors.push('observations contain duplicate observationId values');
    if (typeof raw.observationId === 'string') ids.add(raw.observationId);
    if (!positiveSafeInteger(raw.sequence)) errors.push(`observations[${index}].sequence must be a positive safe integer`);
    if (raw.outcome !== 0 && raw.outcome !== 1) errors.push(`observations[${index}].outcome must be binary 0 or 1`);
    if (!positiveSafeInteger(raw.observedAtMs)) errors.push(`observations[${index}].observedAtMs must be a positive safe integer`);
    else if (raw.observedAtMs < previousObservedAt) errors.push('observations must be in nondecreasing observedAtMs order');
    if (positiveSafeInteger(raw.observedAtMs)) previousObservedAt = raw.observedAtMs;
    if (!digest(raw.sourceDigest)) errors.push(`observations[${index}].sourceDigest must be a sha256 digest`);
    if (identifier(raw.observationId) && positiveSafeInteger(raw.sequence) && (raw.outcome === 0 || raw.outcome === 1) &&
        positiveSafeInteger(raw.observedAtMs) && digest(raw.sourceDigest)) {
      observations.push({
        observationId: raw.observationId,
        sequence: raw.sequence,
        outcome: raw.outcome,
        observedAtMs: raw.observedAtMs,
        sourceDigest: raw.sourceDigest,
      });
    }
  }
  for (let index = 0; index < observations.length; index += 1) {
    if (observations[index]!.sequence !== index + 1) errors.push('observations.sequence must be contiguous from 1; gaps and reordering are not valid provenance');
  }
  return { observations, errors };
}

function validateAnalysisRequest(value: unknown): string[] {
  const errors: string[] = [];
  if (!exactRecord(value, ['asOfMs', 'stop'], 'analysis request', errors)) return errors;
  if (!positiveSafeInteger(value.asOfMs)) errors.push('analysis request.asOfMs must be a positive safe integer');
  if (!exactRecord(value.stop, ['lookId', 'reason', 'observedAtMs'], 'analysis request.stop', errors)) return errors;
  if (!identifier(value.stop.lookId)) errors.push('analysis request.stop.lookId must be a namespaced identifier');
  if (value.stop.reason !== 'planned_completion' && value.stop.reason !== 'pre_registered_early_stop') {
    errors.push('analysis request.stop.reason must be explicit');
  }
  if (!positiveSafeInteger(value.stop.observedAtMs)) errors.push('analysis request.stop.observedAtMs must be a positive safe integer');
  return errors;
}

function analysisMaterial(result: SequentialInferenceResult): Record<string, unknown> {
  const { resultHash: _resultHash, ...material } = result;
  return material;
}

function finalizeResult(result: Omit<SequentialInferenceResult, 'resultHash'>): SequentialInferenceResult {
  const material = { ...result, resultHash: null } as SequentialInferenceResult;
  const resultHash = sha256(canonicalSequentialJson(analysisMaterial(material)));
  return freezeDeep({ ...result, resultHash });
}

/**
 * Analyze only a complete registered look. The caller cannot select a look after
 * seeing more observations: the observation count must equal that look exactly.
 */
export function analyzeSequentialRate(
  protocolInput: unknown,
  observationsInput: unknown,
  requestInput: unknown,
): SequentialInferenceResult {
  const protocolErrors = verifyCommittedSequentialProtocol(protocolInput);
  if (protocolErrors.length > 0) return errorResult(['protocol integrity: ' + protocolErrors.join('; ')]);
  const protocol = protocolInput as CommittedSequentialProtocol;
  const requestErrors = validateAnalysisRequest(requestInput);
  if (requestErrors.length > 0) return errorResult(requestErrors, protocol.protocolHash);
  const request = requestInput as SequentialAnalysisRequest;
  const parsed = validateObservationList(observationsInput);
  if (parsed.errors.length > 0) return errorResult(parsed.errors, protocol.protocolHash);
  const observations = parsed.observations;
  const lookIndex = protocol.looks.findIndex((look) => look.lookId === request.stop.lookId);
  if (lookIndex < 0) return errorResult(['stop lookId is not registered; optional stopping outside the explicit look schedule is refused'], protocol.protocolHash);
  const selectedLook = protocol.looks[lookIndex]!;
  if (observations.length !== selectedLook.sampleSize) {
    return errorResult([
      `observations stop at n=${observations.length}, but registered look ${selectedLook.lookId} is n=${selectedLook.sampleSize}; optional stopping or post-selection is not registered`,
    ], protocol.protocolHash);
  }
  const finalLook = lookIndex === protocol.looks.length - 1;
  if (request.stop.reason === 'planned_completion' && !finalLook) {
    return errorResult(['planned_completion is only valid at the final registered look'], protocol.protocolHash);
  }
  if (request.stop.reason === 'pre_registered_early_stop' && (!protocol.stopping.allowEarlyStop || finalLook)) {
    return errorResult([
      finalLook
        ? 'the final registered look must use planned_completion'
        : 'early stop is not allowed by the committed stopping rule',
    ], protocol.protocolHash);
  }
  const lastObservedAt = observations[observations.length - 1]!.observedAtMs;
  if (request.stop.observedAtMs < lastObservedAt || request.asOfMs < request.stop.observedAtMs) {
    return errorResult(['analysis as-of/stop time precedes retained observations'], protocol.protocolHash);
  }

  const observationDigest = sha256(canonicalSequentialJson(observations));
  const lookResults: SequentialLookResult[] = [];
  for (let index = 0; index <= lookIndex; index += 1) {
    const look = protocol.looks[index]!;
    const prefix = observations.slice(0, look.sampleSize);
    const successes = prefix.reduce((sum, observation) => sum + observation.outcome, 0);
    lookResults.push({
      lookId: look.lookId,
      sampleSize: look.sampleSize,
      successes,
      interval: anytimeRateInterval(successes, look.sampleSize, { level: protocol.errorControl.confidenceLevel }),
      registered: true,
    });
  }
  const interval = lookResults[lookResults.length - 1]!.interval;
  const validity: SequentialValidity = {
    status: 'valid',
    domain: {
      data: 'accumulated',
      sampling: 'independent_bernoulli',
      cluster: 'none',
      assignment: 'fixed',
      selection: 'none',
      errorControl: 'anytime_confidence_sequence',
    },
    confidenceLevel: protocol.errorControl.confidenceLevel,
    assumptions: clone(protocol.assumptions),
    limitations: [
      'Coverage is for accumulated independent Bernoulli observations under the fixed registered outcome definition.',
      'The result does not cover sliding windows, clustered dependence, changing outcomes, adaptive assignment, or post-hoc model selection.',
      'Stopping is protected only inside the committed registered look schedule; an unregistered look is refused rather than re-labelled anytime-valid.',
    ],
  };
  const sourceDigests = [...new Set(observations.map((observation) => observation.sourceDigest))];
  const stopDigest = sha256(canonicalSequentialJson(request.stop));
  return finalizeResult({
    type: SEQUENTIAL_INFERENCE_TYPE,
    version: SEQUENTIAL_INFERENCE_VERSION,
    ok: true,
    errors: [],
    protocolHash: protocol.protocolHash,
    observationDigest,
    stopping: { registeredLookId: selectedLook.lookId, reason: request.stop.reason },
    validity,
    looks: lookResults,
    interval,
    provenance: {
      protocolHash: protocol.protocolHash,
      observationDigest,
      observationSourceDigests: sourceDigests,
      stopDigest,
      asOfMs: request.asOfMs,
      lookIds: lookResults.map((look) => look.lookId),
    },
  });
}

function validateResultInterval(value: unknown, label: string, errors: string[]): value is AnytimeInterval {
  if (!exactRecord(value, ['low', 'high', 'level', 'n', 'k', 'prior', 'validityDomain'], label, errors)) return false;
  if (!finite(value.low) || value.low < 0 || value.low > 1) errors.push(`${label}.low must be finite and in [0,1]`);
  if (!finite(value.high) || value.high < 0 || value.high > 1) errors.push(`${label}.high must be finite and in [0,1]`);
  if (finite(value.low) && finite(value.high) && value.low > value.high) errors.push(`${label} must have low <= high`);
  if (!finite(value.level) || value.level <= 0 || value.level >= 1) errors.push(`${label}.level must be in (0,1)`);
  if (!positiveSafeInteger(value.n)) errors.push(`${label}.n must be a positive safe integer`);
  if (!safeInteger(value.k) || value.k < 0 || (safeInteger(value.n) && value.k > value.n)) {
    errors.push(`${label}.k must be a safe integer in [0,n]`);
  }
  if (value.prior !== 'jeffreys' && value.prior !== 'uniform') errors.push(`${label}.prior is unsupported`);
  if (!exactRecord(value.validityDomain, ['data', 'sampling', 'cluster', 'selection', 'adaptation'], `${label}.validityDomain`, errors)) return false;
  if (value.validityDomain.data !== ANYTIME_VALIDITY_DOMAIN.data ||
      value.validityDomain.sampling !== ANYTIME_VALIDITY_DOMAIN.sampling ||
      value.validityDomain.cluster !== ANYTIME_VALIDITY_DOMAIN.cluster ||
      value.validityDomain.selection !== ANYTIME_VALIDITY_DOMAIN.selection ||
      value.validityDomain.adaptation !== ANYTIME_VALIDITY_DOMAIN.adaptation) {
    errors.push(`${label}.validityDomain does not match the accumulated independent Bernoulli domain`);
  }
  return true;
}

function validateResultValidity(value: unknown, expectedLevel: number | null, errors: string[]): void {
  if (!exactRecord(value, ['status', 'domain', 'confidenceLevel', 'assumptions', 'limitations'], 'sequential result.validity', errors)) return;
  if (value.status !== 'valid') errors.push('sequential result.validity.status must be valid when ok is true');
  if (!finite(value.confidenceLevel) || value.confidenceLevel <= 0 || value.confidenceLevel >= 1) {
    errors.push('sequential result.validity.confidenceLevel must be in (0,1)');
  } else if (expectedLevel !== null && value.confidenceLevel !== expectedLevel) {
    errors.push('sequential result.validity.confidenceLevel must match its interval level');
  }
  if (exactRecord(value.domain, ['data', 'sampling', 'cluster', 'assignment', 'selection', 'errorControl'], 'sequential result.validity.domain', errors)) {
    const expected = {
      data: 'accumulated',
      sampling: 'independent_bernoulli',
      cluster: 'none',
      assignment: 'fixed',
      selection: 'none',
      errorControl: 'anytime_confidence_sequence',
    } as const;
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (value.domain[key] !== expected[key]) errors.push(`sequential result.validity.domain.${key} is outside the supported domain`);
    }
  }
  if (exactRecord(value.assumptions, ['sampling', 'outcome', 'cluster', 'assignment', 'selection'], 'sequential result.validity.assumptions', errors)) {
    if (value.assumptions.sampling !== 'independent_bernoulli' ||
        value.assumptions.outcome !== 'fixed_binary_definition' ||
        value.assumptions.cluster !== 'no_clustering' ||
        value.assumptions.assignment !== 'fixed' ||
        value.assumptions.selection !== 'no_post_selection') {
      errors.push('sequential result.validity.assumptions are outside the supported domain');
    }
  }
  if (!Array.isArray(value.limitations) || value.limitations.length === 0 || value.limitations.some((item) => typeof item !== 'string' || item.length === 0)) {
    errors.push('sequential result.validity.limitations must contain explicit non-empty strings');
  }
}

function validateSuccessfulResult(value: Record<string, unknown>, errors: string[]): void {
  if (value.ok !== true) errors.push('sequential result is not a valid inference result');
  if (!Array.isArray(value.errors) || value.errors.length !== 0) errors.push('successful sequential result.errors must be empty');
  if (!digest(value.protocolHash)) errors.push('sequential result protocolHash is invalid');
  if (!digest(value.observationDigest)) errors.push('sequential result observationDigest is invalid');
  if (!digest(value.resultHash)) errors.push('sequential result resultHash is invalid');

  let lookIds: string[] = [];
  let expectedLevel: number | null = null;
  let finalInterval: unknown = null;
  if (!Array.isArray(value.looks) || value.looks.length === 0) {
    errors.push('sequential result.looks must contain at least one registered look');
  } else {
    const seenIds = new Set<string>();
    let previousSampleSize = 0;
    for (const [index, raw] of value.looks.entries()) {
      const label = `sequential result.looks[${index}]`;
      if (!exactRecord(raw, ['lookId', 'sampleSize', 'successes', 'interval', 'registered'], label, errors)) continue;
      if (!identifier(raw.lookId)) errors.push(`${label}.lookId must be a namespaced identifier`);
      if (typeof raw.lookId === 'string') {
        if (seenIds.has(raw.lookId)) errors.push('sequential result.looks contains duplicate lookId values');
        seenIds.add(raw.lookId);
        lookIds.push(raw.lookId);
      }
      if (!positiveSafeInteger(raw.sampleSize) || raw.sampleSize <= previousSampleSize) {
        errors.push('sequential result.looks sampleSize values must be strictly increasing positive integers');
      } else {
        previousSampleSize = raw.sampleSize;
      }
      if (!safeInteger(raw.successes) || raw.successes < 0 || (positiveSafeInteger(raw.sampleSize) && raw.successes > raw.sampleSize)) {
        errors.push(`${label}.successes must be a safe integer in [0,sampleSize]`);
      }
      if (raw.registered !== true) errors.push(`${label}.registered must be true`);
      if (validateResultInterval(raw.interval, `${label}.interval`, errors)) {
        if (positiveSafeInteger(raw.sampleSize) && raw.interval.n !== raw.sampleSize) errors.push(`${label}.interval.n must match sampleSize`);
        if (safeInteger(raw.successes) && raw.interval.k !== raw.successes) errors.push(`${label}.interval.k must match successes`);
        if (positiveSafeInteger(raw.sampleSize) && safeInteger(raw.successes) && finite(raw.interval.level)) {
          const expectedInterval = anytimeRateInterval(raw.successes, raw.sampleSize, {
            level: raw.interval.level,
            prior: raw.interval.prior,
          });
          if (canonicalSequentialJson(raw.interval) !== canonicalSequentialJson(expectedInterval)) {
            errors.push(`${label}.interval does not match the registered anytime confidence-sequence calculation`);
          }
        }
        if (expectedLevel === null && finite(raw.interval.level)) expectedLevel = raw.interval.level;
        else if (expectedLevel !== null && raw.interval.level !== expectedLevel) errors.push('sequential result look intervals must share one confidence level');
        finalInterval = raw.interval;
      }
    }
  }

  if (value.interval === null) errors.push('successful sequential result.interval must be present');
  else if (validateResultInterval(value.interval, 'sequential result.interval', errors)) {
    if (finalInterval !== null && canonicalSequentialJson(value.interval) !== canonicalSequentialJson(finalInterval)) {
      errors.push('sequential result.interval must equal the final registered look interval');
    }
  }
  validateResultValidity(value.validity, expectedLevel, errors);

  if (exactRecord(value.stopping, ['registeredLookId', 'reason'], 'sequential result.stopping', errors)) {
    if (!identifier(value.stopping.registeredLookId)) errors.push('sequential result.stopping.registeredLookId is invalid');
    if (value.stopping.reason !== 'planned_completion' && value.stopping.reason !== 'pre_registered_early_stop') {
      errors.push('sequential result.stopping.reason is invalid');
    }
    const lastLookId = lookIds[lookIds.length - 1];
    if (lastLookId !== undefined && value.stopping.registeredLookId !== lastLookId) {
      errors.push('sequential result.stopping.registeredLookId must identify the final returned look');
    }
  }

  if (exactRecord(value.provenance, [
    'protocolHash', 'observationDigest', 'observationSourceDigests', 'stopDigest', 'asOfMs', 'lookIds',
  ], 'sequential result.provenance', errors)) {
    if (value.provenance.protocolHash !== value.protocolHash) errors.push('sequential result provenance protocolHash does not match the result');
    if (value.provenance.observationDigest !== value.observationDigest) errors.push('sequential result provenance observationDigest does not match the result');
    if (!Array.isArray(value.provenance.observationSourceDigests) || value.provenance.observationSourceDigests.length === 0 ||
        value.provenance.observationSourceDigests.some((item) => !digest(item))) {
      errors.push('sequential result provenance must contain one or more valid source digests');
    } else if (new Set(value.provenance.observationSourceDigests).size !== value.provenance.observationSourceDigests.length) {
      errors.push('sequential result provenance source digests must be unique');
    }
    if (!digest(value.provenance.stopDigest)) errors.push('sequential result provenance stopDigest is invalid');
    if (!positiveSafeInteger(value.provenance.asOfMs)) errors.push('sequential result provenance asOfMs is invalid');
    if (!Array.isArray(value.provenance.lookIds) ||
        value.provenance.lookIds.some((item) => !identifier(item)) ||
        value.provenance.lookIds.length !== lookIds.length ||
        value.provenance.lookIds.some((item, index) => item !== lookIds[index])) {
      errors.push('sequential result provenance lookIds do not match returned looks');
    }
  }
}

/** Verify a result after persistence/rehydration, before its interval is used. */
export function verifySequentialInferenceResult(value: unknown): string[] {
  const errors: string[] = [];
  if (!exactRecord(value, [
    'type', 'version', 'ok', 'errors', 'protocolHash', 'observationDigest', 'resultHash',
    'stopping', 'validity', 'looks', 'interval', 'provenance',
  ], 'sequential result', errors)) return errors;
  if (value.type !== SEQUENTIAL_INFERENCE_TYPE || value.version !== SEQUENTIAL_INFERENCE_VERSION) errors.push('sequential result has an unsupported type or version');
  try {
    validateSuccessfulResult(value, errors);
  } catch {
    errors.push('sequential result contains unsupported or unsafe nested values');
  }
  if (errors.length === 0) {
    try {
      const expected = sha256(canonicalSequentialJson(analysisMaterial(value as unknown as SequentialInferenceResult)));
      if (expected !== value.resultHash) errors.push('sequential result hash does not match its immutable provenance');
    } catch {
      errors.push('sequential result provenance is not canonicalizable');
    }
  }
  return errors;
}
