import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimProfile, type ClaimProfile } from '../src/epistemic/profile.ts';
import {
  approvePolicy,
  createRecommendation,
  recordAction,
  revokeDecisionLifecycle,
  proposePolicy,
  startDecisionLifecycle,
  type DecisionLifecycle,
  type PolicyEvidence,
  type PolicyProposalInput,
} from '../src/decision/policy.ts';

const issuedAt = '2026-09-10T00:00:00.000Z';
const evidenceId = 'evidence:synthetic:budget-control';

const randomizedProfile: ClaimProfile = claimProfile({
  epistemic: 'supported',
  integrity: 'verified',
  authenticity: 'pinned',
  scope: 'established',
  coverage: 'complete',
  measurement: 'validated',
  causality: 'randomized',
  monetaryBasis: 'provider_observed',
  finality: 'provisional',
  decisionFitness: 'not_assessed',
});

function evidence(overrides: Partial<PolicyEvidence> = {}): PolicyEvidence {
  return {
    id: evidenceId,
    state: 'supported',
    completeness: 'complete',
    revoked: false,
    observedAt: issuedAt,
    freshUntil: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function recommendation(overrides: Record<string, unknown> = {}) {
  return createRecommendation({
    id: 'recommendation:synthetic:budget-control',
    decisionId: 'decision:synthetic:budget-control',
    intervals: [
      { action: 'set_daily_cap', low: 8, high: 10 },
      { action: 'keep_current_cap', low: 0, high: 4 },
    ],
    evidence: [evidence()],
    issuer: { id: 'planner-1', roles: ['planner'] },
    issuedAt,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    consequence: 'changes_spend',
    assuranceInputs: [{ id: 'claim:synthetic:budget-control', profile: randomizedProfile }],
    ...overrides,
  });
}

function proposalInput(overrides: Partial<PolicyProposalInput> = {}): PolicyProposalInput {
  return {
    id: 'proposal:synthetic:budget-control:v1',
    version: 1,
    action: {
      action: 'set_daily_cap',
      kind: 'budget_cap',
      target: 'project:synthetic',
      parameters: { dailyUsd: 10 },
      reversible: true,
      consequence: 'changes_spend',
    },
    requiredApproverRole: 'finance_budget_owner',
    executorRoles: ['budget_operator'],
    approvalTtlMs: 2 * 24 * 60 * 60 * 1000,
    proposedAt: '2026-09-11T00:00:00.000Z',
    idempotencyKey: 'proposal-request-1',
    ...overrides,
  };
}

function proposedLifecycle(): DecisionLifecycle {
  return proposePolicy(
    startDecisionLifecycle(recommendation()),
    proposalInput(),
  );
}

function approvedLifecycle(): DecisionLifecycle {
  return approvePolicy(proposedLifecycle(), {
    id: 'approval:synthetic:budget-control:1',
    idempotencyKey: 'approval-request-1',
    approver: { id: 'finance-1', roles: ['finance_budget_owner'] },
    approvedAt: '2026-09-11T01:00:00.000Z',
    confirmation: true,
  });
}

test('recommendation, proposal, approval and action are separate explicit gates', () => {
  const recommended = startDecisionLifecycle(recommendation());
  assert.equal(recommended.status, 'recommended');
  assert.equal(recommended.proposal, null);

  const proposed = proposedLifecycle();
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.approval, null);

  const approved = approvedLifecycle();
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approval?.approverId, 'finance-1');

  const acted = recordAction(approved, {
    id: 'action:synthetic:budget-control:1',
    idempotencyKey: 'action-request-1',
    executor: { id: 'operator-1', roles: ['budget_operator'] },
    actedAt: '2026-09-11T02:00:00.000Z',
    confirmation: true,
  });
  assert.equal(acted.status, 'action_recorded');
  assert.equal(acted.action?.execution, 'not_executed');
  assert.equal(acted.action?.externalEffect, 'not_attempted');
  assert.equal(acted.action?.automatic, false);
  assert.deepEqual(acted.history.map((event) => event.type), [
    'recommendation_created',
    'policy_proposed',
    'policy_approved',
    'action_recorded',
  ]);
});

test('missing or unresolved evidence cannot become a policy proposal', () => {
  assert.throws(() => recommendation({ evidence: [] }), /evidence/i);

  const unresolved = startDecisionLifecycle(recommendation({
    evidence: [evidence({ state: 'unknown' })],
  }));
  assert.throws(() => proposePolicy(unresolved, proposalInput()), /evidence|supported|assurance/i);

  const incomplete = startDecisionLifecycle(recommendation({
    evidence: [evidence({ completeness: 'partial' })],
  }));
  assert.throws(() => proposePolicy(incomplete, proposalInput()), /evidence|complete|assurance/i);
});

test('undetermined certificates cannot select a policy action', () => {
  const undetermined = startDecisionLifecycle(recommendation({
    intervals: [
      { action: 'set_daily_cap', low: 1, high: 10 },
      { action: 'keep_current_cap', low: 2, high: 11 },
    ],
  }));
  assert.equal(undetermined.recommendation.selectedAction, null);
  assert.throws(() => proposePolicy(undetermined, proposalInput()), /dominance|undetermined|action/i);
});

test('invalid transitions fail closed and do not mutate the prior immutable state', () => {
  const recommended = startDecisionLifecycle(recommendation());
  assert.throws(() => approvePolicy(recommended, {
    id: 'approval:too-early',
    idempotencyKey: 'approval-too-early',
    approver: { id: 'finance-1', roles: ['finance_budget_owner'] },
    approvedAt: '2026-09-11T01:00:00.000Z',
    confirmation: true,
  }), /proposal|transition/i);
  assert.throws(() => recordAction(recommended, {
    id: 'action:too-early',
    idempotencyKey: 'action-too-early',
    executor: { id: 'operator-1', roles: ['budget_operator'] },
    actedAt: '2026-09-11T02:00:00.000Z',
    confirmation: true,
  }), /approval|transition/i);
  assert.equal(recommended.status, 'recommended');
  assert.equal(recommended.proposal, null);
});

test('approval and action replay are idempotent, while divergent replays are refused', () => {
  const proposed = proposedLifecycle();
  const request = {
    id: 'approval:synthetic:budget-control:1',
    idempotencyKey: 'approval-request-1',
    approver: { id: 'finance-1', roles: ['finance_budget_owner'] },
    approvedAt: '2026-09-11T01:00:00.000Z',
    confirmation: true,
  } as const;
  const firstApproval = approvePolicy(proposed, request);
  assert.deepEqual(approvePolicy(firstApproval, request), firstApproval);
  assert.throws(() => approvePolicy(firstApproval, {
    ...request,
    approver: { id: 'finance-2', roles: ['finance_budget_owner'] },
  }), /idempot|replay|transition/i);

  const actionRequest = {
    id: 'action:synthetic:budget-control:1',
    idempotencyKey: 'action-request-1',
    executor: { id: 'operator-1', roles: ['budget_operator'] },
    actedAt: '2026-09-11T02:00:00.000Z',
    confirmation: true,
  } as const;
  const firstAction = recordAction(firstApproval, actionRequest);
  assert.deepEqual(recordAction(firstAction, actionRequest), firstAction);
  assert.throws(() => recordAction(firstAction, {
    ...actionRequest,
    executor: { id: 'operator-2', roles: ['budget_operator'] },
  }), /idempot|replay|transition/i);
});

test('same-key replays with a changed timestamp are divergent requests', () => {
  const proposed = proposedLifecycle();
  const approvalRequest = {
    id: 'approval:synthetic:budget-control:1',
    idempotencyKey: 'approval-request-1',
    approver: { id: 'finance-1', roles: ['finance_budget_owner'] },
    approvedAt: '2026-09-11T01:00:00.000Z',
    confirmation: true,
  } as const;
  const approved = approvePolicy(proposed, approvalRequest);
  assert.throws(() => approvePolicy(approved, {
    ...approvalRequest,
    approvedAt: '2026-09-11T01:01:00.000Z',
  }), /idempot|replay|transition/i);

  const actionRequest = {
    id: 'action:synthetic:budget-control:1',
    idempotencyKey: 'action-request-1',
    executor: { id: 'operator-1', roles: ['budget_operator'] },
    actedAt: '2026-09-11T02:00:00.000Z',
    confirmation: true,
  } as const;
  const acted = recordAction(approved, actionRequest);
  assert.throws(() => recordAction(acted, {
    ...actionRequest,
    actedAt: '2026-09-11T02:01:00.000Z',
  }), /idempot|replay|transition/i);
});

test('approval requires an independent authorized human and action requires an authorized executor', () => {
  const proposed = proposedLifecycle();
  assert.throws(() => approvePolicy(proposed, {
    id: 'approval:wrong-role',
    idempotencyKey: 'approval-wrong-role',
    approver: { id: 'viewer-1', roles: ['auditor'] },
    approvedAt: '2026-09-11T01:00:00.000Z',
    confirmation: true,
  }), /authoriz|role/i);
  assert.throws(() => approvePolicy(proposed, {
    id: 'approval:self',
    idempotencyKey: 'approval-self',
    approver: { id: 'planner-1', roles: ['finance_budget_owner'] },
    approvedAt: '2026-09-11T01:00:00.000Z',
    confirmation: true,
  }), /independent|proposer|authoriz/i);

  const approved = approvedLifecycle();
  assert.throws(() => recordAction(approved, {
    id: 'action:wrong-role',
    idempotencyKey: 'action-wrong-role',
    executor: { id: 'viewer-1', roles: ['auditor'] },
    actedAt: '2026-09-11T02:00:00.000Z',
    confirmation: true,
  }), /authoriz|role/i);
  assert.throws(() => recordAction(approved, {
    id: 'action:no-confirmation',
    idempotencyKey: 'action-no-confirmation',
    executor: { id: 'operator-1', roles: ['budget_operator'] },
    actedAt: '2026-09-11T02:00:00.000Z',
    confirmation: false,
  }), /confirm|explicit/i);
});

test('approval TTL is bounded by policy TTL and exact expiry fails closed', () => {
  const approved = approvedLifecycle();
  assert.throws(() => recordAction(approved, {
    id: 'action:expired',
    idempotencyKey: 'action-expired',
    executor: { id: 'operator-1', roles: ['budget_operator'] },
    actedAt: '2026-09-13T01:00:00.000Z',
    confirmation: true,
  }), /expired|TTL|valid/i);

  const atProposalExpiry = proposePolicy(startDecisionLifecycle(recommendation()), {
    ...proposalInput(),
    proposedAt: '2026-09-16T23:59:59.000Z',
  });
  assert.equal(atProposalExpiry.status, 'proposed');
  assert.throws(() => approvePolicy(atProposalExpiry, {
    id: 'approval:after-proposal-expiry',
    idempotencyKey: 'approval-after-proposal-expiry',
    approver: { id: 'finance-1', roles: ['finance_budget_owner'] },
    approvedAt: '2026-09-17T00:00:00.000Z',
    confirmation: true,
  }), /expired|TTL|proposal/i);
});

test('recorded revocation blocks a later action and preserves the immutable history', () => {
  const approved = approvedLifecycle();
  const revoked = revokeDecisionLifecycle(approved, {
    idempotencyKey: 'revoke-evidence-1',
    targetId: evidenceId,
    revokedAt: '2026-09-11T01:30:00.000Z',
    actor: { id: 'finance-1', roles: ['finance_budget_owner'] },
    reason: 'synthetic evidence withdrawn',
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(approved.status, 'approved');
  assert.throws(() => recordAction(revoked, {
    id: 'action:revoked',
    idempotencyKey: 'action-revoked',
    executor: { id: 'operator-1', roles: ['budget_operator'] },
    actedAt: '2026-09-11T02:00:00.000Z',
    confirmation: true,
  }), /revok|withdraw/i);
  assert.deepEqual(revokeDecisionLifecycle(revoked, {
    idempotencyKey: 'revoke-evidence-1',
    targetId: evidenceId,
    revokedAt: '2026-09-11T01:30:00.000Z',
    actor: { id: 'finance-1', roles: ['finance_budget_owner'] },
    reason: 'synthetic evidence withdrawn',
  }), revoked);
});

test('replayed lifecycle state rejects a forged phase instead of trusting gate fields', () => {
  const proposed = proposedLifecycle();
  const forged = structuredClone(proposed) as { -readonly [K in keyof DecisionLifecycle]: DecisionLifecycle[K] };
  forged.status = 'recommended';
  assert.throws(() => proposePolicy(forged, proposalInput()), /phase|state|transition|proposal|recommended/i);
});
