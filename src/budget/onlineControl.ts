/**
 * WP-J02 — constrained online control for Segreant's own daily spend cap.
 *
 * This is deliberately a narrow action adapter, not a generic provider router.
 * The operator delegates one bounded target (budget.dailyUsd) through a versioned
 * policy. A DecisionCertificate still does NOT authorize action by itself: this
 * module requires both DAL-3 decision fitness and the separately declared control
 * envelope. Missing/expired/contradictory evidence fails toward the operator's
 * safe baseline. The deterministic v1 controller explores at rate zero.
 */

import { createHash } from 'node:crypto';
import type { BudgetCapDecision } from './capDecision.ts';
import { canonicalJson } from '../epistemic/serialization.ts';
import { decimalStringFromNumber } from '../config.ts';
import { compareMoney, money, type Money } from '../economics/money.ts';

export interface BudgetControlPolicyInput {
  readonly id: string;
  readonly version: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly enabled: boolean;
  /** Operator-approved cap restored by the circuit breaker. */
  readonly safeBaselineDailyUsd: number;
  /** Hard envelope for any autonomous cap. */
  readonly minDailyUsd: number;
  readonly maxDailyUsd: number;
  /** Maximum fractional change from the cap the controller currently owns. */
  readonly maxRelativeStep: number;
  /**
   * V1 is deterministic. Keeping the field explicit prevents "no exploration
   * limit" from being confused with "exploration disabled".
   */
  readonly explorationRateCap: number;
  /** The runtime runaway guard must be configured no looser than this amount. */
  readonly maxRunawayUsd: number;
}

export interface BudgetControlPolicy extends BudgetControlPolicyInput {
  readonly digest: string;
}

export type BudgetControlPhase = 'armed' | 'controlling' | 'rolled_back';

export interface BudgetControlState {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly phase: BudgetControlPhase;
  readonly revision: number;
  readonly safeBaselineDailyUsd: number;
  /** Last cap written by this controller; null before it owns a mutation. */
  readonly lastAppliedDailyUsd: number | null;
  readonly lastActionAt: string;
}

export type BudgetControlAction = 'no_action' | 'apply_recommended' | 'rollback_to_baseline';

export interface BudgetControlPlan {
  readonly action: BudgetControlAction;
  readonly nextDailyUsd: number | null;
  readonly reasons: readonly string[];
  readonly nextState: BudgetControlState;
  readonly decisionId: string | null;
}

export interface BudgetControlInput {
  readonly policy: BudgetControlPolicy;
  readonly state: BudgetControlState;
  readonly decision: BudgetCapDecision | null;
  readonly currentDailyUsd: number | null;
  readonly runawayMaxUsd: number | null;
  readonly runawayTripped: boolean;
  readonly now: string;
}

export interface BudgetControlAuditEventInput {
  readonly policy: BudgetControlPolicy;
  /** Stable id used to make crash recovery idempotent across config/state/audit files. */
  readonly transactionId: string;
  readonly state: BudgetControlState;
  readonly action: BudgetControlAction;
  readonly fromDailyUsd: number | null;
  readonly toDailyUsd: number | null;
  readonly at: string;
  readonly reason: string;
  readonly decisionId: string | null;
}

export interface BudgetControlAuditEvent {
  readonly sequence: number;
  readonly transactionId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly stateRevision: number;
  readonly action: BudgetControlAction;
  readonly fromDailyUsd: number | null;
  readonly toDailyUsd: number | null;
  readonly at: string;
  readonly reason: string;
  readonly decisionId: string | null;
  readonly previousHash: string | null;
  readonly hash: string;
}

export interface BudgetControlAuditVerification {
  readonly valid: boolean;
  readonly firstInvalidSequence: number | null;
}

export interface BudgetControlPendingMutationInput {
  readonly transactionId: string;
  readonly policy: BudgetControlPolicy;
  readonly previousState: BudgetControlState;
  readonly plan: BudgetControlPlan;
  readonly fromDailyUsd: number | null;
  readonly at: string;
}

export interface BudgetControlPendingMutation {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly previousState: BudgetControlState;
  readonly nextState: BudgetControlState;
  readonly action: Exclude<BudgetControlAction, 'no_action'>;
  readonly fromDailyUsd: number | null;
  readonly toDailyUsd: number | null;
  readonly at: string;
  readonly reason: string;
  readonly decisionId: string | null;
  readonly digest: string;
}

export type BudgetControlRecoveryStatus = 'complete' | 'abort' | 'conflict' | 'already_recorded';

export interface BudgetControlPendingResolution {
  readonly status: BudgetControlRecoveryStatus;
  readonly reason: string;
}


function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function instant(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new Error(`${label} must be canonical UTC ISO-8601`);
  }
  return text;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number`);
  }
  return value;
}

function cap(value: unknown, label: string): number | null {
  if (value === null) return null;
  return positive(value, label);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function exactUsd(value: number, label: string): Money {
  return money(decimalStringFromNumber(value, label), 'USD', 'effective');
}

function sameAmount(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return compareMoney(exactUsd(left, 'left USD amount'), exactUsd(right, 'right USD amount')) === 0;
}

function compareAmount(left: number, right: number, label: string): -1 | 0 | 1 {
  return compareMoney(exactUsd(left, `${label} left`), exactUsd(right, `${label} right`));
}

/**
 * Exact comparison of |target-current| / current against a declared decimal
 * step. No division or binary floating-point arithmetic participates in the
 * authorization decision.
 */
function relativeStepExceeds(target: number, current: number, maxRelativeStep: number): boolean {
  const t = exactUsd(target, 'target daily cap');
  const cur = exactUsd(current, 'owned current daily cap');
  const scale = Math.max(t.scale, cur.scale);
  const tCoeff = t.coefficient * (10n ** BigInt(scale - t.scale));
  const cCoeff = cur.coefficient * (10n ** BigInt(scale - cur.scale));
  const delta = tCoeff >= cCoeff ? tCoeff - cCoeff : cCoeff - tCoeff;
  const step = exactUsd(maxRelativeStep, 'maxRelativeStep');
  // step is a dimensionless decimal carried through Money only to reuse the
  // canonical decimal parser; cross-multiply before comparing.
  return delta * (10n ** BigInt(step.scale)) > cCoeff * step.coefficient;
}

function stateFor(
  state: BudgetControlState,
  phase: BudgetControlPhase,
  now: string,
  lastAppliedDailyUsd: number | null,
): BudgetControlState {
  return Object.freeze({
    ...state,
    phase,
    revision: state.revision + 1,
    lastAppliedDailyUsd,
    lastActionAt: now,
  });
}

export function budgetControlPolicy(input: BudgetControlPolicyInput): BudgetControlPolicy {
  const id = nonEmpty(input.id, 'budget control policy id');
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new Error('budget control policy version must be a positive safe integer');
  }
  const issuedAt = instant(input.issuedAt, 'budget control policy issuedAt');
  const expiresAt = instant(input.expiresAt, 'budget control policy expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error('budget control policy expiresAt must be after issuedAt');
  }
  if (typeof input.enabled !== 'boolean') throw new Error('budget control policy enabled must be boolean');
  const safeBaselineDailyUsd = positive(input.safeBaselineDailyUsd, 'safeBaselineDailyUsd');
  const minDailyUsd = positive(input.minDailyUsd, 'minDailyUsd');
  const maxDailyUsd = positive(input.maxDailyUsd, 'maxDailyUsd');
  if (compareAmount(minDailyUsd, safeBaselineDailyUsd, 'policy minimum/baseline') > 0
      || compareAmount(safeBaselineDailyUsd, maxDailyUsd, 'policy baseline/maximum') > 0) {
    throw new Error('safeBaselineDailyUsd must be inside [minDailyUsd, maxDailyUsd]');
  }
  const maxRelativeStep = positive(input.maxRelativeStep, 'maxRelativeStep');
  if (maxRelativeStep > 1) throw new Error('maxRelativeStep must be within (0,1]');
  if (input.explorationRateCap !== 0) {
    throw new Error('explorationRateCap must be 0 for the deterministic v1 budget controller');
  }
  const maxRunawayUsd = positive(input.maxRunawayUsd, 'maxRunawayUsd');
  const material = {
    id,
    version: input.version,
    issuedAt,
    expiresAt,
    enabled: input.enabled,
    safeBaselineDailyUsd,
    minDailyUsd,
    maxDailyUsd,
    maxRelativeStep,
    explorationRateCap: 0,
    maxRunawayUsd,
  };
  return Object.freeze({ ...material, digest: sha256(material) });
}

export function initialBudgetControlState(
  policy: BudgetControlPolicy,
  currentDailyUsd: number | null,
  at: string,
): BudgetControlState {
  const now = instant(at, 'budget control state at');
  const current = cap(currentDailyUsd, 'currentDailyUsd');
  if (!sameAmount(current, policy.safeBaselineDailyUsd)) {
    throw new Error('controller can only arm when the live cap equals the declared safe baseline');
  }
  return Object.freeze({
    policyId: policy.id,
    policyVersion: policy.version,
    policyDigest: policy.digest,
    phase: 'armed',
    revision: 0,
    safeBaselineDailyUsd: policy.safeBaselineDailyUsd,
    lastAppliedDailyUsd: null,
    lastActionAt: now,
  });
}

/**
 * Reconcile persisted controller state with the operator-supplied policy.
 * The same exact policy never re-arms itself: rolled_back remains terminal.
 * A genuinely new version/digest may start a new authority epoch, but only when
 * the live cap is already at the new policy's declared safe baseline.
 */
export function reconcileBudgetControlState(
  policy: BudgetControlPolicy,
  persisted: BudgetControlState,
  currentDailyUsd: number | null,
  at: string,
): BudgetControlState {
  if (persisted.policyId === policy.id
      && persisted.policyVersion === policy.version
      && persisted.policyDigest === policy.digest) {
    validateState(policy, persisted);
    return persisted;
  }
  if (persisted.policyId === policy.id) {
    if (persisted.policyVersion > policy.version) {
      throw new Error('budget control policy rollback refused: persisted state belongs to a newer policy version');
    }
    if (persisted.policyVersion === policy.version) {
      throw new Error('budget control policy version reused with different contents; increment the policy version before changing delegated authority');
    }
  }
  return initialBudgetControlState(policy, currentDailyUsd, at);
}

function validateState(policy: BudgetControlPolicy, state: BudgetControlState): void {
  if (state.policyId !== policy.id || state.policyVersion !== policy.version || state.policyDigest !== policy.digest) {
    throw new Error('budget control state does not belong to this exact policy version');
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('budget control state revision is invalid');
  if (!['armed', 'controlling', 'rolled_back'].includes(state.phase)) throw new Error('budget control state phase is invalid');
  if (!sameAmount(state.safeBaselineDailyUsd, policy.safeBaselineDailyUsd)) throw new Error('budget control state baseline does not match policy');
  cap(state.lastAppliedDailyUsd, 'lastAppliedDailyUsd');
  instant(state.lastActionAt, 'budget control state lastActionAt');
}

function noAction(
  state: BudgetControlState,
  current: number | null,
  reasons: readonly string[],
  decisionId: string | null,
): BudgetControlPlan {
  return Object.freeze({
    action: 'no_action',
    nextDailyUsd: current,
    reasons: Object.freeze([...reasons]),
    nextState: state,
    decisionId,
  });
}

function rollback(
  policy: BudgetControlPolicy,
  state: BudgetControlState,
  current: number | null,
  now: string,
  reasons: readonly string[],
  decisionId: string | null,
): BudgetControlPlan {
  if (state.phase !== 'controlling') return noAction(state, current, reasons, decisionId);
  // The controller may only undo its own last write. A manual edit is a human
  // override and terminates autonomous authority for this policy instance.
  if (state.lastAppliedDailyUsd === null || !sameAmount(current, state.lastAppliedDailyUsd)) {
    return noAction(state, current, [...reasons, 'operator override detected; autonomous rollback refused'], decisionId);
  }
  return Object.freeze({
    action: 'rollback_to_baseline',
    nextDailyUsd: policy.safeBaselineDailyUsd,
    reasons: Object.freeze([...reasons]),
    nextState: stateFor(state, 'rolled_back', now, policy.safeBaselineDailyUsd),
    decisionId,
  });
}

export function planBudgetControl(input: BudgetControlInput): BudgetControlPlan {
  const policy = input.policy;
  const state = input.state;
  validateState(policy, state);
  const now = instant(input.now, 'budget control now');
  const current = cap(input.currentDailyUsd, 'currentDailyUsd');
  const runawayMax = cap(input.runawayMaxUsd, 'runawayMaxUsd');
  if (Date.parse(now) < Date.parse(policy.issuedAt)) {
    return noAction(state, current, ['policy is not yet in force'], null);
  }

  const decisionId = input.decision === null
    ? null
    : `${input.decision.problem.id}:v${input.decision.problem.version}`;

  if (state.phase === 'rolled_back') {
    return noAction(state, current, ['policy instance is rolled back; a new policy version is required to re-arm'], decisionId);
  }
  if (!policy.enabled) {
    return rollback(policy, state, current, now, ['policy is disabled'], decisionId);
  }
  if (Date.parse(now) >= Date.parse(policy.expiresAt)) {
    return rollback(policy, state, current, now, ['policy expired'], decisionId);
  }
  if (runawayMax === null) {
    return rollback(policy, state, current, now, ['tail-risk circuit breaker is unavailable: runaway guard is disabled'], decisionId);
  }
  if (compareAmount(runawayMax, policy.maxRunawayUsd, 'runaway bound') > 0) {
    return rollback(policy, state, current, now, ['tail-risk circuit breaker is looser than the delegated policy'], decisionId);
  }
  if (input.runawayTripped) {
    return rollback(policy, state, current, now, ['tail-risk/runaway circuit breaker tripped'], decisionId);
  }
  if (input.decision === null) {
    return rollback(policy, state, current, now, ['no DecisionCertificate is available'], null);
  }

  const decision = input.decision;
  if (decision.certificate.status !== 'proven_dominant'
      || decision.certificate.action !== 'apply_recommended'
      || decision.standing.status !== 'certified'
      || !decision.standing.certifiedForSpendChange
      || !decision.assurance.meetsRequirement) {
    return rollback(policy, state, current, now, ['DecisionCertificate/assurance does not authorize this spend-changing policy envelope'], decisionId);
  }
  if (decision.preference.status !== 'stable'
      || !decision.preference.robustOptimalActions.includes('apply_recommended')) {
    return rollback(policy, state, current, now, ['recommended cap is not robust across the declared admissible preference set'], decisionId);
  }

  const target = positive(decision.basis.recommendedDailyUsd, 'recommendedDailyUsd');
  if (compareAmount(target, policy.minDailyUsd, 'recommended/minimum cap') < 0
      || compareAmount(target, policy.maxDailyUsd, 'recommended/maximum cap') > 0) {
    return rollback(policy, state, current, now, ['recommended cap falls outside the delegated budget envelope'], decisionId);
  }

  const ownedCurrent = state.phase === 'controlling' ? state.lastAppliedDailyUsd : policy.safeBaselineDailyUsd;
  if (!sameAmount(current, ownedCurrent)) {
    return noAction(state, current, ['operator override detected; autonomous action refused'], decisionId);
  }
  if (relativeStepExceeds(target, ownedCurrent!, policy.maxRelativeStep)) {
    return rollback(policy, state, current, now, ['recommended cap exceeds the delegated maximum step size'], decisionId);
  }
  if (sameAmount(current, target)) {
    return noAction(state, current, ['recommended cap already active'], decisionId);
  }

  return Object.freeze({
    action: 'apply_recommended',
    nextDailyUsd: target,
    reasons: Object.freeze([]),
    nextState: stateFor(state, 'controlling', now, target),
    decisionId,
  });
}

function auditMaterial(event: Omit<BudgetControlAuditEvent, 'hash'>): unknown {
  return event;
}

export function appendBudgetControlAuditEvent(
  history: readonly BudgetControlAuditEvent[],
  input: BudgetControlAuditEventInput,
): readonly BudgetControlAuditEvent[] {
  const verified = verifyBudgetControlAudit(history);
  if (!verified.valid) throw new Error(`cannot append to invalid budget control audit chain at sequence ${verified.firstInvalidSequence}`);
  validateState(input.policy, input.state);
  const at = instant(input.at, 'budget control audit at');
  const reason = nonEmpty(input.reason, 'budget control audit reason');
  const fromDailyUsd = cap(input.fromDailyUsd, 'audit fromDailyUsd');
  const toDailyUsd = cap(input.toDailyUsd, 'audit toDailyUsd');
  const previousHash = history.length === 0 ? null : history[history.length - 1]!.hash;
  const transactionId = nonEmpty(input.transactionId, 'budget control audit transactionId');
  if (history.some((event) => event.transactionId === transactionId)) {
    throw new Error(`budget control audit transaction already recorded: ${transactionId}`);
  }
  const base = Object.freeze({
    sequence: history.length + 1,
    transactionId,
    policyId: input.policy.id,
    policyVersion: input.policy.version,
    policyDigest: input.policy.digest,
    stateRevision: input.state.revision,
    action: input.action,
    fromDailyUsd,
    toDailyUsd,
    at,
    reason,
    decisionId: input.decisionId === null ? null : nonEmpty(input.decisionId, 'budget control audit decisionId'),
    previousHash,
  });
  const event: BudgetControlAuditEvent = Object.freeze({ ...base, hash: sha256(auditMaterial(base)) });
  return Object.freeze([...history, event]);
}


function pendingDigest(value: Omit<BudgetControlPendingMutation, 'digest'>): string {
  return sha256(value);
}

export function budgetControlPendingMutation(
  input: BudgetControlPendingMutationInput,
): BudgetControlPendingMutation {
  const transactionId = nonEmpty(input.transactionId, 'budget control transactionId');
  validateState(input.policy, input.previousState);
  const at = instant(input.at, 'budget control pending at');
  if (input.plan.action === 'no_action') {
    throw new Error('a no-action plan has no external mutation to journal');
  }
  if (input.plan.nextState.policyDigest !== input.policy.digest) {
    throw new Error('pending mutation next state does not belong to the policy');
  }
  const fromDailyUsd = cap(input.fromDailyUsd, 'pending fromDailyUsd');
  const toDailyUsd = cap(input.plan.nextDailyUsd, 'pending toDailyUsd');
  const reason = input.plan.reasons.length > 0
    ? input.plan.reasons.join('; ')
    : input.plan.action === 'apply_recommended'
      ? 'certified decision satisfied the delegated control envelope'
      : 'circuit breaker restored the safe baseline';
  const base = Object.freeze({
    schemaVersion: 1 as const,
    transactionId,
    policyId: input.policy.id,
    policyVersion: input.policy.version,
    policyDigest: input.policy.digest,
    previousState: input.previousState,
    nextState: input.plan.nextState,
    action: input.plan.action,
    fromDailyUsd,
    toDailyUsd,
    at,
    reason,
    decisionId: input.plan.decisionId,
  });
  return Object.freeze({ ...base, digest: pendingDigest(base) });
}

function validatePending(pending: BudgetControlPendingMutation, policy: BudgetControlPolicy): void {
  if (pending.schemaVersion !== 1) throw new Error('budget control pending mutation schema is unsupported');
  if (pending.policyId !== policy.id || pending.policyVersion !== policy.version || pending.policyDigest !== policy.digest) {
    throw new Error('budget control pending mutation belongs to a different policy');
  }
  validateState(policy, pending.previousState);
  validateState(policy, pending.nextState);
  if (pending.action !== 'apply_recommended' && pending.action !== 'rollback_to_baseline') {
    throw new Error('budget control pending mutation action is invalid');
  }
  nonEmpty(pending.transactionId, 'budget control pending transactionId');
  instant(pending.at, 'budget control pending at');
  cap(pending.fromDailyUsd, 'pending fromDailyUsd');
  cap(pending.toDailyUsd, 'pending toDailyUsd');
  nonEmpty(pending.reason, 'budget control pending reason');
  const { digest, ...base } = pending;
  if (digest !== pendingDigest(base)) throw new Error('budget control pending mutation digest is invalid');
}

export function resolveBudgetControlPending(
  pending: BudgetControlPendingMutation,
  policy: BudgetControlPolicy,
  currentDailyUsd: number | null,
  audit: readonly BudgetControlAuditEvent[],
): BudgetControlPendingResolution {
  validatePending(pending, policy);
  const verified = verifyBudgetControlAudit(audit);
  if (!verified.valid) {
    throw new Error(`budget control audit chain is invalid at sequence ${verified.firstInvalidSequence}`);
  }
  const matching = audit.find((event) => event.transactionId === pending.transactionId);
  if (matching !== undefined) {
    return Object.freeze({
      status: 'already_recorded',
      reason: 'the transaction is already present in the verified audit chain',
    });
  }
  const current = cap(currentDailyUsd, 'currentDailyUsd');
  if (sameAmount(current, pending.toDailyUsd)) {
    return Object.freeze({
      status: 'complete',
      reason: 'the config mutation committed; controller state and audit must be completed idempotently',
    });
  }
  if (sameAmount(current, pending.fromDailyUsd)) {
    return Object.freeze({
      status: 'abort',
      reason: 'the config mutation did not commit; restore the previous controller state and record a recovered no-action',
    });
  }
  return Object.freeze({
    status: 'conflict',
    reason: 'the live cap matches neither side of the pending mutation; treat this as an operator/external intervention and refuse recovery',
  });
}

export function verifyBudgetControlAudit(history: readonly BudgetControlAuditEvent[]): BudgetControlAuditVerification {
  let previousHash: string | null = null;
  for (let index = 0; index < history.length; index += 1) {
    const event = history[index]!;
    if (event.sequence !== index + 1 || event.previousHash !== previousHash) {
      return Object.freeze({ valid: false, firstInvalidSequence: index + 1 });
    }
    const { hash, ...base } = event;
    if (hash !== sha256(auditMaterial(base))) {
      return Object.freeze({ valid: false, firstInvalidSequence: index + 1 });
    }
    previousHash = hash;
  }
  return Object.freeze({ valid: true, firstInvalidSequence: null });
}
