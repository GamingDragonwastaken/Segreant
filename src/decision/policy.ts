/**
 * Approval-gated decision lifecycle.
 *
 * This is deliberately a local, immutable policy boundary.  It turns a
 * recomputed DecisionCertificate into a reviewable PolicyProposal, requires a
 * separately authorised human Approval, and records an explicitly confirmed
 * Action intent.  It never calls a provider, changes a budget, routes a
 * request, persists credentials, or performs an external side effect.
 *
 * ISSUANCE CLASS: control_boundary — this module records policy/audit state;
 * it does not mint an epistemic Claim.  A product consumer must still route
 * its evidence through `src/decision/epistemic.ts` before using this boundary.
 */

import { createHash } from 'node:crypto';
import {
  certifyDecision,
  type ActionUtilityInterval,
  type DecisionCertificate,
} from './engine.ts';
import {
  gateDecisionForConsequence,
  type DecisionAssuranceGate,
} from './assurance.ts';
import { canonicalJson } from '../epistemic/serialization.ts';

export type PolicyConsequence = 'advisory_only' | 'changes_spend';
export type PolicyEvidenceState = 'supported' | 'unknown' | 'conflicted' | 'refuted';
export type PolicyEvidenceCompleteness = 'complete' | 'partial' | 'missing';
export type PolicyActionKind = 'budget_cap' | 'model_route' | 'provider_limit' | 'custom';

export interface PolicyPrincipal {
  readonly id: string;
  readonly roles: readonly string[];
}

/** Minimal evidence view used by the policy boundary.  It is not a replacement for kernel Evidence. */
export interface PolicyEvidence {
  readonly id: string;
  readonly state: PolicyEvidenceState;
  readonly completeness: PolicyEvidenceCompleteness;
  readonly revoked: boolean;
  readonly observedAt: string;
  readonly freshUntil: string;
}

export interface PolicyAction {
  /** Must equal the selected action in the DecisionCertificate. */
  readonly action: string;
  readonly kind: PolicyActionKind;
  /** A logical local scope, never a provider URL or credential destination. */
  readonly target: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly reversible: boolean;
  readonly consequence: PolicyConsequence;
}

export interface DecisionRecommendationInput {
  readonly id: string;
  readonly decisionId: string;
  readonly intervals: ReadonlyArray<ActionUtilityInterval>;
  readonly evidence: ReadonlyArray<PolicyEvidence>;
  readonly issuer: PolicyPrincipal;
  readonly issuedAt: string;
  readonly ttlMs: number;
  readonly consequence: PolicyConsequence;
  /** Kernel claim profiles from which the assurance gate is derived. */
  readonly assuranceInputs?: readonly unknown[];
}

export type RecommendationStatus = 'qualified' | 'undetermined';

export interface DecisionRecommendation {
  readonly id: string;
  readonly decisionId: string;
  readonly intervals: readonly ActionUtilityInterval[];
  readonly certificate: DecisionCertificate;
  readonly status: RecommendationStatus;
  readonly selectedAction: string | null;
  readonly evidence: readonly PolicyEvidence[];
  readonly issuer: PolicyPrincipal;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consequence: PolicyConsequence;
  readonly assurance: DecisionAssuranceGate;
  readonly digest: string;
}

export interface PolicyProposalInput {
  readonly id: string;
  readonly version: number;
  readonly action: PolicyAction;
  readonly requiredApproverRole: string;
  readonly executorRoles: readonly string[];
  readonly approvalTtlMs: number;
  readonly proposedAt: string;
  readonly idempotencyKey: string;
}

export interface PolicyProposal {
  readonly id: string;
  readonly version: number;
  readonly recommendationId: string;
  readonly recommendationDigest: string;
  readonly action: PolicyAction;
  readonly requiredEvidenceIds: readonly string[];
  readonly requiredApproverRole: string;
  readonly executorRoles: readonly string[];
  readonly approvalTtlMs: number;
  readonly proposedAt: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly digest: string;
}

export interface PolicyApprovalInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly approver: PolicyPrincipal;
  readonly approvedAt: string;
  readonly confirmation: boolean;
}

export interface PolicyApproval {
  readonly id: string;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly idempotencyKey: string;
  readonly approverId: string;
  readonly approverRole: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly confirmation: true;
  readonly requestFingerprint: string;
  readonly digest: string;
}

export interface ActionRequest {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly executor: PolicyPrincipal;
  readonly actedAt: string;
  readonly confirmation: boolean;
}

/** A receipt of an authorised operator intent; no external action has run. */
export interface RecordedAction {
  readonly id: string;
  readonly proposalId: string;
  readonly approvalId: string;
  readonly idempotencyKey: string;
  readonly action: PolicyAction;
  readonly executorId: string;
  readonly actedAt: string;
  readonly confirmation: true;
  readonly execution: 'not_executed';
  readonly externalEffect: 'not_attempted';
  readonly automatic: false;
  readonly requestFingerprint: string;
  readonly digest: string;
}

export interface RevocationInput {
  readonly idempotencyKey: string;
  readonly targetId: string;
  readonly revokedAt: string;
  readonly actor: PolicyPrincipal;
  readonly reason: string;
}

export interface LifecycleRevocation {
  readonly targetId: string;
  readonly idempotencyKey: string;
  readonly revokedAt: string;
  readonly actorId: string;
  readonly reason: string;
  readonly digest: string;
}

export type LifecycleStatus = 'recommended' | 'proposed' | 'approved' | 'action_recorded' | 'revoked';

export type LifecycleEventType =
  | 'recommendation_created'
  | 'policy_proposed'
  | 'policy_approved'
  | 'action_recorded'
  | 'revoked';

export interface LifecycleEvent {
  readonly revision: number;
  readonly type: LifecycleEventType;
  readonly at: string;
  readonly idempotencyKey?: string;
  readonly actorId?: string;
  readonly targetId?: string;
  readonly detail?: string;
}

export interface DecisionLifecycle {
  readonly revision: number;
  readonly status: LifecycleStatus;
  readonly recommendation: DecisionRecommendation;
  readonly proposal: PolicyProposal | null;
  readonly approval: PolicyApproval | null;
  readonly action: RecordedAction | null;
  readonly revocations: readonly LifecycleRevocation[];
  readonly history: readonly LifecycleEvent[];
}

export type PolicyGateReason =
  | 'invalid_transition'
  | 'recommendation_undetermined'
  | 'recommendation_expired'
  | 'evidence_missing'
  | 'evidence_unresolved'
  | 'evidence_stale'
  | 'evidence_revoked'
  | 'assurance_insufficient'
  | 'action_mismatch'
  | 'approval_expired'
  | 'approval_revoked'
  | 'policy_revoked'
  | 'unauthorized_approver'
  | 'unauthorized_executor'
  | 'confirmation_required'
  | 'idempotency_conflict';

export interface PolicyTransitionPreview<T> {
  readonly status: 'accepted' | 'rejected';
  readonly baseRevision: number;
  readonly reasons: readonly PolicyGateReason[];
  readonly value: T | null;
}

const MAX_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const ISO_WITH_TIMEZONE = /T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const POLICY_CONSEQUENCES = ['advisory_only', 'changes_spend'] as const;
const ACTION_KINDS = ['budget_cap', 'model_route', 'provider_limit', 'custom'] as const;
const EVIDENCE_STATES = ['supported', 'unknown', 'conflicted', 'refuted'] as const;
const EVIDENCE_COMPLETENESS = ['complete', 'partial', 'missing'] as const;

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function timestamp(value: unknown, label: string): string {
  const normalized = text(value, label);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || !ISO_WITH_TIMEZONE.test(normalized)) {
    throw new Error(`${label} must be an ISO timestamp in UTC`);
  }
  return new Date(milliseconds).toISOString();
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function ttl(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TTL_MS) {
    throw new Error(`${label} must be a positive, bounded safe integer`);
  }
  return value as number;
}

function member<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value as T[number])) {
    throw new Error(`${label} must be one of ${values.join(', ')}`);
  }
  return value as T[number];
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function freezeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item)));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = freezeJson((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(result);
}

function freezeList<T>(value: readonly T[]): readonly T[] {
  return Object.freeze([...value]);
}

function principal(value: PolicyPrincipal, label: string): PolicyPrincipal {
  if (value === null || typeof value !== 'object') throw new Error(`${label} must be an object`);
  if (!Array.isArray(value.roles) || value.roles.length === 0) throw new Error(`${label}.roles must not be empty`);
  const roles = value.roles.map((role, index) => text(role, `${label}.roles[${index}]`));
  if (new Set(roles).size !== roles.length) throw new Error(`${label}.roles contains duplicates`);
  return Object.freeze({ id: text(value.id, `${label}.id`), roles: freezeList(roles) });
}

function hasRole(actor: PolicyPrincipal, role: string): boolean {
  return actor.roles.includes(role);
}

function addMilliseconds(at: string, milliseconds: number): string {
  const result = Date.parse(at) + milliseconds;
  if (!Number.isSafeInteger(result)) throw new Error('computed expiry is outside the safe timestamp range');
  return new Date(result).toISOString();
}

function before(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

function cloneEvidence(value: PolicyEvidence, index: number): PolicyEvidence {
  if (value === null || typeof value !== 'object') throw new Error(`evidence[${index}] must be an object`);
  const id = text(value.id, `evidence[${index}].id`);
  const state = member(value.state, EVIDENCE_STATES, `evidence[${index}].state`);
  const completeness = member(value.completeness, EVIDENCE_COMPLETENESS, `evidence[${index}].completeness`);
  if (typeof value.revoked !== 'boolean') throw new Error(`evidence[${index}].revoked must be boolean`);
  const observedAt = timestamp(value.observedAt, `evidence[${index}].observedAt`);
  const freshUntil = timestamp(value.freshUntil, `evidence[${index}].freshUntil`);
  if (!before(observedAt, freshUntil)) throw new Error(`evidence[${index}] freshUntil must be after observedAt`);
  return Object.freeze({ id, state, completeness, revoked: value.revoked, observedAt, freshUntil });
}

function cloneEvidenceList(value: ReadonlyArray<PolicyEvidence>): readonly PolicyEvidence[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('recommendation evidence must contain at least one record');
  const result = value.map(cloneEvidence);
  const ids = new Set<string>();
  for (const item of result) {
    if (ids.has(item.id)) throw new Error(`duplicate recommendation evidence: ${item.id}`);
    ids.add(item.id);
  }
  return Object.freeze(result);
}

function cloneIntervals(value: ReadonlyArray<ActionUtilityInterval>): readonly ActionUtilityInterval[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('recommendation intervals must contain at least one action');
  const intervals = value.map((item, index) => Object.freeze({
    action: text(item.action, `interval[${index}].action`),
    low: item.low,
    high: item.high,
  }));
  // The decision engine is the single authority for finite bounds, duplicate
  // actions and interval ordering.
  certifyDecision(intervals);
  return Object.freeze(intervals);
}

function clonePolicyAction(value: PolicyAction): PolicyAction {
  if (value === null || typeof value !== 'object') throw new Error('policy action must be an object');
  const action = text(value.action, 'policy action.action');
  const kind = member(value.kind, ACTION_KINDS, 'policy action.kind');
  const target = text(value.target, 'policy action.target');
  if (value.parameters === null || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) {
    throw new Error('policy action.parameters must be an object');
  }
  // Canonicalization is also the resource-bounded JSON/prototype boundary.
  const parameters = freezeJson(JSON.parse(canonicalJson(value.parameters))) as Readonly<Record<string, unknown>>;
  if (typeof value.reversible !== 'boolean') throw new Error('policy action.reversible must be boolean');
  const consequence = member(value.consequence, POLICY_CONSEQUENCES, 'policy action.consequence');
  return Object.freeze({ action, kind, target, parameters, reversible: value.reversible, consequence });
}

function recommendationBody(value: Omit<DecisionRecommendation, 'digest'>): unknown {
  return {
    id: value.id,
    decisionId: value.decisionId,
    intervals: value.intervals,
    certificate: value.certificate,
    status: value.status,
    selectedAction: value.selectedAction,
    evidence: value.evidence,
    issuer: value.issuer,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    consequence: value.consequence,
    assurance: value.assurance,
  };
}

/** Build an immutable recommendation and derive its assurance gate. */
export function createRecommendation(input: DecisionRecommendationInput): DecisionRecommendation {
  const id = text(input.id, 'recommendation id');
  const decisionId = text(input.decisionId, 'recommendation decisionId');
  const intervals = cloneIntervals(input.intervals);
  const certificate = certifyDecision(intervals);
  const evidence = cloneEvidenceList(input.evidence);
  const issuer = principal(input.issuer, 'recommendation issuer');
  const issuedAt = timestamp(input.issuedAt, 'recommendation issuedAt');
  const expiresAt = addMilliseconds(issuedAt, ttl(input.ttlMs, 'recommendation ttlMs'));
  const consequence = member(input.consequence, POLICY_CONSEQUENCES, 'recommendation consequence');
  const assurance = gateDecisionForConsequence({
    certificate,
    inputs: input.assuranceInputs ?? [],
    consequence,
  });
  const result: Omit<DecisionRecommendation, 'digest'> = Object.freeze({
    id,
    decisionId,
    intervals,
    certificate,
    status: certificate.status === 'proven_dominant' ? 'qualified' : 'undetermined',
    selectedAction: certificate.action,
    evidence,
    issuer,
    issuedAt,
    expiresAt,
    consequence,
    assurance,
  });
  return Object.freeze({ ...result, digest: digest(recommendationBody(result)) });
}

function recommendationCopy(value: DecisionRecommendation): DecisionRecommendation {
  if (value === null || typeof value !== 'object') throw new Error('recommendation must be an object');
  const intervals = cloneIntervals(value.intervals);
  const certificate = certifyDecision(intervals);
  if (canonicalJson(certificate) !== canonicalJson(value.certificate)) throw new Error('recommendation certificate does not match intervals');
  const evidence = cloneEvidenceList(value.evidence);
  const issuer = principal(value.issuer, 'recommendation issuer');
  const issuedAt = timestamp(value.issuedAt, 'recommendation issuedAt');
  const expiresAt = timestamp(value.expiresAt, 'recommendation expiresAt');
  if (!before(issuedAt, expiresAt)) throw new Error('recommendation expiresAt must be after issuedAt');
  const consequence = member(value.consequence, POLICY_CONSEQUENCES, 'recommendation consequence');
  const assurance = gateDecisionForConsequence({
    certificate,
    inputs: value.assurance.assessment.inputs,
    consequence,
  });
  if (canonicalJson(assurance) !== canonicalJson(value.assurance)) throw new Error('recommendation assurance gate failed revalidation');
  const status: RecommendationStatus = certificate.status === 'proven_dominant' ? 'qualified' : 'undetermined';
  if (value.status !== status || value.selectedAction !== certificate.action) throw new Error('recommendation status/action does not match certificate');
  const result: Omit<DecisionRecommendation, 'digest'> = Object.freeze({
    id: text(value.id, 'recommendation id'),
    decisionId: text(value.decisionId, 'recommendation decisionId'),
    intervals,
    certificate,
    status,
    selectedAction: certificate.action,
    evidence,
    issuer,
    issuedAt,
    expiresAt,
    consequence,
    assurance,
  });
  const expectedDigest = digest(recommendationBody(result));
  if (value.digest !== expectedDigest) throw new Error('recommendation digest verification failed');
  return Object.freeze({ ...result, digest: expectedDigest });
}

function lifecycleEvent(input: LifecycleEvent): LifecycleEvent {
  const event: LifecycleEvent = {
    revision: positiveSafeInteger(input.revision, 'lifecycle event revision'),
    type: input.type,
    at: timestamp(input.at, 'lifecycle event at'),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: text(input.idempotencyKey, 'lifecycle event idempotencyKey') }),
    ...(input.actorId === undefined ? {} : { actorId: text(input.actorId, 'lifecycle event actorId') }),
    ...(input.targetId === undefined ? {} : { targetId: text(input.targetId, 'lifecycle event targetId') }),
    ...(input.detail === undefined ? {} : { detail: text(input.detail, 'lifecycle event detail') }),
  };
  return Object.freeze(event);
}

export function startDecisionLifecycle(input: DecisionRecommendation): DecisionLifecycle {
  const recommendation = recommendationCopy(input);
  const event = lifecycleEvent({ revision: 1, type: 'recommendation_created', at: recommendation.issuedAt });
  return Object.freeze({
    revision: 1,
    status: 'recommended',
    recommendation,
    proposal: null,
    approval: null,
    action: null,
    revocations: Object.freeze([]),
    history: Object.freeze([event]),
  });
}

function hasRevocation(state: DecisionLifecycle, targetId: string): boolean {
  return state.revocations.some((revocation) => revocation.targetId === targetId);
}

function evidenceReasons(
  state: DecisionLifecycle,
  at: string,
): readonly PolicyGateReason[] {
  const reasons: PolicyGateReason[] = [];
  const evidence = state.recommendation.evidence;
  if (evidence.length === 0) reasons.push('evidence_missing');
  for (const item of evidence) {
    if (hasRevocation(state, item.id)) reasons.push('evidence_revoked');
    if (item.revoked) reasons.push('evidence_revoked');
    if (item.state !== 'supported' || item.completeness !== 'complete') reasons.push('evidence_unresolved');
    if (!before(at, item.freshUntil)) reasons.push('evidence_stale');
  }
  return Object.freeze([...new Set(reasons)]);
}

function proposalBody(value: Omit<PolicyProposal, 'digest'>): unknown {
  return {
    id: value.id,
    version: value.version,
    recommendationId: value.recommendationId,
    recommendationDigest: value.recommendationDigest,
    action: value.action,
    requiredEvidenceIds: value.requiredEvidenceIds,
    requiredApproverRole: value.requiredApproverRole,
    executorRoles: value.executorRoles,
    approvalTtlMs: value.approvalTtlMs,
    proposedAt: value.proposedAt,
    expiresAt: value.expiresAt,
    idempotencyKey: value.idempotencyKey,
    requestFingerprint: value.requestFingerprint,
  };
}

function proposalRequestFingerprint(input: PolicyProposalInput): string {
  return digest({
    id: text(input.id, 'policy proposal id'),
    version: positiveSafeInteger(input.version, 'policy proposal version'),
    action: clonePolicyAction(input.action),
    requiredApproverRole: text(input.requiredApproverRole, 'required approver role'),
    executorRoles: freezeList(input.executorRoles.map((role, index) => text(role, `executorRoles[${index}]`))),
    approvalTtlMs: ttl(input.approvalTtlMs, 'approvalTtlMs'),
    proposedAt: timestamp(input.proposedAt, 'policy proposal proposedAt'),
  });
}

function buildPolicyProposal(state: DecisionLifecycle, input: PolicyProposalInput): PolicyProposal {
  const recommendation = state.recommendation;
  const proposedAt = timestamp(input.proposedAt, 'policy proposal proposedAt');
  if (recommendation.status !== 'qualified' || recommendation.certificate.status !== 'proven_dominant') {
    throw new Error('Refused: recommendation is undetermined and cannot become a policy proposal');
  }
  if (recommendation.selectedAction === null) throw new Error('Refused: recommendation has no selected action');
  if (!before(proposedAt, recommendation.expiresAt)) throw new Error('Refused: recommendation has expired');
  const evidenceFailure = evidenceReasons(state, proposedAt);
  if (evidenceFailure.length > 0) throw new Error(`Refused: policy proposal evidence gate: ${evidenceFailure.join(', ')}`);
  if (!recommendation.assurance.meetsRequirement) {
    throw new Error(`Refused: policy proposal assurance gate: ${recommendation.assurance.refusal?.message ?? 'insufficient assurance'}`);
  }
  const action = clonePolicyAction(input.action);
  if (action.action !== recommendation.selectedAction || action.consequence !== recommendation.consequence) {
    throw new Error('Refused: policy action does not match the selected recommendation');
  }
  const requiredApproverRole = text(input.requiredApproverRole, 'required approver role');
  if (!Array.isArray(input.executorRoles) || input.executorRoles.length === 0) throw new Error('executorRoles must not be empty');
  const executorRoles = freezeList(input.executorRoles.map((role, index) => text(role, `executorRoles[${index}]`)));
  if (new Set(executorRoles).size !== executorRoles.length) throw new Error('executorRoles contains duplicates');
  const approvalTtlMs = ttl(input.approvalTtlMs, 'approvalTtlMs');
  // The approval expiry is capped at the policy expiry when approval is
  // actually granted.  A proposal may therefore be reviewed late in its
  // bounded lifetime without silently extending the policy's authority.
  const idempotencyKey = text(input.idempotencyKey, 'policy proposal idempotencyKey');
  const requestFingerprint = proposalRequestFingerprint(input);
  const body: Omit<PolicyProposal, 'digest'> = Object.freeze({
    id: text(input.id, 'policy proposal id'),
    version: positiveSafeInteger(input.version, 'policy proposal version'),
    recommendationId: recommendation.id,
    recommendationDigest: recommendation.digest,
    action,
    requiredEvidenceIds: freezeList(recommendation.evidence.map((item) => item.id)),
    requiredApproverRole,
    executorRoles,
    approvalTtlMs,
    proposedAt,
    expiresAt: recommendation.expiresAt,
    idempotencyKey,
    requestFingerprint,
  });
  return Object.freeze({ ...body, digest: digest(proposalBody(body)) });
}

function transitionError<T>(preview: PolicyTransitionPreview<T>): never {
  throw new Error(`Refused: ${preview.reasons.join(', ')}`);
}

export function previewPolicyProposal(
  inputState: DecisionLifecycle,
  input: PolicyProposalInput,
): PolicyTransitionPreview<PolicyProposal> {
  const state = lifecycleCopy(inputState);
  if (state.proposal !== null || state.status !== 'recommended') {
    return Object.freeze({ status: 'rejected', baseRevision: state.revision, reasons: ['invalid_transition'] as const, value: null });
  }
  try {
    const proposal = buildPolicyProposal(state, input);
    return Object.freeze({ status: 'accepted', baseRevision: state.revision, reasons: Object.freeze([]), value: proposal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: PolicyGateReason = message.includes('expired')
      ? 'recommendation_expired'
      : message.includes('evidence')
        ? 'evidence_unresolved'
        : message.includes('assurance')
          ? 'assurance_insufficient'
          : message.includes('undetermined') || message.includes('no selected action')
            ? 'recommendation_undetermined'
          : message.includes('selected recommendation')
            ? 'action_mismatch'
            : 'invalid_transition';
    return Object.freeze({ status: 'rejected', baseRevision: state.revision, reasons: Object.freeze([reason]), value: null });
  }
}

export function commitPolicyProposal(
  inputState: DecisionLifecycle,
  preview: PolicyTransitionPreview<PolicyProposal>,
): DecisionLifecycle {
  const state = lifecycleCopy(inputState);
  if (preview.status !== 'accepted' || preview.value === null) transitionError(preview);
  if (preview.baseRevision !== state.revision) throw new Error('Refused: stale policy proposal transition');
  if (state.status !== 'recommended' || state.proposal !== null) throw new Error('Refused: invalid policy proposal transition');
  const event = lifecycleEvent({
    revision: state.revision + 1,
    type: 'policy_proposed',
    at: preview.value.proposedAt,
    idempotencyKey: preview.value.idempotencyKey,
  });
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    status: 'proposed',
    proposal: preview.value,
    history: Object.freeze([...state.history, event]),
  });
}

export function proposePolicy(inputState: DecisionLifecycle, input: PolicyProposalInput): DecisionLifecycle {
  const state = lifecycleCopy(inputState);
  if (state.proposal !== null) {
    const fingerprint = proposalRequestFingerprint(input);
    if (state.proposal.idempotencyKey === input.idempotencyKey && state.proposal.requestFingerprint === fingerprint) return state;
    throw new Error('Refused: policy proposal idempotency conflict or invalid transition');
  }
  const preview = previewPolicyProposal(state, input);
  if (preview.status !== 'accepted') transitionError(preview);
  return commitPolicyProposal(state, preview);
}

function approvalBody(value: Omit<PolicyApproval, 'digest'>): unknown {
  return {
    id: value.id,
    proposalId: value.proposalId,
    proposalDigest: value.proposalDigest,
    idempotencyKey: value.idempotencyKey,
    approverId: value.approverId,
    approverRole: value.approverRole,
    approvedAt: value.approvedAt,
    expiresAt: value.expiresAt,
    confirmation: value.confirmation,
    requestFingerprint: value.requestFingerprint,
  };
}

function approvalRequestFingerprint(input: PolicyApprovalInput): string {
  const approver = principal(input.approver, 'approver');
  return digest({
    id: text(input.id, 'approval id'),
    approverId: approver.id,
    roles: approver.roles,
    approvedAt: timestamp(input.approvedAt, 'approval approvedAt'),
    confirmation: input.confirmation,
  });
}

function buildApproval(state: DecisionLifecycle, input: PolicyApprovalInput): PolicyApproval {
  if (state.proposal === null || state.status !== 'proposed') throw new Error('Refused: approval requires a proposed policy');
  const proposal = state.proposal;
  const approvedAt = timestamp(input.approvedAt, 'approval approvedAt');
  if (!before(approvedAt, proposal.expiresAt)) throw new Error('Refused: policy proposal has expired');
  if (hasRevocation(state, proposal.id) || hasRevocation(state, state.recommendation.id)) throw new Error('Refused: policy proposal is revoked');
  const evidenceFailure = evidenceReasons(state, approvedAt);
  if (evidenceFailure.length > 0) throw new Error(`Refused: approval evidence gate: ${evidenceFailure.join(', ')}`);
  const approver = principal(input.approver, 'approver');
  if (!hasRole(approver, proposal.requiredApproverRole) || approver.id === state.recommendation.issuer.id) {
    throw new Error('Refused: approver is not an independent authorised policy owner');
  }
  if (input.confirmation !== true) throw new Error('Refused: explicit human approval confirmation is required');
  const idempotencyKey = text(input.idempotencyKey, 'approval idempotencyKey');
  const expiresAt = addMilliseconds(approvedAt, proposal.approvalTtlMs);
  const boundedExpiry = before(expiresAt, proposal.expiresAt) ? expiresAt : proposal.expiresAt;
  const body: Omit<PolicyApproval, 'digest'> = Object.freeze({
    id: text(input.id, 'approval id'),
    proposalId: proposal.id,
    proposalDigest: proposal.digest,
    idempotencyKey,
    approverId: approver.id,
    approverRole: proposal.requiredApproverRole,
    approvedAt,
    expiresAt: boundedExpiry,
    confirmation: true,
    requestFingerprint: approvalRequestFingerprint(input),
  });
  return Object.freeze({ ...body, digest: digest(approvalBody(body)) });
}

export function previewPolicyApproval(
  inputState: DecisionLifecycle,
  input: PolicyApprovalInput,
): PolicyTransitionPreview<PolicyApproval> {
  const state = lifecycleCopy(inputState);
  if (state.approval !== null || state.status !== 'proposed') {
    return Object.freeze({ status: 'rejected', baseRevision: state.revision, reasons: ['invalid_transition'] as const, value: null });
  }
  try {
    const approval = buildApproval(state, input);
    return Object.freeze({ status: 'accepted', baseRevision: state.revision, reasons: Object.freeze([]), value: approval });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: PolicyGateReason = message.includes('expired')
      ? 'approval_expired'
      : message.includes('evidence')
        ? 'evidence_unresolved'
        : message.includes('revoked')
          ? 'policy_revoked'
          : message.includes('approver') || message.includes('authorised')
            ? 'unauthorized_approver'
            : message.includes('confirmation')
              ? 'confirmation_required'
              : 'invalid_transition';
    return Object.freeze({ status: 'rejected', baseRevision: state.revision, reasons: Object.freeze([reason]), value: null });
  }
}

export function commitPolicyApproval(
  inputState: DecisionLifecycle,
  preview: PolicyTransitionPreview<PolicyApproval>,
): DecisionLifecycle {
  const state = lifecycleCopy(inputState);
  if (preview.status !== 'accepted' || preview.value === null) transitionError(preview);
  if (preview.baseRevision !== state.revision) throw new Error('Refused: stale policy approval transition');
  if (state.status !== 'proposed' || state.approval !== null) throw new Error('Refused: invalid policy approval transition');
  const event = lifecycleEvent({
    revision: state.revision + 1,
    type: 'policy_approved',
    at: preview.value.approvedAt,
    idempotencyKey: preview.value.idempotencyKey,
    actorId: preview.value.approverId,
  });
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    status: 'approved',
    approval: preview.value,
    history: Object.freeze([...state.history, event]),
  });
}

export function approvePolicy(inputState: DecisionLifecycle, input: PolicyApprovalInput): DecisionLifecycle {
  const state = lifecycleCopy(inputState);
  if (state.approval !== null) {
    const fingerprint = approvalRequestFingerprint(input);
    if (state.approval.idempotencyKey === input.idempotencyKey && state.approval.requestFingerprint === fingerprint) return state;
    throw new Error('Refused: approval idempotency conflict or invalid transition');
  }
  const preview = previewPolicyApproval(state, input);
  if (preview.status !== 'accepted') transitionError(preview);
  return commitPolicyApproval(state, preview);
}

function actionBody(value: Omit<RecordedAction, 'digest'>): unknown {
  return {
    id: value.id,
    proposalId: value.proposalId,
    approvalId: value.approvalId,
    idempotencyKey: value.idempotencyKey,
    action: value.action,
    executorId: value.executorId,
    actedAt: value.actedAt,
    confirmation: value.confirmation,
    execution: value.execution,
    externalEffect: value.externalEffect,
    automatic: value.automatic,
    requestFingerprint: value.requestFingerprint,
  };
}

function actionRequestFingerprint(input: ActionRequest): string {
  const executor = principal(input.executor, 'executor');
  return digest({
    id: text(input.id, 'action id'),
    executorId: executor.id,
    roles: executor.roles,
    actedAt: timestamp(input.actedAt, 'action actedAt'),
    confirmation: input.confirmation,
  });
}

function buildAction(state: DecisionLifecycle, input: ActionRequest): RecordedAction {
  if (state.proposal === null || state.approval === null) {
    throw new Error('Refused: action requires an approved policy');
  }
  const proposal = state.proposal;
  const approval = state.approval;
  if (state.revocations.length > 0) throw new Error('Refused: approved policy or approval is revoked');
  if (state.status !== 'approved') throw new Error('Refused: action requires an approved policy');
  const actedAt = timestamp(input.actedAt, 'action actedAt');
  if (!before(actedAt, proposal.expiresAt)) throw new Error('Refused: policy proposal has expired');
  if (!before(actedAt, approval.expiresAt)) throw new Error('Refused: approval has expired');
  if (hasRevocation(state, proposal.id) || hasRevocation(state, approval.id) || hasRevocation(state, state.recommendation.id)) {
    throw new Error('Refused: approved policy or approval is revoked');
  }
  const evidenceFailure = evidenceReasons(state, actedAt);
  if (evidenceFailure.length > 0) throw new Error(`Refused: action evidence gate: ${evidenceFailure.join(', ')}`);
  const executor = principal(input.executor, 'executor');
  if (!proposal.executorRoles.some((role) => hasRole(executor, role)) || (proposal.action.consequence === 'changes_spend' && executor.id === approval.approverId)) {
    throw new Error('Refused: executor is not authorised for this policy action');
  }
  if (input.confirmation !== true) throw new Error('Refused: explicit operator action confirmation is required');
  const idempotencyKey = text(input.idempotencyKey, 'action idempotencyKey');
  const body: Omit<RecordedAction, 'digest'> = Object.freeze({
    id: text(input.id, 'action id'),
    proposalId: proposal.id,
    approvalId: approval.id,
    idempotencyKey,
    action: proposal.action,
    executorId: executor.id,
    actedAt,
    confirmation: true,
    execution: 'not_executed',
    externalEffect: 'not_attempted',
    automatic: false,
    requestFingerprint: actionRequestFingerprint(input),
  });
  return Object.freeze({ ...body, digest: digest(actionBody(body)) });
}

export function previewAction(
  inputState: DecisionLifecycle,
  input: ActionRequest,
): PolicyTransitionPreview<RecordedAction> {
  const state = lifecycleCopy(inputState);
  if (state.action !== null || (state.status !== 'approved' && state.status !== 'revoked')) {
    return Object.freeze({ status: 'rejected', baseRevision: state.revision, reasons: ['invalid_transition'] as const, value: null });
  }
  try {
    const action = buildAction(state, input);
    return Object.freeze({ status: 'accepted', baseRevision: state.revision, reasons: Object.freeze([]), value: action });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: PolicyGateReason = message.includes('expired')
      ? 'approval_expired'
      : message.includes('revoked')
        ? 'approval_revoked'
        : message.includes('evidence')
          ? 'evidence_unresolved'
          : message.includes('executor') || message.includes('authorised')
            ? 'unauthorized_executor'
            : message.includes('confirmation')
              ? 'confirmation_required'
              : 'invalid_transition';
    return Object.freeze({ status: 'rejected', baseRevision: state.revision, reasons: Object.freeze([reason]), value: null });
  }
}

export function commitAction(
  inputState: DecisionLifecycle,
  preview: PolicyTransitionPreview<RecordedAction>,
): DecisionLifecycle {
  const state = lifecycleCopy(inputState);
  if (preview.status !== 'accepted' || preview.value === null) transitionError(preview);
  if (preview.baseRevision !== state.revision) throw new Error('Refused: stale action transition');
  if (state.status !== 'approved' || state.action !== null) throw new Error('Refused: invalid action transition');
  const event = lifecycleEvent({
    revision: state.revision + 1,
    type: 'action_recorded',
    at: preview.value.actedAt,
    idempotencyKey: preview.value.idempotencyKey,
    actorId: preview.value.executorId,
  });
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    status: 'action_recorded',
    action: preview.value,
    history: Object.freeze([...state.history, event]),
  });
}

export function recordAction(inputState: DecisionLifecycle, input: ActionRequest): DecisionLifecycle {
  const state = lifecycleCopy(inputState);
  if (state.action !== null) {
    const fingerprint = actionRequestFingerprint(input);
    if (state.action.idempotencyKey === input.idempotencyKey && state.action.requestFingerprint === fingerprint) return state;
    throw new Error('Refused: action idempotency conflict or invalid transition');
  }
  const preview = previewAction(state, input);
  if (preview.status !== 'accepted') transitionError(preview);
  return commitAction(state, preview);
}

/** Alias making the no-external-effect boundary explicit to callers. */
export const recordApprovedAction = recordAction;

function revocationBody(value: Omit<LifecycleRevocation, 'digest'>): unknown {
  return {
    targetId: value.targetId,
    idempotencyKey: value.idempotencyKey,
    revokedAt: value.revokedAt,
    actorId: value.actorId,
    reason: value.reason,
  };
}

function proposalCopy(value: PolicyProposal): PolicyProposal {
  if (value === null || typeof value !== 'object') throw new Error('policy proposal must be an object');
  const body: Omit<PolicyProposal, 'digest'> = Object.freeze({
    id: text(value.id, 'policy proposal id'),
    version: positiveSafeInteger(value.version, 'policy proposal version'),
    recommendationId: text(value.recommendationId, 'policy proposal recommendationId'),
    recommendationDigest: text(value.recommendationDigest, 'policy proposal recommendationDigest'),
    action: clonePolicyAction(value.action),
    requiredEvidenceIds: freezeList(value.requiredEvidenceIds.map((id, index) => text(id, `requiredEvidenceIds[${index}]`))),
    requiredApproverRole: text(value.requiredApproverRole, 'required approver role'),
    executorRoles: freezeList(value.executorRoles.map((role, index) => text(role, `executorRoles[${index}]`))),
    approvalTtlMs: ttl(value.approvalTtlMs, 'approvalTtlMs'),
    proposedAt: timestamp(value.proposedAt, 'policy proposal proposedAt'),
    expiresAt: timestamp(value.expiresAt, 'policy proposal expiresAt'),
    idempotencyKey: text(value.idempotencyKey, 'policy proposal idempotencyKey'),
    requestFingerprint: text(value.requestFingerprint, 'policy proposal requestFingerprint'),
  });
  if (!before(body.proposedAt, body.expiresAt)) throw new Error('policy proposal expiresAt must be after proposedAt');
  if (value.digest !== digest(proposalBody(body))) throw new Error('policy proposal digest verification failed');
  return Object.freeze({ ...body, digest: value.digest });
}

function approvalCopy(value: PolicyApproval): PolicyApproval {
  if (value === null || typeof value !== 'object') throw new Error('policy approval must be an object');
  if (value.confirmation !== true) throw new Error('policy approval confirmation is invalid');
  const body: Omit<PolicyApproval, 'digest'> = Object.freeze({
    id: text(value.id, 'approval id'),
    proposalId: text(value.proposalId, 'approval proposalId'),
    proposalDigest: text(value.proposalDigest, 'approval proposalDigest'),
    idempotencyKey: text(value.idempotencyKey, 'approval idempotencyKey'),
    approverId: text(value.approverId, 'approval approverId'),
    approverRole: text(value.approverRole, 'approval approverRole'),
    approvedAt: timestamp(value.approvedAt, 'approval approvedAt'),
    expiresAt: timestamp(value.expiresAt, 'approval expiresAt'),
    confirmation: true,
    requestFingerprint: text(value.requestFingerprint, 'approval requestFingerprint'),
  });
  if (!before(body.approvedAt, body.expiresAt)) throw new Error('approval expiresAt must be after approvedAt');
  if (value.digest !== digest(approvalBody(body))) throw new Error('policy approval digest verification failed');
  return Object.freeze({ ...body, digest: value.digest });
}

function actionCopy(value: RecordedAction): RecordedAction {
  if (value === null || typeof value !== 'object') throw new Error('recorded action must be an object');
  if (value.confirmation !== true || value.execution !== 'not_executed' || value.externalEffect !== 'not_attempted' || value.automatic !== false) {
    throw new Error('recorded action execution semantics are invalid');
  }
  const body: Omit<RecordedAction, 'digest'> = Object.freeze({
    id: text(value.id, 'action id'),
    proposalId: text(value.proposalId, 'action proposalId'),
    approvalId: text(value.approvalId, 'action approvalId'),
    idempotencyKey: text(value.idempotencyKey, 'action idempotencyKey'),
    action: clonePolicyAction(value.action),
    executorId: text(value.executorId, 'action executorId'),
    actedAt: timestamp(value.actedAt, 'action actedAt'),
    confirmation: true,
    execution: 'not_executed',
    externalEffect: 'not_attempted',
    automatic: false,
    requestFingerprint: text(value.requestFingerprint, 'action requestFingerprint'),
  });
  if (value.digest !== digest(actionBody(body))) throw new Error('recorded action digest verification failed');
  return Object.freeze({ ...body, digest: value.digest });
}

function revocationCopy(value: LifecycleRevocation): LifecycleRevocation {
  if (value === null || typeof value !== 'object') throw new Error('lifecycle revocation must be an object');
  const body: Omit<LifecycleRevocation, 'digest'> = Object.freeze({
    targetId: text(value.targetId, 'revocation targetId'),
    idempotencyKey: text(value.idempotencyKey, 'revocation idempotencyKey'),
    revokedAt: timestamp(value.revokedAt, 'revocation revokedAt'),
    actorId: text(value.actorId, 'revocation actorId'),
    reason: text(value.reason, 'revocation reason'),
  });
  if (value.digest !== digest(revocationBody(body))) throw new Error('lifecycle revocation digest verification failed');
  return Object.freeze({ ...body, digest: value.digest });
}

function assertLifecycleShape(state: {
  readonly revision: number;
  readonly status: LifecycleStatus;
  readonly recommendation: DecisionRecommendation;
  readonly proposal: PolicyProposal | null;
  readonly approval: PolicyApproval | null;
  readonly action: RecordedAction | null;
  readonly revocations: readonly LifecycleRevocation[];
  readonly history: readonly LifecycleEvent[];
}): void {
  const proposal = state.proposal;
  const approval = state.approval;
  const action = state.action;
  const hasProposal = proposal !== null;
  const hasApproval = approval !== null;
  const hasAction = action !== null;

  if (!hasProposal && (hasApproval || hasAction)) throw new Error('decision lifecycle has an approval/action without a proposal');
  if (!hasApproval && hasAction) throw new Error('decision lifecycle has an action without an approval');

  if (proposal !== null) {
    if (proposal.recommendationId !== state.recommendation.id || proposal.recommendationDigest !== state.recommendation.digest) {
      throw new Error('decision lifecycle proposal is not bound to its recommendation');
    }
    if (proposal.expiresAt !== state.recommendation.expiresAt) throw new Error('decision lifecycle proposal TTL is not bounded by recommendation TTL');
    if (proposal.action.action !== state.recommendation.selectedAction || proposal.action.consequence !== state.recommendation.consequence) {
      throw new Error('decision lifecycle proposal action is not bound to its recommendation');
    }
    const evidenceIds = state.recommendation.evidence.map((item) => item.id);
    if (proposal.requiredEvidenceIds.length !== evidenceIds.length || proposal.requiredEvidenceIds.some((id, index) => id !== evidenceIds[index])) {
      throw new Error('decision lifecycle proposal evidence binding does not match recommendation evidence');
    }
  }

  if (approval !== null && proposal !== null) {
    if (approval.proposalId !== proposal.id || approval.proposalDigest !== proposal.digest) {
      throw new Error('decision lifecycle approval is not bound to its proposal');
    }
    const approvalWithinProposal = before(approval.expiresAt, proposal.expiresAt) || approval.expiresAt === proposal.expiresAt;
    if (approval.approverRole !== proposal.requiredApproverRole || !before(approval.approvedAt, approval.expiresAt) || !approvalWithinProposal) {
      throw new Error('decision lifecycle approval validity is outside its proposal');
    }
  }

  if (action !== null && proposal !== null && approval !== null) {
    if (action.proposalId !== proposal.id || action.approvalId !== approval.id || canonicalJson(action.action) !== canonicalJson(proposal.action)) {
      throw new Error('decision lifecycle action is not bound to its approved policy');
    }
  }

  if (state.status === 'recommended' && (hasProposal || hasApproval || hasAction)) throw new Error('recommended lifecycle cannot contain later gate records');
  if (state.status === 'proposed' && (!hasProposal || hasApproval || hasAction)) throw new Error('proposed lifecycle gate records are inconsistent');
  if (state.status === 'approved' && (!hasProposal || !hasApproval || hasAction)) throw new Error('approved lifecycle gate records are inconsistent');
  if (state.status === 'action_recorded' && (!hasProposal || !hasApproval || !hasAction)) throw new Error('action_recorded lifecycle gate records are inconsistent');
  if (state.status === 'revoked' && state.revocations.length === 0) throw new Error('revoked lifecycle must retain a revocation record');

  if (state.history.length !== state.revision) throw new Error('decision lifecycle history/revision mismatch');
  for (let index = 0; index < state.history.length; index += 1) {
    if (state.history[index]!.revision !== index + 1) throw new Error('decision lifecycle history revisions are not contiguous');
  }
}

function lifecycleCopy(inputState: DecisionLifecycle): DecisionLifecycle {
  if (inputState === null || typeof inputState !== 'object') throw new Error('decision lifecycle must be an object');
  const recommendation = recommendationCopy(inputState.recommendation);
  if (!Number.isSafeInteger(inputState.revision) || inputState.revision < 1) throw new Error('lifecycle revision is invalid');
  if (inputState.status !== 'recommended' && inputState.status !== 'proposed' && inputState.status !== 'approved' && inputState.status !== 'action_recorded' && inputState.status !== 'revoked') {
    throw new Error('lifecycle status is invalid');
  }
  const revocations = Object.freeze(inputState.revocations.map((item) => revocationCopy(item)));
  const history = Object.freeze(inputState.history.map((item) => lifecycleEvent(item)));
  const normalized = Object.freeze({
    revision: inputState.revision,
    status: inputState.status,
    recommendation,
    proposal: inputState.proposal === null ? null : proposalCopy(inputState.proposal),
    approval: inputState.approval === null ? null : approvalCopy(inputState.approval),
    action: inputState.action === null ? null : actionCopy(inputState.action),
    revocations,
    history,
  });
  assertLifecycleShape(normalized);
  return normalized;
}

/** Record an effective revocation. It changes no prior record and blocks future action. */
export function revokeDecisionLifecycle(inputState: DecisionLifecycle, input: RevocationInput): DecisionLifecycle {
  const state = lifecycleCopy(inputState);
  const idempotencyKey = text(input.idempotencyKey, 'revocation idempotencyKey');
  const targetId = text(input.targetId, 'revocation targetId');
  const revokedAt = timestamp(input.revokedAt, 'revocation revokedAt');
  const actor = principal(input.actor, 'revocation actor');
  const reason = text(input.reason, 'revocation reason');
  const revocationRole = state.proposal?.requiredApproverRole;
  const actorMayRevoke = revocationRole === undefined
    ? actor.id === state.recommendation.issuer.id || actor.roles.includes('policy_admin')
    : hasRole(actor, revocationRole) || actor.roles.includes('policy_admin');
  if (!actorMayRevoke) throw new Error('Refused: revocation actor is not authorised');
  const known = new Set([
    state.recommendation.id,
    ...state.recommendation.evidence.map((item) => item.id),
    ...(state.proposal === null ? [] : [state.proposal.id]),
    ...(state.approval === null ? [] : [state.approval.id]),
  ]);
  if (!known.has(targetId)) throw new Error(`Refused: unknown revocation target ${targetId}`);
  const existing = state.revocations.find((item) => item.idempotencyKey === idempotencyKey);
  if (existing !== undefined) {
    if (existing.digest !== digest(revocationBody({ targetId, idempotencyKey, revokedAt, actorId: actor.id, reason }))) {
      throw new Error('Refused: revocation idempotency conflict');
    }
    return state;
  }
  const body: Omit<LifecycleRevocation, 'digest'> = Object.freeze({ targetId, idempotencyKey, revokedAt, actorId: actor.id, reason });
  const revocation: LifecycleRevocation = Object.freeze({ ...body, digest: digest(revocationBody(body)) });
  const event = lifecycleEvent({
    revision: state.revision + 1,
    type: 'revoked',
    at: revokedAt,
    idempotencyKey,
    actorId: actor.id,
    targetId,
    detail: reason,
  });
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    status: 'revoked',
    revocations: Object.freeze([...state.revocations, revocation]),
    history: Object.freeze([...state.history, event]),
  });
}

/** Alias for callers that refer to the lifecycle as a policy state machine. */
export const revokePolicy = revokeDecisionLifecycle;
