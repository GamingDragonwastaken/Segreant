/**
 * Observation-only policy rollout control.
 *
 * This module models a conservative, immutable control lifecycle. It does not
 * execute a policy, persist state, authorize an action, or contact a target.
 * Callers must preview a transition and explicitly commit the returned value.
 */

export type ControlPhase =
  | 'shadow'
  | 'simulated_effect'
  | 'canary'
  | 'monitored_expansion'
  | 'full_rollout'
  | 'rolled_back';

export type ControlFallback = 'baseline' | 'shadow' | 'human_approval' | 'no_op';
export type EvidenceState = 'supported' | 'unknown' | 'conflicted' | 'refuted';
export type EvidenceCompleteness = 'complete' | 'partial' | 'missing';
export type ObservationCompleteness = 'complete' | 'partial' | 'missing';
export type MeasurementStatus = 'healthy' | 'broken' | 'unknown';
export type OutcomeStatus = 'safe' | 'harmful' | 'unknown';

export interface ControlRegime {
  readonly treatment: string;
  readonly model: string;
  readonly pricing: string;
  readonly environment: string;
}

export interface ControlPolicy {
  readonly id: string;
  readonly version: number;
  readonly issuedAt: string;
  readonly ttlMs: number;
  readonly requiredEvidenceIds: readonly string[];
  readonly regime: ControlRegime;
  readonly fallback: ControlFallback;
}

export interface ControlEvidence {
  readonly id: string;
  readonly state: EvidenceState;
  readonly observable: boolean;
  readonly revoked: boolean;
  readonly completeness: EvidenceCompleteness;
  readonly observedAt: string;
  readonly freshUntil: string;
}

export interface ControlSignal {
  readonly status: MeasurementStatus | OutcomeStatus | 'healthy' | 'safe';
  readonly observable: boolean;
  readonly observedAt: string;
  readonly freshUntil: string;
}

export interface ControlObservation {
  readonly at: string;
  readonly completeness: ObservationCompleteness;
  readonly regime: ControlRegime;
  readonly evidence: readonly ControlEvidence[];
  readonly measurement: ControlSignal;
  readonly outcome: ControlSignal;
}

export interface ControlTransitionInput {
  readonly to: ControlPhase;
  readonly at: string;
  readonly observation: ControlObservation;
}

export interface ControlTransitionEvent {
  readonly revision: number;
  readonly from: ControlPhase;
  readonly to: ControlPhase;
  readonly at: string;
  readonly reason: ControlReason | 'accepted' | 'manual_rollback';
  readonly detail?: string;
}

export interface PolicyLifecycle {
  readonly policy: ControlPolicy;
  readonly phase: ControlPhase;
  readonly revision: number;
  readonly fallback: ControlFallback;
  readonly history: readonly ControlTransitionEvent[];
}

export type ControlReason =
  | 'unsafe_transition'
  | 'policy_ttl_expired'
  | 'evidence_missing'
  | 'evidence_stale'
  | 'evidence_revoked'
  | 'evidence_conflicted'
  | 'evidence_incomplete'
  | 'regime_changed'
  | 'completeness_degraded'
  | 'measurement_broken'
  | 'unobservable'
  | 'outcome_harm';

export type ControlProposalStatus = 'accepted' | 'fallback' | 'rejected';

export interface ControlTransitionProposal {
  readonly status: ControlProposalStatus;
  readonly persistable: boolean;
  readonly baseRevision: number;
  readonly reasons: readonly ControlReason[];
  readonly nextState: PolicyLifecycle | null;
}

const PHASE_ORDER: readonly Exclude<ControlPhase, 'rolled_back'>[] = [
  'shadow',
  'simulated_effect',
  'canary',
  'monitored_expansion',
  'full_rollout',
];
const MAX_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const ISO_WITH_TIMEZONE = /T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function timestamp(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  const time = Date.parse(text);
  if (!Number.isFinite(time) || !ISO_WITH_TIMEZONE.test(text)) throw new Error(`${label} must be an ISO timestamp in UTC`);
  return new Date(time).toISOString();
}

function positiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function finiteTtl(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TTL_MS) {
    throw new Error('ttlMs must be a positive, bounded safe integer');
  }
  return value as number;
}

function fallback(value: unknown): ControlFallback {
  if (value !== 'baseline' && value !== 'shadow' && value !== 'human_approval' && value !== 'no_op') {
    throw new Error('fallback must be baseline, shadow, human_approval, or no_op');
  }
  return value;
}

function regime(value: ControlRegime): ControlRegime {
  if (value === null || typeof value !== 'object') throw new Error('regime must be an object');
  return Object.freeze({
    treatment: nonEmpty(value.treatment, 'regime treatment'),
    model: nonEmpty(value.model, 'regime model'),
    pricing: nonEmpty(value.pricing, 'regime pricing'),
    environment: nonEmpty(value.environment, 'regime environment'),
  });
}

function stringList(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must not be empty`);
  const seen = new Set<string>();
  const output = value.map((item, index) => {
    const id = nonEmpty(item, `${label}[${index}]`);
    if (seen.has(id)) throw new Error(`${label} contains duplicate ${id}`);
    seen.add(id);
    return id;
  });
  return Object.freeze(output);
}

function cloneEvidence(value: ControlEvidence, index: number): ControlEvidence {
  if (value === null || typeof value !== 'object') throw new Error(`evidence[${index}] must be an object`);
  const state = value.state;
  if (state !== 'supported' && state !== 'unknown' && state !== 'conflicted' && state !== 'refuted') {
    throw new Error(`evidence[${index}] has an invalid state`);
  }
  if (typeof value.observable !== 'boolean' || typeof value.revoked !== 'boolean') {
    throw new Error(`evidence[${index}] observable and revoked must be boolean`);
  }
  if (value.completeness !== 'complete' && value.completeness !== 'partial' && value.completeness !== 'missing') {
    throw new Error(`evidence[${index}] has an invalid completeness`);
  }
  return Object.freeze({
    id: nonEmpty(value.id, `evidence[${index}] id`),
    state,
    observable: value.observable,
    revoked: value.revoked,
    completeness: value.completeness,
    observedAt: timestamp(value.observedAt, `evidence[${index}] observedAt`),
    freshUntil: timestamp(value.freshUntil, `evidence[${index}] freshUntil`),
  });
}

function cloneSignal(value: ControlSignal, label: string): ControlSignal {
  if (value === null || typeof value !== 'object') throw new Error(`${label} must be an object`);
  if (typeof value.observable !== 'boolean') throw new Error(`${label}.observable must be boolean`);
  return Object.freeze({
    status: nonEmpty(value.status, `${label}.status`) as ControlSignal['status'],
    observable: value.observable,
    observedAt: timestamp(value.observedAt, `${label}.observedAt`),
    freshUntil: timestamp(value.freshUntil, `${label}.freshUntil`),
  });
}

function cloneObservation(value: ControlObservation): ControlObservation {
  if (value === null || typeof value !== 'object') throw new Error('observation must be an object');
  if (value.completeness !== 'complete' && value.completeness !== 'partial' && value.completeness !== 'missing') {
    throw new Error('observation completeness is invalid');
  }
  const evidence = value.evidence.map(cloneEvidence);
  const ids = new Set<string>();
  for (const item of evidence) {
    if (ids.has(item.id)) throw new Error(`duplicate observation evidence: ${item.id}`);
    ids.add(item.id);
  }
  return Object.freeze({
    at: timestamp(value.at, 'observation at'),
    completeness: value.completeness,
    regime: regime(value.regime),
    evidence: Object.freeze(evidence),
    measurement: cloneSignal(value.measurement, 'measurement'),
    outcome: cloneSignal(value.outcome, 'outcome'),
  });
}

function policyCopy(value: ControlPolicy): ControlPolicy {
  if (value === null || typeof value !== 'object') throw new Error('policy must be an object');
  const issuedAt = timestamp(value.issuedAt, 'issuedAt');
  return Object.freeze({
    id: nonEmpty(value.id, 'id'),
    version: positiveVersion(value.version, 'version'),
    issuedAt,
    ttlMs: finiteTtl(value.ttlMs),
    requiredEvidenceIds: stringList(value.requiredEvidenceIds, 'requiredEvidenceIds'),
    regime: regime(value.regime),
    fallback: fallback(value.fallback),
  });
}

function lifecycleCopy(value: PolicyLifecycle): PolicyLifecycle {
  const policy = policyCopy(value.policy);
  if (!PHASE_ORDER.includes(value.phase as Exclude<ControlPhase, 'rolled_back'>) && value.phase !== 'rolled_back') {
    throw new Error('invalid lifecycle phase');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('revision must be a non-negative safe integer');
  const history = Object.freeze(value.history.map((event) => Object.freeze({ ...event })));
  return Object.freeze({
    policy,
    phase: value.phase,
    revision: value.revision,
    fallback: fallback(value.fallback),
    history,
  });
}

function sameRegime(a: ControlRegime, b: ControlRegime): boolean {
  return a.treatment === b.treatment
    && a.model === b.model
    && a.pricing === b.pricing
    && a.environment === b.environment;
}

function phaseIndex(phase: ControlPhase): number {
  return PHASE_ORDER.indexOf(phase as Exclude<ControlPhase, 'rolled_back'>);
}

function failClosed(
  state: PolicyLifecycle,
  at: string,
  reasons: readonly ControlReason[],
): ControlTransitionProposal {
  const event: ControlTransitionEvent = Object.freeze({
    revision: state.revision + 1,
    from: state.phase,
    to: 'rolled_back',
    at,
    reason: reasons[0] ?? 'unobservable',
  });
  const nextState: PolicyLifecycle = Object.freeze({
    policy: state.policy,
    phase: 'rolled_back',
    revision: state.revision + 1,
    fallback: state.fallback,
    history: Object.freeze([...state.history, event]),
  });
  return Object.freeze({
    status: 'fallback',
    persistable: true,
    baseRevision: state.revision,
    reasons: Object.freeze([...reasons]),
    nextState,
  });
}

function observationReasons(state: PolicyLifecycle, observation: ControlObservation): readonly ControlReason[] {
  const reasons: ControlReason[] = [];
  if (observation.completeness !== 'complete') reasons.push('completeness_degraded');
  if (!sameRegime(state.policy.regime, observation.regime)) reasons.push('regime_changed');

  const evidenceById = new Map(observation.evidence.map((item) => [item.id, item]));
  for (const id of state.policy.requiredEvidenceIds) {
    const item = evidenceById.get(id);
    if (!item) {
      reasons.push('evidence_missing');
      continue;
    }
    if (item.revoked) reasons.push('evidence_revoked');
    if (item.state === 'conflicted' || item.state === 'refuted') reasons.push('evidence_conflicted');
    if (item.state !== 'supported') reasons.push('evidence_incomplete');
    if (item.completeness !== 'complete') reasons.push('evidence_incomplete');
    if (!item.observable) reasons.push('unobservable');
    if (Date.parse(observation.at) >= Date.parse(item.freshUntil)) reasons.push('evidence_stale');
  }

  if (observation.measurement.status !== 'healthy' || !observation.measurement.observable) {
    reasons.push('measurement_broken');
  }
  if (observation.outcome.status === 'harmful') reasons.push('outcome_harm');
  if (observation.outcome.status !== 'safe' || !observation.outcome.observable) reasons.push('unobservable');
  return Object.freeze([...new Set(reasons)]);
}

function accepted(
  state: PolicyLifecycle,
  input: ControlTransitionInput,
): ControlTransitionProposal {
  const event: ControlTransitionEvent = Object.freeze({
    revision: state.revision + 1,
    from: state.phase,
    to: input.to,
    at: input.at,
    reason: 'accepted',
  });
  const nextState: PolicyLifecycle = Object.freeze({
    policy: state.policy,
    phase: input.to,
    revision: state.revision + 1,
    fallback: state.fallback,
    history: Object.freeze([...state.history, event]),
  });
  return Object.freeze({
    status: 'accepted',
    persistable: true,
    baseRevision: state.revision,
    reasons: Object.freeze([]),
    nextState,
  });
}

export function createControlPolicy(input: {
  readonly id: string;
  readonly version: number;
  readonly issuedAt: string;
  readonly ttlMs: number;
  readonly requiredEvidenceIds: readonly string[];
  readonly regime: ControlRegime;
  readonly fallback: ControlFallback;
}): ControlPolicy {
  return policyCopy(input);
}

export function startControlLifecycle(policy: ControlPolicy, at: string): PolicyLifecycle {
  const normalizedPolicy = policyCopy(policy);
  const issuedAt = timestamp(at, 'lifecycle start at');
  if (Date.parse(issuedAt) < Date.parse(normalizedPolicy.issuedAt)) {
    throw new Error('lifecycle start cannot precede policy issuance');
  }
  return Object.freeze({
    policy: normalizedPolicy,
    phase: 'shadow',
    revision: 0,
    fallback: normalizedPolicy.fallback,
    history: Object.freeze([]),
  });
}

export function previewControlTransition(
  inputState: PolicyLifecycle,
  input: ControlTransitionInput,
): ControlTransitionProposal {
  const state = lifecycleCopy(inputState);
  if (state.phase === 'rolled_back') throw new Error('lifecycle is already rolled_back');
  const to = input.to;
  if (to === 'rolled_back') throw new Error('use rollbackControl for rolled_back transitions');
  const at = timestamp(input.at, 'transition at');
  const observation = cloneObservation(input.observation);
  if (observation.at !== at) throw new Error('transition at must match observation.at');
  const currentIndex = phaseIndex(state.phase);
  const targetIndex = phaseIndex(to);
  if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
    return Object.freeze({
      status: 'rejected',
      persistable: false,
      baseRevision: state.revision,
      reasons: Object.freeze(['unsafe_transition'] as const),
      nextState: null,
    });
  }

  const expiresAt = Date.parse(state.policy.issuedAt) + state.policy.ttlMs;
  if (Date.parse(at) >= expiresAt) return failClosed(state, at, ['policy_ttl_expired']);

  const reasons = observationReasons(state, observation);
  if (reasons.length > 0) return failClosed(state, at, reasons);
  return accepted(state, { ...input, to, at, observation });
}

export function commitControlTransition(
  inputState: PolicyLifecycle,
  proposal: ControlTransitionProposal,
): PolicyLifecycle {
  const state = lifecycleCopy(inputState);
  if (proposal.status === 'rejected' || proposal.nextState === null || !proposal.persistable) {
    throw new Error('rejected control transition cannot commit');
  }
  if (proposal.baseRevision !== state.revision) throw new Error('stale control transition revision');
  if (proposal.nextState.revision !== state.revision + 1) throw new Error('invalid control transition revision');
  if (proposal.nextState.policy.id !== state.policy.id || proposal.nextState.policy.version !== state.policy.version) {
    throw new Error('control transition policy identity mismatch');
  }
  return lifecycleCopy(proposal.nextState);
}

export function applyControlTransition(
  state: PolicyLifecycle,
  input: ControlTransitionInput,
): PolicyLifecycle {
  const proposal = previewControlTransition(state, input);
  return commitControlTransition(state, proposal);
}

export function rollbackControl(
  inputState: PolicyLifecycle,
  at: string,
  reason: string,
): PolicyLifecycle {
  // Preserve the exact immutable object for an idempotent rollback. Validate
  // it first so callers cannot use this fast path to bypass the boundary.
  if (inputState.phase === 'rolled_back') {
    lifecycleCopy(inputState);
    return inputState;
  }
  const state = lifecycleCopy(inputState);
  const normalizedAt = timestamp(at, 'rollback at');
  const normalizedReason = nonEmpty(reason, 'rollback reason');
  const event: ControlTransitionEvent = Object.freeze({
    revision: state.revision + 1,
    from: state.phase,
    to: 'rolled_back',
    at: normalizedAt,
    reason: 'manual_rollback',
    detail: normalizedReason,
  });
  return Object.freeze({
    policy: state.policy,
    phase: 'rolled_back',
    revision: state.revision + 1,
    fallback: state.fallback,
    history: Object.freeze([...state.history, event]),
  });
}
