import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimProfile } from '../src/epistemic/profile.ts';
import { decideBudgetCap } from '../src/budget/capDecision.ts';
import {
  appendBudgetControlAuditEvent,
  budgetControlPendingMutation,
  resolveBudgetControlPending,
  budgetControlPolicy,
  initialBudgetControlState,
  planBudgetControl,
  verifyBudgetControlAudit,
} from '../src/budget/onlineControl.ts';

const DAL3_INPUT = {
  id: 'claim:test:assigned',
  profile: claimProfile({
    epistemic: 'supported', integrity: 'verified', authenticity: 'pinned', scope: 'established',
    coverage: 'complete', measurement: 'validated', causality: 'randomized', monetaryBasis: 'effective',
    finality: 'provisional', decisionFitness: 'not_assessed',
  }),
};

const CERTIFIED = decideBudgetCap({
  dailySpends: [20, 20, 20, 20, 20],
  realizedSpendShare: 0.02,
  currentDailyCapUsd: 100,
  recommendedDailyUsd: 10,
  inputs: [DAL3_INPUT],
});

const REVIEW_ONLY = decideBudgetCap({
  dailySpends: [20, 20, 20, 20, 20],
  realizedSpendShare: 0.02,
  currentDailyCapUsd: 100,
  recommendedDailyUsd: 10,
});

function policy(overrides: Record<string, unknown> = {}) {
  return budgetControlPolicy({
    id: 'budget-control:daily',
    version: 1,
    issuedAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-10-22T00:00:00.000Z',
    enabled: true,
    safeBaselineDailyUsd: 100,
    minDailyUsd: 5,
    maxDailyUsd: 100,
    maxRelativeStep: 0.95,
    explorationRateCap: 0,
    maxRunawayUsd: 10,
    ...overrides,
  });
}

test('J02: a certified, preference-stable cap decision can change the live cap only inside the delegated envelope', () => {
  const p = policy();
  const state = initialBudgetControlState(p, 100, '2026-09-22T00:01:00.000Z');
  const plan = planBudgetControl({
    policy: p,
    state,
    decision: CERTIFIED,
    currentDailyUsd: 100,
    runawayMaxUsd: 5,
    runawayTripped: false,
    now: '2026-09-22T00:02:00.000Z',
  });
  assert.equal(plan.action, 'apply_recommended');
  assert.equal(plan.nextDailyUsd, 10);
  assert.equal(plan.nextState.phase, 'controlling');
  assert.equal(plan.nextState.lastAppliedDailyUsd, 10);
  assert.equal(plan.reasons.length, 0);
});

test('J02: review-only evidence cannot change spend and an active controller fails back to its safe baseline', () => {
  const p = policy();
  const armed = initialBudgetControlState(p, 100, '2026-09-22T00:01:00.000Z');
  const active = planBudgetControl({
    policy: p,
    state: armed,
    decision: CERTIFIED,
    currentDailyUsd: 100,
    runawayMaxUsd: 5,
    runawayTripped: false,
    now: '2026-09-22T00:02:00.000Z',
  }).nextState;
  const fallback = planBudgetControl({
    policy: p,
    state: active,
    decision: REVIEW_ONLY,
    currentDailyUsd: 10,
    runawayMaxUsd: 5,
    runawayTripped: false,
    now: '2026-09-22T00:03:00.000Z',
  });
  assert.equal(fallback.action, 'rollback_to_baseline');
  assert.equal(fallback.nextDailyUsd, 100);
  assert.equal(fallback.nextState.phase, 'rolled_back');
  assert.ok(fallback.reasons.some((reason) => /certif|assurance/i.test(reason)));
});

test('J02: tail-risk breach, expiry, and non-zero exploration all fail closed', () => {
  const p = policy();
  const state = initialBudgetControlState(p, 100, '2026-09-22T00:01:00.000Z');
  const active = planBudgetControl({
    policy: p,
    state,
    decision: CERTIFIED,
    currentDailyUsd: 100,
    runawayMaxUsd: 5,
    runawayTripped: false,
    now: '2026-09-22T00:02:00.000Z',
  }).nextState;

  const tail = planBudgetControl({
    policy: p,
    state: active,
    decision: CERTIFIED,
    currentDailyUsd: 10,
    runawayMaxUsd: 5,
    runawayTripped: true,
    now: '2026-09-22T00:03:00.000Z',
  });
  assert.equal(tail.action, 'rollback_to_baseline');
  assert.ok(tail.reasons.some((reason) => /tail|runaway/i.test(reason)));

  const expired = planBudgetControl({
    policy: p,
    state: active,
    decision: CERTIFIED,
    currentDailyUsd: 10,
    runawayMaxUsd: 5,
    runawayTripped: false,
    now: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(expired.action, 'rollback_to_baseline');
  assert.ok(expired.reasons.some((reason) => /expired/i.test(reason)));

  assert.throws(
    () => policy({ explorationRateCap: 0.01 }),
    /explorationRateCap.*0|deterministic/i,
  );
});

test('J02: operator override is never overwritten by autonomous rollback or apply', () => {
  const p = policy();
  const armed = initialBudgetControlState(p, 100, '2026-09-22T00:01:00.000Z');
  const active = planBudgetControl({
    policy: p,
    state: armed,
    decision: CERTIFIED,
    currentDailyUsd: 100,
    runawayMaxUsd: 5,
    runawayTripped: false,
    now: '2026-09-22T00:02:00.000Z',
  }).nextState;
  const plan = planBudgetControl({
    policy: p,
    state: active,
    decision: REVIEW_ONLY,
    currentDailyUsd: 20,
    runawayMaxUsd: 5,
    runawayTripped: false,
    now: '2026-09-22T00:03:00.000Z',
  });
  assert.equal(plan.action, 'no_action');
  assert.equal(plan.nextDailyUsd, 20);
  assert.ok(plan.reasons.some((reason) => /operator override/i.test(reason)));
});

test('J02: audit events form a verifiable hash chain and tampering is detected', () => {
  const p = policy();
  const state = initialBudgetControlState(p, 100, '2026-09-22T00:01:00.000Z');
  const first = appendBudgetControlAuditEvent([], {
    policy: p,
    state,
    action: 'no_action',
    fromDailyUsd: 100,
    toDailyUsd: 100,
    at: '2026-09-22T00:01:00.000Z',
    reason: 'controller armed',
    decisionId: null,
    transactionId: 'tx-1',
  });
  const second = appendBudgetControlAuditEvent(first, {
    policy: p,
    state,
    action: 'apply_recommended',
    fromDailyUsd: 100,
    toDailyUsd: 10,
    at: '2026-09-22T00:02:00.000Z',
    reason: 'certified bounded action',
    decisionId: 'budget-cap:daily:example',
    transactionId: 'tx-2',
  });
  assert.equal(verifyBudgetControlAudit(second).valid, true);
  const tampered = second.map((event, index) => index === 0 ? { ...event, reason: 'tampered' } : event);
  assert.equal(verifyBudgetControlAudit(tampered).valid, false);
});


test('J02: a durable pending mutation distinguishes complete, abort, and conflict recovery', () => {
  const p = policy();
  const previous = initialBudgetControlState(p, 100, '2026-09-22T00:01:00.000Z');
  const plan = planBudgetControl({
    policy: p,
    state: previous,
    decision: CERTIFIED,
    currentDailyUsd: 100,
    runawayMaxUsd: 5,
    runawayTripped: false,
    now: '2026-09-22T00:02:00.000Z',
  });
  assert.equal(plan.action, 'apply_recommended');
  const pending = budgetControlPendingMutation({
    transactionId: 'tx-recovery',
    policy: p,
    previousState: previous,
    plan,
    fromDailyUsd: 100,
    at: '2026-09-22T00:02:00.000Z',
  });

  assert.equal(resolveBudgetControlPending(pending, p, 10, []).status, 'complete');
  assert.equal(resolveBudgetControlPending(pending, p, 100, []).status, 'abort');
  assert.equal(resolveBudgetControlPending(pending, p, 42, []).status, 'conflict');

  const recorded = appendBudgetControlAuditEvent([], {
    policy: p,
    state: plan.nextState,
    action: plan.action,
    fromDailyUsd: 100,
    toDailyUsd: 10,
    at: '2026-09-22T00:02:00.000Z',
    reason: 'committed',
    decisionId: plan.decisionId,
    transactionId: 'tx-recovery',
  });
  assert.equal(resolveBudgetControlPending(pending, p, 100, recorded).status, 'already_recorded');
  assert.throws(
    () => resolveBudgetControlPending(pending, policy({ version: 2 }), 10, []),
    /policy/i,
  );
});
